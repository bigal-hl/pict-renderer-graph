# Styles

A graph's optional `style` field selects a style profile -- the palette, roughness, fill style, fonts, and canvas appearance applied to the rendered scene. There are four bundled profiles, registered by name in `source/styles/Style-Registry.js`. The default is `notebook`.

`style` accepts either a name string (`'notebook'`) or an inline profile object (see [Inline overrides](#inline-overrides) below).

## The four profiles

| `style` | Description |
|---|---|
| `notebook` (default) | Warm-ink hand-drawn -- the look of `pict-section-excalidraw`'s Notebook-Default |
| `whiteboard` | Whiteboard sketch -- cross-hatched fills, a cooler blue-grey palette, slightly larger fonts |
| `clean` | Crisp / print-ready -- roughness 0, sharp corners, solid fills, Helvetica |
| `dark` | Dark-mode notebook -- charcoal paper, light ink, muted-orange accent |

### notebook

The default profile. It re-exports `pict-section-excalidraw`'s `Notebook-Default` directly, so it always tracks whatever that profile defines -- a single source of truth for the warm-ink hand-drawn look.

### whiteboard

Inherits Notebook-Default and tunes it bolder and cooler: roughness `1`, stroke width `2`, `cross-hatch` fills, the Excalifont face at size `22`, and a graphite-blue / cool off-white palette with an ink-blue accent. It sets the canvas background to a cool off-white (`#F4F7F9`).

### clean

The "we used a ruler" profile -- roughness `0`, sharp corners (roundness disabled), `solid` fills, Helvetica at size `18`, and a black-on-white palette. Its `RandomSeedSalt` is fixed so every diagram lays out identically, which makes it suitable for print and formal technical reports.

### dark

The notebook palette inverted for dark-mode docs: a bone-colored ink on charcoal paper with a muted-orange accent, `hachure` fills, Excalifont at size `20`. It sets the Excalidraw theme to `dark`, the background to charcoal (`#1B1F23`), and `exportWithDarkMode` to `true` -- so the SVG/PNG export honors dark mode without you passing the `darkMode` render option.

## Inline overrides

Pass `style` as an object to start from a named profile and tweak fields. The object's `name` field chooses the base (Notebook-Default if omitted); the remaining fields merge over it. `Palette` and `AppState` deep-merge, so you can change one color without restating the rest.

```javascript
libRenderer.render(
	{
		type:  'flow',
		style: { name: 'notebook', RandomSeedSalt: 42 },   // notebook, re-rolled wobble
		nodes: [ /* ... */ ],
		edges: [ /* ... */ ]
	},
	{ format: 'svg' },
	(pError, pOutput) => { /* ... */ });
```

Changing `RandomSeedSalt` re-rolls the deterministic hand-drawn jitter while keeping the rest of the profile. Because the cache key includes the style fingerprint (including `RandomSeedSalt`), a tweaked inline profile produces a distinct cache entry and re-renders rather than returning a stale image.

An inline profile without a `name` field merges over the notebook default.

## Runtime style updates

You can patch a named profile while the service is running -- handy for tuning a palette or bumping roughness without a restart. Because cached entries record which named style produced them, the renderer can patch the profile and invalidate exactly the affected cache entries in one atomic call.

### Library

```javascript
// Update a style and auto-invalidate the cache entries rendered under it.
libRenderer.updateStyle('notebook',
	{ Palette: { ink: '#2A2A2A', accent: '#FF6F61' }, RandomSeedSalt: 99 },
	(pError, pResult) =>
	{
		// pResult: { profile, invalidatedMemory, invalidatedDisk }
		// The next render({ style: 'notebook' }) uses the new palette.
	});

// Register a brand-new named style at runtime.
libRenderer.styles.register('my-team', { /* full style profile */ });
```

`updateStyle(name, patch, callback)` deep-merges `Palette`, `AppState`, `Layout`, and `DefaultSizes`; everything else in the patch replaces. It calls back with the updated `profile` plus the counts of invalidated memory and disk entries. Updating an unknown style returns an error suggesting `styles.register(name, profile)`.

### HTTP

```bash
# Patch a style and auto-invalidate affected cache entries.
curl -X PATCH http://127.0.0.1:7790/styles/notebook \
     -H 'Content-Type: application/json' \
     -d '{"Palette":{"ink":"#2A2A2A"}, "RandomSeedSalt":99}'
```

The response is `{ Success: true, profile, invalidatedMemory: N, invalidatedDisk: M }`.

## Cache invalidation by style

Separately from updating a profile, you can drop cached renders by style (or by type, or exactly by hash):

```javascript
libRenderer.invalidateCache((pError, pStats) => { /* drop everything */ });
libRenderer.invalidateCache({ style: 'notebook' }, callback);   // only notebook-rendered entries
libRenderer.invalidateCache({ type:  'flow'     }, callback);   // only flow-typed entries
libRenderer.invalidateCache({ hash:  '<sha256>' }, callback);   // exactly one entry
```

Filters are AND-ed (`{ style: 'notebook', type: 'flow' }` matches the intersection). Both the memory and disk tiers are walked. See [Invocation Modes](invocation-modes.md) for the matching HTTP cache routes.

## Listing styles at runtime

```bash
npx pict-renderer-graph list-styles
```

Over HTTP, `GET /render/styles` returns the same list as JSON. Each entry is `{ name, description, palette }`.
