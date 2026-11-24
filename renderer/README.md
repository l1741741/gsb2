# Canvas Scene Renderer

A dependency-free JavaScript sample for drawing a small 2D scene graph with the browser's Canvas 2D API. It is intentionally a compact starting codebase, not a full game engine.

## Requirements

- Node.js 20 or newer for tests.
- A modern browser for the visual demo.
- No third-party packages or remote assets.

## Verify

From this directory:

```sh
npm test
npm run demo
```

Open `http://localhost:4173/demo/` to inspect the static scene. The server runs from the renderer directory so it can serve both `demo/` and `src/` modules. The demo uses only local JavaScript and Canvas primitives.

## Current API

`src/scene.js` exports `group`, `rectangle`, `circle`, and `sprite` factories. Nodes can have local position, rotation, scale, opacity, visibility, and z-index. Groups draw children in ascending z-index order; equal z-index values retain insertion order.

`src/renderer.js` exports `CanvasRenderer`. A renderer accepts a Canvas 2D context and draws a root node. It clears the canvas by default; `render(root, { clear: false })` draws without clearing. The renderer does not provide a camera, update loop, input system, animation system, tile map, or asset loader.

## Evidence

The unit tests use a recording Canvas 2D context to verify the renderer's command contract. They do not substitute for browser rendering; use the demo to inspect the actual output.
