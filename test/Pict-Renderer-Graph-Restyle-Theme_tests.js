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

const { restyleElements, seedFor, applyEmphasis, buildIdLabelMap, reflowText, rerouteArrows, splitTitleLines } = require('../source/Pict-Renderer-Graph-Restyle.js');
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

	test('text takes Excalifont + ink and is scaled down to fit the box', function ()
	{
		let tmpEls = [ { id: 't1', type: 'text', text: 'API', fontFamily: 1, fontSize: 16 } ];
		restyleElements(tmpEls, Profile);
		Expect(tmpEls[0].fontFamily).to.equal(5);           // Excalifont
		Expect(tmpEls[0].strokeColor).to.equal(Profile.Palette.ink);
		Expect(tmpEls[0].fontSize).to.equal(13);            // 16 * 0.8, rounded -- fits the mermaid box
	});

	test('edges take the link palette color and render without wobble', function ()
	{
		let tmpEls = [ { id: 'e1', type: 'arrow' }, { id: 'e2', type: 'line' } ];
		restyleElements(tmpEls, Profile);
		Expect(tmpEls[0].strokeColor).to.equal(Profile.Palette.link);
		Expect(tmpEls[1].strokeColor).to.equal(Profile.Palette.link);
		Expect(tmpEls[0].roughness).to.equal(0);
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

suite('PictRendererGraph — emphasis hints', function ()
{
	let _Mermaid = 'graph LR\n  user[User] --> api[API Gateway] --> db[(Database)]';

	// Mirrors mermaid-to-excalidraw output: shapes with generated ids, text
	// elements carrying the label + a containerId back to their shape.
	function makeScene()
	{
		return [
			{ id: 's_db',  type: 'rectangle', strokeColor: '#1B1F23', strokeWidth: 2 },
			{ id: 't_db',  type: 'text', text: 'Database',    containerId: 's_db',  strokeColor: '#1B1F23' },
			{ id: 's_api', type: 'rectangle', strokeColor: '#1B1F23', strokeWidth: 2 },
			{ id: 't_api', type: 'text', text: 'API Gateway', containerId: 's_api', strokeColor: '#1B1F23' }
		];
	}

	test('buildIdLabelMap parses node ids to their labels', function ()
	{
		let tmpMap = buildIdLabelMap(_Mermaid);
		Expect(tmpMap.user).to.equal('User');
		Expect(tmpMap.api).to.equal('API Gateway');
		Expect(tmpMap.db).to.equal('Database');
	});

	test('buildIdLabelMap keeps the full quoted label even with parentheses/br inside', function ()
	{
		let tmpMap = buildIdLabelMap('graph TB\n  L1["Layer 1 - Fable (Core Ecosystem)<br/>DI, config"]');
		Expect(tmpMap.L1).to.equal('Layer 1 - Fable (Core Ecosystem)<br/>DI, config');
	});

	test('emphasis matches a multi-line, parenthesized label through tag/whitespace normalization', function ()
	{
		let tmpMermaid = 'graph TB\n  L1["Layer 1 - Fable (Core Ecosystem)<br/>DI, config"]';
		let tmpEls =
		[
			{ id: 's_l1', type: 'rectangle', strokeColor: '#1B1F23', strokeWidth: 2 },
			// the rendered text has the <br/> turned into a newline
			{ id: 't_l1', type: 'text', text: 'Layer 1 - Fable (Core Ecosystem)\nDI, config', containerId: 's_l1', strokeColor: '#1B1F23' }
		];
		applyEmphasis(tmpEls, [ { node: 'L1', accent: true } ], tmpMermaid, Profile);
		Expect(tmpEls.find((e) => e.id === 't_l1').strokeColor).to.equal(Profile.Palette.accent);
	});

	test('accent + bold by node id colors text + shape and thickens the shape', function ()
	{
		let tmpEls = makeScene();
		applyEmphasis(tmpEls, [ { node: 'db', accent: true, bold: true } ], _Mermaid, Profile);
		Expect(tmpEls.find((e) => e.id === 't_db').strokeColor).to.equal(Profile.Palette.accent);
		Expect(tmpEls.find((e) => e.id === 's_db').strokeColor).to.equal(Profile.Palette.accent);
		Expect(tmpEls.find((e) => e.id === 's_db').strokeWidth).to.be.greaterThan(2);
	});

	test('dim referenced by label uses the deemphasis palette', function ()
	{
		let tmpEls = makeScene();
		applyEmphasis(tmpEls, [ { node: 'API Gateway', dim: true } ], _Mermaid, Profile);
		Expect(tmpEls.find((e) => e.id === 't_api').strokeColor).to.equal(Profile.Palette.deemphasis);
	});

	test('leaves unreferenced nodes and empty hint lists untouched', function ()
	{
		let tmpEls = makeScene();
		applyEmphasis(tmpEls, [ { node: 'db', accent: true } ], _Mermaid, Profile);
		Expect(tmpEls.find((e) => e.id === 't_api').strokeColor).to.equal('#1B1F23');
		let tmpEls2 = makeScene();
		applyEmphasis(tmpEls2, [], _Mermaid, Profile);
		Expect(tmpEls2.find((e) => e.id === 't_db').strokeColor).to.equal('#1B1F23');
	});
});

suite('PictRendererGraph — text re-flow (repair mermaid wrap)', function ()
{
	test('rewraps a stranded-token label greedily, preserving the <br/> title break', function ()
	{
		// mermaid-to-excalidraw's broken output strands "DI," on its own line.
		let tmpEls = [ { id: 't1', type: 'text', text: 'Layer 1 - Fable (Core Ecosystem)\nDI,\nconfiguration, logging, UUID, expressions' } ];
		let tmpMermaid = 'graph TB\n  L1["Layer 1 - Fable (Core Ecosystem)<br/>DI, configuration, logging, UUID, expressions"]';
		reflowText(tmpEls, tmpMermaid);
		let tmpLines = tmpEls[0].text.split('\n');
		Expect(tmpLines[0]).to.equal('Layer 1 - Fable (Core Ecosystem)');   // <br/> title break kept
		Expect(tmpLines.indexOf('DI,')).to.equal(-1);                       // no stranded token
		Expect(tmpEls[0].text).to.contain('DI, configuration');             // greedy: joined with next words
		Expect(tmpLines.length).to.be.at.most(3);                           // fits the box (no extra lines)
	});

	test('repairs a character-broken hyphenated label split mid-token', function ()
	{
		// mermaid-to-excalidraw ignores the <br/> and character-wraps both the
		// hyphenated module name and the method, stranding fragments mid-token:
		// "Fable-" / "Settings" / ".settin" / "gs". The whitespace-insensitive
		// match must still recognize it and restore the two intended lines.
		let tmpEls = [ { id: 't1', type: 'text', text: 'Fable-\nSettings\n.settin\ngs' } ];
		reflowText(tmpEls, 'graph TB\n  settings["Fable-Settings<br/>.settings"]');
		Expect(tmpEls[0].text).to.equal('Fable-Settings\n.settings');
	});

	test('keeps a short hyphenated label + method cohesive (Fable-Log / .log)', function ()
	{
		let tmpEls = [ { id: 't1', type: 'text', text: 'Fable-\nLog\n.log' } ];
		reflowText(tmpEls, 'graph TB\n  flog["Fable-Log<br/>.log"]');
		Expect(tmpEls[0].text).to.equal('Fable-Log\n.log');
	});

	test('leaves text it cannot match to a label alone', function ()
	{
		let tmpEls = [ { id: 't1', type: 'text', text: 'Totally unrelated text' } ];
		reflowText(tmpEls, 'graph TB\n  A["Something else"]');
		Expect(tmpEls[0].text).to.equal('Totally unrelated text');
	});
});

suite('PictRendererGraph — arrow re-routing (perpendicular landings)', function ()
{
	// Two boxes side by side (A on the left, B on the right) and a connector
	// that mermaid drew as a straight 2-point line A.right -> B.left.
	function makeHorizontalScene()
	{
		return [
			{ id: 's_a', type: 'rectangle', x: 0,   y: 0, width: 100, height: 60 },
			{ id: 's_b', type: 'rectangle', x: 200, y: 0, width: 100, height: 60 },
			{
				id: 'e1', type: 'arrow', x: 100, y: 30,
				points: [ [ 0, 0 ], [ 100, 0 ] ],
				startBinding: { elementId: 's_a' }, endBinding: { elementId: 's_b' }
			}
		];
	}

	test('adds a perpendicular departure + approach stub (sampled curve, square landing)', function ()
	{
		let tmpEls = makeHorizontalScene();
		rerouteArrows(tmpEls, null);
		let tmpArrow = tmpEls.find((e) => e.id === 'e1');
		let tmpN = tmpArrow.points.length;
		// Re-routed into a densely-sampled curve, not a 2-point straight line.
		Expect(tmpN).to.be.above(4);
		// First waypoint is the (unchanged) start anchor.
		Expect(tmpArrow.points[0][0]).to.equal(0);
		Expect(tmpArrow.points[0][1]).to.equal(0);
		// Departure leaves A's right edge horizontally (x grows, y flat).
		Expect(tmpArrow.points[1][0]).to.be.greaterThan(0);
		Expect(tmpArrow.points[1][1]).to.equal(0);
		// Approach reaches B's left edge horizontally -- last segment is flat in
		// y, so the arrowhead meets the vertical edge square-on (no swoop).
		Expect(tmpArrow.points[tmpN - 1][1]).to.equal(tmpArrow.points[tmpN - 2][1]);
		// End anchor lands at B's left-edge midpoint (abs 200,30 -> rel 100,0).
		Expect(tmpArrow.points[tmpN - 1][0]).to.equal(100);
		Expect(tmpArrow.points[tmpN - 1][1]).to.equal(0);
	});

	test('emits the connector as a straight-sampled polyline (no Catmull-Rom rounding)', function ()
	{
		// The sampled points already trace the bezier; rounding them would
		// re-introduce the tangent overshoot the bezier control points avoid.
		let tmpEls = makeHorizontalScene();
		rerouteArrows(tmpEls, null);
		Expect(tmpEls.find((e) => e.id === 'e1').roundness).to.equal(null);
	});

	test('lands perpendicular on a top edge for a vertical (stacked) connector', function ()
	{
		let tmpEls = [
			{ id: 's_a', type: 'rectangle', x: 0, y: 0,   width: 100, height: 60 },
			{ id: 's_b', type: 'rectangle', x: 0, y: 200, width: 100, height: 60 },
			{
				id: 'e1', type: 'arrow', x: 50, y: 60,
				points: [ [ 0, 0 ], [ 0, 140 ] ],
				startBinding: { elementId: 's_a' }, endBinding: { elementId: 's_b' }
			}
		];
		rerouteArrows(tmpEls, null);
		let tmpArrow = tmpEls.find((e) => e.id === 'e1');
		let tmpN = tmpArrow.points.length;
		// Last segment is flat in x (vertical), so it meets B's top edge square-on.
		Expect(tmpArrow.points[tmpN - 1][0]).to.equal(tmpArrow.points[tmpN - 2][0]);
		// ...and continues downward into the edge (end is below the approach).
		Expect(tmpArrow.points[tmpN - 1][1]).to.be.greaterThan(tmpArrow.points[tmpN - 2][1]);
	});

	test('two connectors converging on one edge land at DISTINCT points (no crossing)', function ()
	{
		// The layer4 case: two boxes above, both pointing down into one box below.
		// Each arrival must get its own slot across the target's top edge, ordered
		// by the source's x, so the curves never cross to reach a shared midpoint.
		// Sources overlap the target horizontally (so it's "below", not "off to one
		// side") -- exactly how restify/static sit above core in layer4.
		let tmpEls = [
			{ id: 'left',   type: 'rectangle', x: 160, y: 0,   width: 120, height: 60 },
			{ id: 'right',  type: 'rectangle', x: 300, y: 0,   width: 120, height: 60 },
			{ id: 'target', type: 'rectangle', x: 150, y: 250, width: 220, height: 80 },
			{ id: 'eL', type: 'arrow', x: 0, y: 0, points: [ [ 0, 0 ], [ 1, 1 ] ], startBinding: { elementId: 'left' },  endBinding: { elementId: 'target' } },
			{ id: 'eR', type: 'arrow', x: 0, y: 0, points: [ [ 0, 0 ], [ 1, 1 ] ], startBinding: { elementId: 'right' }, endBinding: { elementId: 'target' } }
		];
		rerouteArrows(tmpEls, null);
		let tmpL = tmpEls.find((e) => e.id === 'eL');
		let tmpR = tmpEls.find((e) => e.id === 'eR');
		let tmpLEndX = tmpL.x + tmpL.points[tmpL.points.length - 1][0];
		let tmpREndX = tmpR.x + tmpR.points[tmpR.points.length - 1][0];
		// Distinct landings...
		Expect(tmpLEndX).to.not.equal(tmpREndX);
		// ...and the left source lands left of the right source (no swap/cross).
		Expect(tmpLEndX).to.be.lessThan(tmpREndX);
		// Both still on the target's top edge (y = target.y = 250).
		Expect(tmpL.y + tmpL.points[tmpL.points.length - 1][1]).to.equal(250);
		Expect(tmpR.y + tmpR.points[tmpR.points.length - 1][1]).to.equal(250);
	});

	test('leaves an unbound connector untouched', function ()
	{
		let tmpEls = [
			{ id: 'e1', type: 'arrow', x: 0, y: 0, points: [ [ 0, 0 ], [ 50, 20 ], [ 100, 0 ] ] }
		];
		rerouteArrows(tmpEls, null);
		Expect(tmpEls[0].points.length).to.equal(3);
	});

	test('departs from the edge facing the target, not mermaid\'s attachment side', function ()
	{
		// mermaid attached the start to box A's TOP edge (a hub fanning out),
		// but the target sits off to the right -- so the connector must depart
		// from A's RIGHT edge midpoint and run rightward, not upward.
		let tmpEls = [
			{ id: 'a', type: 'rectangle', x: 0,   y: 0,   width: 100, height: 60 },
			{ id: 'b', type: 'rectangle', x: 400, y: -40, width: 100, height: 60 },
			{
				id: 'e', type: 'arrow', x: 50, y: 0,
				points: [ [ 0, 0 ], [ 400, -10 ] ],         // mermaid drew it from A's top
				startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }
			}
		];
		rerouteArrows(tmpEls, null);
		let tmpArrow = tmpEls.find((e) => e.id === 'e');
		// Anchored at A's right-edge midpoint (100, 30), not the top (50, 0).
		Expect(tmpArrow.x).to.equal(100);
		Expect(tmpArrow.y).to.equal(30);
		// First hop runs right (perpendicular to the right edge): +x, flat y.
		Expect(tmpArrow.points[1][0]).to.be.greaterThan(0);
		Expect(tmpArrow.points[1][1]).to.equal(0);
	});

	test('attaches to top/bottom only when the target is clearly above/below', function ()
	{
		// Target almost directly below (dy dominates dx) -> vertical attach.
		let tmpEls = [
			{ id: 'a', type: 'rectangle', x: 0,  y: 0,   width: 100, height: 60 },
			{ id: 'b', type: 'rectangle', x: 20, y: 300, width: 100, height: 60 },
			{ id: 'e', type: 'arrow', x: 50, y: 60, points: [ [ 0, 0 ], [ 20, 240 ] ], startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } }
		];
		rerouteArrows(tmpEls, null);
		let tmpArrow = tmpEls.find((e) => e.id === 'e');
		// Departs A's bottom-edge midpoint (50, 60) heading straight down.
		Expect(tmpArrow.x).to.equal(50);
		Expect(tmpArrow.y).to.equal(60);
		Expect(tmpArrow.points[1][0]).to.equal(0);            // flat x
		Expect(tmpArrow.points[1][1]).to.be.greaterThan(0);   // +y (downward)
	});
});

suite('PictRendererGraph — title hierarchy (split heading from detail)', function ()
{
	// A box label bound to its container, the way mermaid-to-excalidraw emits it.
	function makeLabel(pText)
	{
		return [
			{ id: 's1', type: 'rectangle', x: 0, y: 0, width: 200, height: 100, boundElements: [ { type: 'text', id: 't1' }, { type: 'arrow', id: 'a1' } ] },
			{ id: 't1', type: 'text', text: pText, containerId: 's1', fontSize: 16, lineHeight: 1.25, strokeColor: '#1B1F23', textAlign: 'center', verticalAlign: 'middle', x: 20, y: 30, width: 160, height: 40 }
		];
	}

	test('promotes a two-segment title to a full-size element above smaller detail', function ()
	{
		let tmpMermaid = 'graph TB\n  s["Fable-Settings<br/>.settings"]';
		let tmpEls = makeLabel('Fable-Settings\n.settings');
		splitTitleLines(tmpEls, tmpMermaid, Profile);
		let tmpTitle  = tmpEls.find((e) => e.id === 't1_title');
		let tmpDetail = tmpEls.find((e) => e.id === 't1');
		Expect(tmpTitle).to.not.equal(undefined);
		Expect(tmpTitle.text).to.equal('Fable-Settings');
		Expect(tmpDetail.text).to.equal('.settings');
		Expect(tmpTitle.fontSize).to.be.greaterThan(tmpDetail.fontSize);   // title larger
		Expect(tmpTitle.y).to.be.lessThan(tmpDetail.y);                    // title sits above
		Expect(tmpTitle.containerId).to.equal(null);                       // unbound (centered manually)
		Expect(tmpDetail.containerId).to.equal(null);
	});

	test('drops only the text binding from the container, keeping arrow bindings', function ()
	{
		let tmpEls = makeLabel('Fable-Log\n.log');
		splitTitleLines(tmpEls, 'graph TB\n  s["Fable-Log<br/>.log"]', Profile);
		let tmpBox = tmpEls.find((e) => e.id === 's1');
		Expect(tmpBox.boundElements.some((b) => b.type === 'text')).to.equal(false);
		Expect(tmpBox.boundElements.some((b) => b.type === 'arrow')).to.equal(true);
	});

	test('treats a short first segment in a 3-part label as a title (FoxHound)', function ()
	{
		let tmpMermaid = 'graph TB\n  s["FoxHound<br/>(Query DSL)<br/>.addFilter()"]';
		let tmpEls = makeLabel('FoxHound\n(Query DSL)\n.addFilter()');
		splitTitleLines(tmpEls, tmpMermaid, Profile);
		Expect(tmpEls.find((e) => e.id === 't1_title').text).to.equal('FoxHound');
		Expect(tmpEls.find((e) => e.id === 't1').text).to.equal('(Query DSL)\n.addFilter()');
	});

	test('leaves a co-equal bullet list (long first segment) as one block', function ()
	{
		let tmpMermaid = 'graph TB\n  b["Behavior injection hooks<br/>Dynamic filtering<br/>Bulk operations"]';
		let tmpEls = makeLabel('Behavior injection hooks\nDynamic filtering\nBulk operations');
		splitTitleLines(tmpEls, tmpMermaid, Profile);
		Expect(tmpEls.find((e) => e.id === 't1_title')).to.equal(undefined);
		Expect(tmpEls.filter((e) => e.type === 'text').length).to.equal(1);
	});

	test('promoted title inherits the (accented) detail stroke color', function ()
	{
		let tmpMermaid = 'graph TB\n  s["FoxHound<br/>(Query DSL)<br/>.addFilter()"]';
		let tmpEls = makeLabel('FoxHound\n(Query DSL)\n.addFilter()');
		tmpEls.find((e) => e.id === 't1').strokeColor = '#C9602F';   // emphasis ran first
		splitTitleLines(tmpEls, tmpMermaid, Profile);
		Expect(tmpEls.find((e) => e.id === 't1_title').strokeColor).to.equal('#C9602F');
	});

	test('leaves a single-line label bound and unsplit', function ()
	{
		let tmpEls = makeLabel('Service Provider Base');
		splitTitleLines(tmpEls, 'graph TB\n  s["Service Provider Base"]', Profile);
		Expect(tmpEls.find((e) => e.id === 't1_title')).to.equal(undefined);
		Expect(tmpEls.find((e) => e.id === 't1').containerId).to.equal('s1');
	});
});
