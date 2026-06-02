/*
	Tests for the native flowchart path:
	  - Pict-Renderer-Graph-Mermaid-Parse.js   (mermaid flowchart -> graph)
	  - diagrams/Diagram-FlowGraph.js           (parse -> dagre -> emit scene)

	Both run in pure Node (no browser): the handler's toScene is synchronous --
	parse + dagre layout + generator + the restyle passes. Only the final SVG
	export (not exercised here) needs Chromium.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const { parseMermaidFlowchart, parseNodeToken } = require('../source/Pict-Renderer-Graph-Mermaid-Parse.js');
const libFlowGraph = require('../source/diagrams/Diagram-FlowGraph.js');
const Profile = require('pict-section-excalidraw/source/style-profiles/Notebook-Default.js');

suite('PictRendererGraph — mermaid flowchart parser', function ()
{
	test('parses direction, nodes, and edges from a simple flowchart', function ()
	{
		let tmpGraph = parseMermaidFlowchart('graph LR\n  a["A"] --> b["B"]\n  b --> c["C"]');
		Expect(tmpGraph.direction).to.equal('LR');
		Expect(tmpGraph.nodes.map((n) => n.id)).to.deep.equal([ 'a', 'b', 'c' ]);
		Expect(tmpGraph.edges).to.deep.equal([ { from: 'a', to: 'b' }, { from: 'b', to: 'c' } ]);
	});

	test('maps node shapes to rectangle / ellipse / diamond', function ()
	{
		Expect(parseNodeToken('a["X"]').kind).to.equal('rectangle');
		Expect(parseNodeToken('a(["X"])').kind).to.equal('ellipse');
		Expect(parseNodeToken('a[(X)]').kind).to.equal('ellipse');
		Expect(parseNodeToken('a{X}').kind).to.equal('diamond');
		Expect(parseNodeToken('a{{X}}').kind).to.equal('diamond');
	});

	test('turns <br/> into a newline and strips quotes', function ()
	{
		Expect(parseNodeToken('n["Title<br/>detail"]').label).to.equal('Title\ndetail');
	});

	test('parses subgraphs, nesting, and parentage', function ()
	{
		let tmpSrc = 'graph TB\n' +
			'  subgraph Outer["Outer"]\n' +
			'    subgraph Inner["Inner"]\n' +
			'      x["X"]\n' +
			'    end\n' +
			'    y["Y"]\n' +
			'  end';
		let tmpGraph = parseMermaidFlowchart(tmpSrc);
		let tmpInner = tmpGraph.clusters.find((c) => c.id === 'Inner');
		let tmpOuter = tmpGraph.clusters.find((c) => c.id === 'Outer');
		Expect(tmpInner.nodes).to.deep.equal([ 'x' ]);
		Expect(tmpInner.parent).to.equal('Outer');
		Expect(tmpOuter.nodes).to.deep.equal([ 'y' ]);
		Expect(tmpOuter.parent).to.equal(null);
	});

	test('a cluster-to-cluster edge does not leak the cluster ids as nodes', function ()
	{
		let tmpSrc = 'graph TB\n' +
			'  subgraph Core["Core"]\n    v["V"]\n  end\n' +
			'  subgraph Sec["Sec"]\n    f["F"]\n  end\n' +
			'  Core --> Sec';
		let tmpGraph = parseMermaidFlowchart(tmpSrc);
		// Only the real member nodes survive -- Core / Sec are clusters, not shapes.
		Expect(tmpGraph.nodes.map((n) => n.id).sort()).to.deep.equal([ 'f', 'v' ]);
		// ...but the edge between the clusters is preserved (the renderer remaps it).
		Expect(tmpGraph.edges).to.deep.equal([ { from: 'Core', to: 'Sec' } ]);
	});

	test('captures an edge label', function ()
	{
		let tmpGraph = parseMermaidFlowchart('graph LR\n  a["A"] -->|go| b["B"]');
		Expect(tmpGraph.edges[0].label).to.equal('go');
	});
});

suite('PictRendererGraph — flowgraph handler (parse -> dagre -> scene)', function ()
{
	test('lays out a fan into a scene with one box + label per node', function ()
	{
		let tmpSrc = 'graph LR\n  hub["Hub"] --> a["A"]\n  hub --> b["B"]\n  hub --> c["C"]';
		let tmpScene = libFlowGraph.toScene({ type: 'flowgraph', mermaid: tmpSrc }, Profile, null);
		Expect(tmpScene.type).to.equal('excalidraw');
		let tmpRects = tmpScene.elements.filter((e) => e.type === 'rectangle');
		Expect(tmpRects.length).to.equal(4);            // hub + a + b + c
		// Every node box gets a positioned, non-overlapping x (dagre ran).
		let tmpXs = tmpRects.map((r) => r.x);
		Expect(Math.max.apply(null, tmpXs)).to.be.greaterThan(Math.min.apply(null, tmpXs));
	});

	test('draws a dashed frame (+ label) for a subgraph', function ()
	{
		let tmpSrc = 'graph TB\n  subgraph Box["Group"]\n    a["A"]\n    b["B"]\n  end\n  a --> out["Out"]';
		let tmpScene = libFlowGraph.toScene({ type: 'flowgraph', mermaid: tmpSrc }, Profile, null);
		let tmpFrame = tmpScene.elements.find((e) => e.id === 'cluster-Box' && e.type === 'rectangle');
		Expect(tmpFrame).to.not.equal(undefined);
		Expect(tmpFrame.strokeStyle).to.equal('dashed');
		let tmpLabel = tmpScene.elements.find((e) => e.id === 'cluster-label-Box');
		Expect(tmpLabel.text).to.equal('Group');
	});

	test('produces nested frames for nested subgraphs', function ()
	{
		let tmpSrc = 'graph TB\n' +
			'  subgraph Outer["Outer"]\n    subgraph Inner["Inner"]\n      x["X"]\n    end\n  end';
		let tmpScene = libFlowGraph.toScene({ type: 'flowgraph', mermaid: tmpSrc }, Profile, null);
		let tmpOuter = tmpScene.elements.find((e) => e.id === 'cluster-Outer');
		let tmpInner = tmpScene.elements.find((e) => e.id === 'cluster-Inner');
		Expect(tmpOuter).to.not.equal(undefined);
		Expect(tmpInner).to.not.equal(undefined);
		// Outer fully encloses Inner.
		Expect(tmpOuter.x).to.be.at.most(tmpInner.x);
		Expect(tmpOuter.y).to.be.at.most(tmpInner.y);
		Expect(tmpOuter.x + tmpOuter.width).to.be.at.least(tmpInner.x + tmpInner.width);
	});

	test('splits a heading from detail (title hierarchy) on a multi-line label', function ()
	{
		let tmpSrc = 'graph LR\n  a["Fable-Settings<br/>.settings"] --> b["B"]';
		let tmpScene = libFlowGraph.toScene({ type: 'flowgraph', mermaid: tmpSrc }, Profile, null);
		let tmpTitle = tmpScene.elements.find((e) => e.type === 'text' && e.text === 'Fable-Settings');
		let tmpDetail = tmpScene.elements.find((e) => e.type === 'text' && e.text === '.settings');
		Expect(tmpTitle).to.not.equal(undefined);
		Expect(tmpDetail).to.not.equal(undefined);
		Expect(tmpTitle.fontSize).to.be.greaterThan(tmpDetail.fontSize);
	});
});
