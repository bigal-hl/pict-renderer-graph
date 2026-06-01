/**
 * Pict-Renderer-Graph.js
 *
 * Fable-service entry: takes structured graph JSON, produces an Excalidraw-
 * rendered SVG (or PNG) carrying both Excalidraw's standard embedded scene
 * and our own <pict-renderer-graph:source> metadata block.
 *
 * Three invocation modes (this file is the core; the CLI + Orator routes
 * thinly wrap render()):
 *
 *   1. Library:  new PictRendererGraph(fable); .initialize(cb); .render(g, opts, cb); .shutdown(cb)
 *   2. CLI:      source/cli/Pict-Renderer-Graph-CLI-Run.js
 *   3. HTTP:     source/server/Pict-Renderer-Graph-Routes.js (connectRoutes)
 *
 * Render pipeline:
 *
 *   pGraph ──► registry.get(pGraph.type)          // resolve diagram handler
 *           ──► styles.resolve(pGraph.style)      // resolve style profile
 *           ──► handler.toScene(g, profile)       // produce Excalidraw scene
 *           ──► browser.render(scene, opts)       // SVG via puppeteer + wrapper
 *           ──► inject <pict-renderer-graph:source> metadata
 *           ──► { svg|png, mime, scene, source }
 */

const libFableServiceProviderBase = require('fable-serviceproviderbase');

const libBrowser = require('./browser/Pict-Renderer-Graph-Browser.js');
const libDiagramRegistry = require('./diagrams/Diagram-Registry.js');
const libStyleRegistry   = require('./styles/Style-Registry.js');
const libCache           = require('./cache/Pict-Renderer-Graph-Cache.js');
const libCoalescer       = require('./cache/Pict-Renderer-Graph-Coalescer.js');
const { RendererBusyError } = require('./Pict-Renderer-Graph-Errors.js');
const libThemeSVG           = require('./Pict-Renderer-Graph-Theme-SVG.js');
const _DefaultConfiguration = require('./Pict-Renderer-Graph-DefaultConfiguration.js');

const _NS_URI = 'https://fable-retold.github.io/pict-renderer-graph/ns/v1';

class PictRendererGraph extends libFableServiceProviderBase
{
	constructor(pFable, pOptions, pServiceHash)
	{
		let tmpOptions = Object.assign({}, _DefaultConfiguration, pOptions || {});
		super(pFable, tmpOptions, pServiceHash);
		this.serviceType = 'PictRendererGraph';

		this._browser = null;
		this._cache     = new libCache(this.options, pFable);
		this._coalescer = new libCoalescer();
		this.diagrams = libDiagramRegistry;
		this.styles   = libStyleRegistry;
	}

	// ----- Lifecycle ----------------------------------------------------

	/**
	 * Warm the headless browser.  Idempotent.  Optional — render() will
	 * lazy-warm on first call when AutoWarmOnRender is true (default).
	 */
	initialize(fCallback)
	{
		let tmpCb = (typeof fCallback === 'function') ? fCallback : () => {};
		if (!this._browser) this._browser = new libBrowser(this.options, this.fable);
		this._browser.warm(tmpCb);
	}

	/**
	 * Close the browser + asset server + flush pending cache writes.
	 * Idempotent.
	 */
	shutdown(fCallback)
	{
		let tmpCb = (typeof fCallback === 'function') ? fCallback : () => {};
		let tmpFinish = () =>
		{
			if (!this._browser) return tmpCb(null);
			this._browser.close((pErr) =>
			{
				this._browser = null;
				tmpCb(pErr);
			});
		};
		if (this._cache) this._cache.close(tmpFinish);
		else             tmpFinish();
	}

	// ----- The headline API ---------------------------------------------

	/**
	 * Render a graph description into SVG (or PNG).
	 *
	 * @param {object} pGraph  - { type, title?, style?, nodes?, edges?, ... }
	 * @param {object} pOpts   - { format: 'svg'|'png', includeSource?, embedScene?,
	 *                            scale?, padding?, background?, darkMode?,
	 *                            themeVariables? (rewrite palette -> CSS vars) }
	 * @param {Function} fCallback - (pErr, { svg|png, mime, scene, source })
	 */
	render(pGraph, pOpts, fCallback)
	{
		// Allow render(graph, callback) shorthand.
		if (typeof pOpts === 'function' && typeof fCallback === 'undefined')
		{
			fCallback = pOpts;
			pOpts = {};
		}
		let tmpCb = (typeof fCallback === 'function') ? fCallback : () => {};
		let tmpOpts = pOpts || {};

		// Validate + resolve the diagram type.
		let tmpType = (pGraph && pGraph.type) || null;
		if (!tmpType) return tmpCb(new Error('graph.type is required'));
		let tmpHandler = this.diagrams.get(tmpType);
		if (!tmpHandler) return tmpCb(new Error('unknown diagram type "' + tmpType + '" — known: ' +
			this.diagrams.list().map((d) => d.type).join(', ')));

		// Resolve the style profile — keep the user-facing name so the
		// cache layer can record it for invalidate-by-style.
		let tmpResolved = this.styles.resolveWithName(pGraph.style);
		let tmpProfile  = tmpResolved.profile;
		let tmpStyleName = tmpResolved.inputName;
		let tmpGraphType = pGraph.type || null;

		// Cache lookup (memory → disk).  On hit, short-circuit the whole
		// render pipeline — no browser, no handler, no coalesce.
		let tmpHash = this._cache.hashRenderKey(pGraph, tmpOpts, tmpProfile);
		this._cache.get(tmpHash, (pCacheErr, pCached) =>
		{
			if (pCached)
			{
				// pCached already carries cacheHit:'memory'|'disk' from the cache layer.
				return tmpCb(null, _applyThemeVariables(Object.assign({}, pCached, { source: pGraph }), tmpOpts, tmpProfile));
			}

			// Cache miss — coalesce concurrent identical requests.
			this._coalescer.coalesce(tmpHash, () =>
			{
				return new Promise((fResolve, fReject) =>
				{
					this._executeMiss(tmpHandler, pGraph, tmpProfile, tmpOpts, tmpHash,
						{ styleName: tmpStyleName, graphType: tmpGraphType },
						(pErr, pResult) =>
						{
							if (pErr) return fReject(pErr);
							fResolve(pResult);
						});
				});
			}, (pCoErr, pResult) =>
			{
				if (pCoErr) return tmpCb(pCoErr);
				// Cache hit flag is null for fresh renders (or the leader
				// of a coalesced group); followers will see the result
				// from the leader's render — also no cacheHit.
				return tmpCb(null, _applyThemeVariables(pResult, tmpOpts, tmpProfile));
			});
		});
	}

	/**
	 * Cache-miss path: ensure the browser is warm, run the diagram handler,
	 * hand the scene to the browser, splice in source metadata, populate
	 * the cache (carrying styleName + graphType so invalidate-by-style
	 * and invalidate-by-type can find this entry later).
	 */
	_executeMiss(pHandler, pGraph, pProfile, pOpts, pCacheHash, pCacheMeta, fCallback)
	{
		if (!this._browser) this._browser = new libBrowser(this.options, this.fable);
		let tmpProceed = () =>
		{
			this._renderWithHandler(pHandler, pGraph, pProfile, pOpts, (pErr, pResult) =>
			{
				if (pErr) return fCallback(pErr);
				// Populate cache.  Fire-and-forget — set() is non-blocking
				// for the in-memory tier and best-effort for disk.
				this._cache.set(pCacheHash, pResult, pCacheMeta, () => {});
				fCallback(null, pResult);
			});
		};
		if (this._browser.isWarm()) return tmpProceed();
		if (!this.options.AutoWarmOnRender)
		{
			return fCallback(new Error('renderer not initialized — call initialize() first, or set AutoWarmOnRender'));
		}
		this._browser.warm((pErr) =>
		{
			if (pErr) return fCallback(pErr);
			tmpProceed();
		});
	}

	// ----- Cache + style management -------------------------------------

	/**
	 * Drop cache entries matching a filter.  Both memory + disk tiers.
	 *
	 *   renderer.invalidateCache(cb)                              // everything
	 *   renderer.invalidateCache({ all: true }, cb)               // everything (explicit)
	 *   renderer.invalidateCache({ hash: '<sha256>' }, cb)        // one entry
	 *   renderer.invalidateCache({ style: 'notebook' }, cb)       // every notebook-rendered entry
	 *   renderer.invalidateCache({ type:  'flow'     }, cb)       // every flow-typed entry
	 *   renderer.invalidateCache({ style: 'notebook', type: 'flow' }, cb)   // intersection
	 *
	 * @param {object|Function} pFilterOrCb
	 * @param {Function}        [fCallback] - (err, { invalidatedMemory, invalidatedDisk })
	 */
	invalidateCache(pFilterOrCb, fCallback)
	{
		if (typeof pFilterOrCb === 'function')
		{
			return this._cache.invalidate(null, pFilterOrCb);
		}
		this._cache.invalidate(pFilterOrCb, fCallback || (() => {}));
	}

	/**
	 * Atomically update a style profile + invalidate any cached entries
	 * that were rendered under it.  After this call returns, the next
	 * render() using the named style will re-execute the renderer with
	 * the new profile.
	 *
	 * Patch shape: any subset of style-profile fields.  Palette / AppState /
	 * Layout / DefaultSizes deep-merge; everything else replaces.
	 *
	 * @param {string}   pName
	 * @param {object}   pPatch
	 * @param {Function} fCallback - (err, { profile, invalidatedMemory, invalidatedDisk })
	 */
	updateStyle(pName, pPatch, fCallback)
	{
		let tmpCb = (typeof fCallback === 'function') ? fCallback : () => {};
		let tmpUpdated = this.styles.update(pName, pPatch || {});
		if (!tmpUpdated)
		{
			return tmpCb(new Error('unknown style "' + pName + '"; use styles.register(name, profile) to add a new one'));
		}
		this._cache.invalidate({ style: pName }, (pErr, pStats) =>
		{
			if (pErr) return tmpCb(pErr);
			return tmpCb(null, Object.assign({ profile: tmpUpdated }, pStats));
		});
	}

	// ----- Orator integration -------------------------------------------

	/**
	 * Register HTTP routes on the supplied Orator service server.  Mirrors
	 * Retold-Data-Service-DataCloner.connectRoutes().
	 */
	connectRoutes(pOratorServer)
	{
		require('./server/Pict-Renderer-Graph-Routes.js')(this, pOratorServer);
	}

	// ----- Internal -----------------------------------------------------

	_renderWithHandler(pHandler, pGraph, pProfile, pOpts, fCallback)
	{
		let tmpAfterScene = (pSceneErr, pScene) =>
		{
			if (pSceneErr) return fCallback(pSceneErr);
			if (!pScene || !Array.isArray(pScene.elements))
			{
				return fCallback(new Error('diagram handler "' + pHandler.name + '" returned an invalid scene'));
			}

			// Translate caller options → exporter appState flags.
			let tmpBrowserOpts =
			{
				format:           pOpts.format || 'svg',
				exportEmbedScene: (pOpts.embedScene !== false),   // default true
				exportPadding:    (pOpts.padding   !== undefined) ? pOpts.padding   : 16,
				exportScale:      (pOpts.scale     !== undefined) ? pOpts.scale     : 1,
				exportBackground: (pOpts.background !== undefined) ? pOpts.background : true,
				exportWithDarkMode: (pOpts.darkMode !== undefined)
					? pOpts.darkMode
					: !!(pScene.appState && pScene.appState.exportWithDarkMode)
			};

			this._browser.render(pScene, tmpBrowserOpts, (pRenderErr, pResult) =>
			{
				if (pRenderErr) return fCallback(pRenderErr);

				let tmpOutput = {
					mime:  pResult.mime,
					scene: pScene,
					source: pGraph
				};

				if (pResult.format === 'png' || pResult.png)
				{
					tmpOutput.png = pResult.png;
					return fCallback(null, tmpOutput);
				}

				// SVG path — optionally splice in our source metadata.
				let tmpSvg = pResult.svg;
				if (pOpts.includeSource !== false)
				{
					tmpSvg = _injectSourceMetadata(tmpSvg, pGraph);
				}
				tmpOutput.svg = tmpSvg;
				return fCallback(null, tmpOutput);
			});
		};

		// Diagram handlers may be sync OR async.  Sync handlers return the
		// scene from toScene().  Async handlers (mermaid) take a callback.
		try
		{
			if (pHandler.async)
			{
				pHandler.toScene(pGraph, pProfile, this._browser, tmpAfterScene);
			}
			else
			{
				let tmpScene = pHandler.toScene(pGraph, pProfile, this._browser);
				tmpAfterScene(null, tmpScene);
			}
		}
		catch (pErr)
		{
			fCallback(pErr);
		}
	}
}

// ----- SVG post-processing ---------------------------------------------

/**
 * Splice a <pict-renderer-graph:source> metadata element into the SVG,
 * carrying the original graph JSON as CDATA.  We append it inside the
 * existing <metadata> element (Excalidraw always creates one) so we stay
 * within the SVG metadata vocabulary rather than inventing a parallel
 * structure.
 */
function _injectSourceMetadata(pSvgString, pGraph)
{
	let tmpJson = JSON.stringify(pGraph);
	// CDATA can't contain `]]>` — paranoid escape just in case any input
	// somehow has it.  (Unlikely for graph descriptions but free to do.)
	let tmpSafeJson = tmpJson.split(']]>').join(']]]]><![CDATA[>');

	let tmpBlock = '<pict-renderer-graph:source xmlns:pict-renderer-graph="' + _NS_URI + '">' +
		'<![CDATA[' + tmpSafeJson + ']]>' +
		'</pict-renderer-graph:source>';

	// Excalidraw exports an SVG that contains a <metadata>…</metadata>
	// element (sometimes empty, sometimes with the embedded scene).
	// Splice our block in just before </metadata>.  If no <metadata> tag
	// exists, wrap our block in one and inject after the opening <svg> tag.
	let tmpMetaCloseIdx = pSvgString.indexOf('</metadata>');
	if (tmpMetaCloseIdx >= 0)
	{
		return pSvgString.slice(0, tmpMetaCloseIdx) + tmpBlock + pSvgString.slice(tmpMetaCloseIdx);
	}
	// No metadata element — inject a fresh one right after the opening svg.
	let tmpSvgOpenEnd = pSvgString.indexOf('>');
	if (tmpSvgOpenEnd > 0)
	{
		return pSvgString.slice(0, tmpSvgOpenEnd + 1) +
			'<metadata>' + tmpBlock + '</metadata>' +
			pSvgString.slice(tmpSvgOpenEnd + 1);
	}
	// Pathologically malformed SVG — prepend.
	return '<metadata>' + tmpBlock + '</metadata>' + pSvgString;
}

/**
 * Apply the CSS-variable theme rewrite to a result's SVG when the caller asked
 * for it (pOpts.themeVariables).  Runs on the way OUT of render() — after the
 * cache hit-or-miss — so it post-processes both fresh and cached SVGs without
 * being baked into (or doubling) the cache.  No-op for png or when not asked.
 */
function _applyThemeVariables(pResult, pOpts, pProfile)
{
	if (pResult && pOpts && pOpts.themeVariables && (typeof pResult.svg === 'string'))
	{
		return Object.assign({}, pResult, { svg: libThemeSVG.themeifySVG(pResult.svg, pProfile) });
	}
	return pResult;
}

module.exports = PictRendererGraph;
module.exports.default_configuration = _DefaultConfiguration;
module.exports.injectSourceMetadata = _injectSourceMetadata;  // exported for tests
module.exports.NS_URI = _NS_URI;
module.exports.RendererBusyError = RendererBusyError;
module.exports.Cache             = libCache;
module.exports.Coalescer         = libCoalescer;
