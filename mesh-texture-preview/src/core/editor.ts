/**
 * Editor commands: the only place that mutates a MeshDocument.
 *
 * Every command takes a document and returns a new one (structural sharing of
 * untouched pieces, though documents are small so cloning is used in practice).
 * Commands never consult history or UI state, which keeps them testable.
 *
 * Dragging semantics
 * ------------------
 * A control point is a *fabric position*. Moving it moves every vertex welded
 * at that position, so triangles on both sides of a split seam stay together
 * and the fabric remains water-tight. UVs do not change when dragging, which
 * is what makes local stretch visible: the texture is pinned to the corners,
 * and moving fabric corners stretches or squashes it.
 */

import { cloneDocument } from './history.ts';
import { weldTopology } from './diagnostics.ts';
import type { MeshDocument, SeamKind, Vec2, Vertex } from './types.ts';

/**
 * All vertex indices welded at the same position as `index`.
 */
export function weldedGroup(doc: MeshDocument, index: number): number[] {
  if (!doc.vertices[index]) return [];
  const topology = weldTopology(doc.vertices);
  const weld = topology.vertexWeld[index];
  const result: number[] = [];
  for (let i = 0; i < doc.vertices.length; i++) {
    if (topology.vertexWeld[i] === weld) result.push(i);
  }
  return result;
}

/**
 * Moves a control point to a new fabric position. Every welded vertex moves
 * together; `pinned` vertices refuse the move.
 */
export function moveControlPoint(
  doc: MeshDocument,
  index: number,
  position: Vec2,
): { document: MeshDocument; moved: number[] } {
  const group = weldedGroup(doc, index);
  if (group.length === 0) return { document: doc, moved: [] };
  if (doc.vertices[index].pinned) return { document: doc, moved: [] };
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new TypeError('control point position must be finite');
  }
  if (group.some((i) => doc.vertices[i].pinned)) {
    // Moving would drag a pinned vertex; reject the whole gesture rather than
    // silently splitting a welded group.
    return { document: doc, moved: [] };
  }
  const next = cloneDocument(doc);
  for (const i of group) next.vertices[i] = { ...next.vertices[i], x: position.x, y: position.y };
  return { document: next, moved: group };
}

/** Sets or clears the pinned flag on a control point (all welded vertices). */
export function setPinned(doc: MeshDocument, index: number, pinned: boolean): MeshDocument {
  const group = weldedGroup(doc, index);
  if (group.length === 0) return doc;
  const next = cloneDocument(doc);
  for (const i of group) {
    if (pinned) next.vertices[i] = { ...next.vertices[i], pinned: true };
    else next.vertices[i] = { x: next.vertices[i].x, y: next.vertices[i].y };
  }
  return next;
}

/** Sets the UV of one triangle corner (per-corner UVs make splits possible). */
export function setCornerUv(
  doc: MeshDocument,
  triangleId: number,
  corner: 0 | 1 | 2,
  uv: Vec2,
): MeshDocument {
  if (!Number.isFinite(uv.x) || !Number.isFinite(uv.y)) {
    throw new TypeError('corner UV must be finite');
  }
  const index = doc.triangles.findIndex((t) => t.id === triangleId);
  if (index < 0) return doc;
  const next = cloneDocument(doc);
  const uvs: [Vec2, Vec2, Vec2] = [{ ...next.triangles[index].uvs[0] }, { ...next.triangles[index].uvs[1] }, { ...next.triangles[index].uvs[2] }];
  uvs[corner] = { x: uv.x, y: uv.y };
  next.triangles[index] = { ...next.triangles[index], uvs };
  return next;
}

/** Offsets all three UVs of a triangle, preserving its local scale. */
export function nudgeTriangleUv(doc: MeshDocument, triangleId: number, delta: Vec2): MeshDocument {
  const index = doc.triangles.findIndex((t) => t.id === triangleId);
  if (index < 0) return doc;
  const next = cloneDocument(doc);
  const tri = next.triangles[index];
  next.triangles[index] = {
    ...tri,
    uvs: tri.uvs.map((uv) => ({ x: uv.x + delta.x, y: uv.y + delta.y })) as [Vec2, Vec2, Vec2],
  };
  return next;
}

/**
 * Declares a seam between the two triangles sharing a fabric edge.
 *
 * Returns null when the triangles do not share exactly one fabric edge, when
 * a seam already exists on that edge, or when the ids are unknown.
 */
export function declareSeam(
  doc: MeshDocument,
  triangleA: number,
  triangleB: number,
  kind: SeamKind,
  id: string,
): { document: MeshDocument; reason?: string } {
  const a = doc.triangles.find((t) => t.id === triangleA);
  const b = doc.triangles.find((t) => t.id === triangleB);
  if (!a || !b) return { document: doc, reason: '三角形不存在' };
  if (triangleA === triangleB) return { document: doc, reason: '需要两个不同的三角形' };
  const topology = weldTopology(doc.vertices);
  const shared: number[] = [];
  for (const va of a.vertices) {
    for (const vb of b.vertices) {
      if (topology.vertexWeld[va] === topology.vertexWeld[vb] && !shared.includes(topology.vertexWeld[va])) {
        shared.push(topology.vertexWeld[va]);
      }
    }
  }
  if (shared.length !== 2) return { document: doc, reason: '两个三角形没有共用一条边' };
  const existing = doc.seams.find(
    (seam) =>
      (seam.triangles[0] === triangleA && seam.triangles[1] === triangleB) ||
      (seam.triangles[0] === triangleB && seam.triangles[1] === triangleA),
  );
  if (existing) {
    const next = cloneDocument(doc);
    // `existing` belongs to the original document, so find the clone's entry
    // by id rather than by reference.
    const index = next.seams.findIndex((seam) => seam.id === existing.id);
    if (index >= 0) next.seams[index] = { id: existing.id, triangles: existing.triangles, kind };
    return { document: next };
  }
  if (doc.seams.some((seam) => seam.id === id)) {
    return { document: doc, reason: `拼缝 id "${id}" 已存在` };
  }
  const next = cloneDocument(doc);
  next.seams.push({ id, triangles: [triangleA, triangleB], kind });
  return { document: next };
}

/** Removes a seam declaration. Undeclared shared edges fall back to continuous. */
export function removeSeam(doc: MeshDocument, id: string): MeshDocument {
  if (!doc.seams.some((seam) => seam.id === id)) return doc;
  const next = cloneDocument(doc);
  next.seams = next.seams.filter((seam) => seam.id !== id);
  return next;
}

/** Renames a seam declaration, rejecting empty or duplicate ids. */
export function renameSeam(doc: MeshDocument, id: string, nextId: string): MeshDocument {
  const trimmed = nextId.trim();
  if (!trimmed) return doc;
  if (doc.seams.some((seam) => seam.id === trimmed && seam.id !== id)) return doc;
  const next = cloneDocument(doc);
  const seam = next.seams.find((s) => s.id === id);
  if (!seam) return doc;
  seam.id = trimmed;
  return next;
}

/** Updates the diagnostic thresholds. */
export function setThresholds(
  doc: MeshDocument,
  settings: Partial<MeshDocument['diagnostics']>,
): MeshDocument {
  const next = cloneDocument(doc);
  const merged = { ...next.diagnostics, ...settings };
  for (const key of ['stretchThreshold', 'collapseThreshold', 'seamTolerance'] as const) {
    const value = merged[key];
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${key} 必须是正有限数`);
    }
  }
  if (merged.collapseThreshold >= 1) throw new RangeError('collapseThreshold 必须小于 1');
  next.diagnostics = merged;
  return next;
}

/** Adds a new control point; returns the new index. */
export function addControlPoint(
  doc: MeshDocument,
  position: Vec2,
  pinned = false,
): { document: MeshDocument; index: number } {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new TypeError('control point position must be finite');
  }
  const next = cloneDocument(doc);
  const vertex: Vertex = { x: position.x, y: position.y };
  if (pinned) vertex.pinned = true;
  next.vertices.push(vertex);
  return { document: next, index: next.vertices.length - 1 };
}
