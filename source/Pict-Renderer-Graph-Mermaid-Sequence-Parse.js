/**
 * Pict-Renderer-Graph-Mermaid-Sequence-Parse.js
 *
 * Parser for the mermaid SEQUENCE DIAGRAM subset the docs use -- participants
 * (with `as` aliases), the message arrow family, self-messages, notes
 * (right of / left of / over, single + spanning), and the block constructs
 * loop / alt+else / opt / par+and / critical / break (nestable). Turns the
 * text into an ordered participant + event model the native sequence renderer
 * lays out, so sequence diagrams render through code we own rather than
 * mermaid-to-excalidraw.
 *
 * Output:
 *   {
 *     title?: string,
 *     participants: [ { id, label } ],          // in first-seen order
 *     events: [
 *       { kind:'message', from, to, msgKind:'sync'|'async'|'return', dashed, self, text },
 *       { kind:'note', placement:'over'|'rightof'|'leftof', actors:[id,...], text },
 *       { kind:'block', op:'loop'|'alt'|'opt'|'par'|'critical'|'break', label },
 *       { kind:'else', label },                 // divider inside alt / par / critical
 *       { kind:'end' }
 *     ]
 *   }
 */

// Message arrow operators, longest first. Each maps to a draw style.
//   ->>  sync (solid, filled head)      -->>  return (dashed, filled head)
//   ->   sync (solid, filled head)      -->   return (dashed, filled head)
//   -)   async (solid, open head)       --)   async (dashed, open head)
//   -x   sync  (solid, filled head)     --x   sync  (dashed, filled head)
const _Arrows =
[
	{ op: '-->>', dashed: true,  msgKind: 'return' },
	{ op: '->>',  dashed: false, msgKind: 'sync'   },
	{ op: '--)',  dashed: true,  msgKind: 'async'  },
	{ op: '-)',   dashed: false, msgKind: 'async'  },
	{ op: '--x',  dashed: true,  msgKind: 'sync'   },
	{ op: '-x',   dashed: false, msgKind: 'sync'   },
	{ op: '-->',  dashed: true,  msgKind: 'return' },
	{ op: '->',   dashed: false, msgKind: 'sync'   }
];

const _BlockOps = { loop: 1, alt: 1, opt: 1, par: 1, critical: 1, break: 1, rect: 1 };

function parseMermaidSequence(pSource)
{
	let tmpLines = String(pSource == null ? '' : pSource).split('\n');

	let tmpTitle = null;
	let tmpParticipants = {};
	let tmpOrder = [];
	let tmpEvents = [];

	let tmpDeclare = (pId, pLabel) =>
	{
		let tmpId = String(pId).trim();
		if (!tmpId) { return; }
		if (!tmpParticipants[tmpId])
		{
			tmpParticipants[tmpId] = { id: tmpId, label: (pLabel != null && String(pLabel).trim()) ? String(pLabel).trim() : tmpId };
			tmpOrder.push(tmpId);
		}
		else if (pLabel != null && String(pLabel).trim())
		{
			tmpParticipants[tmpId].label = String(pLabel).trim();
		}
	};

	for (let l = 0; l < tmpLines.length; l++)
	{
		let tmpLine = tmpLines[l].trim();
		if (!tmpLine || tmpLine.slice(0, 2) === '%%') { continue; }
		if (/^sequenceDiagram\b/i.test(tmpLine)) { continue; }
		if (/^autonumber\b/i.test(tmpLine)) { continue; }

		let tmpTitleM = tmpLine.match(/^title\s+(.+)$/i);
		if (tmpTitleM) { tmpTitle = tmpTitleM[1].trim(); continue; }

		// participant X as Label  /  participant X  (actor is the same to us)
		let tmpPart = tmpLine.match(/^(?:participant|actor)\s+(.+)$/i);
		if (tmpPart)
		{
			let tmpAs = tmpPart[1].match(/^(.+?)\s+as\s+(.+)$/i);
			if (tmpAs) { tmpDeclare(tmpAs[1].trim(), tmpAs[2].trim()); }
			else { tmpDeclare(tmpPart[1].trim(), null); }
			continue;
		}

		// activate / deactivate -- we don't draw activation bars yet; skip.
		if (/^(?:activate|deactivate)\b/i.test(tmpLine)) { continue; }

		// Notes: Note right of X: t | Note left of X: t | Note over X: t | Note over X,Y: t
		let tmpNote = tmpLine.match(/^note\s+(right of|left of|over)\s+([^:]+):\s*(.*)$/i);
		if (tmpNote)
		{
			let tmpPlacement = tmpNote[1].toLowerCase().replace(/\s+/g, '');   // rightof | leftof | over
			let tmpActors = tmpNote[2].split(',').map((s) => s.trim()).filter((s) => s.length);
			for (let a = 0; a < tmpActors.length; a++) { tmpDeclare(tmpActors[a], null); }
			tmpEvents.push({ kind: 'note', placement: tmpPlacement, actors: tmpActors, text: tmpNote[3].trim() });
			continue;
		}

		// Block close.
		if (/^end\b/i.test(tmpLine)) { tmpEvents.push({ kind: 'end' }); continue; }

		// Block divider (alt/par/critical): else / and / option.
		let tmpElse = tmpLine.match(/^(?:else|and|option)\b\s*(.*)$/i);
		if (tmpElse) { tmpEvents.push({ kind: 'else', label: (tmpElse[1] || '').trim() }); continue; }

		// Block open: loop / alt / opt / par / critical / break / rect <label>
		let tmpBlock = tmpLine.match(/^([A-Za-z]+)\b\s*(.*)$/);
		if (tmpBlock && _BlockOps[tmpBlock[1].toLowerCase()])
		{
			tmpEvents.push({ kind: 'block', op: tmpBlock[1].toLowerCase(), label: (tmpBlock[2] || '').trim() });
			continue;
		}

		// Message: FROM <arrow> TO : text
		let tmpMsg = _parseMessage(tmpLine);
		if (tmpMsg)
		{
			tmpDeclare(tmpMsg.from, null);
			tmpDeclare(tmpMsg.to, null);
			tmpEvents.push(Object.assign({ kind: 'message', self: tmpMsg.from === tmpMsg.to }, tmpMsg));
			continue;
		}
		// Unrecognized line -- ignore (keeps the parser forgiving).
	}

	return {
		title:        tmpTitle,
		participants: tmpOrder.map((pId) => tmpParticipants[pId]),
		events:       tmpEvents
	};
}

function _parseMessage(pLine)
{
	for (let i = 0; i < _Arrows.length; i++)
	{
		let tmpArrow = _Arrows[i];
		let tmpIdx = pLine.indexOf(tmpArrow.op);
		if (tmpIdx < 0) { continue; }
		let tmpLeft  = pLine.slice(0, tmpIdx).trim();
		let tmpRight = pLine.slice(tmpIdx + tmpArrow.op.length);
		// Left must look like a participant id (no spaces/colons in the id part).
		if (!/^[A-Za-z0-9_]+$/.test(tmpLeft)) { continue; }
		let tmpColon = tmpRight.indexOf(':');
		let tmpTo   = (tmpColon >= 0 ? tmpRight.slice(0, tmpColon) : tmpRight).trim();
		let tmpText = (tmpColon >= 0 ? tmpRight.slice(tmpColon + 1) : '').trim();
		// Strip mermaid activation markers (+/-) on the target.
		tmpTo = tmpTo.replace(/^[+-]/, '').trim();
		if (!/^[A-Za-z0-9_]+$/.test(tmpTo)) { continue; }
		return { from: tmpLeft, to: tmpTo, dashed: tmpArrow.dashed, msgKind: tmpArrow.msgKind, text: tmpText };
	}
	return null;
}

module.exports =
{
	parseMermaidSequence: parseMermaidSequence
};
