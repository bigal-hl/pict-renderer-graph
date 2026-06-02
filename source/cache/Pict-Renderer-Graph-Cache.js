/**
 * Pict-Renderer-Graph-Cache.js
 *
 * Two-tier LRU cache for rendered diagrams.
 *
 *   Tier 1 (memory) : LRU of up to CacheCapacity entries, served instantly.
 *   Tier 2 (disk)   : files under DiskCacheDirectory, survives process restart.
 *
 * Public API (all callback-based for symmetry with the rest of the module):
 *
 *     new Cache(options, fable?)
 *     cache.get(hash, callback)              // (err, value | null)
 *     cache.set(hash, value, callback)       // (err)
 *     cache.close(callback)                  // flush pending disk writes
 *     cache.hashRenderKey(graph, opts, profile) // → 64-char hex SHA-256
 *
 * Value shape:
 *
 *     { svg | png, mime, scene, source, generatedAt }
 *
 * A `cacheHit` field is attached to the returned value indicating which
 * tier served the response: 'memory', 'disk', or absent (i.e. miss).
 *
 * Cache key composition (hashRenderKey):
 *   SHA-256 over a canonicalized JSON blob built from:
 *     - renderer      (package version + _RENDER_ALGORITHM_VERSION) so a change
 *                     to the rendering code invalidates entries for unchanged input
 *     - graph         (recursively key-sorted)
 *     - format        (svg | png)
 *     - scale, padding, background, embedScene, includeSource
 *     - profileFingerprint (subset of profile fields that actually affect output)
 *   So `{a:1, b:2}` and `{b:2, a:1}` hash the same; same-named style with
 *   a tweaked RandomSeedSalt hashes differently.
 *
 * Disk-cache discipline:
 *   - Filenames: <hash>.svg|.png + <hash>.meta.json
 *   - Opportunistic LRU-by-mtime cleanup on set() when entry count exceeds
 *     DiskCacheMaxEntries.  No background timer; works fine for short-lived
 *     CLI invocations + long-lived servers alike.
 *   - Writes are async (fire-and-forget on memory cache.set()); close()
 *     awaits pending writes so a clean shutdown doesn't lose work.
 */

const libCrypto = require('crypto');
const libFs     = require('fs');
const libPath   = require('path');
const libOs     = require('os');
const { LRUCache } = require('lru-cache');

const _DEFAULT_CAPACITY      = 50;
const _DEFAULT_DISK_MAX      = 500;
const _DEFAULT_DISK_DIR_NAME = 'pict-renderer-graph';

// The cache key is hashed over the graph + opts + profile, but NOT over the
// rendering code -- so a change to scene generation (layout, edge routing,
// label emission, ...) would otherwise be masked by a stale hit on the same
// source. Fold the package version plus a hand-bumped algorithm version into
// the key so any such change invalidates prior entries automatically. Bump
// _RENDER_ALGORITHM_VERSION whenever the produced scene/SVG changes for
// unchanged input (the package version covers released upgrades; the constant
// covers in-development iterations between publishes).
const _PACKAGE_VERSION          = (() => { try { return require('../../package.json').version; } catch (pErr) { return '0'; } })();
const _RENDER_ALGORITHM_VERSION = 2;   // 2: bezier-sampled, port-distributed edge routing

class PictRendererGraphCache
{
	constructor(pOptions, pFable)
	{
		this.options = pOptions || {};
		this.fable   = pFable || null;
		this.log     = (pFable && pFable.log) || console;

		this._memoryEnabled = this.options.CacheEnabled !== false;
		this._diskEnabled   = this._memoryEnabled && this.options.DiskCacheEnabled !== false;

		this._memory = this._memoryEnabled
			? new LRUCache({ max: this.options.CacheCapacity || _DEFAULT_CAPACITY })
			: null;

		this._diskDir = this._diskEnabled ? this._resolveDiskDir() : null;
		this._pendingWrites = new Set();

		if (this._diskEnabled)
		{
			try { libFs.mkdirSync(this._diskDir, { recursive: true }); }
			catch (pErr) { this.log.warn && this.log.warn('[pict-renderer-graph cache] failed to create disk dir: ' + pErr.message); }
		}
	}

	// ------------------------------------------------------------------
	// Cache key
	// ------------------------------------------------------------------

	/**
	 * Build a stable SHA-256 cache key for (graph, opts, resolved profile).
	 * @param {object} pGraph
	 * @param {object} pOpts
	 * @param {object} pResolvedProfile - the style profile after Style-Registry.resolve()
	 * @returns {string} 64-char hex hash
	 */
	hashRenderKey(pGraph, pOpts, pResolvedProfile)
	{
		let tmpOpts = pOpts || {};
		let tmpProfile = pResolvedProfile || {};
		let tmpKey =
		{
			renderer:      _PACKAGE_VERSION + ':' + _RENDER_ALGORITHM_VERSION,
			graph:         _canonicalize(pGraph || {}),
			format:        tmpOpts.format || 'svg',
			scale:         (tmpOpts.scale !== undefined)   ? tmpOpts.scale   : 1,
			padding:       (tmpOpts.padding !== undefined) ? tmpOpts.padding : 16,
			background:    tmpOpts.background !== false,
			embedScene:    tmpOpts.embedScene !== false,
			includeSource: tmpOpts.includeSource !== false,
			profileFingerprint: _canonicalize({
				Roughness:      tmpProfile.Roughness,
				StrokeWidth:    tmpProfile.StrokeWidth,
				StrokeStyle:    tmpProfile.StrokeStyle,
				FillStyle:      tmpProfile.FillStyle,
				Roundness:      tmpProfile.Roundness,
				FontFamily:     tmpProfile.FontFamily,
				FontSize:       tmpProfile.FontSize,
				Palette:        tmpProfile.Palette,
				RandomSeedSalt: tmpProfile.RandomSeedSalt,
				Layout:         tmpProfile.Layout,
				AppState:       tmpProfile.AppState
			})
		};
		return libCrypto.createHash('sha256').update(JSON.stringify(tmpKey)).digest('hex');
	}

	// ------------------------------------------------------------------
	// get / set / close
	// ------------------------------------------------------------------

	get(pHash, fCallback)
	{
		let tmpCb = (typeof fCallback === 'function') ? fCallback : () => {};
		if (!this._memoryEnabled) return tmpCb(null, null);

		let tmpMem = this._memory.get(pHash);
		if (tmpMem)
		{
			// Return a shallow clone with the cacheHit marker so the caller
			// can report on it without mutating the cache entry.
			tmpCb(null, Object.assign({}, tmpMem, { cacheHit: 'memory' }));
			return;
		}

		if (!this._diskEnabled) return tmpCb(null, null);

		this._readFromDisk(pHash, (pErr, pDiskValue) =>
		{
			if (pErr || !pDiskValue) return tmpCb(null, null);
			// Promote disk hits into memory so the next request is faster.
			try { this._memory.set(pHash, pDiskValue); }
			catch (pSetErr) { /* benign — memory cache is best-effort */ }
			tmpCb(null, Object.assign({}, pDiskValue, { cacheHit: 'disk' }));
		});
	}

	/**
	 * Store a rendered diagram in the cache.
	 *
	 * @param {string}   pHash
	 * @param {object}   pValue   - { svg|png, mime, scene, source, generatedAt }
	 * @param {object}   [pMeta]  - { styleName, graphType } — recorded so
	 *                              invalidate-by-style / invalidate-by-type
	 *                              can match later.  Optional but recommended.
	 * @param {Function} fCallback
	 */
	set(pHash, pValue, pMeta, fCallback)
	{
		// Back-compat: set(hash, value, callback) without meta.
		if (typeof pMeta === 'function' && typeof fCallback === 'undefined')
		{
			fCallback = pMeta;
			pMeta = null;
		}
		let tmpCb = (typeof fCallback === 'function') ? fCallback : () => {};
		if (!this._memoryEnabled || !pValue) return tmpCb(null);

		// Strip the cacheHit field if the caller is round-tripping a hit;
		// keeps stored entries clean.
		let tmpStored = Object.assign({}, pValue);
		delete tmpStored.cacheHit;
		if (!tmpStored.generatedAt) tmpStored.generatedAt = Date.now();
		if (pMeta && pMeta.styleName) tmpStored.styleName = pMeta.styleName;
		if (pMeta && pMeta.graphType) tmpStored.graphType = pMeta.graphType;

		try { this._memory.set(pHash, tmpStored); }
		catch (pErr) { /* benign — memory cache full / shape error */ }

		if (!this._diskEnabled) return tmpCb(null);

		// Disk write is fire-and-forget — track in _pendingWrites so close()
		// can await it.
		let tmpWritePromise = this._writeToDisk(pHash, tmpStored);
		this._pendingWrites.add(tmpWritePromise);
		tmpWritePromise
			.catch((pWriteErr) =>
			{
				this.log.warn && this.log.warn('[pict-renderer-graph cache] disk write failed: ' + pWriteErr.message);
			})
			.finally(() =>
			{
				this._pendingWrites.delete(tmpWritePromise);
				// Opportunistic LRU eviction: only after the write succeeds
				// so we don't double-up on inode pressure during a burst.
				this._sweepIfOverCap();
			});

		tmpCb(null);
	}

	close(fCallback)
	{
		let tmpCb = (typeof fCallback === 'function') ? fCallback : () => {};
		if (this._pendingWrites.size === 0) return tmpCb(null);
		Promise.allSettled([...this._pendingWrites])
			.then(() => tmpCb(null))
			.catch(() => tmpCb(null));
	}

	/**
	 * Invalidate cache entries matching a filter.  Both memory and disk
	 * tiers are walked.
	 *
	 * Filter shape:
	 *
	 *     { hash:  '<sha256>' }       // exact match — drops at most one entry
	 *     { style: 'notebook'  }      // drops every entry rendered with style 'notebook'
	 *     { type:  'flow'      }      // drops every entry of diagram type 'flow'
	 *     { style: 'notebook', type: 'flow' }   // intersection (both must match)
	 *     { all:   true        }      // explicit drop-everything
	 *     null  / undefined  / {}     // also drops everything (treated as {all: true})
	 *
	 * @param {object}   [pFilter]
	 * @param {Function} fCallback - (err, { invalidatedMemory, invalidatedDisk })
	 */
	invalidate(pFilter, fCallback)
	{
		if (typeof pFilter === 'function' && typeof fCallback === 'undefined')
		{
			fCallback = pFilter;
			pFilter = null;
		}
		let tmpCb = (typeof fCallback === 'function') ? fCallback : () => {};
		let tmpFilter = pFilter || {};
		let tmpDropAll = !!tmpFilter.all
			|| (!tmpFilter.hash && !tmpFilter.style && !tmpFilter.type);

		// ----- memory tier -----
		let tmpInvalidatedMemory = 0;
		if (this._memoryEnabled && this._memory)
		{
			if (tmpDropAll)
			{
				tmpInvalidatedMemory = this._memory.size;
				this._memory.clear();
			}
			else
			{
				// Collect keys to delete first; lru-cache doesn't promise
				// safe deletion during iteration.
				let tmpToDelete = [];
				for (let [ tmpKey, tmpValue ] of this._memory.entries())
				{
					if (_matchesFilter(tmpKey, tmpValue, tmpFilter))
					{
						tmpToDelete.push(tmpKey);
					}
				}
				for (let i = 0; i < tmpToDelete.length; i++)
				{
					this._memory.delete(tmpToDelete[i]);
					tmpInvalidatedMemory++;
				}
			}
		}

		// ----- disk tier -----
		if (!this._diskEnabled || !this._diskDir)
		{
			return tmpCb(null, { invalidatedMemory: tmpInvalidatedMemory, invalidatedDisk: 0 });
		}

		libFs.readdir(this._diskDir, (pErr, pEntries) =>
		{
			if (pErr) return tmpCb(null, { invalidatedMemory: tmpInvalidatedMemory, invalidatedDisk: 0 });
			let tmpMetas = pEntries.filter((e) => e.endsWith('.meta.json'));
			if (tmpMetas.length === 0) return tmpCb(null, { invalidatedMemory: tmpInvalidatedMemory, invalidatedDisk: 0 });

			let tmpInvalidatedDisk = 0;
			let tmpPending = tmpMetas.length;

			let tmpFinish = () =>
			{
				tmpPending--;
				if (tmpPending > 0) return;
				tmpCb(null, { invalidatedMemory: tmpInvalidatedMemory, invalidatedDisk: tmpInvalidatedDisk });
			};

			for (let i = 0; i < tmpMetas.length; i++)
			{
				let tmpMetaName = tmpMetas[i];
				let tmpHash     = tmpMetaName.replace(/\.meta\.json$/, '');
				let tmpMetaPath = libPath.join(this._diskDir, tmpMetaName);

				// Drop-all bypasses the read+parse step.
				if (tmpDropAll)
				{
					this._deleteDiskEntry(tmpHash, (pDelErr, pDeleted) =>
					{
						if (pDeleted) tmpInvalidatedDisk++;
						tmpFinish();
					});
					continue;
				}

				libFs.readFile(tmpMetaPath, 'utf8', (pMetaErr, pMetaJson) =>
				{
					if (pMetaErr) { return tmpFinish(); }
					let tmpMeta;
					try { tmpMeta = JSON.parse(pMetaJson); }
					catch (pParseErr) { return tmpFinish(); }
					// Build a synthetic value carrying the same fields the
					// memory matcher uses.
					let tmpSyntheticValue =
					{
						styleName: tmpMeta.styleName,
						graphType: tmpMeta.graphType,
						source:    tmpMeta.source
					};
					if (!_matchesFilter(tmpHash, tmpSyntheticValue, tmpFilter))
					{
						return tmpFinish();
					}
					this._deleteDiskEntry(tmpHash, (pDelErr, pDeleted) =>
					{
						if (pDeleted) tmpInvalidatedDisk++;
						tmpFinish();
					});
				});
			}
		});
	}

	_deleteDiskEntry(pHash, fCallback)
	{
		let tmpCb = (typeof fCallback === 'function') ? fCallback : () => {};
		let tmpAny = false;
		let tmpPending = 3;
		let tmpDone = () =>
		{
			tmpPending--;
			if (tmpPending === 0) tmpCb(null, tmpAny);
		};
		libFs.unlink(this._pathFor(pHash, '.meta.json'), (pErr) => { if (!pErr) tmpAny = true; tmpDone(); });
		libFs.unlink(this._pathFor(pHash, '.svg'),       (pErr) => { if (!pErr) tmpAny = true; tmpDone(); });
		libFs.unlink(this._pathFor(pHash, '.png'),       (pErr) => { if (!pErr) tmpAny = true; tmpDone(); });
	}

	// ------------------------------------------------------------------
	// Disk I/O
	// ------------------------------------------------------------------

	_resolveDiskDir()
	{
		if (this.options.DiskCacheDirectory) return this.options.DiskCacheDirectory;
		let tmpBase = process.env.XDG_CACHE_HOME
			|| libPath.join(libOs.homedir(), '.cache');
		return libPath.join(tmpBase, _DEFAULT_DISK_DIR_NAME);
	}

	_pathFor(pHash, pExt)
	{
		return libPath.join(this._diskDir, pHash + pExt);
	}

	_readFromDisk(pHash, fCallback)
	{
		let tmpMetaPath = this._pathFor(pHash, '.meta.json');
		libFs.readFile(tmpMetaPath, 'utf8', (pMetaErr, pMetaJson) =>
		{
			if (pMetaErr) return fCallback(null, null);
			let tmpMeta;
			try { tmpMeta = JSON.parse(pMetaJson); }
			catch (pParseErr) { return fCallback(null, null); }

			let tmpPayloadExt = (tmpMeta.mime === 'image/png') ? '.png' : '.svg';
			let tmpPayloadPath = this._pathFor(pHash, tmpPayloadExt);
			let tmpReadMode    = (tmpPayloadExt === '.png') ? null : 'utf8';

			libFs.readFile(tmpPayloadPath, tmpReadMode, (pBodyErr, pBody) =>
			{
				if (pBodyErr) return fCallback(null, null);
				let tmpValue = {
					mime:        tmpMeta.mime,
					scene:       tmpMeta.scene,
					source:      tmpMeta.source,
					generatedAt: tmpMeta.generatedAt,
					styleName:   tmpMeta.styleName || null,
					graphType:   tmpMeta.graphType || null
				};
				if (tmpPayloadExt === '.png') tmpValue.png = pBody;
				else                          tmpValue.svg = pBody;
				// Bump mtime so LRU-by-mtime sweep treats this entry as
				// freshly used — keeps hot entries from being evicted.
				libFs.utimes(tmpPayloadPath, new Date(), new Date(), () => {});
				libFs.utimes(tmpMetaPath,    new Date(), new Date(), () => {});
				fCallback(null, tmpValue);
			});
		});
	}

	_writeToDisk(pHash, pValue)
	{
		return new Promise((fResolve, fReject) =>
		{
			let tmpPayloadExt = (pValue.mime === 'image/png') ? '.png' : '.svg';
			let tmpPayload   = (tmpPayloadExt === '.png') ? pValue.png : pValue.svg;
			if (!tmpPayload) return fResolve();   // nothing to write

			let tmpMeta = {
				mime:        pValue.mime,
				scene:       pValue.scene,
				source:      pValue.source,
				generatedAt: pValue.generatedAt || Date.now(),
				styleName:   pValue.styleName || null,
				graphType:   pValue.graphType || null
			};

			let tmpPayloadPath = this._pathFor(pHash, tmpPayloadExt);
			let tmpMetaPath    = this._pathFor(pHash, '.meta.json');

			libFs.writeFile(tmpPayloadPath, tmpPayload, (pPayloadErr) =>
			{
				if (pPayloadErr) return fReject(pPayloadErr);
				libFs.writeFile(tmpMetaPath, JSON.stringify(tmpMeta), 'utf8', (pMetaErr) =>
				{
					if (pMetaErr) return fReject(pMetaErr);
					fResolve();
				});
			});
		});
	}

	_sweepIfOverCap()
	{
		let tmpCap = this.options.DiskCacheMaxEntries || _DEFAULT_DISK_MAX;
		libFs.readdir(this._diskDir, (pErr, pEntries) =>
		{
			if (pErr) return;
			let tmpMetas = pEntries.filter((e) => e.endsWith('.meta.json'));
			if (tmpMetas.length <= tmpCap) return;

			// Stat each meta + sort by mtime ascending (oldest first).
			let tmpStats = [];
			let tmpPending = tmpMetas.length;
			for (let i = 0; i < tmpMetas.length; i++)
			{
				let tmpFile = libPath.join(this._diskDir, tmpMetas[i]);
				libFs.stat(tmpFile, (pStatErr, pStat) =>
				{
					if (!pStatErr) tmpStats.push({ file: tmpFile, hash: tmpMetas[i].replace('.meta.json', ''), mtime: pStat.mtimeMs });
					tmpPending--;
					if (tmpPending === 0) finishSweep();
				});
			}

			let finishSweep = () =>
			{
				tmpStats.sort((a, b) => a.mtime - b.mtime);
				let tmpToDelete = tmpStats.length - tmpCap;
				for (let i = 0; i < tmpToDelete; i++)
				{
					let tmpHash = tmpStats[i].hash;
					libFs.unlink(this._pathFor(tmpHash, '.meta.json'), () => {});
					libFs.unlink(this._pathFor(tmpHash, '.svg'), () => {});
					libFs.unlink(this._pathFor(tmpHash, '.png'), () => {});
				}
			};
		});
	}

	// ------------------------------------------------------------------
	// Diagnostics
	// ------------------------------------------------------------------

	memoryCount() { return this._memory ? this._memory.size : 0; }
	diskDir()     { return this._diskDir; }
}

// ------------------------------------------------------------------
// Helpers (private)
// ------------------------------------------------------------------

/**
 * Match a single cache entry against an invalidation filter.  `hash` is
 * an exact match; `style` and `type` match the recorded styleName /
 * graphType.  Multiple criteria are AND-ed.
 */
function _matchesFilter(pHash, pValue, pFilter)
{
	if (pFilter.hash && pFilter.hash !== pHash) return false;
	if (pFilter.style)
	{
		let tmpStyle = pValue && (pValue.styleName ||
			(pValue.source && (typeof pValue.source.style === 'string' ? pValue.source.style :
				(pValue.source.style && pValue.source.style.name))));
		if (tmpStyle !== pFilter.style) return false;
	}
	if (pFilter.type)
	{
		let tmpType = pValue && (pValue.graphType ||
			(pValue.source && pValue.source.type));
		if (tmpType !== pFilter.type) return false;
	}
	return true;
}

/**
 * Recursively rebuild an object with sorted keys so JSON.stringify is
 * order-stable.  Arrays keep their order (semantically meaningful in
 * graphs — node order matters for auto-layout).
 */
function _canonicalize(pValue)
{
	if (pValue === null || pValue === undefined) return pValue;
	if (Array.isArray(pValue)) return pValue.map(_canonicalize);
	if (typeof pValue !== 'object') return pValue;
	let tmpKeys = Object.keys(pValue).sort();
	let tmpOut  = {};
	for (let i = 0; i < tmpKeys.length; i++)
	{
		tmpOut[tmpKeys[i]] = _canonicalize(pValue[tmpKeys[i]]);
	}
	return tmpOut;
}

module.exports = PictRendererGraphCache;
module.exports.canonicalize = _canonicalize;   // exported for tests
