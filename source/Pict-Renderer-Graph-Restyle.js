/**
 * Pict-Renderer-Graph-Restyle.js
 *
 * Apply a resolved style profile to Excalidraw elements that were produced
 * by something OTHER than our notebook generator -- principally the
 * @excalidraw/mermaid-to-excalidraw output, which builds elements with
 * mermaid's own flat defaults (no roughness, no hand-drawn font, mermaid's
 * palette).
 *
 * Mermaid owns the STRUCTURE (every element's x / y / width / height stays
 * exactly where mermaid's dagre/ELK pass put it). We own the INK: stroke
 * palette, roughness, stroke width, fill style, hand-drawn font, and a
 * deterministic per-element seed so the same source always wobbles the same
 * way.
 *
 * The seed helpers mirror scripts/Generate-Notebook-Diagram.js so a restyled
 * mermaid scene and a natively-generated scene share one notion of "the
 * same hand". fontFamilyMap is imported from there (single source of truth).
 */

const _FontFamilyMap = require('pict-section-excalidraw/scripts/Generate-Notebook-Diagram.js').fontFamilyMap
	|| { 'Excalifont': 5, 'Helvetica': 2, 'Cascadia': 3, 'Lilita One': 7 };
const _DefaultFontFamily = 5; // Excalifont

// Excalifont renders wider + taller than mermaid's default metrics at the same
// point size, so mermaid-sized boxes overflow once we swap the font in. Scale
// the text down uniformly to bring it back inside the boxes (and keep the
// whole diagram visually consistent rather than per-box-fitted).
const _MermaidFontScale = 0.8;

// Tiny deterministic FNV-1a hash -> integer (matches the generator).
function hashString(pStr)
{
	let tmpHash = 2166136261;
	for (let i = 0; i < pStr.length; i++)
	{
		tmpHash ^= pStr.charCodeAt(i);
		tmpHash = (tmpHash * 16777619) >>> 0;
	}
	return tmpHash >>> 0;
}

function seedFor(pProfile, pComponentKey)
{
	let tmpSalt  = (pProfile && pProfile.RandomSeedSalt) || 0;
	let tmpRange = (pProfile && pProfile.SeedRange) || [ 1, 99999 ];
	let tmpRaw   = hashString(pComponentKey + ':' + tmpSalt);
	let tmpSpan  = tmpRange[1] - tmpRange[0] + 1;
	return tmpRange[0] + (tmpRaw % tmpSpan);
}

function fontFamilyIndex(pProfile)
{
	let tmpName = (pProfile && pProfile.FontFamily) || 'Excalifont';
	return _FontFamilyMap[tmpName] || _DefaultFontFamily;
}

/**
 * Restyle an array of Excalidraw elements in place with a style profile.
 * Geometry is preserved; only paint / font / roughness / seed change.
 *
 * @param {Array}  pElements - excalidraw elements (mutated in place)
 * @param {object} pProfile  - resolved style profile (Palette, Roughness, ...)
 * @returns {Array} the same array, restyled
 */
function restyleElements(pElements, pProfile)
{
	if (!Array.isArray(pElements) || !pProfile)
	{
		return pElements;
	}

	let tmpPalette     = pProfile.Palette || {};
	let tmpInk         = tmpPalette.ink || '#1B1F23';
	let tmpEdge        = tmpPalette.link || tmpInk;
	let tmpPaper       = tmpPalette.paper || '#FBF7EE';
	let tmpDeemphasis  = tmpPalette.deemphasis || tmpInk;
	let tmpRoughness   = (pProfile.Roughness !== undefined) ? pProfile.Roughness : 1;
	let tmpStrokeWidth = pProfile.StrokeWidth || 2;
	let tmpStrokeStyle = pProfile.StrokeStyle || 'solid';
	let tmpFillStyle   = pProfile.FillStyle || 'hachure';
	let tmpRoundness   = (pProfile.Roundness !== undefined) ? pProfile.Roundness : { type: 2 };
	let tmpFontCode    = fontFamilyIndex(pProfile);

	for (let i = 0; i < pElements.length; i++)
	{
		let tmpElement = pElements[i];
		if (!tmpElement || !tmpElement.type)
		{
			continue;
		}
		let tmpKey = tmpElement.id || ('element-' + i);

		switch (tmpElement.type)
		{
			case 'rectangle':
			case 'ellipse':
			case 'diamond':
				tmpElement.strokeColor = tmpInk;
				tmpElement.strokeWidth = tmpStrokeWidth;
				tmpElement.strokeStyle = tmpStrokeStyle;
				tmpElement.roughness   = tmpRoughness;
				tmpElement.seed        = seedFor(pProfile, 'shape:' + tmpKey);
				// Keep a fill only where mermaid actually filled the shape;
				// recolor it toward the warm paper tone with a hand-drawn
				// hachure. Unfilled shapes stay outline-only (cleanest look).
				if (tmpElement.backgroundColor && tmpElement.backgroundColor !== 'transparent')
				{
					tmpElement.backgroundColor = tmpPaper;
					tmpElement.fillStyle       = tmpFillStyle;
				}
				else
				{
					tmpElement.backgroundColor = 'transparent';
				}
				// Ellipses have no roundness; rectangles/diamonds take the profile's.
				if (tmpElement.type !== 'ellipse')
				{
					tmpElement.roundness = tmpRoundness;
				}
				break;

			case 'text':
				tmpElement.strokeColor = tmpInk;
				tmpElement.fontFamily  = tmpFontCode;
				// Scale down so the wider/taller Excalifont fits the box mermaid
				// sized for its own narrower font.
				if (typeof tmpElement.fontSize === 'number')
				{
					tmpElement.fontSize = Math.max(11, Math.round(tmpElement.fontSize * _MermaidFontScale));
				}
				tmpElement.seed        = seedFor(pProfile, 'label:' + tmpKey);
				break;

			case 'arrow':
			case 'line':
				tmpElement.strokeColor = tmpEdge;
				tmpElement.strokeWidth = tmpStrokeWidth;
				tmpElement.strokeStyle = tmpStrokeStyle;
				// Connectors read cleaner without wobble -- the hand-drawn feel
				// lives in the shapes; jittery arrows just look noisy.
				tmpElement.roughness   = 0;
				tmpElement.seed        = seedFor(pProfile, 'edge:' + tmpKey);
				break;

			case 'frame':
				// Subgraph / cluster container: a quiet, de-emphasized outline.
				tmpElement.strokeColor = tmpDeemphasis;
				break;

			default:
				break;
		}
	}

	return pElements;
}

/**
 * Parse a mermaid source into a node-id -> label map, so an emphasis hint can
 * name a node by its short id (db) or its displayed label (Database).  Matches
 * the common node declarations: id[label], id(label), id([label]), id[(label)],
 * id{label}, id((label)).  Nodes that only appear in edges (no declared label)
 * are simply their own id and are matched by id directly.
 */
function buildIdLabelMap(pMermaid)
{
	let tmpMap = {};
	if (typeof pMermaid !== 'string') { return tmpMap; }
	// Quoted labels first -- id["...anything, incl. () [] {} ..."] -- the
	// quotes bound the label so parens/brackets inside it are safe.
	let tmpQuoted = /\b([A-Za-z0-9_]+)\s*[\[\(\{]+\s*"([^"]*)"/g;
	let tmpMatch;
	while ((tmpMatch = tmpQuoted.exec(pMermaid)))
	{
		if (tmpMatch[2].trim()) { tmpMap[tmpMatch[1]] = tmpMatch[2].trim(); }
	}
	// Then unquoted labels -- id[label], id(label), id{label}, id([label]),
	// id[(label)] -- stopping at the first closing bracket (no nested parens).
	let tmpUnquoted = /\b([A-Za-z0-9_]+)\s*[\[\(\{]+([^\]\)\}|"]+?)[\]\)\}]+/g;
	while ((tmpMatch = tmpUnquoted.exec(pMermaid)))
	{
		let tmpLabel = tmpMatch[2].replace(/^["']|["']$/g, '').trim();
		if (tmpLabel && !tmpMap[tmpMatch[1]]) { tmpMap[tmpMatch[1]] = tmpLabel; }
	}
	return tmpMap;
}

/**
 * Apply emphasis hints to a restyled scene.  Each hint names a node (by id or
 * label) and a treatment: accent (palette accent stroke), dim (palette
 * deemphasis stroke), bold (thicker shape outline).  Matching is by the node's
 * label text -- the only stable identifier in mermaid-to-excalidraw output --
 * resolved through buildIdLabelMap so short ids work too.  Geometry is never
 * touched (no overlap risk).
 *
 * @param {Array}  pElements - excalidraw elements (mutated)
 * @param {Array}  pEmphasis - [ { node|nodes, accent?, dim?, bold? } ]
 * @param {string} pMermaid  - the mermaid source (for id -> label)
 * @param {object} pProfile  - resolved style profile (palette)
 * @returns {Array} the same array
 */
function applyEmphasis(pElements, pEmphasis, pMermaid, pProfile)
{
	if (!Array.isArray(pElements) || !Array.isArray(pEmphasis) || !pEmphasis.length)
	{
		return pElements;
	}
	let tmpPalette = (pProfile && pProfile.Palette) || {};
	let tmpAccent  = tmpPalette.accent || '#C9602F';
	let tmpDim     = tmpPalette.deemphasis || '#8A7F72';
	let tmpStrokeWidth = (pProfile && pProfile.StrokeWidth) || 2;

	let tmpIdLabel = buildIdLabelMap(pMermaid);
	// Normalize for matching: drop HTML tags (labels may carry <b>/<i>/<br/>)
	// and all whitespace (mermaid turns <br/> into newlines in the element
	// text), then lowercase. Makes "L1" -> "Layer 1<br/>Fable" match the
	// rendered "Layer 1\nFable" text element.
	let tmpNorm = (pStr) => String(pStr == null ? '' : pStr).replace(/<[^>]+>/g, '').replace(/\s+/g, '').toLowerCase();

	let tmpTextByLabel = {};
	let tmpById = {};
	for (let i = 0; i < pElements.length; i++)
	{
		let tmpEl = pElements[i];
		tmpById[tmpEl.id] = tmpEl;
		if (tmpEl.type === 'text') { tmpTextByLabel[tmpNorm(tmpEl.text)] = tmpEl; }
	}

	for (let h = 0; h < pEmphasis.length; h++)
	{
		let tmpHint  = pEmphasis[h] || {};
		let tmpNodes = Array.isArray(tmpHint.nodes) ? tmpHint.nodes : (tmpHint.node ? [ tmpHint.node ] : []);
		for (let n = 0; n < tmpNodes.length; n++)
		{
			let tmpRef    = tmpNodes[n];
			let tmpLabel  = tmpIdLabel[tmpRef] || tmpRef;
			let tmpTextEl = tmpTextByLabel[tmpNorm(tmpLabel)] || tmpTextByLabel[tmpNorm(tmpRef)];
			if (!tmpTextEl) { continue; }
			let tmpShapeEl = tmpTextEl.containerId ? tmpById[tmpTextEl.containerId] : null;
			let tmpTargets = tmpShapeEl ? [ tmpTextEl, tmpShapeEl ] : [ tmpTextEl ];
			for (let t = 0; t < tmpTargets.length; t++)
			{
				let tmpTarget = tmpTargets[t];
				if (tmpHint.dim)         { tmpTarget.strokeColor = tmpDim; }
				else if (tmpHint.accent) { tmpTarget.strokeColor = tmpAccent; }
				if (tmpHint.bold && tmpTarget.type !== 'text')
				{
					tmpTarget.strokeWidth = tmpStrokeWidth + 1.5;
				}
			}
		}
	}
	return pElements;
}

module.exports =
{
	restyleElements: restyleElements,
	applyEmphasis:   applyEmphasis,
	buildIdLabelMap: buildIdLabelMap,
	seedFor:         seedFor,
	fontFamilyIndex: fontFamilyIndex
};
