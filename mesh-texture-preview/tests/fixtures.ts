/**
 * Shared test fixtures. Kept in one place so every test measures the same
 * meshes, and so a change to the fixture intentionally affects all of them.
 */

import type { MeshDocument, Triangle, Vec2, Vertex } from '../src/core/types.ts';

export const SETTINGS = { stretchThreshold: 1.35, collapseThreshold: 0.02, seamTolerance: 1e-3 };

/** A 2×2 quad of 4 triangles with a 1:1 texture mapping. */
export function quadGrid(): MeshDocument {
  const vertices: Vertex[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 200, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
    { x: 200, y: 100 },
    { x: 0, y: 200 },
    { x: 100, y: 200 },
    { x: 200, y: 200 },
  ];
  const uvAt = (index: number): Vec2 => ({ x: (index % 3) * 0.5, y: Math.floor(index / 3) * 0.5 });
  const triangles: Triangle[] = [];
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 2; col++) {
      const i00 = row * 3 + col;
      const i10 = i00 + 1;
      const i01 = i00 + 3;
      const i11 = i01 + 1;
      const id = triangles.length;
      triangles.push({ id, vertices: [i00, i11, i10], uvs: [uvAt(i00), uvAt(i11), uvAt(i10)] });
      triangles.push({ id: id + 1, vertices: [i00, i01, i11], uvs: [uvAt(i00), uvAt(i01), uvAt(i11)] });
    }
  }
  return {
    format: 'fabric-mesh-preview',
    version: 1,
    texture: { name: 'test.png', width: 256, height: 256 },
    vertices,
    triangles,
    seams: [],
    diagnostics: SETTINGS,
  };
}

/** A single triangle. */
export function singleTriangle(points: [Vec2, Vec2, Vec2], uvs: [Vec2, Vec2, Vec2]): MeshDocument {
  return {
    format: 'fabric-mesh-preview',
    version: 1,
    texture: { name: 'test.png', width: 256, height: 256 },
    vertices: points.map((p) => ({ x: p.x, y: p.y })),
    triangles: [{ id: 0, vertices: [0, 1, 2], uvs }],
    seams: [],
    diagnostics: SETTINGS,
  };
}

/**
 * Two triangles forming a diamond, sharing exactly the fabric edge A–B.
 * Side B is a separate panel with its own vertices at the same positions, and
 * all of panel B's UVs are shifted by `shift` along U. A weld by position
 * rejoins the shared edge, so the fabric is closed while the two sides sample
 * different texels — the canonical split seam.
 */
export function splitPair(shift: number): MeshDocument {
  const vertices: Vertex[] = [
    { x: 0, y: 0 }, // 0: A
    { x: 100, y: 0 }, // 1: B (panel A)
    { x: 50, y: 100 }, // 2: C (panel A, above)
    { x: 100, y: 0 }, // 3: B' (panel B, same position as 1)
    { x: 50, y: -100 }, // 4: D (panel B, below)
  ];
  // Panel A: A(0,0) B(100,0) C(50,100), UVs with matching winding.
  const uvsA: [Vec2, Vec2, Vec2] = [
    { x: 0, y: 0 },
    { x: 0.5, y: 0 },
    { x: 0.25, y: 0.5 },
  ];
  // Panel B: A(0,0) B'(100,0) D(50,-100); every UV shifted by `shift`.
  const uvsB: [Vec2, Vec2, Vec2] = [
    { x: 0 + shift, y: 0 },
    { x: 0.5 + shift, y: 0 },
    { x: 0.25 + shift, y: -0.5 },
  ];
  return {
    format: 'fabric-mesh-preview',
    version: 1,
    texture: { name: 'test.png', width: 256, height: 256 },
    vertices,
    triangles: [
      { id: 0, vertices: [0, 1, 2], uvs: uvsA },
      { id: 1, vertices: [0, 3, 4], uvs: uvsB },
    ],
    seams: [{ id: 'split-edge', triangles: [0, 1], kind: 'split' }],
    diagnostics: SETTINGS,
  };
}

/** A deliberately flipped triangle: UV winding opposite to fabric winding. */
export function flippedTriangle(): MeshDocument {
  return singleTriangle(
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ],
    [
      { x: 0, y: 0 },
      { x: 0, y: 0.5 },
      { x: 0.5, y: 0 },
    ],
  );
}
