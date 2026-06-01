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
				tmpElement.seed        = seedFor(pProfile, 'label:' + tmpKey);
				// Leave fontSize alone -- mermaid sized the containers around
				// its own metrics; re-sizing here would overflow the boxes.
				break;

			case 'arrow':
			case 'line':
				tmpElement.strokeColor = tmpEdge;
				tmpElement.strokeWidth = tmpStrokeWidth;
				tmpElement.strokeStyle = tmpStrokeStyle;
				tmpElement.roughness   = tmpRoughness;
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

module.exports = { restyleElements: restyleElements, seedFor: seedFor, fontFamilyIndex: fontFamilyIndex };
