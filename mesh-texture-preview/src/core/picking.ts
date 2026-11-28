/**
 * Picking: hit-testing in fabric space and in texture space.
 *
 * Picking lives with geometry rather than the renderer so it can be unit
 * tested against the same transforms the view uses. `PaneRect` values are
 * CSS pixels local to a pane.
 */

import { barycentric, clamp, dist, pointInTriangle, segmentDistance } from './geometry.ts';
import { resolveSeams, weldTopology } from './diagnostics.ts';
import type { MeshDocument, Vec2 } from './types.ts';

export interface PaneRect {
  width: number;
  height: number;
}

export interface PaneCamera {
  centerX: number;
  centerY: number;
  scale: number;
}

/** CSS point (pane-local, Y down) → fabric world. */
export function paneToWorld(camera: PaneCamera, rect: PaneRect, x: number, y: number): Vec2 {
  return {
    x: (x - rect.width / 2) / camera.scale + camera.centerX,
    y: (y - rect.height / 2) / camera.scale + camera.centerY,
  };
}

/** Fabric world → CSS point (pane-local, Y down). */
export function worldToPane(camera: PaneCamera, rect: PaneRect, p: Vec2): Vec2 {
  return {
    x: rect.width / 2 + (p.x - camera.centerX) * camera.scale,
    y: rect.height / 2 + (p.y - camera.centerY) * camera.scale,
  };
}

const UV_FIT = 0.84;

/** CSS point (pane-local) → UV. */
export function paneToUv(rect: PaneRect, x: number, y: number, fit = UV_FIT): Vec2 {
  const side = Math.min(rect.width, rect.height) * fit;
  return {
    x: 0.5 + (x - rect.width / 2) / side,
    y: 0.5 + (y - rect.height / 2) / side,
  };
}

/** UV → CSS point (pane-local). */
export function uvToPane(rect: PaneRect, uv: Vec2, fit = UV_FIT): Vec2 {
  const side = Math.min(rect.width, rect.height) * fit;
  return {
    x: rect.width / 2 + (uv.x - 0.5) * side,
    y: rect.height / 2 + (uv.y - 0.5) * side,
  };
}

export interface PickResult {
  kind: 'vertex' | 'seam' | 'triangle' | 'none';
  vertex: number | null;
  triangleId: number | null;
  seamId: string | null;
  /** Distance in CSS pixels to the picked item, for priority rules. */
  distance: number;
}

const EMPTY: PickResult = { kind: 'none', vertex: null, triangleId: null, seamId: null, distance: Infinity };

/**
 * Picks a control point first (within `handleRadius` CSS px), then a seam
 * within `seamRadius`, then the triangle under the cursor.
 */
export function pickInFabric(
  doc: MeshDocument,
  camera: PaneCamera,
  rect: PaneRect,
  cssX: number,
  cssY: number,
  handleRadius = 8,
  seamRadius = 5,
): PickResult {
  const world = paneToWorld(camera, rect, cssX, cssY);
  const topology = weldTopology(doc.vertices);

  // Control points: nearest welded position.
  let bestVertex: PickResult | null = null;
  for (let weld = 0; weld < topology.weldVertex.length; weld++) {
    const position = topology.weldPosition[weld];
    const d = dist(world, position) * camera.scale;
    if (d > handleRadius) continue;
    const index = topology.weldVertex[weld];
    if (!bestVertex || d < bestVertex.distance) {
      bestVertex = { kind: 'vertex', vertex: index, triangleId: null, seamId: null, distance: d };
    }
  }
  if (bestVertex) return bestVertex;

  // Seams: nearest declared/resolved seam line.
  let bestSeam: PickResult | null = null;
  for (const seam of resolveSeams(doc)) {
    const d = segmentDistance(world, seam.p0, seam.p1).distance * camera.scale;
    if (d > seamRadius) continue;
    if (!bestSeam || d < bestSeam.distance) {
      bestSeam = {
        kind: 'seam',
        vertex: null,
        triangleId: null,
        seamId: seam.id,
        distance: d,
      };
    }
  }
  if (bestSeam) return bestSeam;

  // Triangles: smallest triangle containing the point wins (topmost).
  let bestTriangle: PickResult | null = null;
  for (const tri of doc.triangles) {
    const p0 = doc.vertices[tri.vertices[0]];
    const p1 = doc.vertices[tri.vertices[1]];
    const p2 = doc.vertices[tri.vertices[2]];
    if (!pointInTriangle(world, p0, p1, p2)) continue;
    const area = Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)) / 2;
    if (!bestTriangle || area < bestTriangle.distance) {
      bestTriangle = { kind: 'triangle', vertex: null, triangleId: tri.id, seamId: null, distance: area };
    }
  }
  return bestTriangle ?? EMPTY;
}

/**
 * Picks in the texture pane: nearest UV corner within `radius`, else the
 * triangle whose UV triangle contains the point. Returns both the triangle
 * and the corner index, since UV editing works per corner.
 */
export function pickInTexture(
  doc: MeshDocument,
  rect: PaneRect,
  cssX: number,
  cssY: number,
  radius = 6,
): { triangleId: number | null; corner: 0 | 1 | 2 | null; distance: number } {
  const uv = paneToUv(rect, cssX, cssY);
  const side = Math.min(rect.width, rect.height) * UV_FIT;
  let best: { triangleId: number | null; corner: 0 | 1 | 2 | null; distance: number } = {
    triangleId: null,
    corner: null,
    distance: Infinity,
  };
  for (const tri of doc.triangles) {
    for (let k = 0; k < 3; k++) {
      const d = dist(uv, tri.uvs[k]) * side;
      if (d <= radius && d < best.distance) {
        best = { triangleId: tri.id, corner: k as 0 | 1 | 2, distance: d };
      }
    }
  }
  if (best.triangleId !== null) return best;

  for (const tri of doc.triangles) {
    if (!pointInTriangle(uv, tri.uvs[0], tri.uvs[1], tri.uvs[2])) continue;
    return { triangleId: tri.id, corner: null, distance: 0 };
  }
  return { triangleId: null, corner: null, distance: Infinity };
}

/** Barycentric weights of a fabric point in a triangle, for smooth dragging. */
export function triangleWeights(doc: MeshDocument, triangleId: number, p: Vec2): [number, number, number] | null {
  const tri = doc.triangles.find((t) => t.id === triangleId);
  if (!tri) return null;
  return barycentric(p, doc.vertices[tri.vertices[0]], doc.vertices[tri.vertices[1]], doc.vertices[tri.vertices[2]]);
}

/** Converts a texture-space delta in CSS pixels to a UV delta. */
export function pxToUvDelta(rect: PaneRect, dx: number, dy: number, fit = UV_FIT): Vec2 {
  const side = Math.min(rect.width, rect.height) * fit;
  return { x: dx / side, y: dy / side };
}

export { clamp };
