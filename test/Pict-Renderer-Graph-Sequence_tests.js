/*
	Tests for the native sequence-diagram path:
	  - Pict-Renderer-Graph-Mermaid-Sequence-Parse.js  (mermaid -> model)
	  - diagrams/Diagram-SequenceGraph.js               (model -> scene)

	Both run in pure Node; the handler's toScene is synchronous.
*/

const Chai = require('chai');
const Expect = Chai.expect;

const { parseMermaidSequence } = require('../source/Pict-Renderer-Graph-Mermaid-Sequence-Parse.js');
const libSeq = require('../source/diagrams/Diagram-SequenceGraph.js');
const Profile = require('pict-section-excalidraw/source/style-profiles/Notebook-Default.js');

suite('PictRendererGraph — mermaid sequence parser', function ()
{
	test('reads participants (with `as` alias) and auto-declares from messages', function ()
	{
		let tmpModel = parseMermaidSequence('sequenceDiagram\n  participant A as Alice\n  A->>B: hi');
		Expect(tmpModel.participants.map((p) => p.id)).to.deep.equal([ 'A', 'B' ]);
		Expect(tmpModel.participants[0].label).to.equal('Alice');
		Expect(tmpModel.participants[1].label).to.equal('B');   // auto-declared, label = id
	});

	test('classifies message arrow kinds', function ()
	{
		let tmpModel = parseMermaidSequence('sequenceDiagram\n  A->>B: s\n  B-->>A: r\n  A-)B: a\n  A->B: p');
		let tmpMsgs = tmpModel.events.filter((e) => e.kind === 'message');
		Expect(tmpMsgs[0]).to.include({ msgKind: 'sync',   dashed: false });
		Expect(tmpMsgs[1]).to.include({ msgKind: 'return', dashed: true  });
		Expect(tmpMsgs[2]).to.include({ msgKind: 'async',  dashed: false });
		Expect(tmpMsgs[3]).to.include({ msgKind: 'sync',   dashed: false });
	});

	test('flags a self-message', function ()
	{
		let tmpModel = parseMermaidSequence('sequenceDiagram\n  D->>D: think');
		Expect(tmpModel.events[0]).to.include({ kind: 'message', self: true, from: 'D', to: 'D' });
	});

	test('parses notes (over, right of) and their actors', function ()
	{
		let tmpModel = parseMermaidSequence('sequenceDiagram\n  Note over A,B: spanning\n  Note right of A: side');
		let tmpNotes = tmpModel.events.filter((e) => e.kind === 'note');
		Expect(tmpNotes[0]).to.include({ placement: 'over', text: 'spanning' });
		Expect(tmpNotes[0].actors).to.deep.equal([ 'A', 'B' ]);
		Expect(tmpNotes[1]).to.include({ placement: 'rightof', text: 'side' });
	});

	test('emits ordered block / else / end events, including nesting', function ()
	{
		let tmpSrc = 'sequenceDiagram\n' +
			'  loop outer\n    loop inner\n      A->>B: x\n    end\n  end\n' +
			'  alt ok\n    A->>B: y\n  else no\n    A->>B: z\n  end';
		let tmpKinds = parseMermaidSequence(tmpSrc).events.map((e) => e.kind + (e.op ? ':' + e.op : ''));
		Expect(tmpKinds).to.deep.equal([
			'block:loop', 'block:loop', 'message', 'end', 'end',
			'block:alt', 'message', 'else', 'message', 'end'
		]);
	});
});

suite('PictRendererGraph — seqgraph handler (mermaid -> scene)', function ()
{
	test('builds an actor box + dashed lifeline per participant', function ()
	{
		let tmpScene = libSeq.toScene({ type: 'seqgraph', mermaid: 'sequenceDiagram\n  A->>B: hi\n  B-->>A: bye' }, Profile, null);
		let tmpActors = tmpScene.elements.filter((e) => e.type === 'rectangle' && /^seq-actor-/.test(e.id));
		let tmpLives  = tmpScene.elements.filter((e) => e.type === 'line' && /^seq-life-/.test(e.id));
		Expect(tmpActors.length).to.equal(2);
		Expect(tmpLives.length).to.equal(2);
		Expect(tmpLives[0].strokeStyle).to.equal('dashed');
	});

	test('draws a dashed labeled frame for a loop block', function ()
	{
		let tmpScene = libSeq.toScene({ type: 'seqgraph', mermaid: 'sequenceDiagram\n  loop every minute\n    A->>B: ping\n  end' }, Profile, null);
		let tmpFrame = tmpScene.elements.find((e) => e.type === 'rectangle' && /^seq-block-/.test(e.id));
		Expect(tmpFrame).to.not.equal(undefined);
		Expect(tmpFrame.strokeStyle).to.equal('dashed');
		let tmpTab = tmpScene.elements.find((e) => e.type === 'text' && /^seq-blocklabel-/.test(e.id));
		Expect(tmpTab.text).to.equal('loop [every minute]');
	});

	test('draws a self-message as a multi-point loop-back arrow', function ()
	{
		let tmpScene = libSeq.toScene({ type: 'seqgraph', mermaid: 'sequenceDiagram\n  D->>D: recurse' }, Profile, null);
		let tmpArrow = tmpScene.elements.find((e) => e.type === 'arrow' && /^seq-msg-/.test(e.id));
		Expect(tmpArrow.points.length).to.equal(4);            // out, down, back
		Expect(tmpArrow.endArrowhead).to.equal('triangle');
	});

	test('an else divider appears inside an alt frame', function ()
	{
		let tmpScene = libSeq.toScene({ type: 'seqgraph', mermaid: 'sequenceDiagram\n  alt ok\n    A->>B: y\n  else no\n    B->>A: z\n  end' }, Profile, null);
		let tmpDivider = tmpScene.elements.find((e) => e.type === 'line' && /^seq-divider-/.test(e.id));
		Expect(tmpDivider).to.not.equal(undefined);
		Expect(tmpDivider.strokeStyle).to.equal('dashed');
	});
});
