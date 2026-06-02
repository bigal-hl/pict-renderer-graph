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
				// lives in the shapes; jittery arrows just look noisy. The path
				// itself (perpendicular landings) is repaired by rerouteArrows.
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

// Greedy word-wrap a string to a maximum character count per line.
function _greedyWrap(pText, pMaxChars)
{
	let tmpWords = String(pText == null ? '' : pText).split(/\s+/).filter((w) => w.length);
	if (!tmpWords.length) { return ['']; }
	let tmpLines = [];
	let tmpCurrent = '';
	for (let i = 0; i < tmpWords.length; i++)
	{
		let tmpWord = tmpWords[i];
		if (!tmpCurrent) { tmpCurrent = tmpWord; }
		else if ((tmpCurrent.length + 1 + tmpWord.length) <= pMaxChars) { tmpCurrent += ' ' + tmpWord; }
		else { tmpLines.push(tmpCurrent); tmpCurrent = tmpWord; }
	}
	if (tmpCurrent) { tmpLines.push(tmpCurrent); }
	return tmpLines;
}

// Map a mermaid source's labels to their author-intended <br/> segments,
// keyed by the label's break-stripped, lowercased text (so a rendered text
// element can be matched back to its original label).
function _labelSegmentsMap(pMermaid)
{
	let tmpMap = {};
	if (typeof pMermaid !== 'string') { return tmpMap; }
	// Match key: strip tags and ALL whitespace. mermaid-to-excalidraw breaks
	// labels at arbitrary points -- including mid-token (e.g. "Fable-Settings"
	// rendered as "Fable-\nSettings") -- so collapsing whitespace to a single
	// space would leave a spurious gap that fails to match the source label.
	// Removing whitespace entirely makes the key invariant to where it broke.
	let tmpJoinKey = (s) => String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/\s+/g, '').toLowerCase();
	let tmpToSegments = (pLabel) => pLabel.split(/<br\s*\/?>/i).map((s) => s.replace(/<[^>]+>/g, '').trim()).filter((s) => s.length);

	let tmpQuoted = /[\[\(\{]+\s*"([^"]*)"/g;
	let tmpMatch;
	while ((tmpMatch = tmpQuoted.exec(pMermaid)))
	{
		let tmpSegs = tmpToSegments(tmpMatch[1]);
		if (tmpSegs.length) { tmpMap[tmpJoinKey(tmpMatch[1])] = tmpSegs; }
	}
	let tmpUnquoted = /[\[\(\{]+([^\]\)\}|"]+?)[\]\)\}]+/g;
	while ((tmpMatch = tmpUnquoted.exec(pMermaid)))
	{
		let tmpKey = tmpJoinKey(tmpMatch[1]);
		if (tmpMap[tmpKey]) { continue; }
		let tmpSegs = tmpToSegments(tmpMatch[1]);
		if (tmpSegs.length) { tmpMap[tmpKey] = tmpSegs; }
	}
	return tmpMap;
}

/**
 * Re-flow text elements to undo mermaid-to-excalidraw's broken auto-wrap (it
 * strands the first comma/hyphen token on its own line). We rebuild each
 * label from its author-intended <br/> segments and greedy-wrap every segment
 * to the widest line that ALREADY fit the box -- so the result is sensible and
 * guaranteed to fit (no font measurement needed).
 *
 * @param {Array}  pElements - excalidraw elements (mutated)
 * @param {string} pMermaid  - the original mermaid source (for the labels)
 * @returns {Array} the same array
 */
function reflowText(pElements, pMermaid)
{
	if (!Array.isArray(pElements)) { return pElements; }
	let tmpMap = _labelSegmentsMap(pMermaid);
	// Same whitespace-insensitive key as _labelSegmentsMap: the rendered text's
	// line breaks (wherever mermaid put them, mid-token included) vanish, so it
	// matches the source label regardless of how badly it was wrapped.
	let tmpJoinKey = (s) => String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/\s+/g, '').toLowerCase();

	for (let i = 0; i < pElements.length; i++)
	{
		let tmpEl = pElements[i];
		if (tmpEl.type !== 'text' || (typeof tmpEl.text !== 'string')) { continue; }
		let tmpSegments = tmpMap[tmpJoinKey(tmpEl.text)];
		if (!tmpSegments) { continue; }

		// The widest line mermaid already produced fits the box; wrap to it.
		let tmpExisting = tmpEl.text.split('\n');
		let tmpMaxChars = 1;
		for (let l = 0; l < tmpExisting.length; l++) { tmpMaxChars = Math.max(tmpMaxChars, tmpExisting[l].length); }

		let tmpLines = [];
		for (let s = 0; s < tmpSegments.length; s++) { tmpLines = tmpLines.concat(_greedyWrap(tmpSegments[s], tmpMaxChars)); }
		// Only adopt the re-flow if it doesn't add lines (stays inside the box).
		if (tmpLines.length <= tmpExisting.length) { tmpEl.text = tmpLines.join('\n'); }
	}
	return pElements;
}

// Outward unit normals for each box edge -- the same notion as
// pict-section-flow's GeometryProvider.sideDirection.
const _SideRight  = { dx: 1,  dy: 0 };
const _SideLeft   = { dx: -1, dy: 0 };
const _SideTop    = { dx: 0,  dy: -1 };
const _SideBottom = { dx: 0,  dy: 1 };

// A point ALONG a box edge, given that edge's outward normal (_SideRight, ...)
// and a fraction (0..1) across the edge. Horizontal edges (top/bottom) vary in
// X; vertical edges (left/right) vary in Y. Fraction 0.5 is the midpoint.
function _edgeAnchor(pBox, pSide, pFraction)
{
	let tmpX = (typeof pBox.x === 'number') ? pBox.x : 0;
	let tmpY = (typeof pBox.y === 'number') ? pBox.y : 0;
	let tmpW = pBox.width  || 0;
	let tmpH = pBox.height || 0;
	let tmpF = pFraction;
	if (pSide.dx > 0) { return { x: tmpX + tmpW,      y: tmpY + tmpH * tmpF }; }   // right edge, vary Y
	if (pSide.dx < 0) { return { x: tmpX,             y: tmpY + tmpH * tmpF }; }   // left edge, vary Y
	if (pSide.dy > 0) { return { x: tmpX + tmpW * tmpF, y: tmpY + tmpH }; }        // bottom edge, vary X
	return { x: tmpX + tmpW * tmpF, y: tmpY };                                     // top edge, vary X
}

// Midpoint of a box edge -- the single-connector case of _edgeAnchor.
function _edgeMidpoint(pBox, pSide)
{
	return _edgeAnchor(pBox, pSide, 0.5);
}

// Short name for a side, so connectors landing on the same physical edge of the
// same box can be grouped (box id + side name) and fanned out across it.
function _sideName(pSide)
{
	if (pSide.dx > 0) { return 'R'; }
	if (pSide.dx < 0) { return 'L'; }
	if (pSide.dy > 0) { return 'B'; }
	return 'T';
}

// When several connectors share one edge, spread their anchors across the
// central band of that edge (leaving the rounded corners clear) rather than
// stacking them on the midpoint.
const _PortBandLo = 0.18;
const _PortBandHi = 0.82;

// Cubic bezier point at t -- B(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 +
// t^3 P3 (ported from pict-section-flow's PathGenerator.evaluateCubicBezier).
function _cubicBezier(pP0, pP1, pP2, pP3, pT)
{
	let tmpOMT  = 1 - pT;
	let tmpOMT2 = tmpOMT * tmpOMT;
	let tmpOMT3 = tmpOMT2 * tmpOMT;
	let tmpT2   = pT * pT;
	let tmpT3   = tmpT2 * pT;
	return {
		x: tmpOMT3 * pP0.x + 3 * tmpOMT2 * pT * pP1.x + 3 * tmpOMT * tmpT2 * pP2.x + tmpT3 * pP3.x,
		y: tmpOMT3 * pP0.y + 3 * tmpOMT2 * pT * pP1.y + 3 * tmpOMT * tmpT2 * pP2.y + tmpT3 * pP3.y
	};
}

const _BezierSteps = 18;

/**
 * Build a smooth connector polyline between two anchored edges, reusing
 * pict-section-flow's directional-geometry recipe (computeDirectionalGeometry):
 * a short straight stub off each edge along its outward normal, then a cubic
 * bezier whose two control points ALSO sit along those normals -- so the curve
 * leaves the start edge and arrives at the end edge exactly perpendicular, and
 * (because both control points pull the curve back along the normal) it never
 * bows past its own endpoints. That last property is the whole point: two
 * connectors converging on one box stay within their own lanes instead of
 * crossing. Excalidraw's roundness:2 Catmull-Rom can't do this -- it derives
 * tangents from neighbouring points and overshoots -- so we sample the bezier
 * into a dense polyline and emit it as straight points (the SVG export draws
 * linear elements straight from `points`, so the sampled curve is what renders).
 *
 * @returns {Array<{x,y}>} absolute points: start, stub, bezier samples, end.
 */
function _connectorPoints(pStart, pSideA, pEnd, pSideB)
{
	let tmpRaw      = Math.sqrt(Math.pow(pEnd.x - pStart.x, 2) + Math.pow(pEnd.y - pStart.y, 2));
	let tmpStraight = Math.max(6, Math.min(16, tmpRaw * 0.22));

	let tmpDepartX   = pStart.x + pSideA.dx * tmpStraight;
	let tmpDepartY   = pStart.y + pSideA.dy * tmpStraight;
	let tmpApproachX = pEnd.x   + pSideB.dx * tmpStraight;
	let tmpApproachY = pEnd.y   + pSideB.dy * tmpStraight;

	let tmpDX   = Math.abs(tmpApproachX - tmpDepartX);
	let tmpDY   = Math.abs(tmpApproachY - tmpDepartY);
	let tmpDist = Math.sqrt(tmpDX * tmpDX + tmpDY * tmpDY);
	let tmpBaseOffset = Math.max(Math.min(tmpDist * 0.4, 180), 30);

	// Curve offset adapts to how the two edges relate: facing edges get a gentle
	// offset scaled by the inline distance; same-axis-not-facing edges need a
	// wider one so the path doesn't collapse; perpendicular edges a moderate one.
	let tmpSameAxis = (pSideA.dx !== 0 && pSideB.dx !== 0) || (pSideA.dy !== 0 && pSideB.dy !== 0);
	let tmpFacing = false;
	if (tmpSameAxis)
	{
		if (pSideA.dx === 1 && pSideB.dx === -1 && pEnd.x >= pStart.x)      { tmpFacing = true; }
		else if (pSideA.dx === -1 && pSideB.dx === 1 && pEnd.x <= pStart.x) { tmpFacing = true; }
		else if (pSideA.dy === 1 && pSideB.dy === -1 && pEnd.y >= pStart.y) { tmpFacing = true; }
		else if (pSideA.dy === -1 && pSideB.dy === 1 && pEnd.y <= pStart.y) { tmpFacing = true; }
	}
	let tmpOffset;
	if (tmpFacing)        { let tmpInline = (pSideA.dx !== 0) ? tmpDX : tmpDY; tmpOffset = Math.max(tmpInline * 0.35, 24); }
	else if (tmpSameAxis) { tmpOffset = Math.max(tmpBaseOffset, 60); }
	else                  { tmpOffset = Math.max(tmpBaseOffset * 0.8, 36); }

	let tmpP0 = { x: tmpDepartX,                       y: tmpDepartY };
	let tmpP1 = { x: tmpDepartX + pSideA.dx * tmpOffset, y: tmpDepartY + pSideA.dy * tmpOffset };
	let tmpP2 = { x: tmpApproachX + pSideB.dx * tmpOffset, y: tmpApproachY + pSideB.dy * tmpOffset };
	let tmpP3 = { x: tmpApproachX,                     y: tmpApproachY };

	let tmpPts = [ { x: pStart.x, y: pStart.y } ];
	for (let s = 0; s <= _BezierSteps; s++) { tmpPts.push(_cubicBezier(tmpP0, tmpP1, tmpP2, tmpP3, s / _BezierSteps)); }
	tmpPts.push({ x: pEnd.x, y: pEnd.y });
	return tmpPts;
}

/**
 * Re-route bound connectors so they leave and enter their boxes perpendicular
 * to the edge that FACES the other box -- the clean-landing trick
 * pict-section-flow's PathGenerator uses (a short departure/approach stub along
 * each side's outward normal, then a smooth curve between).
 *
 * The side is chosen from the direction between the two box centers, NOT from
 * where mermaid attached the endpoint. mermaid's dagre frequently attaches a
 * hub's edges to its top and bottom even when every target is off to one side,
 * so the connectors depart vertically and swoop back across other boxes (the
 * meadow-endpoints fan is the worst case). Choosing the facing edge makes a
 * left-right fan depart rightward from the hub and land on each target's left
 * edge; the choice is biased toward the horizontal axis so near-diagonal
 * targets still attach to the side rather than flipping to top/bottom. Each
 * endpoint anchors at its chosen edge's midpoint, then start -> depart ->
 * approach -> end is drawn as a rounded (type 2) curve so the arrowhead always
 * meets its box square-on.
 *
 * The bindings are kept (the scene stays hand-editable); Excalidraw's SVG
 * export draws a linear element straight from its `points`, so these computed
 * waypoints are exactly what renders.
 *
 * @param {Array}  pElements - excalidraw elements (mutated in place)
 * @param {object} pProfile  - resolved style profile (reserved; parity with siblings)
 * @returns {Array} the same array
 */
function rerouteArrows(pElements, pProfile)
{
	if (!Array.isArray(pElements)) { return pElements; }

	let tmpById = {};
	for (let i = 0; i < pElements.length; i++)
	{
		if (pElements[i] && pElements[i].id) { tmpById[pElements[i].id] = pElements[i]; }
	}

	// Pass 1 -- for every eligible connector, choose the facing edges from how
	// the boxes sit relative to each other, using their EXTENTS (not just
	// centers). Horizontal separation wins first: a target entirely off to one
	// side attaches left/right (so a hub whose targets are stacked in a column
	// to the right fans out from its right edge). Only when the boxes overlap
	// horizontally do we go vertical (a target entirely above/below -- e.g. two
	// boxes converging down onto one below them). If they overlap on both axes,
	// fall back to the dominant center direction. The anchor POINT on each edge
	// is deferred to pass 2 so connectors sharing an edge can fan out.
	let tmpRoutes = [];
	for (let i = 0; i < pElements.length; i++)
	{
		let tmpArrow = pElements[i];
		if (!tmpArrow || (tmpArrow.type !== 'arrow' && tmpArrow.type !== 'line')) { continue; }
		if (!Array.isArray(tmpArrow.points) || tmpArrow.points.length < 2) { continue; }

		let tmpStartId = tmpArrow.startBinding && tmpArrow.startBinding.elementId;
		let tmpEndId   = tmpArrow.endBinding   && tmpArrow.endBinding.elementId;
		let tmpBoxA = tmpStartId ? tmpById[tmpStartId] : null;
		let tmpBoxB = tmpEndId   ? tmpById[tmpEndId]   : null;
		// Need both ends bound to a distinct box to know the edges to land on;
		// unbound connectors and self-loops are left exactly as mermaid drew them.
		if (!tmpBoxA || !tmpBoxB || tmpBoxA === tmpBoxB) { continue; }

		let tmpAL = tmpBoxA.x || 0, tmpAR = (tmpBoxA.x || 0) + (tmpBoxA.width  || 0);
		let tmpAT = tmpBoxA.y || 0, tmpAB = (tmpBoxA.y || 0) + (tmpBoxA.height || 0);
		let tmpBL = tmpBoxB.x || 0, tmpBR = (tmpBoxB.x || 0) + (tmpBoxB.width  || 0);
		let tmpBT = tmpBoxB.y || 0, tmpBB = (tmpBoxB.y || 0) + (tmpBoxB.height || 0);

		let tmpSideA, tmpSideB;
		if (tmpBL >= tmpAR)        { tmpSideA = _SideRight;  tmpSideB = _SideLeft; }    // target entirely right
		else if (tmpBR <= tmpAL)  { tmpSideA = _SideLeft;   tmpSideB = _SideRight; }   // target entirely left
		else if (tmpBT >= tmpAB)  { tmpSideA = _SideBottom; tmpSideB = _SideTop; }     // target entirely below
		else if (tmpBB <= tmpAT)  { tmpSideA = _SideTop;    tmpSideB = _SideBottom; }  // target entirely above
		else
		{
			// Overlapping on both axes -- pick the dominant center-to-center axis.
			let tmpDX = (tmpBL + tmpBR) / 2 - (tmpAL + tmpAR) / 2;
			let tmpDY = (tmpBT + tmpBB) / 2 - (tmpAT + tmpAB) / 2;
			if (Math.abs(tmpDX) >= Math.abs(tmpDY))
			{
				tmpSideA = (tmpDX >= 0) ? _SideRight : _SideLeft;
				tmpSideB = (tmpDX >= 0) ? _SideLeft : _SideRight;
			}
			else
			{
				tmpSideA = (tmpDY >= 0) ? _SideBottom : _SideTop;
				tmpSideB = (tmpDY >= 0) ? _SideTop : _SideBottom;
			}
		}

		tmpRoutes.push({ arrow: tmpArrow, boxA: tmpBoxA, boxB: tmpBoxB, sideA: tmpSideA, sideB: tmpSideB });
	}

	// Pass 2 -- group connector endpoints by the physical edge they land on
	// (box id + side) and distribute their anchors across that edge instead of
	// stacking every one on the midpoint. Without this, two arrows converging on
	// the same side both target the edge center and their curves cross as they
	// meet (the layer4 restify+static -> core funnel). Ordering each group by
	// the OPPOSITE endpoint's position along the edge axis makes the leftmost
	// source land leftmost (topmost -> topmost on a vertical edge), so the fan
	// opens cleanly and never crosses.
	let tmpPorts = {};
	let tmpRegister = (pBox, pSide, pRoute, pWhich) =>
	{
		let tmpKey   = (pBox.id || '?') + '|' + _sideName(pSide);
		let tmpHoriz = (pSide.dy !== 0);   // top/bottom edges vary in X
		let tmpOther = (pWhich === 'A') ? pRoute.boxB : pRoute.boxA;
		let tmpOrder = tmpHoriz
			? ((tmpOther.x || 0) + (tmpOther.width  || 0) / 2)
			: ((tmpOther.y || 0) + (tmpOther.height || 0) / 2);
		(tmpPorts[tmpKey] = tmpPorts[tmpKey] || []).push({ box: pBox, side: pSide, route: pRoute, which: pWhich, order: tmpOrder });
	};
	for (let i = 0; i < tmpRoutes.length; i++)
	{
		tmpRegister(tmpRoutes[i].boxA, tmpRoutes[i].sideA, tmpRoutes[i], 'A');
		tmpRegister(tmpRoutes[i].boxB, tmpRoutes[i].sideB, tmpRoutes[i], 'B');
	}
	let tmpPortKeys = Object.keys(tmpPorts);
	for (let k = 0; k < tmpPortKeys.length; k++)
	{
		let tmpGroup = tmpPorts[tmpPortKeys[k]];
		// Stable order by the opposite endpoint, tie-broken by id so the layout
		// is deterministic regardless of element array order.
		tmpGroup.sort((a, b) => (a.order - b.order) || (a.route.arrow.id < b.route.arrow.id ? -1 : 1));
		let tmpCount = tmpGroup.length;
		for (let g = 0; g < tmpCount; g++)
		{
			let tmpEntry = tmpGroup[g];
			let tmpFraction = (tmpCount === 1)
				? 0.5
				: (_PortBandLo + (_PortBandHi - _PortBandLo) * (g + 1) / (tmpCount + 1));
			let tmpAnchor = _edgeAnchor(tmpEntry.box, tmpEntry.side, tmpFraction);
			if (tmpEntry.which === 'A') { tmpEntry.route.startAnchor = tmpAnchor; }
			else { tmpEntry.route.endAnchor = tmpAnchor; }
		}
	}

	// Pass 3 -- draw each connector as a perpendicular stub off each anchored
	// edge joined by a non-overshooting cubic bezier (sampled to a polyline).
	for (let i = 0; i < tmpRoutes.length; i++)
	{
		let tmpRoute = tmpRoutes[i];
		let tmpArrow = tmpRoute.arrow;
		let tmpStart = tmpRoute.startAnchor;
		let tmpEnd   = tmpRoute.endAnchor;

		let tmpAbs = _connectorPoints(tmpStart, tmpRoute.sideA, tmpEnd, tmpRoute.sideB);

		let tmpMinX = Infinity, tmpMinY = Infinity, tmpMaxX = -Infinity, tmpMaxY = -Infinity;
		for (let p = 0; p < tmpAbs.length; p++)
		{
			tmpMinX = Math.min(tmpMinX, tmpAbs[p].x); tmpMaxX = Math.max(tmpMaxX, tmpAbs[p].x);
			tmpMinY = Math.min(tmpMinY, tmpAbs[p].y); tmpMaxY = Math.max(tmpMaxY, tmpAbs[p].y);
		}
		// Re-anchor at the start edge anchor; express the rest relative.
		tmpArrow.x = tmpStart.x;
		tmpArrow.y = tmpStart.y;
		tmpArrow.points = tmpAbs.map((pt) => [ pt.x - tmpStart.x, pt.y - tmpStart.y ]);
		tmpArrow.width  = tmpMaxX - tmpMinX;
		tmpArrow.height = tmpMaxY - tmpMinY;
		// The points already trace the smooth bezier; keep them as a straight
		// polyline (no Catmull-Rom rounding, which would re-introduce overshoot).
		tmpArrow.roundness = null;
	}

	return pElements;
}

// Squash a label / rendered text to a whitespace + tag free key, so a
// rendered text element matches its source label regardless of wrapping.
function _squashKey(pStr)
{
	return String(pStr == null ? '' : pStr).replace(/<[^>]+>/g, '').replace(/\s+/g, '').toLowerCase();
}

/**
 * Give multi-line box labels a heading hierarchy: the title (the first <br/>
 * segment the author wrote) stays full size while the detail line(s) below it
 * shrink, so the heading reads as a heading. Excalidraw has no per-line styling
 * (one font + size per text element) and Excalifont has no bold weight, so the
 * title is promoted into its own text element -- unbound and centered across
 * the box -- stacked above a smaller detail element (the re-purposed original).
 *
 * A first segment counts as a title only when the author clearly separated a
 * heading from a description: either the label has exactly two segments, or it
 * has more but the first is a short (<= 2 word) name. That distinguishes
 * "FoxHound / (Query DSL) / methods" (FoxHound is a title) from a co-equal
 * bullet list like "Behavior injection hooks / Dynamic filtering / Bulk ops"
 * (no title -- left as one block).
 *
 * Runs after applyEmphasis so the promoted title inherits any accent color.
 *
 * @param {Array}  pElements - excalidraw elements (mutated; titles appended)
 * @param {string} pMermaid  - mermaid source (for the <br/> segment structure)
 * @param {object} pProfile  - resolved style profile (for the title seed)
 * @returns {Array} the same array
 */
function splitTitleLines(pElements, pMermaid, pProfile)
{
	if (!Array.isArray(pElements)) { return pElements; }
	let tmpMap = _labelSegmentsMap(pMermaid);

	let tmpById = {};
	for (let i = 0; i < pElements.length; i++)
	{
		if (pElements[i] && pElements[i].id) { tmpById[pElements[i].id] = pElements[i]; }
	}

	let tmpAppend = [];
	for (let i = 0; i < pElements.length; i++)
	{
		let tmpText = pElements[i];
		if (!tmpText || tmpText.type !== 'text' || typeof tmpText.text !== 'string') { continue; }
		if (!tmpText.containerId) { continue; }
		let tmpBox = tmpById[tmpText.containerId];
		if (!tmpBox) { continue; }

		let tmpLines = tmpText.text.split('\n');
		if (tmpLines.length < 2) { continue; }

		let tmpSegments = tmpMap[_squashKey(tmpText.text)];
		if (!tmpSegments || tmpSegments.length < 2) { continue; }

		// Heading vs. the first item of a co-equal list?
		let tmpTitleWords = tmpSegments[0].trim().split(/\s+/).length;
		let tmpIsTitle = (tmpSegments.length === 2) || (tmpTitleWords <= 2);
		if (!tmpIsTitle) { continue; }

		// How many rendered lines does the title segment occupy? (Usually one;
		// reconstruct so a title that itself wrapped still splits cleanly.)
		let tmpTitleKey = _squashKey(tmpSegments[0]);
		let tmpAccum = '';
		let tmpK = 0;
		while (tmpK < tmpLines.length)
		{
			tmpAccum += _squashKey(tmpLines[tmpK]);
			tmpK++;
			if (tmpAccum === tmpTitleKey) { break; }
			if (tmpAccum.length >= tmpTitleKey.length) { tmpK = 0; break; }
		}
		if (tmpK < 1 || tmpK >= tmpLines.length) { continue; }   // no clean title/detail split

		let tmpTitle  = tmpLines.slice(0, tmpK).join('\n');
		let tmpDetail = tmpLines.slice(tmpK).join('\n');

		let tmpLineH      = tmpText.lineHeight || 1.25;
		let tmpTitleSize  = tmpText.fontSize || 16;
		let tmpDetailSize = Math.max(10, Math.round(tmpTitleSize * 0.82));

		let tmpTitleH  = tmpK * tmpTitleSize * tmpLineH;
		let tmpDetailH = (tmpLines.length - tmpK) * tmpDetailSize * tmpLineH;
		let tmpTotalH  = tmpTitleH + tmpDetailH;
		let tmpTop     = tmpBox.y + (tmpBox.height - tmpTotalH) / 2;

		// Title: a new, box-centered element at full size, above the detail.
		let tmpTitleEl = Object.assign({}, tmpText);
		tmpTitleEl.id            = tmpText.id + '_title';
		tmpTitleEl.text          = tmpTitle;
		tmpTitleEl.originalText  = tmpTitle;
		tmpTitleEl.fontSize      = tmpTitleSize;
		tmpTitleEl.containerId   = null;
		tmpTitleEl.textAlign     = 'center';
		tmpTitleEl.verticalAlign = 'top';
		tmpTitleEl.x             = tmpBox.x;
		tmpTitleEl.y             = tmpTop;
		tmpTitleEl.width         = tmpBox.width;
		tmpTitleEl.height        = tmpTitleH;
		tmpTitleEl.seed          = seedFor(pProfile, 'title:' + tmpText.id);
		tmpTitleEl.boundElements = null;
		tmpAppend.push(tmpTitleEl);

		// Detail: re-purpose the original element, shrunk, below the title.
		tmpText.text          = tmpDetail;
		tmpText.originalText  = tmpDetail;
		tmpText.fontSize      = tmpDetailSize;
		tmpText.containerId   = null;
		tmpText.textAlign     = 'center';
		tmpText.verticalAlign = 'top';
		tmpText.x             = tmpBox.x;
		tmpText.y             = tmpTop + tmpTitleH;
		tmpText.width         = tmpBox.width;
		tmpText.height        = tmpDetailH;

		// Drop the container's text binding so it no longer re-centers the
		// (now detail-only) element over the whole box. The arrow bindings stay.
		if (Array.isArray(tmpBox.boundElements))
		{
			tmpBox.boundElements = tmpBox.boundElements.filter((b) => !(b && b.type === 'text'));
		}
	}

	for (let i = 0; i < tmpAppend.length; i++) { pElements.push(tmpAppend[i]); }
	return pElements;
}

module.exports =
{
	restyleElements: restyleElements,
	applyEmphasis:   applyEmphasis,
	reflowText:      reflowText,
	rerouteArrows:   rerouteArrows,
	splitTitleLines: splitTitleLines,
	buildIdLabelMap: buildIdLabelMap,
	seedFor:         seedFor,
	fontFamilyIndex: fontFamilyIndex
};
