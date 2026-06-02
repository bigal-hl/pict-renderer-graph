/**
 * Diagram-SequenceGraph.js
 *
 * Native sequence-diagram path: parse mermaid `sequenceDiagram` syntax and emit
 * an Excalidraw scene directly -- participant lanes, dashed lifelines, messages
 * (sync / async / return, including self-messages), notes, and the block
 * constructs (loop / alt+else / opt / par+and / critical / break), drawn as
 * labeled dashed frames that nest. No mermaid-to-excalidraw round-trip.
 *
 * Sequence diagrams don't fit the node/edge generator, so this lays out and
 * emits elements itself (mirroring Diagram-Sequence.js's hand-built approach),
 * driven by the ordered event model from the sequence parser.
 *
 * Input graph: { type:'seqgraph', mermaid:'<sequenceDiagram source>', style?, title? }
 */

const libParse   = require('../Pict-Renderer-Graph-Mermaid-Sequence-Parse.js');
const libGenerate = require('pict-section-excalidraw/scripts/Generate-Notebook-Diagram.js');
const libRestyle = require('../Pict-Renderer-Graph-Restyle.js');

const _HeaderTop   = 70;    // title space above actor boxes
const _ActorH      = 56;
const _RowH        = 58;     // vertical step per message
const _SelfRowH    = 52;     // extra drop for a self-message loop
const _NoteH       = 50;
const _BlockTopPad = 30;     // room for the block label tab
const _BlockBotPad = 16;
const _ElseGap     = 26;
const _FootPad     = 36;
const _SidePad     = 40;

function _fontIdx(pProfile)
{
	return libGenerate.fontFamilyMap[(pProfile && pProfile.FontFamily) || 'Excalifont'] || 5;
}

function _text(pText, pX, pY, pW, pH, pSize, pFont, pColor, pSeed, pExtras)
{
	let tmpEx = pExtras || {};
	return {
		id:              tmpEx.id || ('seq-text-' + pSeed),
		type:            'text',
		x:               pX, y: pY, width: pW, height: pH, angle: 0,
		strokeColor:     pColor, backgroundColor: 'transparent',
		fillStyle:       'solid', strokeWidth: 1, strokeStyle: 'solid',
		roughness:       1, opacity: 100, groupIds: [], frameId: null, roundness: null,
		seed:            pSeed, version: 1, versionNonce: pSeed, isDeleted: false,
		boundElements:   tmpEx.containerId ? null : null,
		updated:         1, link: null, locked: false,
		text:            pText, fontSize: pSize, fontFamily: pFont,
		textAlign:       tmpEx.textAlign || 'left',
		verticalAlign:   tmpEx.verticalAlign || 'top',
		containerId:     tmpEx.containerId || null,
		originalText:    pText, autoResize: !tmpEx.containerId, lineHeight: 1.25, index: null
	};
}

module.exports =
{
	name:        'seqgraph',
	description: 'Native sequence diagram -- parse mermaid sequenceDiagram syntax + emit lanes, lifelines, messages, notes, and nested loop/alt/opt frames.',
	async:       false,

	toScene: function (pGraph, pProfile, pVendor, fCallback)
	{
		let tmpParsed = libParse.parseMermaidSequence(pGraph.mermaid || pGraph.source || '');
		let tmpTitle  = pGraph.title || tmpParsed.title || null;

		let tmpProfile = pProfile || {};
		let tmpPalette = tmpProfile.Palette || {};
		let tmpInk     = tmpPalette.ink || '#1B1F23';
		let tmpAccent  = tmpPalette.accent || '#C9602F';
		let tmpHi      = tmpPalette.highlight || '#E8C547';
		let tmpDeem    = tmpPalette.deemphasis || '#8A7F72';
		let tmpLink    = tmpPalette.link || '#2E7D74';
		let tmpRough   = (tmpProfile.Roughness !== undefined) ? tmpProfile.Roughness : 1;
		let tmpStrokeW = tmpProfile.StrokeWidth || 2;
		let tmpFill    = tmpProfile.FillStyle || 'hachure';
		let tmpFont    = _fontIdx(tmpProfile);
		let tmpFS      = tmpProfile.FontSize || 18;
		let tmpMsgFS   = Math.max(12, tmpFS - 4);
		let tmpSeedKey = (pKey) => libRestyle.seedFor(tmpProfile, pKey);

		let tmpParts = tmpParsed.participants;
		if (!tmpParts.length)
		{
			let tmpEmpty = { type: 'excalidraw', version: 2, source: 'pict-renderer-graph/seqgraph',
				elements: [], appState: Object.assign({}, tmpProfile.AppState || {}), files: {} };
			if (typeof fCallback === 'function') { fCallback(null, tmpEmpty); }
			return tmpEmpty;
		}

		// Lane geometry: each actor box sized to its label; lanes evenly spaced.
		let tmpActorW = {};
		let tmpMaxW = 120;
		for (let i = 0; i < tmpParts.length; i++)
		{
			let tmpW = Math.max(110, Math.ceil((tmpParts[i].label || '').length * tmpFS * 0.6 + 28));
			tmpActorW[tmpParts[i].id] = tmpW;
			if (tmpW > tmpMaxW) { tmpMaxW = tmpW; }
		}
		let tmpLaneSpacing = tmpMaxW + 80;
		let tmpLaneX = {};
		for (let i = 0; i < tmpParts.length; i++)
		{
			tmpLaneX[tmpParts[i].id] = _SidePad + i * tmpLaneSpacing + tmpLaneSpacing / 2;
		}
		let tmpLaneIndex = {};
		for (let i = 0; i < tmpParts.length; i++) { tmpLaneIndex[tmpParts[i].id] = i; }

		// ---- Pass 1: walk events, assign y, collect frames ----
		let tmpY = _HeaderTop + _ActorH + 24;
		let tmpStack = [];
		let tmpMsgs = [];
		let tmpNotes = [];
		let tmpFrames = [];

		for (let e = 0; e < tmpParsed.events.length; e++)
		{
			let tmpEv = tmpParsed.events[e];
			if (tmpEv.kind === 'message')
			{
				if (tmpEv.self)
				{
					tmpMsgs.push({ ev: tmpEv, y: tmpY + _RowH / 2, self: true });
					tmpY += _RowH + _SelfRowH;
				}
				else
				{
					tmpMsgs.push({ ev: tmpEv, y: tmpY + _RowH / 2, self: false });
					tmpY += _RowH;
				}
			}
			else if (tmpEv.kind === 'note')
			{
				tmpNotes.push({ ev: tmpEv, y: tmpY + 6 });
				tmpY += _NoteH + 14;
			}
			else if (tmpEv.kind === 'block')
			{
				tmpStack.push({ op: tmpEv.op, label: tmpEv.label, startY: tmpY, depth: tmpStack.length, dividers: [] });
				tmpY += _BlockTopPad;
			}
			else if (tmpEv.kind === 'else')
			{
				if (tmpStack.length)
				{
					tmpStack[tmpStack.length - 1].dividers.push({ y: tmpY, label: tmpEv.label });
					tmpY += _ElseGap;
				}
			}
			else if (tmpEv.kind === 'end')
			{
				let tmpBlock = tmpStack.pop();
				if (tmpBlock)
				{
					tmpFrames.push({
						op: tmpBlock.op, label: tmpBlock.label, depth: tmpBlock.depth,
						top: tmpBlock.startY, bottom: tmpY, dividers: tmpBlock.dividers
					});
					tmpY += _BlockBotPad;
				}
			}
		}
		let tmpFloor = tmpY + _FootPad;

		// ---- Build elements ----
		let tmpEls = [];

		// Title.
		if (tmpTitle)
		{
			tmpEls.push(_text(tmpTitle, _SidePad, 14, 360, 34, Math.round(tmpFS * 1.5), tmpFont, tmpInk, tmpSeedKey('seq-title'),
				{ id: 'seq-title' }));
		}

		// Lifelines (behind), then block frames, then actor boxes, then messages/notes.
		for (let i = 0; i < tmpParts.length; i++)
		{
			let tmpCX = tmpLaneX[tmpParts[i].id];
			let tmpTopY = _HeaderTop + _ActorH;
			tmpEls.push({
				id: 'seq-life-' + tmpParts[i].id, type: 'line',
				x: tmpCX, y: tmpTopY, width: 0, height: tmpFloor - tmpTopY, angle: 0,
				strokeColor: tmpDeem, backgroundColor: 'transparent', fillStyle: 'solid',
				strokeWidth: Math.max(1, tmpStrokeW * 0.75), strokeStyle: 'dashed',
				roughness: tmpRough, opacity: 100, groupIds: [], frameId: null, roundness: null,
				seed: tmpSeedKey('life:' + tmpParts[i].id), version: 1, versionNonce: 1, isDeleted: false,
				boundElements: null, updated: 1, link: null, locked: false,
				points: [ [ 0, 0 ], [ 0, tmpFloor - tmpTopY ] ], lastCommittedPoint: null,
				startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null,
				elbowed: false, index: null
			});
		}

		// Block frames (largest depth drawn last so nesting reads correctly).
		tmpFrames.sort((a, b) => a.depth - b.depth);
		for (let f = 0; f < tmpFrames.length; f++)
		{
			let tmpFr = tmpFrames[f];
			let tmpInset = 14 + tmpFr.depth * 12;
			let tmpX = _SidePad + tmpInset;
			let tmpW = (tmpParts.length * tmpLaneSpacing) - tmpInset * 2;
			let tmpSeed = tmpSeedKey('block:' + tmpFr.op + ':' + tmpFr.top);
			tmpEls.push({
				id: 'seq-block-' + f, type: 'rectangle',
				x: tmpX, y: tmpFr.top, width: tmpW, height: tmpFr.bottom - tmpFr.top, angle: 0,
				strokeColor: tmpDeem, backgroundColor: 'transparent', fillStyle: 'solid',
				strokeWidth: 1, strokeStyle: 'dashed', roughness: tmpRough, opacity: 100,
				groupIds: [], frameId: null, roundness: { type: 3 }, seed: tmpSeed,
				version: 1, versionNonce: tmpSeed, isDeleted: false, boundElements: [],
				updated: 1, link: null, locked: false, index: null
			});
			// Label tab: "op [label]".
			let tmpTabText = tmpFr.op + (tmpFr.label ? ' [' + tmpFr.label + ']' : '');
			tmpEls.push(_text(tmpTabText, tmpX + 8, tmpFr.top + 4, tmpW - 16, 20, tmpMsgFS, tmpFont, tmpDeem,
				tmpSeedKey('blocklabel:' + f), { id: 'seq-blocklabel-' + f }));
			// Else / and dividers.
			for (let d = 0; d < tmpFr.dividers.length; d++)
			{
				let tmpDiv = tmpFr.dividers[d];
				let tmpDSeed = tmpSeedKey('divider:' + f + ':' + d);
				tmpEls.push({
					id: 'seq-divider-' + f + '-' + d, type: 'line',
					x: tmpX, y: tmpDiv.y, width: tmpW, height: 0, angle: 0,
					strokeColor: tmpDeem, backgroundColor: 'transparent', fillStyle: 'solid',
					strokeWidth: 1, strokeStyle: 'dashed', roughness: tmpRough, opacity: 100,
					groupIds: [], frameId: null, roundness: null, seed: tmpDSeed,
					version: 1, versionNonce: tmpDSeed, isDeleted: false, boundElements: null,
					updated: 1, link: null, locked: false,
					points: [ [ 0, 0 ], [ tmpW, 0 ] ], lastCommittedPoint: null,
					startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null,
					elbowed: false, index: null
				});
				if (tmpDiv.label)
				{
					tmpEls.push(_text('[' + tmpDiv.label + ']', tmpX + 8, tmpDiv.y + 3, tmpW - 16, 18, tmpMsgFS, tmpFont, tmpDeem,
						tmpSeedKey('divlabel:' + f + ':' + d), { id: 'seq-divlabel-' + f + '-' + d }));
				}
			}
		}

		// Actor header boxes + labels.
		for (let i = 0; i < tmpParts.length; i++)
		{
			let tmpP = tmpParts[i];
			let tmpW = tmpActorW[tmpP.id];
			let tmpX = tmpLaneX[tmpP.id] - tmpW / 2;
			let tmpBoxId = 'seq-actor-' + tmpP.id;
			let tmpSeed = tmpSeedKey('actor:' + tmpP.id);
			tmpEls.push({
				id: tmpBoxId, type: 'rectangle',
				x: tmpX, y: _HeaderTop, width: tmpW, height: _ActorH, angle: 0,
				strokeColor: tmpInk, backgroundColor: 'transparent', fillStyle: tmpFill,
				strokeWidth: tmpStrokeW, strokeStyle: 'solid', roughness: tmpRough, opacity: 100,
				groupIds: [], frameId: null, roundness: { type: 3 }, seed: tmpSeed,
				version: 1, versionNonce: tmpSeed, isDeleted: false,
				boundElements: [ { id: 'seq-actorlabel-' + tmpP.id, type: 'text' } ],
				updated: 1, link: null, locked: false, index: null
			});
			tmpEls.push(_text(tmpP.label, tmpX + 8, _HeaderTop + (_ActorH - tmpFS) / 2, tmpW - 16, tmpFS + 4,
				tmpFS, tmpFont, tmpInk, tmpSeed + 1,
				{ id: 'seq-actorlabel-' + tmpP.id, containerId: tmpBoxId, textAlign: 'center', verticalAlign: 'middle' }));
		}

		// Notes.
		for (let n = 0; n < tmpNotes.length; n++)
		{
			let tmpNote = tmpNotes[n];
			let tmpActors = tmpNote.ev.actors.map((a) => tmpLaneX[a]).filter((x) => x !== undefined);
			if (!tmpActors.length) { continue; }
			let tmpCx, tmpW;
			if (tmpNote.ev.placement === 'over')
			{
				let tmpMin = Math.min.apply(null, tmpActors), tmpMax = Math.max.apply(null, tmpActors);
				tmpCx = (tmpMin + tmpMax) / 2;
				tmpW = Math.max(150, (tmpMax - tmpMin) + 150);
			}
			else
			{
				let tmpDir = (tmpNote.ev.placement === 'rightof') ? 1 : -1;
				tmpW = Math.max(140, tmpNote.ev.text.length * tmpMsgFS * 0.55 + 24);
				tmpCx = tmpActors[0] + tmpDir * (tmpW / 2 + 14);
			}
			let tmpNX = tmpCx - tmpW / 2;
			let tmpNoteId = 'seq-note-' + n;
			let tmpSeed = tmpSeedKey('note:' + n);
			tmpEls.push({
				id: tmpNoteId, type: 'rectangle',
				x: tmpNX, y: tmpNote.y, width: tmpW, height: _NoteH, angle: 0,
				strokeColor: tmpInk, backgroundColor: tmpHi, fillStyle: tmpFill,
				strokeWidth: Math.max(1, tmpStrokeW * 0.8), strokeStyle: 'solid', roughness: tmpRough,
				opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: tmpSeed,
				version: 1, versionNonce: tmpSeed, isDeleted: false,
				boundElements: [ { id: 'seq-notelabel-' + n, type: 'text' } ],
				updated: 1, link: null, locked: false, index: null
			});
			tmpEls.push(_text(tmpNote.ev.text, tmpNX + 8, tmpNote.y + 6, tmpW - 16, _NoteH - 12,
				tmpMsgFS, tmpFont, tmpInk, tmpSeed + 1,
				{ id: 'seq-notelabel-' + n, containerId: tmpNoteId, textAlign: 'center', verticalAlign: 'middle' }));
		}

		// Messages.
		for (let m = 0; m < tmpMsgs.length; m++)
		{
			let tmpM = tmpMsgs[m];
			let tmpEv = tmpM.ev;
			let tmpColor = (tmpEv.msgKind === 'async') ? tmpLink : tmpInk;
			let tmpStyle = tmpEv.dashed ? 'dashed' : 'solid';
			let tmpHead  = (tmpEv.msgKind === 'async') ? 'triangle_outline' : 'triangle';
			let tmpSeed  = tmpSeedKey('msg:' + m);

			if (tmpM.self)
			{
				let tmpX = tmpLaneX[tmpEv.from];
				let tmpLoopW = 46, tmpLoopH = _SelfRowH - 8;
				tmpEls.push({
					id: 'seq-msg-' + m, type: 'arrow',
					x: tmpX, y: tmpM.y, width: tmpLoopW, height: tmpLoopH, angle: 0,
					strokeColor: tmpColor, backgroundColor: 'transparent', fillStyle: 'solid',
					strokeWidth: tmpStrokeW, strokeStyle: tmpStyle, roughness: tmpRough, opacity: 100,
					groupIds: [], frameId: null, roundness: { type: 2 }, seed: tmpSeed,
					version: 1, versionNonce: tmpSeed, isDeleted: false, boundElements: [],
					updated: 1, link: null, locked: false,
					points: [ [ 0, 0 ], [ tmpLoopW, 0 ], [ tmpLoopW, tmpLoopH ], [ 0, tmpLoopH ] ],
					lastCommittedPoint: null, startBinding: null, endBinding: null,
					startArrowhead: null, endArrowhead: tmpHead, elbowed: false, index: null
				});
				if (tmpEv.text)
				{
					tmpEls.push(_text(tmpEv.text, tmpX + tmpLoopW + 10, tmpM.y + tmpLoopH / 2 - 10, Math.max(80, tmpEv.text.length * tmpMsgFS * 0.6), 18,
						tmpMsgFS, tmpFont, tmpColor, tmpSeed + 1, { id: 'seq-msglabel-' + m }));
				}
				continue;
			}

			let tmpFromX = tmpLaneX[tmpEv.from];
			let tmpToX   = tmpLaneX[tmpEv.to];
			if (tmpFromX === undefined || tmpToX === undefined) { continue; }
			let tmpDir = (tmpFromX < tmpToX) ? 1 : -1;
			let tmpSX = tmpFromX + tmpDir * 3;
			let tmpEX = tmpToX - tmpDir * 3;
			tmpEls.push({
				id: 'seq-msg-' + m, type: 'arrow',
				x: tmpSX, y: tmpM.y, width: tmpEX - tmpSX, height: 0, angle: 0,
				strokeColor: tmpColor, backgroundColor: 'transparent', fillStyle: 'solid',
				strokeWidth: tmpStrokeW, strokeStyle: tmpStyle, roughness: tmpRough, opacity: 100,
				groupIds: [], frameId: null, roundness: { type: 2 }, seed: tmpSeed,
				version: 1, versionNonce: tmpSeed, isDeleted: false, boundElements: [],
				updated: 1, link: null, locked: false,
				points: [ [ 0, 0 ], [ tmpEX - tmpSX, 0 ] ], lastCommittedPoint: null,
				startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: tmpHead,
				elbowed: false, index: null
			});
			if (tmpEv.text)
			{
				let tmpMidX = (tmpSX + tmpEX) / 2;
				let tmpLW = Math.max(60, tmpEv.text.length * tmpMsgFS * 0.6);
				tmpEls.push(_text(tmpEv.text, tmpMidX - tmpLW / 2, tmpM.y - 22, tmpLW, 18,
					tmpMsgFS, tmpFont, tmpColor, tmpSeed + 1, { id: 'seq-msglabel-' + m, textAlign: 'center' }));
			}
		}

		let tmpAppState = Object.assign({}, tmpProfile.AppState || {});
		tmpAppState.currentItemFontFamily = tmpFont;
		let tmpScene = {
			type: 'excalidraw', version: 2, source: 'pict-renderer-graph/seqgraph',
			elements: tmpEls, appState: tmpAppState, files: {}
		};
		if (typeof fCallback === 'function') { fCallback(null, tmpScene); }
		return tmpScene;
	}
};
