/**
 * Pict-Renderer-Graph-Mermaid-Parse.js
 *
 * A small, dependency-free parser for the mermaid FLOWCHART subset we actually
 * use in the docs -- `graph TB|LR|...`, node declarations with the common
 * shapes, edges (with optional labels), and `subgraph ... end` clusters. It
 * turns that text into the structured { direction, nodes, edges, clusters }
 * shape the native notebook generator consumes, so a flowchart can be laid out
 * and emitted by code we own instead of round-tripped through
 * mermaid-to-excalidraw.
 *
 * This is deliberately NOT a full mermaid grammar -- sequence / class / state
 * / gantt / ER stay on the mermaid-to-excalidraw path. It covers flowcharts,
 * which are the overwhelming majority of the ecosystem's diagrams.
 *
 * Node shapes are mapped onto the three primitives the generator draws:
 *   [..] [[..]] >..]            -> rectangle
 *   (..) ([..]) ((..)) [(..)]   -> ellipse  (rounded / stadium / circle / db)
 *   {..} {{..}}                 -> diamond  (decision / hexagon)
 *
 * `<br/>` in a label becomes a newline (the generator splits on \n for lines).
 */

// Opening/closing delimiter pairs, longest first so `([` is tried before `(`.
const _Shapes =
[
	{ open: '([', close: '])', kind: 'ellipse'   },
	{ open: '[[', close: ']]', kind: 'rectangle' },
	{ open: '[(', close: ')]', kind: 'ellipse'   },
	{ open: '((', close: '))', kind: 'ellipse'   },
	{ open: '{{', close: '}}', kind: 'diamond'   },
	{ open: '[',  close: ']',  kind: 'rectangle' },
	{ open: '(',  close: ')',  kind: 'ellipse'   },
	{ open: '{',  close: '}',  kind: 'diamond'   }
];

// mermaid edge operators (variable dash counts), longest/most-specific first.
const _ArrowRe = /(-\.->|<-->|-->|---|==>|===|--o|--x|-\.-)/;

// Decode the handful of HTML entities authors use when a label needs to show a
// literal angle bracket / ampersand / quote (e.g. "&lt;Entity&gt;" or "&quot;x&quot;").
// `&amp;` is decoded LAST so a single pass never double-unescapes.
function _decodeEntities(pStr)
{
	return String(pStr)
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;/g, '\'')
		.replace(/&apos;/g, '\'')
		.replace(/&amp;/g, '&');
}

function _cleanLabel(pRaw)
{
	let tmpStr = String(pRaw == null ? '' : pRaw).trim();
	// Strip one layer of surrounding quotes mermaid allows around a label.
	tmpStr = tmpStr.replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1');
	// Author line breaks -> real newlines; drop any other tags.
	tmpStr = tmpStr.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[^>]+>/g, '');
	// Entities (&lt; &gt; &amp; ...) become the literal characters they name --
	// done after tag stripping so a decoded `<` is shown, not re-stripped.
	tmpStr = _decodeEntities(tmpStr);
	return tmpStr.trim();
}

/**
 * Parse a single node token -- an id with an optional shaped label, e.g.
 * `api["API Gateway"]`, `db[(Database)]`, `ok{Valid?}`, or a bare `api`.
 * Returns { id, label?, kind? } or null when the token isn't a node.
 */
function parseNodeToken(pToken)
{
	let tmpTok = String(pToken == null ? '' : pToken).trim();
	if (!tmpTok) { return null; }

	let tmpMatch = tmpTok.match(/^([A-Za-z0-9_.\-]+)([\s\S]*)$/);
	if (!tmpMatch) { return null; }
	let tmpId   = tmpMatch[1];
	let tmpRest = tmpMatch[2].trim();
	if (!tmpRest) { return { id: tmpId }; }

	for (let i = 0; i < _Shapes.length; i++)
	{
		let tmpShape = _Shapes[i];
		if (tmpRest.length >= (tmpShape.open.length + tmpShape.close.length) &&
			tmpRest.slice(0, tmpShape.open.length) === tmpShape.open &&
			tmpRest.slice(-tmpShape.close.length) === tmpShape.close)
		{
			let tmpInner = tmpRest.slice(tmpShape.open.length, tmpRest.length - tmpShape.close.length);
			return { id: tmpId, label: _cleanLabel(tmpInner), kind: tmpShape.kind };
		}
	}
	// id with trailing junk we don't recognize -- treat as a bare id.
	return { id: tmpId };
}

/**
 * Parse a mermaid flowchart source into a structured graph.
 *
 * @param {string} pSource - mermaid flowchart text
 * @returns {{ direction: string, nodes: Array, edges: Array, clusters: Array }}
 */
function parseMermaidFlowchart(pSource)
{
	let tmpLines = String(pSource == null ? '' : pSource).split('\n');

	let tmpDirection = 'TB';
	let tmpNodes = {};
	let tmpOrder = [];
	let tmpEdges = [];
	let tmpClusters = [];
	let tmpClusterStack = [];

	let tmpDeclare = (pId, pLabel, pKind) =>
	{
		if (!tmpNodes[pId])
		{
			tmpNodes[pId] = { id: pId, label: (pLabel != null) ? pLabel : pId, kind: pKind || 'rectangle' };
			tmpOrder.push(pId);
		}
		else
		{
			if (pLabel != null) { tmpNodes[pId].label = pLabel; }
			if (pKind && pKind !== 'rectangle') { tmpNodes[pId].kind = pKind; }
		}
		// Record membership in the innermost open subgraph.
		if (tmpClusterStack.length)
		{
			let tmpCluster = tmpClusterStack[tmpClusterStack.length - 1];
			if (tmpCluster.nodes.indexOf(pId) === -1) { tmpCluster.nodes.push(pId); }
		}
		return tmpNodes[pId];
	};

	for (let l = 0; l < tmpLines.length; l++)
	{
		let tmpLine = tmpLines[l].trim();
		if (!tmpLine || tmpLine.slice(0, 2) === '%%') { continue; }

		// Header: graph / flowchart [direction]
		let tmpHeader = tmpLine.match(/^(?:graph|flowchart)\s+(TB|TD|BT|LR|RL)\b/i);
		if (tmpHeader)
		{
			let tmpDir = tmpHeader[1].toUpperCase();
			tmpDirection = (tmpDir === 'TD') ? 'TB' : tmpDir;
			continue;
		}
		if (/^(?:graph|flowchart)\b/i.test(tmpLine)) { continue; }

		// Subgraph open / close.
		let tmpSub = tmpLine.match(/^subgraph\s+(.+)$/i);
		if (tmpSub)
		{
			let tmpTok = parseNodeToken(tmpSub[1]);
			let tmpCluster =
			{
				id:     tmpTok ? tmpTok.id : ('cluster' + tmpClusters.length),
				label:  (tmpTok && tmpTok.label != null) ? tmpTok.label : (tmpTok ? tmpTok.id : null),
				nodes:  [],
				parent: tmpClusterStack.length ? tmpClusterStack[tmpClusterStack.length - 1].id : null
			};
			tmpClusters.push(tmpCluster);
			tmpClusterStack.push(tmpCluster);
			continue;
		}
		if (/^end\b/i.test(tmpLine)) { tmpClusterStack.pop(); continue; }
		if (/^direction\b/i.test(tmpLine)) { continue; }
		if (/^(?:style|classDef|class|linkStyle|click)\b/i.test(tmpLine)) { continue; }

		// Edge line (contains an arrow operator)?
		if (_ArrowRe.test(tmpLine))
		{
			let tmpStrokeKind = (/-\.-|-\.->/.test(tmpLine)) ? 'dashed' : 'solid';
			let tmpSegs = tmpLine.split(_ArrowRe);
			let tmpPrev = null;
			for (let s = 0; s < tmpSegs.length; s++)
			{
				if (s % 2 === 1) { continue; }   // odd segments are the arrow operators
				let tmpSeg = tmpSegs[s].trim();
				let tmpEdgeLabel = null;
				// A leading |label| belongs to the arrow that precedes this token.
				let tmpLbl = tmpSeg.match(/^\|([^|]*)\|\s*([\s\S]*)$/);
				if (tmpLbl) { tmpEdgeLabel = _cleanLabel(tmpLbl[1]); tmpSeg = tmpLbl[2].trim(); }
				let tmpTok = parseNodeToken(tmpSeg);
				if (tmpTok && tmpTok.id)
				{
					tmpDeclare(tmpTok.id, tmpTok.label, tmpTok.kind);
					if (tmpPrev)
					{
						let tmpEdge = { from: tmpPrev, to: tmpTok.id };
						if (tmpEdgeLabel) { tmpEdge.label = tmpEdgeLabel; }
						if (tmpStrokeKind === 'dashed') { tmpEdge.kind = 'dashed'; }
						tmpEdges.push(tmpEdge);
					}
					tmpPrev = tmpTok.id;
				}
				else { tmpPrev = null; }
			}
			continue;
		}

		// Standalone node declaration (has a shaped label).
		let tmpStandalone = parseNodeToken(tmpLine);
		if (tmpStandalone && tmpStandalone.id && tmpStandalone.label != null)
		{
			tmpDeclare(tmpStandalone.id, tmpStandalone.label, tmpStandalone.kind);
		}
	}

	// A cluster-to-cluster edge (e.g. layer5's `Core --> Sections`) makes the
	// edge scanner above declare `Core`/`Sections` as nodes. Strip those
	// phantom nodes -- they are subgraph references, not shapes. Edges keep the
	// cluster ids; the renderer remaps them to representative members.
	let tmpClusterIds = {};
	for (let i = 0; i < tmpClusters.length; i++) { tmpClusterIds[tmpClusters[i].id] = true; }
	for (let i = 0; i < tmpClusters.length; i++)
	{
		tmpClusters[i].nodes = tmpClusters[i].nodes.filter((pId) => !tmpClusterIds[pId]);
	}

	// Keep a cluster if it holds nodes directly OR is the parent of another
	// cluster (e.g. layer5's "Pict" wraps "Core" + "Sections" but has no
	// direct member nodes of its own).
	let tmpParentIds = {};
	for (let i = 0; i < tmpClusters.length; i++)
	{
		if (tmpClusters[i].parent) { tmpParentIds[tmpClusters[i].parent] = true; }
	}

	return {
		direction: tmpDirection,
		nodes:     tmpOrder.map((pId) => tmpNodes[pId]).filter((n) => !tmpClusterIds[n.id]),
		edges:     tmpEdges,
		clusters:  tmpClusters.filter((c) => c.nodes.length || tmpParentIds[c.id])
	};
}

module.exports =
{
	parseMermaidFlowchart: parseMermaidFlowchart,
	parseNodeToken:        parseNodeToken
};
