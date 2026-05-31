# Diagram Types

Every graph carries a `type` field that selects a diagram handler. There are six, registered in `source/diagrams/Diagram-Registry.js`. `type` is required; an unknown type fails with an error listing the known types. Type matching is case-insensitive.

| `type` | Layout | Best for |
|---|---|---|
| `flow` | Topo-sorted columns; nodes stack vertically within a column | Process flows, lines-and-boxes, service architectures |
| `star` | Hub-and-spoke: one central node, others on a circle | Mental models, "X relates to A/B/C/D" |
| `sequence` | Actor lanes with vertical lifelines and horizontal messages | API call sequences, protocol diagrams |
| `mindmap` | Recursive radial tree, fanning out by depth | Brainstorms, hierarchies, ontologies |
| `datadict` | Entity tables with typed field rows and FK arrows | Data dictionaries, entity-relationship diagrams |
| `mermaid` | Whatever mermaid produces (dagre/ELK internally) | Anything mermaid supports |

`flow`, `star`, and `mindmap` share a common node/edge vocabulary (they all delegate to `pict-section-excalidraw`'s scene generator). `sequence`, `datadict`, and `mermaid` each take their own input shape, described below.

## Shared node and edge vocabulary (flow, star, mindmap)

These three types describe a graph as `nodes` and `edges`.

### Nodes

```javascript
{ id: 'api', label: 'API Gateway', kind: 'rectangle', accent: 'accent' }
```

| Field | Values | Description |
|---|---|---|
| `id` | string | Unique node identifier, referenced by edges |
| `label` | string | Text drawn inside the node |
| `kind` | `rectangle` (default), `ellipse`, `diamond`, `note` | Node shape. `note` is a sticky-note: a filled rectangle in the highlight color |
| `accent` | `ink`, `accent`, `highlight`, `deemphasis`, `link` | Maps the node's stroke to a palette color |
| `background` | a palette key (e.g. `highlight`) | Fill color for the node |
| `width`, `height` | numbers | Optional explicit size; otherwise sized from the style's defaults and the label length |

The default `kind` is `rectangle` for `flow`, and `ellipse` for `mindmap` nodes.

### Edges

```javascript
{ from: 'user', to: 'api', label: 'request', kind: 'solid', accent: 'link' }
```

| Field | Values | Description |
|---|---|---|
| `from` | node id | Source node |
| `to` | node id | Target node |
| `label` | string | Optional text on the edge |
| `kind` | `solid` (default), `dashed`, `dotted`, `curved` | Line style |
| `accent` | a palette key | Edge color; defaults to the `link` color |

### flow

```javascript
{
	type:  'flow',
	title: 'should i ship?',
	style: 'notebook',
	nodes:
	[
		{ id: 'start', label: 'ready?',        kind: 'diamond'   },
		{ id: 'tests', label: 'tests pass?',   kind: 'diamond'   },
		{ id: 'ship',  label: 'ship it',       kind: 'ellipse',   accent: 'link'   },
		{ id: 'wait',  label: 'fix + retry',   kind: 'note',      background: 'highlight' }
	],
	edges:
	[
		{ from: 'start', to: 'tests', label: 'yes' },
		{ from: 'tests', to: 'ship',  label: 'yes' },
		{ from: 'tests', to: 'wait',  label: 'no'  }
	]
}
```

Nodes are topo-sorted into left-to-right columns; multiple nodes in the same rank stack vertically. An optional `layout` field is forwarded to the generator (defaults to `'flow'`).

### star

One node is the hub at the center; the rest sit on a circle around it.

```javascript
{
	type:  'star',
	title: 'event bus',
	nodes:
	[
		{ id: 'bus', label: 'Event Bus', kind: 'ellipse', hub: true },
		{ id: 'a',   label: 'Service A' },
		{ id: 'b',   label: 'Service B' },
		{ id: 'c',   label: 'Service C' }
	],
	edges:
	[
		{ from: 'bus', to: 'a' },
		{ from: 'bus', to: 'b' },
		{ from: 'bus', to: 'c' }
	]
}
```

Hub selection, in order: a node marked `hub: true`, else the node touched by the most edges, else the first node. (The graph also accepts a top-level `hub` field naming the hub node id.) An optional top-level `spokeOrder` array of node ids reorders the spokes clockwise from twelve o'clock; any spokes not listed are appended.

### mindmap

A recursive radial hierarchy. The root sits in the center; children fan out in concentric rings by depth, each child dividing its parent's angular sweep.

```javascript
{
	type:  'mindmap',
	title: 'web stack',
	root:  'app',
	nodes:
	[
		{ id: 'app',     label: 'Web App'   },
		{ id: 'client',  label: 'Client'    },
		{ id: 'server',  label: 'Server'    },
		{ id: 'browser', label: 'Browser'   },
		{ id: 'mobile',  label: 'Mobile'    }
	],
	edges:
	[
		{ from: 'app',    to: 'client'  },
		{ from: 'app',    to: 'server'  },
		{ from: 'client', to: 'browser' },
		{ from: 'client', to: 'mobile'  }
	]
}
```

Edges are read as parent-to-child. The optional `root` field names the root node id (it defaults to the first node). Nodes not reachable from the root are placed in a fallback grid below the diagram. Mindmaps do not distinguish edge direction for the tree structure.

## sequence

A UML-style sequence diagram: actor boxes across the top, vertical dashed lifelines dropping from each, and horizontal labeled messages ordered top to bottom. This type uses `actors` and `messages` rather than `nodes` and `edges`.

```javascript
{
	type:  'sequence',
	title: 'OAuth2 auth code',
	actors:
	[
		{ id: 'user',  label: 'User'                     },
		{ id: 'app',   label: 'App',    accent: 'accent' },
		{ id: 'authz', label: 'Authorization Server'     }
	],
	messages:
	[
		{ from: 'user',  to: 'app',   label: 'click login',          kind: 'sync'   },
		{ from: 'app',   to: 'authz', label: 'redirect /authorize',  kind: 'async'  },
		{ from: 'authz', to: 'app',   label: 'authorization code',   kind: 'return' },
		{ from: 'app',   to: 'app',   label: 'validate token',       kind: 'note'   }
	]
}
```

### Actors

| Field | Values | Description |
|---|---|---|
| `id` | string | Actor identifier, referenced by messages |
| `label` | string | Text in the actor box (defaults to the id) |
| `accent` | `accent`, `link`, `highlight`, `deemphasis` | Stroke color for the actor box and label |

### Messages

| Field | Values | Description |
|---|---|---|
| `from` | actor id | Originating lifeline |
| `to` | actor id | Receiving lifeline |
| `label` | string | Optional text above the message arrow |
| `kind` | `sync` (default), `async`, `return`, `note` | Message style (see below) |

Message kinds:

- **`sync`** -- a solid arrow with a filled arrowhead.
- **`async`** -- a solid arrow with an open (outline) arrowhead, drawn in the link color.
- **`return`** -- a dashed arrow.
- **`note`** -- not an arrow at all, but a small highlight-filled note rectangle near the originating actor (using the message's `label` as its text).

A message whose `from` or `to` does not match a declared actor is skipped.

## datadict

A data dictionary / entity-relationship diagram. Each entity is a tall rectangle with a header (the entity name) and one text row per field; FK-style arrows link entities. Entities are laid out in a grid (three columns), wrapping to new rows -- relations are not topo-sorted, since FK graphs commonly contain cycles.

```javascript
{
	type:  'datadict',
	title: 'blog schema',
	entities:
	[
		{
			id:    'post',
			label: 'Post',
			fields:
			[
				{ name: 'id',        type: 'int',  pk: true        },
				{ name: 'author_id', type: 'int',  fk: true        },
				{ name: 'title',     type: 'text'                  },
				{ name: 'body',      type: 'text', nullable: true  }
			]
		},
		{
			id:    'author',
			label: 'Author',
			accent: 'accent',
			fields:
			[
				{ name: 'id',   type: 'int', pk: true },
				{ name: 'name', type: 'text'          }
			]
		}
	],
	relations:
	[
		{ from: 'post.author_id', to: 'author.id', label: 'wrote', kind: 'one-to-many' }
	]
}
```

### Entities

| Field | Values | Description |
|---|---|---|
| `id` | string | Entity identifier, referenced by relations |
| `label` | string | Entity / table name, rendered as the header (defaults to the id) |
| `accent` | `accent`, `link`, `deemphasis` | Stroke color for the entity box, header, and separator |
| `fields` | array | One row per field (see below) |

### Fields

| Field | Values | Description |
|---|---|---|
| `name` | string | Field name |
| `type` | string | Optional type, rendered after the name |
| `pk` | boolean | Primary key -- prefixed with a star and drawn in the accent color |
| `fk` | boolean | Foreign key -- prefixed with an arrow glyph and drawn in the link color |
| `nullable` | boolean | Renders a trailing `?` marker |

> **Note:** a field's `note` key is accepted in the input shape but is not currently rendered in the field row -- only `name`, `type`, `pk`/`fk`, and `nullable` affect output.

### Relations

| Field | Values | Description |
|---|---|---|
| `from` | `entityId.fieldName` (or `entityId`) | Source endpoint; a `field` part attaches the arrow to that field's row |
| `to` | `entityId.fieldName` (or `entityId`) | Target endpoint |
| `label` | string | Optional text on the relation arrow |
| `kind` | `one-to-many`, `one-to-one`, `many-to-many` | A `many-to-many` relation is drawn dashed; others are solid |

For backward compatibility, `datadict` also accepts `nodes`/`edges` in place of `entities`/`relations` (with the entity's fields under a `fields` array) and translates them.

## mermaid

A pass-through to `@excalidraw/mermaid-to-excalidraw`, run inside the browser (mermaid's parse is async and uses its own dagre/ELK layout). Supply the mermaid source as a `mermaid` string.

```javascript
{
	type:    'mermaid',
	title:   'state machine',
	mermaid: 'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running: start\n  Running --> Idle: stop'
}
```

| Field | Description |
|---|---|
| `mermaid` | The mermaid source string (required) |
| `mermaidOptions` | Optional options object forwarded to `parseMermaidToExcalidraw` |

The handler's gallery and description cover mermaid flowchart, sequence, class, state, and gantt syntax -- anything `mermaid-to-excalidraw` supports.

> **Style caveat:** because mermaid builds its own elements with its own defaults, a `style` profile only affects the canvas-level theme tokens (such as background color) for mermaid diagrams. Roughness, palette, and font from the style profile do not apply.

A mermaid graph with no `mermaid` field fails with an error.

## Listing types at runtime

The diagram registry is introspectable. From the CLI:

```bash
npx pict-renderer-graph list-types
```

Over HTTP, `GET /render/types` returns the same list as JSON. Each entry is `{ type, name, description, async }`.
