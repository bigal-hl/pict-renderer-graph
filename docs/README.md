# pict-renderer-graph

Headless Excalidraw rendering as a Fable service. Pass in structured graph JSON, get back a hand-drawn SVG (or PNG) carrying the original scene as embedded metadata. The renderer drives a pre-warmed, pooled headless Chromium so each diagram exports in roughly the time Excalidraw needs to lay out and serialize a scene -- no per-call browser launch.

`pict-section-excalidraw` proved that Excalidraw can be driven programmatically. **pict-renderer-graph** packages that capability as a first-class server-side service: a pre-warmed Chromium page pool, a unified graph-input schema, six diagram types, four style profiles, and three invocation modes (library / CLI / HTTP).

## What it does

- **Six diagram types** -- `flow`, `star`, `sequence`, `mindmap`, `datadict`, and `mermaid`. Each maps a structured JSON description onto an Excalidraw scene.
- **Four style profiles** -- `notebook` (default), `whiteboard`, `clean`, and `dark`. Styles can be overridden inline per render and patched at runtime.
- **Three invocation modes** -- call `render()` as a library, shell out to the `pict-renderer-graph` CLI, or POST graph JSON to a long-running HTTP service.
- **Production-shaped runtime** -- an N-page Chromium pool for real parallelism, a two-tier (memory + disk) LRU cache, in-flight request coalescing, and a bounded queue that fails fast under overload.
- **Round-trippable output** -- every SVG embeds both the Excalidraw scene (for re-editing in `pict-section-excalidraw`) and the original graph JSON (for re-rendering with a different style or layout).

## Quick example

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

	libRenderer.render(
		{
			type:  'flow',
			title: 'service flow',
			style: 'notebook',
			nodes:
			[
				{ id: 'user', label: 'User',        kind: 'ellipse'   },
				{ id: 'api',  label: 'API Gateway', kind: 'rectangle' },
				{ id: 'db',   label: 'Database',    kind: 'rectangle' }
			],
			edges:
			[
				{ from: 'user', to: 'api', label: 'request' },
				{ from: 'api',  to: 'db',  label: 'query'   }
			]
		},
		{ format: 'svg', includeSource: true },
		(pRenderError, pOutput) =>
		{
			console.log(pOutput.svg);                       // the SVG string
			libRenderer.shutdown(() => process.exit(0));
		});
});
```

## Documentation

- [Quick Start](quickstart.md) -- install, render your first diagram, and serve over HTTP
- [Architecture](architecture.md) -- the Chromium pre-warm, page pool, and render pipeline
- [Diagram Types](diagram-types.md) -- the six types and their input shapes
- [Styles](styles.md) -- the four style profiles, inline overrides, and runtime updates
- [Invocation Modes](invocation-modes.md) -- library, CLI, and HTTP in detail

## Related Modules

- [pict-section-excalidraw](https://fable-retold.github.io/pict-section-excalidraw/) -- the Excalidraw integration this service drives; supplies the scene generator and the default style profile
- [fable](https://fable-retold.github.io/fable/) -- the core dependency-injection and service framework
- [fable-serviceproviderbase](https://fable-retold.github.io/fable-serviceproviderbase/) -- the base class the renderer service extends
- [orator](https://fable-retold.github.io/orator/) -- the API server used by the HTTP invocation mode

## License

MIT -- see LICENSE.
