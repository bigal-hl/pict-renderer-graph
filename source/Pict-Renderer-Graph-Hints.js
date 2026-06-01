/**
 * Pict-Renderer-Graph-Hints.js
 *
 * The LAYOUT-INTENT half of a .hints.json sidecar.  Emphasis (accent / dim /
 * bold a node) is a post-layout paint pass and lives in the restyle module;
 * layout intent has to be expressed BEFORE the engine runs, so we translate
 * it into the mermaid source we feed mermaid-to-excalidraw, then do a small
 * post-layout cleanup for clusters.
 *
 * Layout hints (all optional):
 *   {
 *     "direction": "TB" | "TD" | "BT" | "LR" | "RL",   // override graph flow
 *     "engine":    "dagre" | "elk",                    // layout engine
 *     "spacing":   { "node": <px>, "rank": <px> },     // gaps
 *     "clusters":  [ { "id", "label"?, "nodes": [...], "visible"?: true } ],
 *     "order":     [ [ "a", "b", "c" ], ... ]          // best-effort L-to-R
 *   }
 *
 * Reliability, honestly: direction / engine / spacing / clusters are honored
 * by the engine.  `order` is best-effort -- it appends invisible edges to bias
 * dagre's sibling ordering, which usually works but isn't a hard constraint;
 * "X directly left of Y" is a nudge, not a guarantee.
 */

const _Directions = { TB: 1, TD: 1, BT: 1, LR: 1, RL: 1 };

function _escapeLabel(pStr)
{
	return String(pStr == null ? '' : pStr).replace(/"/g, '');
}

// Build the %%{init}%% directive carrying engine + spacing, or '' if neither.
function _initDirective(pHints)
{
	let tmpFlowchart = {};
	if (pHints.spacing)
	{
		if (typeof pHints.spacing.node === 'number') { tmpFlowchart.nodeSpacing = pHints.spacing.node; }
		if (typeof pHints.spacing.rank === 'number') { tmpFlowchart.rankSpacing = pHints.spacing.rank; }
	}
	if (pHints.engine === 'elk') { tmpFlowchart.defaultRenderer = 'elk'; }
	if (!Object.keys(tmpFlowchart).length) { return ''; }
	return '%%{init: ' + JSON.stringify({ flowchart: tmpFlowchart }) + '}%%\n';
}

// Rewrite the direction on the first `graph X` / `flowchart X` line.
function _rewriteDirection(pSource, pDirection)
{
	if (!pDirection || !_Directions[pDirection]) { return pSource; }
	return pSource.replace(/^(\s*(?:graph|flowchart)(?:-elk)?\s+)(TB|TD|BT|LR|RL)\b/m, '$1' + pDirection);
}

/**
 * Rewrite a mermaid source per the layout hints.
 *
 * @param {string} pSource - mermaid source
 * @param {object} pHints  - object carrying direction/engine/spacing/clusters/order
 * @returns {{ mermaid: string, clusters: Array<{id,label,visible}> }}
 */
function applyLayoutHints(pSource, pHints)
{
	let tmpClusters = [];
	if ((typeof pSource !== 'string') || !pHints)
	{
		return { mermaid: pSource, clusters: tmpClusters };
	}

	let tmpOut = _rewriteDirection(pSource, pHints.direction);

	// Clusters -> appended subgraph blocks.  Referencing already-declared node
	// ids inside a subgraph assigns them to that cluster; the node keeps its
	// original label + edges.  Invisible clusters get the id as a findable
	// title that the post-layout pass strips along with the frame.
	if (Array.isArray(pHints.clusters))
	{
		let tmpBlocks = [];
		for (let i = 0; i < pHints.clusters.length; i++)
		{
			let tmpCluster = pHints.clusters[i];
			if (!tmpCluster || !Array.isArray(tmpCluster.nodes) || !tmpCluster.nodes.length) { continue; }
			let tmpId      = tmpCluster.id || ('prgcluster' + tmpClusters.length);
			let tmpVisible = (tmpCluster.visible !== false);
			let tmpLabel   = tmpVisible ? (tmpCluster.label || tmpId) : tmpId;
			tmpBlocks.push('subgraph ' + tmpId + '["' + _escapeLabel(tmpLabel) + '"]\n  ' + tmpCluster.nodes.join('\n  ') + '\nend');
			tmpClusters.push({ id: tmpId, label: tmpLabel, visible: tmpVisible });
		}
		if (tmpBlocks.length) { tmpOut += '\n  ' + tmpBlocks.join('\n  ') + '\n'; }
	}

	// Order -> invisible edges (~~~) to bias dagre's sibling ordering.
	if (Array.isArray(pHints.order))
	{
		let tmpLines = [];
		for (let i = 0; i < pHints.order.length; i++)
		{
			let tmpSeq = pHints.order[i];
			if (Array.isArray(tmpSeq) && tmpSeq.length >= 2) { tmpLines.push('  ' + tmpSeq.join(' ~~~ ')); }
		}
		if (tmpLines.length) { tmpOut += '\n' + tmpLines.join('\n') + '\n'; }
	}

	// Engine + spacing init directive must lead the source.
	let tmpInit = _initDirective(pHints);
	if (tmpInit) { tmpOut = tmpInit + tmpOut; }

	return { mermaid: tmpOut, clusters: tmpClusters };
}

/**
 * Post-layout cluster cleanup.  A subgraph renders as an enclosing rectangle
 * plus a label text whose containerId points at that frame.  Visible clusters
 * get a quiet dashed deemphasis frame; invisible clusters have the frame +
 * label removed (they existed only to group the layout).
 *
 * @returns {Array} the elements (a new array when anything was removed)
 */
function applyClusterStyling(pElements, pClusters, pProfile)
{
	if (!Array.isArray(pElements) || !Array.isArray(pClusters) || !pClusters.length)
	{
		return pElements;
	}
	let tmpPalette = (pProfile && pProfile.Palette) || {};
	let tmpDeemphasis = tmpPalette.deemphasis || '#8A7F72';
	let tmpNorm = (pStr) => String(pStr == null ? '' : pStr).replace(/<[^>]+>/g, '').replace(/\s+/g, '').toLowerCase();

	let tmpById = {};
	for (let i = 0; i < pElements.length; i++) { tmpById[pElements[i].id] = pElements[i]; }

	let tmpRemove = {};
	for (let c = 0; c < pClusters.length; c++)
	{
		let tmpCluster = pClusters[c];
		let tmpLabelEl = null;
		for (let i = 0; i < pElements.length; i++)
		{
			if (pElements[i].type === 'text' && tmpNorm(pElements[i].text) === tmpNorm(tmpCluster.label)) { tmpLabelEl = pElements[i]; break; }
		}
		if (!tmpLabelEl) { continue; }
		let tmpFrame = tmpLabelEl.containerId ? tmpById[tmpLabelEl.containerId] : null;

		if (tmpCluster.visible)
		{
			if (tmpFrame) { tmpFrame.strokeColor = tmpDeemphasis; tmpFrame.strokeStyle = 'dashed'; }
			tmpLabelEl.strokeColor = tmpDeemphasis;
		}
		else
		{
			if (tmpFrame) { tmpRemove[tmpFrame.id] = true; }
			tmpRemove[tmpLabelEl.id] = true;
		}
	}

	if (Object.keys(tmpRemove).length)
	{
		return pElements.filter((e) => !tmpRemove[e.id]);
	}
	return pElements;
}

module.exports = { applyLayoutHints: applyLayoutHints, applyClusterStyling: applyClusterStyling };
