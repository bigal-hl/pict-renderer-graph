# pict-renderer-graph

> Headless Excalidraw rendering as a Fable service

Pass in structured graph JSON, get back a hand-drawn SVG (or PNG). A pre-warmed, pooled Chromium turns six diagram types into Excalidraw scenes -- usable as a library, a CLI, or an HTTP service.

- **Six Diagram Types** -- flow, star, sequence, mindmap, data dictionary, and mermaid pass-through
- **Four Style Profiles** -- notebook, whiteboard, clean, and dark, with inline overrides and runtime patching
- **Three Invocation Modes** -- call `render()` as a library, shell out to the CLI, or POST graph JSON over HTTP
- **Built for Load** -- an N-page Chromium pool, a two-tier cache, in-flight coalescing, and fail-fast backpressure
- **Round-Trippable Output** -- every SVG embeds the Excalidraw scene and the original graph JSON

[Quick Start](quickstart.md)
[Architecture](architecture.md)
[Diagram Types](diagram-types.md)
[GitHub](https://github.com/fable-retold/pict-renderer-graph)
