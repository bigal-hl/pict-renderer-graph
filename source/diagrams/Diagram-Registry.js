/**
 * Diagram-Registry.js
 *
 * Maps graph `type` strings to their handler module.  Each handler is an
 * object with shape:
 *
 *     {
 *       name:        string,            // user-facing name
 *       description: string,            // shown by `list-types` CLI
 *       toScene:     function(graph, profile, vendor, callback)
 *                                       // callback(err, { elements, appState, files })
 *                                       // sync handlers can ignore the callback
 *                                       //   and return the scene directly.
 *                                       // async handlers (e.g. mermaid) MUST use
 *                                       //   the callback because parseMermaidToExcalidraw
 *                                       //   resolves in the browser context.
 *     }
 *
 * The vendor argument is a small helper exposing the browser-side surface
 * via puppeteer.  It's only non-null for handlers that need it (mermaid).
 * The library / CLI passes it in; consumers calling toScene directly from
 * node (e.g. unit tests) can pass null for sync handlers.
 */

const _Registry =
{
	'flow':     require('./Diagram-Flow.js'),
	'flowgraph': require('./Diagram-FlowGraph.js'),
	'star':     require('./Diagram-Star.js'),
	'sequence': require('./Diagram-Sequence.js'),
	'seqgraph': require('./Diagram-SequenceGraph.js'),
	'mindmap':  require('./Diagram-MindMap.js'),
	'datadict': require('./Diagram-DataDictionary.js'),
	'mermaid':  require('./Diagram-Mermaid.js')
};

module.exports =
{
	get: function (pName)
	{
		return _Registry[(pName || '').toLowerCase()] || null;
	},

	list: function ()
	{
		let tmpNames = Object.keys(_Registry);
		let tmpOut   = [];
		for (let i = 0; i < tmpNames.length; i++)
		{
			let tmpName = tmpNames[i];
			let tmpHandler = _Registry[tmpName];
			tmpOut.push({
				type:        tmpName,
				name:        tmpHandler.name || tmpName,
				description: tmpHandler.description || '',
				async:       !!tmpHandler.async
			});
		}
		return tmpOut;
	},

	register: function (pName, pHandler)
	{
		_Registry[pName] = pHandler;
	}
};
