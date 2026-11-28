# Source origin

The tool in this directory was written for this task on 2026-11-28. It is
original code, not copied or forked from any upstream mesh editor, UV tool or
WebGL framework.

Everything vendored is a build-time tool only:

- `typescript` — the compiler used to type-check and emit `build/`.
- `@types/node` — type definitions for the Node test/tooling code.

There are no runtime dependencies, no remote assets, and no copied shader code:
the shaders in `src/webgl/shaders.ts` are hand-written for this tool, and the
sample gingham texture and meshes are generated procedurally by
`tools/build-samples.ts`.

The existing `renderer/` example at the repository root predates this tool and
is unrelated to it.
