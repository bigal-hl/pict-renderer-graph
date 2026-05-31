# Invocation Modes

The renderer's core is one `render()` method. The library, CLI, and HTTP modes are three thin wrappers over it -- pick whichever fits how you want to call the service.

## Library

Instantiate the service against a Fable instance, warm it once, render, and shut down.

```javascript
const libFable = require('fable');
const libPictRendererGraph = require('pict-renderer-graph');

let pictFable = new libFable();
let libRenderer = new libPictRendererGraph(pictFable);

libRenderer.initialize((pError) =>
{
	if (pError)
	{
		return console.error(pError);
	}

	libRenderer.render(pGraph, { format: 'svg' }, (pRenderError, pOutput) =>
	{
		// pOutput: { svg | png, mime, scene, source }
		libRenderer.shutdown(() => process.exit(0));
	});
});
```

### Constructor

```javascript
new PictRendererGraph(pFable, pOptions, pServiceHash)
```

`pFable` is required. `pOptions` overrides any of the defaults in `source/Pict-Renderer-Graph-DefaultConfiguration.js`:

```javascript
new PictRendererGraph(pictFable,
	{
		PageCount:              4,        // concurrent renders per Chromium process
		MaxQueueDepth:          32,       // fail fast (RendererBusyError) above this
		QueueRetryAfterSeconds: 1,        // Retry-After value when backpressured
		CacheEnabled:           true,
		CacheCapacity:          50,       // in-memory LRU entries
		DiskCacheEnabled:       true,
		DiskCacheDirectory:     null,     // null -> ~/.cache/pict-renderer-graph/
		DiskCacheMaxEntries:    500,      // LRU-by-mtime sweep above this
		AutoWarmOnRender:       true      // warm lazily on first render() if not initialized
	});
```

See [Architecture](architecture.md) for what each of these does, and [Quick Start](quickstart.md) for the full `render()` options table.

### Methods

| Method | Description |
|---|---|
| `initialize(callback)` | Warm the headless browser (launch Chromium, boot the asset server, open the page pool). Idempotent. Optional when `AutoWarmOnRender` is true -- the first `render()` warms lazily. |
| `render(graph, options, callback)` | Render a graph to SVG or PNG. `render(graph, callback)` is also accepted, taking default options. Calls back with `(error, output)`. |
| `shutdown(callback)` | Close the browser and asset server and flush pending disk-cache writes. Idempotent. |
| `invalidateCache(filter, callback)` | Drop cache entries. Omit the filter (or pass `{ all: true }`) to drop everything; filter by `{ hash }`, `{ style }`, and/or `{ type }`. Calls back with `{ invalidatedMemory, invalidatedDisk }`. |
| `updateStyle(name, patch, callback)` | Patch a named style profile and invalidate the cache entries rendered under it, atomically. Calls back with `{ profile, invalidatedMemory, invalidatedDisk }`. |
| `connectRoutes(oratorServer)` | Register the HTTP routes on an Orator service server (see [HTTP](#http) below). |

The diagram and style registries are also exposed as `renderer.diagrams` and `renderer.styles` -- `renderer.diagrams.list()` and `renderer.styles.list()` return the introspection lists, and `renderer.styles.register(name, profile)` adds a style at runtime.

### Errors

Backpressure raises a typed `RendererBusyError` (exported as `require('pict-renderer-graph').RendererBusyError`) carrying `retryAfterSeconds` and `queueDepth`. Identify it with `instanceof` or by `error.name === 'RendererBusyError'` to back off rather than retry immediately. All other failures (missing `type`, unknown type, render timeout, browser crash) come back as ordinary `Error` objects.

## CLI

The package installs a `pict-renderer-graph` binary.

```
pict-renderer-graph render <input.json|-> <output.svg|.png|->  [options]
pict-renderer-graph serve [--port N] [--host H]
pict-renderer-graph list-types
pict-renderer-graph list-styles
pict-renderer-graph --help
```

### render

```bash
# Pipe JSON in, write an SVG file
cat flow.json | npx pict-renderer-graph render - flow.svg

# File in, 2x-scale PNG out
npx pict-renderer-graph render flow.json flow.png --format png --scale 2

# Render to stdout
npx pict-renderer-graph render flow.json -
```

Input is a file path or `-` for stdin. Output is a file path or `-` for stdout (meaningful for SVG; a PNG to stdout writes a binary blob). The format is inferred from the output extension (`.png` -> PNG, otherwise SVG) unless `--format` overrides it. On success to a file, the CLI prints the output path, byte size, and element count to stderr.

| Option | Description |
|---|---|
| `--format svg|png` | Output format (default: svg, or inferred from filename) |
| `--scale N` | Export scale multiplier (default 1) |
| `--padding N` | Export padding in pixels (default 16) |
| `--style NAME` | Override the style profile (`notebook` / `whiteboard` / `clean` / `dark`); sets `style` on the input graph |
| `--no-embed-scene` | Omit Excalidraw's embedded-scene metadata |
| `--no-source` | Omit the `pict-renderer-graph:source` metadata block |

The `render` command warms a fresh renderer, renders once, and shuts down -- so it pays the Chromium cold-start cost on every invocation. For repeated renders, use the library or HTTP mode and keep the browser warm.

### serve

```bash
npx pict-renderer-graph serve --port 7790
npx pict-renderer-graph serve --port 7790 --host 0.0.0.0
```

Boots a long-running Orator HTTP service with the routes below. `--port` defaults to `7790`; `--host` defaults to `127.0.0.1`. The browser warms at startup, and SIGINT/SIGTERM trigger a clean shutdown.

### list-types / list-styles

```bash
npx pict-renderer-graph list-types     # prints each type and its description
npx pict-renderer-graph list-styles    # prints each style and its description
```

## HTTP

HTTP mode exposes the renderer over an Orator service server. Start it with the CLI's `serve` command, or register the routes on an Orator app you already run via `renderer.connectRoutes(oratorServer)`. The [example application](#example-application) shows the full wiring.

### Routes

| Method | Route | Description |
|---|---|---|
| POST | `/render` | Render graph JSON. Returns `image/svg+xml` by default |
| POST | `/render?format=png` | Returns `image/png` (also triggered by an `Accept: image/png` header) |
| POST | `/render?format=json` | Returns a JSON envelope `{ Success, svg, scene, source, cacheHit }` |
| GET | `/render/types` | List the diagram types as JSON |
| GET | `/render/styles` | List the style profiles as JSON |
| DELETE | `/cache` | Drop every cache entry (memory + disk) |
| POST | `/cache/invalidate` | Filtered invalidation; body `{ hash?, style?, type?, all? }` |
| PATCH | `/styles/:name` | Patch a named style profile and auto-invalidate affected cache entries |
| GET | `/` | A small JSON landing page listing the endpoints |

`POST /render` also accepts `scale` and `padding` query parameters. Its request body must be a JSON object, or the service returns `400`.

```bash
# SVG (default)
curl -X POST http://127.0.0.1:7790/render \
     -H 'Content-Type: application/json' \
     -d @diagram.json > diagram.svg

# PNG at 2x scale
curl -X POST 'http://127.0.0.1:7790/render?format=png&scale=2' \
     -d @diagram.json > diagram.png

# JSON envelope (svg + scene + source)
curl -X POST 'http://127.0.0.1:7790/render?format=json' \
     -d @diagram.json | jq .
```

### Cache and style management over HTTP

```bash
# Drop everything
curl -X DELETE http://127.0.0.1:7790/cache

# Drop by filter -- only notebook-rendered entries
curl -X POST http://127.0.0.1:7790/cache/invalidate \
     -H 'Content-Type: application/json' \
     -d '{"style":"notebook"}'

# Patch a style and auto-invalidate
curl -X PATCH http://127.0.0.1:7790/styles/notebook \
     -H 'Content-Type: application/json' \
     -d '{"Palette":{"ink":"#2A2A2A"}, "RandomSeedSalt":99}'
```

`DELETE /cache` and `POST /cache/invalidate` return `{ Success: true, invalidatedMemory: N, invalidatedDisk: M }` (the filtered route echoes the `Filter`). `PATCH /styles/:name` also returns the updated `profile`.

### Diagnostic headers

Every successful `/render` response carries:

| Header | Values |
|---|---|
| `X-PictRendererGraph-Cache` | `miss`, `hit-memory`, or `hit-disk` |
| `X-PictRendererGraph-Elements` | Element count in the rendered scene |
| `X-PictRendererGraph-Pool-Depth` | `<busy>/<total>` pages |
| `Retry-After` | Seconds to wait before retrying (only on a `503`) |

### Backpressure

When the renderer is overloaded (in-flight plus queued work has hit `MaxQueueDepth`), `/render` responds with `503` and a `Retry-After` header, plus a body of `{ Success: false, Error, RetryAfter, QueueDepth }`. Well-behaved clients should honor `Retry-After` rather than retrying immediately.

## Example application

`example_applications/renderer_service/` is the smallest sensible standalone Orator app that hosts the renderer -- roughly fifty lines. It creates a Fable instance with `Product` set, registers Orator and the restify service-server with the service manager, instantiates the renderer and warms it up front, calls `connectRoutes`, and starts listening (with SIGINT/SIGTERM wired for a clean shutdown).

```bash
cd example_applications/renderer_service
npm install
npm start                            # serves on http://127.0.0.1:7790
PORT=8080 npm start                  # custom port
```

Use it as a template, or just `npm install pict-renderer-graph` and call `renderer.connectRoutes(...)` from whichever Orator app you already run.
