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

	test('is a no-op when no layout hints are present', function ()
	{
		Expect(applyLayoutHints(_Src, {}).mermaid).to.equal(_Src);
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
});
