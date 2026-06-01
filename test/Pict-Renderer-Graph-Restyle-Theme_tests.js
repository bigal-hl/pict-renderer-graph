/*
	Unit tests for the two pure helpers that give mermaid (and any imported)
	scenes the themed, hand-drawn, theme-adaptive look:

	  - Pict-Renderer-Graph-Restyle.js  (restyleElements)
	  - Pict-Renderer-Graph-Theme-SVG.js (themeifySVG)

	Both are deterministic string/object transforms with no browser, so these
	run fast and need no Chromium.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const { restyleElements, seedFor } = require('../source/Pict-Renderer-Graph-Restyle.js');
const { themeifySVG } = require('../source/Pict-Renderer-Graph-Theme-SVG.js');
const Profile = require('pict-section-excalidraw/source/style-profiles/Notebook-Default.js');

suite('PictRendererGraph — restyle (mermaid -> themed ink)', function ()
{
	test('preserves geometry while applying ink, roughness, stroke, seed to shapes', function ()
	{
		let tmpEls =
		[
			{ id: 'n1', type: 'rectangle', x: 10, y: 20, width: 180, height: 80, strokeColor: '#333', backgroundColor: 'transparent', roughness: 0, strokeWidth: 1 }
		];
		restyleElements(tmpEls, Profile);
		Expect(tmpEls[0].x).to.equal(10);
		Expect(tmpEls[0].y).to.equal(20);
		Expect(tmpEls[0].width).to.equal(180);
		Expect(tmpEls[0].strokeColor).to.equal(Profile.Palette.ink);
		Expect(tmpEls[0].roughness).to.equal(Profile.Roughness);
		Expect(tmpEls[0].strokeWidth).to.equal(Profile.StrokeWidth);
		Expect(typeof tmpEls[0].seed).to.equal('number');
		Expect(tmpEls[0].backgroundColor).to.equal('transparent');
	});

	test('recolors a filled shape toward paper with a hachure fill', function ()
	{
		let tmpEls = [ { id: 'n2', type: 'rectangle', backgroundColor: '#ECECFF' } ];
		restyleElements(tmpEls, Profile);
		Expect(tmpEls[0].backgroundColor).to.equal(Profile.Palette.paper);
		Expect(tmpEls[0].fillStyle).to.equal(Profile.FillStyle);
	});

	test('text takes Excalifont + ink and keeps its mermaid font size', function ()
	{
		let tmpEls = [ { id: 't1', type: 'text', text: 'API', fontFamily: 1, fontSize: 16 } ];
		restyleElements(tmpEls, Profile);
		Expect(tmpEls[0].fontFamily).to.equal(5);           // Excalifont
		Expect(tmpEls[0].strokeColor).to.equal(Profile.Palette.ink);
		Expect(tmpEls[0].fontSize).to.equal(16);            // unchanged (avoids overflow)
	});

	test('edges take the link palette color', function ()
	{
		let tmpEls = [ { id: 'e1', type: 'arrow' }, { id: 'e2', type: 'line' } ];
		restyleElements(tmpEls, Profile);
		Expect(tmpEls[0].strokeColor).to.equal(Profile.Palette.link);
		Expect(tmpEls[1].strokeColor).to.equal(Profile.Palette.link);
	});

	test('seed is deterministic for the same key + profile', function ()
	{
		Expect(seedFor(Profile, 'shape:n1')).to.equal(seedFor(Profile, 'shape:n1'));
	});

	test('is a no-op without a profile', function ()
	{
		let tmpEls = [ { id: 'n', type: 'rectangle', strokeColor: '#abc' } ];
		restyleElements(tmpEls, null);
		Expect(tmpEls[0].strokeColor).to.equal('#abc');
	});
});

suite('PictRendererGraph — themeify (palette -> CSS variables)', function ()
{
	let _SVG =
		'<svg xmlns="http://www.w3.org/2000/svg">' +
		'<metadata><pict-renderer-graph:source><![CDATA[{"strokeColor":"#1B1F23","fill":"#FBF7EE"}]]></pict-renderer-graph:source></metadata>' +
		'<path stroke="#1B1F23" fill="transparent" d="M0 0"/>' +
		'<path fill="#FBF7EE" stroke="#1B1F23" d="M1 1"/>' +
		'<text fill="#1B1F23">API</text>' +
		'<path stroke="#2E7D74" d="M2 2"/>' +
		'</svg>';

	test('rewrites drawing palette colors to var(--diagram-*, fallback)', function ()
	{
		let tmpOut = themeifySVG(_SVG, Profile);
		Expect(tmpOut).to.contain('stroke="var(--diagram-ink, #1B1F23)"');
		Expect(tmpOut).to.contain('fill="var(--diagram-paper, #FBF7EE)"');
		Expect(tmpOut).to.contain('stroke="var(--diagram-link, #2E7D74)"');
	});

	test('leaves the <metadata> scene + source block byte-intact', function ()
	{
		let tmpOut = themeifySVG(_SVG, Profile);
		let tmpMeta = tmpOut.match(/<metadata[\s\S]*?<\/metadata>/)[0];
		Expect(tmpMeta).to.contain('"strokeColor":"#1B1F23"');
		Expect(tmpMeta).to.not.contain('var(--diagram');
	});

	test('does not touch non-palette values like transparent', function ()
	{
		Expect(themeifySVG(_SVG, Profile)).to.contain('fill="transparent"');
	});

	test('is a no-op without a profile palette', function ()
	{
		Expect(themeifySVG(_SVG, {})).to.equal(_SVG);
	});
});
