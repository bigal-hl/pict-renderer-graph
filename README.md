# pict-renderer-graph

> Headless Excalidraw rendering as a fable service. JSON in, hand-drawn SVG (or PNG) out.

`pict-section-excalidraw` proved that Excalidraw can be driven programmatically. **pict-renderer-graph** packages that capability as a first-class server-side service: a pre-warmed Chromium, a unified graph-input schema, and three invocation modes (library / CLI / HTTP).

```
   structured graph JSON         pict-renderer-graph              SVG with embedded scene
   ┌─────────────────────┐    ┌─────────────────────────┐    ┌────────────────────────┐
   │  type: "flow"       │    │   ┌─ diagram registry   │    │  <svg>                 │
   │  nodes: [...]       │ ──►│   ├─ style profile      │ ──►│    <metadata>          │
   │  edges: [...]       │    │   ├─ Generate scene     │    │     <!-- excalidraw    │
   │  style: "notebook"  │    │   └─► Chromium          │    │          payload --> │
   │                     │    │       exportToSvg       │    │     <pict-renderer-    │
   └─────────────────────┘    └─────────────────────────┘    │          graph:source/>│
                                                              │    </metadata>         │
                                                              │    ...drawings...      │
                                                              │  </svg>                │
                                                              └────────────────────────┘
```

## Quick start

### Library

```javascript
const libFable = require('fable');
const libPictRendererGraph = require('pict-renderer-graph');

let fable = new libFable();
let renderer = new libPictRendererGraph(fable);

renderer.initialize((pErr) =>
{
    if (pErr) return console.error(pErr);

    renderer.render(
        {
            type:   'flow',
            title:  'service flow',
            style:  'notebook',
            nodes:
            [
                { id: 'user', label: 'User',        kind: 'ellipse' },
                { id: 'api',  label: 'API Gateway', kind: 'rectangle' },
                { id: 'db',   label: 'Database',    kind: 'rectangle' }
            ],
            edges:
            [
                { from: 'user', to: 'api', label: 'request' },
                { from: 'api',  to: 'db',  label: 'query' }
            ]
        },
        { format: 'svg', includeSource: true },
        (pErr, pOut) =>
        {
            console.log(pOut.svg);                      // the SVG string
            renderer.shutdown(() => process.exit(0));
        });
});
```

### CLI

```bash
# One-shot
echo '{"type":"flow","nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"edges":[{"from":"a","to":"b"}]}' \
  | npx pict-renderer-graph render - /tmp/diagram.svg

# Long-running HTTP service
npx pict-renderer-graph serve --port 7790

# Inspect
npx pict-renderer-graph list-types
npx pict-renderer-graph list-styles
```

### HTTP

```bash
npx pict-renderer-graph serve --port 7790 &

curl -X POST http://localhost:7790/render \
     -H 'Content-Type: application/json' \
     -d @diagram.json \
     > diagram.svg
```

## Diagram types

| `type` | Layout | Best for |
|---|---|---|
| `flow` | Topo-sorted columns, max-width per column | Process flow, lines-and-boxes, service architectures |
| `star` | Hub-and-spoke (central node, others on a circle) | Mental models, "X relates to A/B/C/D" |
| `sequence` | Actor lanes + vertical lifelines + horizontal messages | API call sequences, protocol diagrams |
| `mindmap` | Recursive radial tree | Brainstorms, hierarchies, ontologies |
| `datadict` | Tall entities with multi-line field labels + FK arrows | Data dictionaries, entity relationship diagrams |
| `mermaid` | Whatever mermaid produces (uses dagre/ELK internally) | Anything mermaid supports — flow, class, state, gantt |

## Style profiles

| `style` | Vibe |
|---|---|
| `notebook` (default) | Warm-ink hand-drawn — the look of `pict-section-excalidraw`'s Notebook-Default |
| `whiteboard` | Slightly bolder, cross-hatched fills, cooler palette |
| `clean` | Roughness 0, sharp corners, Helvetica — print-ready |
| `dark` | Charcoal paper, light ink, muted-orange accent |

Inline overrides work: `{ style: { name: 'notebook', RandomSeedSalt: 42 } }` keeps notebook but re-rolls the wobble.

## Concurrency, caching, backpressure

The renderer is built for production load. Out of the box:

- **N-page pool** (`PageCount: 4`) — N concurrent renders run truly in parallel inside one Chromium process.
- **Two-tier LRU cache** — memory + disk (`~/.cache/pict-renderer-graph/`). Identical input returns in microseconds; survives process restart.
- **In-flight coalescing** — when 10 callers request the same diagram at the same time, the work runs once and all 10 receive the result.
- **Bounded queue** (`MaxQueueDepth: 32`) — when overloaded, new requests fail fast with `RendererBusyError` (HTTP: 503 + `Retry-After: 1`) instead of growing memory.

### Throughput at a glance

Measured on a developer workstation (4-page pool, single chromium, M-series chip):

| Workload | Wall-clock for 16 renders | p50 latency | Throughput |
|---|---|---|---|
| 16 unique diagrams, 4 concurrent | 282 ms | 13 ms | 57 req/s |
| 16 identical diagrams, 4 concurrent (cache + coalesce) | 270 ms | **0 ms** | 59 req/s |

Run your own:

```bash
npm run loadtest -- --concurrency 8 --total 100 --unique
npm run loadtest -- --concurrency 8 --total 100 --identical
```

### Tuning options

```javascript
new PictRendererGraph(fable, {
    PageCount:              4,        // concurrent renders per process
    MaxQueueDepth:          32,       // 503-or-equivalent above this
    QueueRetryAfterSeconds: 1,        // Retry-After value when backpressured
    CacheEnabled:           true,
    CacheCapacity:          50,       // in-memory LRU entries
    DiskCacheEnabled:       true,
    DiskCacheDirectory:     null,     // null → ~/.cache/pict-renderer-graph/
    DiskCacheMaxEntries:    500       // LRU-by-mtime sweep above this
});
```

### Diagnostic headers

Every HTTP response carries:

| Header | Values |
|---|---|
| `X-PictRendererGraph-Cache` | `miss` &#124; `hit-memory` &#124; `hit-disk` |
| `X-PictRendererGraph-Elements` | element count in the rendered scene |
| `X-PictRendererGraph-Pool-Depth` | `<busy>/<total>` pages |
| `Retry-After` | seconds to wait before retry (only on 503) |

## Cache invalidation + runtime style updates

Tuning a style profile mid-flight (changing a palette, bumping roughness) shouldn't cost a server restart. The renderer exposes a programmatic invalidation API and a one-call `updateStyle()` that combines the patch with the cache flush:

### Library

```javascript
// Drop everything
renderer.invalidateCache((err, { invalidatedMemory, invalidatedDisk }) =>
{
    console.log(`Dropped ${invalidatedMemory} mem + ${invalidatedDisk} disk entries`);
});

// Drop by filter
renderer.invalidateCache({ style: 'notebook' }, callback);   // only notebook-rendered entries
renderer.invalidateCache({ type:  'flow' },     callback);   // only flow-typed entries
renderer.invalidateCache({ hash:  '<sha256>' }, callback);   // exact one entry

// Update a style + auto-invalidate affected cache entries (atomic)
renderer.updateStyle('notebook',
    { Palette: { ink: '#2A2A2A', accent: '#FF6F61' }, RandomSeedSalt: 99 },
    (err, { profile, invalidatedMemory, invalidatedDisk }) =>
    {
        // The next render({ style: 'notebook' }) uses the new palette.
    });

// Register a brand-new style at runtime
renderer.styles.register('my-team', { /* full style profile */ });
```

### HTTP

```bash
# Drop everything
curl -X DELETE http://127.0.0.1:7790/cache

# Drop by filter — POST /cache/invalidate with body { hash?, style?, type?, all? }
curl -X POST http://127.0.0.1:7790/cache/invalidate \
     -H 'Content-Type: application/json' \
     -d '{"style":"notebook"}'

# Patch a style + auto-invalidate
curl -X PATCH http://127.0.0.1:7790/styles/notebook \
     -H 'Content-Type: application/json' \
     -d '{"Palette":{"ink":"#2A2A2A"}, "RandomSeedSalt":99}'
```

All three return `{ Success: true, invalidatedMemory: N, invalidatedDisk: M }` (PATCH also returns `profile`).

## SVG output format

Every rendered SVG carries two metadata blocks:

1. **Excalidraw embed** (`<!-- payload-type:application/vnd.excalidraw+json -->` + base64 scene). Round-trips into any `pict-section-excalidraw` view for hand editing.
2. **Source embed** (`<pict-renderer-graph:source>` with CDATA-wrapped original JSON). Lets a consumer re-render with a different style or layout without parsing Excalidraw elements.

```xml
<metadata>
  <!-- payload-type:application/vnd.excalidraw+json -->
  <!-- payload-start --> ...base64... <!-- payload-end -->
  <pict-renderer-graph:source xmlns:pict-renderer-graph="https://fable-retold.github.io/pict-renderer-graph/ns/v1">
    <![CDATA[ { "type": "flow", "nodes": [...], "edges": [...] } ]]>
  </pict-renderer-graph:source>
</metadata>
```

## Gallery — visual regression / DSL exploration

A non-checked-in fixture gallery exercises every diagram type, style, and edge case in one
pass — useful for spot-checking aesthetics after a layout change, for feeling out the edges
of the DSL, and as a quick "do all six types still render?" smoke after refactors.

```bash
npm run test:gallery
```

This boots a pre-warmed renderer (4-page pool, cache disabled so every fixture re-renders),
walks every `test/fixtures/gallery/<NN-category>/*.json` (36 fixtures across 8 categories:
flow, star, sequence, mindmap, datadict, mermaid, styles, edge cases), and writes per-fixture
`<name>.png` (2× scale) + `<name>.svg` into `test/gallery/<category>/`. It then builds
`test/gallery/index.html` — open it in a browser to see all renderings as a sortable grid
of cards, each with the original input JSON in a collapsible `<details>` block.

The whole `test/gallery/` directory is gitignored — regenerate locally any time. Add new
fixtures to `test/fixtures/gallery/<category>/` and re-run; the generator picks them up
automatically.

**Categories:**

| Category | Fixtures | What it stresses |
|---|---|---|
| `01-flow` | 5 | Multi-tier architectures, microservices, CI/CD, ETL, decision trees |
| `02-star` | 3 | Hub-and-spoke (pub-sub, star schema, service mesh) |
| `03-sequence` | 4 | Real protocols (OAuth2, TCP handshake, REST CRUD, saga) |
| `04-mindmap` | 2 | Standards (12-factor app, web stack) |
| `05-datadict` | 3 | Entity tables (blog, e-commerce, social) |
| `06-mermaid` | 5 | Mermaid pass-through (flowchart, sequence, class, state) |
| `07-styles` | 5 | Same graph in notebook/whiteboard/clean/dark/inline-tuned variants |
| `08-edges` | 9 | DSL edge cases — single node, cycle, self-loop, unicode/long labels, all kinds, all accents, disconnected components, 30-node stress |

Bonus: the standards-oriented fixtures (OAuth2 RFC 6749, 12-factor, TCP three-way handshake)
double as visual regression for "does this still look right against the canonical reference
diagram everyone has seen 100 times?"

## Architecture

```
modules/pict/pict-renderer-graph/
├── source/
│   ├── Pict-Renderer-Graph.js              # main fable service
│   ├── browser/Pict-Renderer-Graph-Browser.js   # pre-warmed Chromium lifecycle
│   ├── diagrams/                            # one file per diagram type
│   │   ├── Diagram-Registry.js
│   │   ├── Diagram-Flow.js                  # delegates to pict-section-excalidraw
│   │   ├── Diagram-Star.js
│   │   ├── Diagram-Sequence.js
│   │   ├── Diagram-MindMap.js
│   │   ├── Diagram-DataDictionary.js
│   │   └── Diagram-Mermaid.js               # async, runs in-page
│   ├── styles/                              # style profiles
│   ├── cli/Pict-Renderer-Graph-CLI-Run.js   # CLI entry
│   └── server/Pict-Renderer-Graph-Routes.js # Orator route registration
├── test/                                     # mocha + puppeteer e2e
└── example_applications/renderer_service/    # standalone Orator app
```

See [the plan](../../../.claude/plans/okay-this-is-beautiful-jazzy-flame.md) for the full design rationale.

## License

MIT — see LICENSE.
