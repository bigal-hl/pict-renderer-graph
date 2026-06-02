/**
 * Diagram-FlowGraph.js
 *
 * Native flowchart path: take mermaid FLOWCHART syntax, parse it ourselves,
 * lay it out with dagre (the same layout engine mermaid uses) and emit
 * Excalidraw elements with our own notebook generator, then apply the same
 * perpendicular edge-routing and title-hierarchy passes the mermaid path uses
 * -- all without round-tripping through mermaid-to-excalidraw.
 *
 * Owning parse -> layout -> emit means label/box/edge decisions are made
 * correctly at emission time (title vs detail as separate elements, edges
 * attached to facing sides, boxes sized to wrapped text) instead of repaired
 * after the fact. Exotic mermaid types (sequence/class/state/ER) stay on the
 * 'mermaid' handler.
 *
 * Input graph shape:
 *   { type:'flowgraph', mermaid:'<flowchart source>', style?, title?,
 *     direction?, spacing?{node,rank}, emphasis?, restyle? }
 */

const libGenerate = require('pict-section-excalidraw/scripts/Generate-Notebook-Diagram.js');
const libParse    = require('../Pict-Renderer-Graph-Mermaid-Parse.js');
const libRestyle  = require('../Pict-Renderer-Graph-Restyle.js');
const libDagre    = require('@dagrejs/dagre');

// Estimate a node's box size from its label (widest line + line count), the
// same heuristic the generator uses, so dagre spaces nodes for the real boxes.
function _sizeForLabel(pLabel, pProfile)
{
	let tmpFontSize = (pProfile && pProfile.FontSize) || 20;
	let tmpLines    = String(pLabel == null ? '' : pLabel).split('\n');
	let tmpMaxLine  = 0;
	for (let i = 0; i < tmpLines.length; i++)
	{
		if (tmpLines[i].length > tmpMaxLine) { tmpMaxLine = tmpLines[i].length; }
	}
	return {
		width:  Math.max(120, Math.ceil(tmpMaxLine * tmpFontSize * 0.55 + 32)),
		height: Math.max(56,  Math.ceil(tmpLines.length * tmpFontSize * 1.25 + 28))
	};
}

// A representative member node id for a cluster -- descends into child
// clusters when the cluster has no direct member nodes (e.g. layer5's Pict).
function _clusterRepNode(pClusterId, pClustersById, pClusters)
{
	let tmpCluster = pClustersById[pClusterId];
	if (!tmpCluster) { return null; }
	if (tmpCluster.nodes && tmpCluster.nodes.length) { return tmpCluster.nodes[0]; }
	for (let i = 0; i < pClusters.length; i++)
	{
		if (pClusters[i].parent === pClusterId)
		{
			let tmpRep = _clusterRepNode(pClusters[i].id, pClustersById, pClusters);
			if (tmpRep) { return tmpRep; }
		}
	}
	return null;
}

/**
 * Lay the parsed graph out with dagre, using a COMPOUND graph so subgraph
 * members (including edge-less ones like spb / proxy / tidings, and all of
 * layer5's grouped modules) stay together inside their cluster. Stamps
 * absolute x/y/width/height onto the nodes and returns a map of cluster id ->
 * bounding rect (top-left) for frame drawing.
 */
function _dagreLayout(pNodes, pEdges, pClusters, pDirection, pProfile, pSpacing)
{
	let tmpRankDir = (pDirection === 'LR' || pDirection === 'RL') ? pDirection
		: (pDirection === 'BT') ? 'BT' : 'TB';
	let tmpNodeSep = (pSpacing && pSpacing.node) || 45;
	let tmpRankSep = (pSpacing && pSpacing.rank) || 90;

	let tmpGraph = new libDagre.graphlib.Graph({ compound: true, multigraph: true });
	tmpGraph.setGraph({ rankdir: tmpRankDir, nodesep: tmpNodeSep, ranksep: tmpRankSep, marginx: 16, marginy: 16 });
	tmpGraph.setDefaultEdgeLabel(() => ({}));

	for (let i = 0; i < pNodes.length; i++)
	{
		let tmpSize = _sizeForLabel(pNodes[i].label, pProfile);
		tmpGraph.setNode(pNodes[i].id, { width: tmpSize.width, height: tmpSize.height });
	}

	// Cluster nodes + parentage (node -> innermost cluster, cluster -> parent).
	let tmpClustersById = {};
	for (let i = 0; i < pClusters.length; i++) { tmpClustersById[pClusters[i].id] = pClusters[i]; }
	let tmpNodeIsReal = {};
	for (let i = 0; i < pNodes.length; i++) { tmpNodeIsReal[pNodes[i].id] = true; }

	for (let i = 0; i < pClusters.length; i++)
	{
		let tmpCluster = pClusters[i];
		tmpGraph.setNode(tmpCluster.id, { label: tmpCluster.label || '' });
		for (let n = 0; n < tmpCluster.nodes.length; n++)
		{
			if (tmpNodeIsReal[tmpCluster.nodes[n]]) { tmpGraph.setParent(tmpCluster.nodes[n], tmpCluster.id); }
		}
	}
	// Nested clusters: child cluster -> parent cluster.
	for (let i = 0; i < pClusters.length; i++)
	{
		if (pClusters[i].parent && tmpClustersById[pClusters[i].parent])
		{
			tmpGraph.setParent(pClusters[i].id, pClusters[i].parent);
		}
	}

	// Edges -- remap any endpoint that is a cluster id to a representative
	// member node (a cluster has no shape of its own to attach to).
	let tmpResolve = (pId) => tmpNodeIsReal[pId] ? pId : _clusterRepNode(pId, tmpClustersById, pClusters);
	let tmpDrawEdges = [];
	for (let i = 0; i < pEdges.length; i++)
	{
		let tmpFrom = tmpResolve(pEdges[i].from);
		let tmpTo   = tmpResolve(pEdges[i].to);
		if (!tmpFrom || !tmpTo || tmpFrom === tmpTo) { continue; }
		tmpGraph.setEdge(tmpFrom, tmpTo, {}, 'e' + i);
		tmpDrawEdges.push(Object.assign({}, pEdges[i], { from: tmpFrom, to: tmpTo }));
	}

	libDagre.layout(tmpGraph);

	for (let i = 0; i < pNodes.length; i++)
	{
		let tmpGN = tmpGraph.node(pNodes[i].id);
		if (!tmpGN) { continue; }
		pNodes[i].x      = Math.round(tmpGN.x - tmpGN.width / 2);
		pNodes[i].y      = Math.round(tmpGN.y - tmpGN.height / 2);
		pNodes[i].width  = tmpGN.width;
		pNodes[i].height = tmpGN.height;
	}

	let tmpClusterRects = {};
	for (let i = 0; i < pClusters.length; i++)
	{
		let tmpGC = tmpGraph.node(pClusters[i].id);
		if (!tmpGC || typeof tmpGC.x !== 'number') { continue; }
		tmpClusterRects[pClusters[i].id] =
		{
			x:      Math.round(tmpGC.x - tmpGC.width / 2),
			y:      Math.round(tmpGC.y - tmpGC.height / 2),
			width:  Math.round(tmpGC.width),
			height: Math.round(tmpGC.height),
			label:  pClusters[i].label
		};
	}

	return { drawEdges: tmpDrawEdges, clusterRects: tmpClusterRects };
}

// Reassign cross-axis positions within each dagre rank so nodes appear in
// DECLARATION order (dagre's crossing-minimizer otherwise reorders them, e.g.
// it reverses a fan). Only used when there are no clusters, so it can't pull a
// member out of its cluster's spatial group.
function _preserveDeclarationOrder(pNodes, pDirection)
{
	let tmpHoriz = (pDirection === 'LR' || pDirection === 'RL');
	let tmpGroups = {};
	for (let i = 0; i < pNodes.length; i++)
	{
		let tmpN = pNodes[i];
		tmpN.__decl = i;
		let tmpCenter = tmpHoriz ? (tmpN.x + tmpN.width / 2) : (tmpN.y + tmpN.height / 2);
		let tmpKey = Math.round(tmpCenter);
		(tmpGroups[tmpKey] = tmpGroups[tmpKey] || []).push(tmpN);
	}
	let tmpKeys = Object.keys(tmpGroups);
	for (let k = 0; k < tmpKeys.length; k++)
	{
		let tmpGroup = tmpGroups[tmpKeys[k]];
		if (tmpGroup.length < 2) { continue; }
		let tmpCross = tmpGroup.map((n) => tmpHoriz ? (n.y + n.height / 2) : (n.x + n.width / 2)).sort((a, b) => a - b);
		let tmpByDecl = tmpGroup.slice().sort((a, b) => a.__decl - b.__decl);
		for (let i = 0; i < tmpByDecl.length; i++)
		{
			let tmpN = tmpByDecl[i];
			if (tmpHoriz) { tmpN.y = Math.round(tmpCross[i] - tmpN.height / 2); }
			else { tmpN.x = Math.round(tmpCross[i] - tmpN.width / 2); }
		}
	}
}

// Build dashed cluster frame rectangles (+ labels) from dagre cluster rects.
// Larger frames first so nested clusters draw on top of their parent.
function _buildClusterFrames(pClusterRects, pProfile)
{
	let tmpPalette = (pProfile && pProfile.Palette) || {};
	let tmpDeemph  = tmpPalette.deemphasis || '#8A7F72';
	let tmpFontSize = Math.max(13, ((pProfile && pProfile.FontSize) || 20) - 5);
	let tmpLabelH   = Math.ceil(tmpFontSize * 1.4);
	let tmpPad      = 14;

	let tmpFrames = [];
	let tmpIds = Object.keys(pClusterRects);
	for (let i = 0; i < tmpIds.length; i++)
	{
		let tmpRect = pClusterRects[tmpIds[i]];
		let tmpHasLabel = tmpRect.label && String(tmpRect.label).trim().length;
		// Grow the box a touch and reserve a label strip across the top.
		let tmpX = tmpRect.x - tmpPad;
		let tmpY = tmpRect.y - tmpPad - (tmpHasLabel ? tmpLabelH : 0);
		let tmpW = tmpRect.width + tmpPad * 2;
		let tmpH = tmpRect.height + tmpPad * 2 + (tmpHasLabel ? tmpLabelH : 0);
		let tmpSeed = libRestyle.seedFor(pProfile, 'cluster:' + tmpIds[i]);

		let tmpFrame =
		{
			id:              'cluster-' + tmpIds[i],
			type:            'rectangle',
			x:               tmpX, y: tmpY, width: tmpW, height: tmpH,
			angle:           0,
			strokeColor:     tmpDeemph,
			backgroundColor: 'transparent',
			fillStyle:       'solid',
			strokeWidth:     1,
			strokeStyle:     'dashed',
			roughness:       (pProfile && pProfile.Roughness !== undefined) ? pProfile.Roughness : 1,
			opacity:         100,
			groupIds:        [],
			frameId:         null,
			roundness:       { type: 3 },
			seed:            tmpSeed,
			version:         1, versionNonce: tmpSeed, isDeleted: false,
			boundElements:   [], updated: 1, link: null, locked: false, index: null
		};

		let tmpLabelEl = null;
		if (tmpHasLabel)
		{
			tmpLabelEl =
			{
				id:              'cluster-label-' + tmpIds[i],
				type:            'text',
				x:               tmpX, y: tmpY + 5, width: tmpW, height: tmpLabelH,
				angle:           0,
				strokeColor:     tmpDeemph,
				backgroundColor: 'transparent',
				fillStyle:       'solid',
				strokeWidth:     1, strokeStyle: 'solid', roughness: 1, opacity: 100,
				groupIds:        [], frameId: null, roundness: null,
				seed:            tmpSeed, version: 1, versionNonce: tmpSeed, isDeleted: false,
				boundElements:   null, updated: 1, link: null, locked: false,
				text:            String(tmpRect.label),
				fontSize:        tmpFontSize,
				fontFamily:      libGenerate.fontFamilyMap[(pProfile && pProfile.FontFamily)] || 5,
				textAlign:       'center', verticalAlign: 'top',
				containerId:     null, originalText: String(tmpRect.label),
				autoResize:      true, lineHeight: 1.25, index: null
			};
		}
		tmpFrames.push({ area: tmpW * tmpH, frame: tmpFrame, label: tmpLabelEl });
	}

	tmpFrames.sort((a, b) => b.area - a.area);   // largest first -> drawn behind
	let tmpOut = [];
	for (let i = 0; i < tmpFrames.length; i++)
	{
		tmpOut.push(tmpFrames[i].frame);
		if (tmpFrames[i].label) { tmpOut.push(tmpFrames[i].label); }
	}
	return tmpOut;
}

module.exports =
{
	name:        'flowgraph',
	description: 'Native flowchart -- parse mermaid flowchart syntax, lay out with dagre, emit + route with our own generator (no mermaid-to-excalidraw).',
	async:       false,

	toScene: function (pGraph, pProfile, pVendor, fCallback)
	{
		let tmpSource = pGraph.mermaid || pGraph.source || '';
		let tmpParsed = libParse.parseMermaidFlowchart(tmpSource);
		let tmpDirection = pGraph.direction || tmpParsed.direction;

		let tmpNodes = tmpParsed.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind }));

		let tmpLayout = _dagreLayout(tmpNodes, tmpParsed.edges, tmpParsed.clusters, tmpDirection, pProfile, pGraph.spacing);

		// Preserve declaration order within ranks when there's nothing to keep
		// grouped (clustered diagrams trust dagre's ordering).
		if (!tmpParsed.clusters.length) { _preserveDeclarationOrder(tmpNodes, tmpDirection); }

		let tmpInput =
		{
			title:  pGraph.title || null,
			nodes:  tmpNodes,
			edges:  tmpLayout.drawEdges,
			layout: 'manual'
		};
		let tmpScene = libGenerate(tmpInput, pProfile);

		if (pGraph.restyle !== false)
		{
			libRestyle.rerouteArrows(tmpScene.elements, pProfile);
			if (Array.isArray(pGraph.emphasis) && pGraph.emphasis.length)
			{
				libRestyle.applyEmphasis(tmpScene.elements, pGraph.emphasis, tmpSource, pProfile);
			}
			libRestyle.splitTitleLines(tmpScene.elements, tmpSource, pProfile);
		}

		// Cluster frames behind everything else.
		let tmpFrames = _buildClusterFrames(tmpLayout.clusterRects, pProfile);
		if (tmpFrames.length) { tmpScene.elements = tmpFrames.concat(tmpScene.elements); }

		if (typeof fCallback === 'function') { fCallback(null, tmpScene); }
		return tmpScene;
	}
};
