# Quick Start

This walks you from install to a rendered diagram in each of the three invocation modes.

## Install

```bash
npm install pict-renderer-graph fable
```

The package depends on `puppeteer`, which downloads a matching Chromium build on install. `pict-section-excalidraw` (the source of the scene generator and the default style profile) is a dependency too, so a normal `npm install` brings everything the renderer needs.

## Render from a script (library mode)

Create a renderer, warm the browser once, render as many diagrams as you like, then shut down.

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
			if (pRenderError)
			{
				return console.error(pRenderError);
			}
			console.log(pOutput.svg);                       // the SVG string
			libRenderer.shutdown(() => process.exit(0));
		});
});
```

### The render callback result

`render()` calls back with `(pError, pOutput)`. The output object carries:

| Field | Present when | Description |
|---|---|---|
| `svg` | format is `svg` | The serialized SVG string |
| `png` | format is `png` | A PNG `Buffer` |
| `mime` | always | `image/svg+xml` or `image/png` |
| `scene` | always | The Excalidraw scene object that was rendered (`{ type, version, source, elements, appState, files }`) |
| `source` | always | The original graph JSON you passed in |

### Render options

The second argument to `render()` is an options bag. All fields are optional; you can also call `render(graph, callback)` and take the defaults.

| Option | Default | Description |
|---|---|---|
| `format` | `'svg'` | `'svg'` or `'png'` |
| `includeSource` | `true` | Splice the original graph JSON into the SVG as a `<pict-renderer-graph:source>` metadata block (SVG only) |
| `embedScene` | `true` | Embed the Excalidraw scene in the SVG via Excalidraw's `exportEmbedScene` |
| `scale` | `1` | Export scale multiplier |
| `padding` | `16` | Export padding in pixels |
| `background` | `true` | Render the canvas background |
| `darkMode` | from style | Force dark-mode export on or off; defaults to the style profile's `exportWithDarkMode` |

## Render from the command line (CLI mode)

The package installs a `pict-renderer-graph` binary.

```bash
# One-shot: read graph JSON from stdin, write an SVG file
echo '{"type":"flow","nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"edges":[{"from":"a","to":"b"}]}' \
  | npx pict-renderer-graph render - /tmp/diagram.svg

# Read from a file, write a 2x-scale PNG
npx pict-renderer-graph render flow.json flow.png --format png --scale 2

# Inspect what types and styles are available
npx pict-renderer-graph list-types
npx pict-renderer-graph list-styles
```

Input may be a file path or `-` for stdin; output may be a path or `-` for stdout. The output format is inferred from the file extension (`.png` -> PNG, anything else -> SVG) unless `--format` overrides it. See [Invocation Modes](invocation-modes.md) for the full flag list.

## Serve over HTTP (HTTP mode)

Run a long-lived service and POST graph JSON to it.

```bash
npx pict-renderer-graph serve --port 7790
```

Then, from another shell:

```bash
curl -X POST http://127.0.0.1:7790/render \
     -H 'Content-Type: application/json' \
     -d @diagram.json \
     > diagram.svg
```

The service binds to `127.0.0.1` by default. Pass `--host` to change the bind address. The HTTP surface (PNG and JSON output, type and style listing, cache management, runtime style patching) is documented in [Invocation Modes](invocation-modes.md).

## Next steps

- Pick a [diagram type](diagram-types.md) that fits your data
- Choose or tune a [style](styles.md)
- Read the [architecture](architecture.md) to understand pre-warming and the page pool before deploying under load
