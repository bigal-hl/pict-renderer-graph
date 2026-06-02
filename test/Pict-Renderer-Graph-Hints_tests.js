/*
	Unit tests for the layout-intent hint translation:
	  - applyLayoutHints   (rewrite the mermaid source: direction, engine,
	                        spacing, clusters -> subgraphs, order -> edges)
	  - applyClusterStyling (post-layout: quiet visible cluster frames, strip
	                        invisible ones)
	Pure transforms; no browser.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const { applyLayoutHints, applyClusterStyling } = require('../source/Pict-Renderer-Graph-Hints.js');
const Profile = require('pict-section-excalidraw/source/style-profiles/Notebook-Default.js');

suite('PictRendererGraph — layout hints (mermaid rewriting)', function ()
{
	let _Src = 'graph TB\n  a[Alpha] --> b[Beta]\n  b --> c[Gamma]';

	test('rewrites the graph direction', function ()
	{
		Expect(applyLayoutHints(_Src, { direction: 'LR' }).mermaid).to.contain('graph LR');
	});

	test('emits an init directive for spacing + engine', function ()
	{
		let tmpMermaid = applyLayoutHints(_Src, { spacing: { node: 60, rank: 100 }, engine: 'elk' }).mermaid;
		Expect(tmpMermaid).to.contain('"nodeSpacing":60');
		Expect(tmpMermaid).to.contain('"rankSpacing":100');
		Expect(tmpMermaid).to.contain('"defaultRenderer":"elk"');
	});

	test('clusters become subgraph blocks with metadata', function ()
	{
		let tmpOut = applyLayoutHints(_Src, { clusters:
		[
			{ id: 'g', label: 'Group One', nodes: [ 'a', 'b' ], visible: true },
			{ id: 'h', nodes: [ 'c' ], visible: false }
		] });
		Expect(tmpOut.mermaid).to.contain('subgraph g["Group One"]');
		Expect(tmpOut.mermaid).to.contain('subgraph h["h"]');
		Expect(tmpOut.clusters).to.have.length(2);
		Expect(tmpOut.clusters[0].visible).to.equal(true);
		Expect(tmpOut.clusters[1].visible).to.equal(false);
	});

	test('order becomes invisible ordering edges', function ()
	{
		Expect(applyLayoutHints(_Src, { order: [ [ 'a', 'b', 'c' ] ] }).mermaid).to.contain('a ~~~ b ~~~ c');
	});

	test('always sets a generous wrapping width, even with no other hints', function ()
	{
		let tmpOut = applyLayoutHints(_Src, {}).mermaid;
		Expect(tmpOut).to.contain('"wrappingWidth"');   // keeps long labels on one line
		Expect(tmpOut).to.contain(_Src);                // original source preserved
	});
});

suite('PictRendererGraph — cluster styling (post-layout)', function ()
{
	// Mirrors the subgraph shape: a frame rectangle + a label text whose
	// containerId points back to the frame, plus a member node.
	function makeScene()
	{
		return [
			{ id: 'frameV', type: 'rectangle', strokeColor: '#1B1F23', strokeStyle: 'solid' },
			{ id: 'lblV',   type: 'text', text: 'Group One', containerId: 'frameV', strokeColor: '#1B1F23' },
			{ id: 'frameH', type: 'rectangle', strokeColor: '#1B1F23' },
			{ id: 'lblH',   type: 'text', text: 'hidden', containerId: 'frameH', strokeColor: '#1B1F23' },
			{ id: 'node',   type: 'rectangle', strokeColor: '#1B1F23' }
		];
	}

	test('a visible cluster frame becomes a dashed deemphasis outline', function ()
	{
		let tmpEls = makeScene();
		applyClusterStyling(tmpEls, [ { id: 'g', label: 'Group One', visible: true } ], Profile);
		let tmpFrame = tmpEls.find((e) => e.id === 'frameV');
		Expect(tmpFrame.strokeColor).to.equal(Profile.Palette.deemphasis);
		Expect(tmpFrame.strokeStyle).to.equal('dashed');
	});

	test('an invisible cluster has its frame + label removed, members kept', function ()
	{
		let tmpEls = makeScene();
		let tmpOut = applyClusterStyling(tmpEls, [ { id: 'h', label: 'hidden', visible: false } ], Profile);
		Expect(tmpOut.find((e) => e.id === 'frameH')).to.equal(undefined);
		Expect(tmpOut.find((e) => e.id === 'lblH')).to.equal(undefined);
		Expect(tmpOut.find((e) => e.id === 'node')).to.not.equal(undefined);
	});

	test('softens a native subgraph frame (a rectangle enclosing >= 2 others)', function ()
	{
		// No hint clusters -- exercise only the geometric native-frame pass.
		let tmpEls =
		[
			{ id: 'frame', type: 'rectangle', x: 0,  y: 0,   width: 300, height: 200, strokeColor: '#1B1F23', strokeStyle: 'solid' },
			{ id: 'n1',    type: 'rectangle', x: 20, y: 20,  width: 80,  height: 50,  strokeColor: '#1B1F23' },
			{ id: 'n2',    type: 'rectangle', x: 20, y: 100, width: 80,  height: 50,  strokeColor: '#1B1F23' }
		];
		applyClusterStyling(tmpEls, [], Profile);
		let tmpFrame = tmpEls.find((e) => e.id === 'frame');
		Expect(tmpFrame.strokeColor).to.equal(Profile.Palette.deemphasis);
		Expect(tmpFrame.strokeStyle).to.equal('dashed');
		Expect(tmpEls.find((e) => e.id === 'n1').strokeStyle).to.not.equal('dashed');
	});
});
