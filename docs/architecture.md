# Architecture

pict-renderer-graph turns a graph description into an Excalidraw-rendered image. The work splits into two halves: a pure-JavaScript layer that builds an Excalidraw scene from your input, and a browser layer that exports that scene to SVG or PNG inside a pre-warmed headless Chromium. Around both sits a cache, an in-flight coalescer, and a bounded queue.

## The render pipeline

A single `render(graph, options, callback)` call flows through these stages:

```
graph JSON
  --> registry.get(graph.type)        resolve the diagram handler
  --> styles.resolveWithName(style)    resolve the style profile (keeps the user-facing name)
  --> cache.get(hash)                  memory -> disk lookup; on hit, short-circuit everything
  --> coalescer.coalesce(hash, ...)    collapse concurrent identical requests into one render
  --> handler.toScene(graph, profile)  produce an Excalidraw scene { elements, appState, files }
  --> browser.render(scene, options)   export to SVG/PNG inside a pooled Chromium page
  --> inject <pict-renderer-graph:source> metadata (SVG only)
  --> { svg | png, mime, scene, source }
```

The orchestration lives in `source/Pict-Renderer-Graph.js`. The diagram handlers live under `source/diagrams/`, the style profiles under `source/styles/`, the browser layer in `source/browser/Pict-Renderer-Graph-Browser.js`, and the cache in `source/cache/`.

### Diagram handlers

Each diagram type is a small handler object registered by name in `source/diagrams/Diagram-Registry.js`. A handler exposes `name`, `description`, an `async` flag, and a `toScene(graph, profile, browser, callback)` function.

Most handlers are **synchronous** -- they compute element positions in Node and return the scene directly. The `mermaid` handler is **asynchronous**: it must run `parseMermaidToExcalidraw` inside the browser (mermaid's layout is async and runs against its own dagre/ELK pipeline), so it takes the callback and uses the browser's `evaluateInPage` helper. The orchestrator branches on the `async` flag and supports both shapes.

Three handlers (`flow`, `star`, `mindmap`) delegate to `pict-section-excalidraw`'s `Generate-Notebook-Diagram.js` for scene construction -- they precompute node positions and hand off with `layout: 'manual'` so they inherit style application, label binding, arrow binding, title placement, and deterministic seeding. The `sequence` and `datadict` handlers build Excalidraw elements directly because their primitives (lifelines, multi-line field blocks) don't fit the one-label-per-node model.

## The pre-warmed Chromium

Launching Chromium per render would dominate latency. Instead, the browser layer holds one long-lived headless Chromium with a pool of pages already loaded and ready to export.

### Warming

`warm()` (called by `initialize()`, or lazily on the first `render()` when `AutoWarmOnRender` is true) does three things:

1. **Boots a loopback asset server.** The Excalidraw wrapper bundle fetches font and locale chunks at runtime from `window.EXCALIDRAW_ASSET_PATH`. A tiny Node `http` server serves the vendor-built directory (from `pict-section-excalidraw`'s `vendor/excalidraw-built`) on a random free port, bound to `127.0.0.1` only, so vendor assets are never exposed on a routable interface.
2. **Launches Chromium** via Puppeteer with the configured launch options (headless, `--no-sandbox` / `--disable-setuid-sandbox` for Docker/CI, a 1600x1200 default viewport).
3. **Opens N pages in parallel**, navigates each to the host page, and waits for the wrapper bundle to finish booting (`window.__pictRendererGraphReady === true`).

`warm()` is idempotent and guards against concurrent warms: a second caller polls until the first finishes. `WarmTimeoutMs` (default 30000) bounds how long it waits for the bundle to come up on slow or cold-start machines.

### Why a shared page is safe

Excalidraw's `exportToSvg` and `exportToBlob` are pure-functional per the Excalidraw source -- they take a scene and return an image without mutating page state. That means any number of renders can share a page without state pollution, and the pool can hand any idle page to any render.

## Concurrency, caching, and backpressure

The runtime is built for production load. The defaults live in `source/Pict-Renderer-Graph-DefaultConfiguration.js` and are tuned for a developer workstation.

### The page pool

`PageCount` (default 4) pages live inside the one Chromium process. A render acquires the first idle page; N concurrent renders therefore run truly in parallel inside Chromium. If every page is busy, the job FIFO-waits for one to free up.

Mermaid renders go through the same queue and pool via `evaluateInPage`, so mermaid and non-mermaid work share the pool fairly.

### Two-tier LRU cache

Identical input returns from cache instead of re-rendering.

- **Tier 1 (memory)** -- an LRU of up to `CacheCapacity` (default 50) entries, served instantly.
- **Tier 2 (disk)** -- files under `DiskCacheDirectory` (default `$XDG_CACHE_HOME/pict-renderer-graph/` or `~/.cache/pict-renderer-graph/`), surviving process restart. A disk hit is promoted back into memory so the next lookup is fast.

The cache key is a SHA-256 over a canonicalized blob of the graph (recursively key-sorted, so `{a:1, b:2}` and `{b:2, a:1}` hash the same), the format and export options (`scale`, `padding`, `background`, `embedScene`, `includeSource`), and a fingerprint of the style-profile fields that actually affect output (roughness, stroke, fill, fonts, palette, `RandomSeedSalt`, layout, appState). Bumping a style's `RandomSeedSalt` therefore produces a different key and re-renders.

Disk entries are kept under `DiskCacheMaxEntries` (default 500) by an opportunistic LRU-by-mtime sweep that runs on `set()` -- there is no background timer, so the discipline works for both short-lived CLI runs and long-lived servers. Disk writes are fire-and-forget; `shutdown()` awaits any pending writes so a clean shutdown does not lose work.

On a cache hit, the whole pipeline short-circuits -- no browser, no handler, no coalesce. The returned value carries a `cacheHit` marker of `'memory'` or `'disk'`; a fresh render has no marker.

### In-flight coalescing

When several callers request the same diagram (same cache key) at the same moment, the coalescer runs the work once and resolves all waiters with the single result. A burst of identical requests costs one render, not one per caller.

### Bounded queue (backpressure)

To stop a misbehaving client or a load spike from exhausting memory, the renderer caps the total of in-flight plus queued work at `MaxQueueDepth` (default 32). When a new request would exceed that, it fails immediately with a `RendererBusyError` carrying `retryAfterSeconds` (from `QueueRetryAfterSeconds`, default 1) and the observed `queueDepth`. The error is delivered asynchronously, never synchronously.

The HTTP layer translates `RendererBusyError` into a `503` response with a `Retry-After` header (it identifies the error with an `instanceof` check, so backpressure produces a `503` rather than a generic `500`).

### Resilience

If a single page dies mid-render (target closed, protocol error, session closed), only that page is rewarmed -- the rest of the pool keeps serving, and the failed job is retried on whichever page is free. If a rewarm fails, the dead slot is dropped from the pool. Consecutive warm failures are capped by `MaxConsecutiveWarmRetries` (default 3) so the service gives up cleanly rather than thrashing.

## Output format

Every rendered SVG carries two metadata blocks inside its `<metadata>` element:

1. **Excalidraw scene embed** -- Excalidraw's standard `exportEmbedScene` payload (a `payload-type:application/vnd.excalidraw+json` comment plus the base64 scene). This round-trips into any `pict-section-excalidraw` view for hand editing.
2. **Source embed** -- a `<pict-renderer-graph:source>` element (namespace `https://fable-retold.github.io/pict-renderer-graph/ns/v1`) wrapping the original graph JSON in CDATA. A consumer can re-render with a different style or layout without parsing Excalidraw elements.

```xml
<metadata>
  <!-- payload-type:application/vnd.excalidraw+json -->
  <!-- payload-start --> ...base64... <!-- payload-end -->
  <pict-renderer-graph:source xmlns:pict-renderer-graph="https://fable-retold.github.io/pict-renderer-graph/ns/v1">
    <![CDATA[ { "type": "flow", "nodes": [...], "edges": [...] } ]]>
  </pict-renderer-graph:source>
</metadata>
```

The source block is added by the renderer after export, just before `</metadata>`; if the SVG has no `<metadata>` element, the renderer wraps the block in a fresh one. The scene embed comes from Excalidraw itself and is controlled by the `embedScene` option. PNG output carries no metadata blocks -- the format has no place to put them.

## Source layout

```
modules/pict/pict-renderer-graph/
|-- source/
|   |-- Pict-Renderer-Graph.js                  # fable service: orchestration + SVG metadata injection
|   |-- Pict-Renderer-Graph-DefaultConfiguration.js
|   |-- Pict-Renderer-Graph-Errors.js           # RendererBusyError
|   |-- browser/
|   |   |-- Pict-Renderer-Graph-Browser.js      # pre-warmed Chromium + page pool
|   |   `-- renderer-host.html                   # the host page the wrapper bundle boots in
|   |-- cache/
|   |   |-- Pict-Renderer-Graph-Cache.js        # two-tier LRU cache
|   |   `-- Pict-Renderer-Graph-Coalescer.js    # in-flight request coalescing
|   |-- diagrams/                                # one handler per diagram type
|   |   |-- Diagram-Registry.js
|   |   |-- Diagram-Flow.js
|   |   |-- Diagram-Star.js
|   |   |-- Diagram-Sequence.js
|   |   |-- Diagram-MindMap.js
|   |   |-- Diagram-DataDictionary.js
|   |   `-- Diagram-Mermaid.js                   # async, runs in-page
|   |-- styles/                                  # the four style profiles + registry
|   |-- cli/Pict-Renderer-Graph-CLI-Run.js       # CLI entry
|   `-- server/Pict-Renderer-Graph-Routes.js     # Orator route registration
|-- test/                                         # mocha + puppeteer end-to-end
`-- example_applications/renderer_service/        # standalone Orator app
```
