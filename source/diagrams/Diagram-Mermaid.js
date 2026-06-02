/**
 * Diagram-Mermaid.js
 *
 * Pass-through to @excalidraw/mermaid-to-excalidraw, run inside the
 * wrapper bundle's browser context (since parseMermaidToExcalidraw is
 * async + relies on mermaid's own dagre/ELK pipeline).
 *
 * Input shape:
 *
 *   { type: 'mermaid', mermaid: '<mermaid source>', title?, style? }
 *
 * The returned scene reuses mermaid's internal layout (dagre/ELK) for
 * structure.  By default the style profile is then applied over the result
 * (see Pict-Renderer-Graph-Restyle.js) so roughness / palette / font / seed
 * match the hand-drawn look — mermaid owns geometry, the profile owns ink.
 * Pass { restyle: false } to keep raw mermaid-to-excalidraw output.
 */

const libRestyle = require('../Pict-Renderer-Graph-Restyle.js');
const libHints   = require('../Pict-Renderer-Graph-Hints.js');

module.exports =
{
	name:        'mermaid',
	description: 'Pass-through to @excalidraw/mermaid-to-excalidraw — render any mermaid syntax (flow/sequence/class/state/gantt) in Excalidraw style.',
	async:       true,

	toScene: function (pGraph, pProfile, pBrowser, fCallback)
	{
		if (!pGraph || !pGraph.mermaid)
		{
			return fCallback(new Error('mermaid diagrams require a "mermaid" string field with the mermaid source'));
		}
		if (!pBrowser || typeof pBrowser.evaluateInPage !== 'function')
		{
			return fCallback(new Error('mermaid handler requires a warm browser (parseMermaidToExcalidraw runs in-page)'));
		}

		// Run the parse inside the browser context via the pool's public
		// evaluateInPage helper.  Goes through the same queue + page-pool
		// + backpressure path as render() so concurrent mermaid + non-
		// mermaid work shares fairly.
		let tmpEvalFn = async (pIn) =>
		{
			let tmpVendor = window.PictSectionExcalidrawVendor;
			if (!tmpVendor || !tmpVendor.parseMermaidToExcalidraw)
			{
				throw new Error('parseMermaidToExcalidraw not available in page (wrapper bundle out of date?)');
			}
			let tmpParsed = await tmpVendor.parseMermaidToExcalidraw(pIn.mermaid, pIn.options || {});
			let tmpSkeleton = (tmpParsed && tmpParsed.elements) || [];
			let tmpFiles    = (tmpParsed && tmpParsed.files)    || {};
			let tmpElements = tmpVendor.convertToExcalidrawElements
				? tmpVendor.convertToExcalidrawElements(tmpSkeleton)
				: tmpSkeleton;
			return { elements: tmpElements, files: tmpFiles };
		};

		// Translate layout-intent hints into the mermaid we feed the engine
		// (direction, engine, spacing, clusters -> subgraphs, order). Emphasis
		// is applied later, post-layout. tmpHinted.clusters drives the
		// post-layout cluster cleanup below.
		let tmpHinted = libHints.applyLayoutHints(pGraph.mermaid, pGraph);
		let tmpInput = { mermaid: tmpHinted.mermaid, options: pGraph.mermaidOptions || {} };
		pBrowser.evaluateInPage(tmpEvalFn, tmpInput, (pErr, pResult) =>
		{
			if (pErr) return fCallback(pErr);
			let tmpElements = pResult.elements || [];
			// Mermaid notes carry HTML <br/> tags in their source text;
			// mermaid-to-excalidraw passes them through verbatim instead
			// of converting to newlines, so they render literally.
			for (let i = 0; i < tmpElements.length; i++)
			{
				let tmpElement = tmpElements[i];
				if (tmpElement && tmpElement.type === 'text' && typeof tmpElement.text === 'string')
				{
					// <br/> -> newline, then collapse the doubled blank lines
					// mermaid-to-excalidraw emits around hard breaks.
					tmpElement.text = tmpElement.text
						.replace(/<br\s*\/?>/gi, '\n')
						.replace(/[ \t]*\n[ \t]*\n[ \t]*/g, '\n')
						.replace(/\n{2,}/g, '\n');
				}
			}
			// Apply the style profile's ink over mermaid's structure so the
			// diagram takes on the themed hand-drawn look.  Mermaid keeps owning
			// geometry; we override paint / roughness / font / seed.  Opt out
			// with { restyle: false } for raw mermaid-to-excalidraw output.
			if (pGraph.restyle !== false)
			{
				libRestyle.restyleElements(tmpElements, pProfile);
			}
			// Cluster frames: quiet the visible ones (dashed deemphasis) and
			// strip the invisible ones (they existed only to group the layout).
			// May return a filtered array, so reassign.
			tmpElements = libHints.applyClusterStyling(tmpElements, tmpHinted.clusters, pProfile);
			// Emphasis hints (accent / dim / bold a node by id or label) ride
			// on the graph input; applied after the base restyle so they win.
			if (Array.isArray(pGraph.emphasis) && pGraph.emphasis.length)
			{
				libRestyle.applyEmphasis(tmpElements, pGraph.emphasis, pGraph.mermaid, pProfile);
			}

			// Build the scene with the style profile's appState.  Mermaid
			// owns the structure, we own the canvas-level theme tokens.
			let tmpAppState = Object.assign({}, (pProfile && pProfile.AppState) || {});
			fCallback(null, {
				type:     'excalidraw',
				version:  2,
				source:   'pict-renderer-graph/mermaid',
				elements: tmpElements,
				appState: tmpAppState,
				files:    pResult.files    || {}
			});
		});
	}
};
