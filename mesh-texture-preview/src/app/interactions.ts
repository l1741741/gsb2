/**
 * DOM-independent interactions used by the browser controller.
 *
 * Picking and dragging math lives here so the browser smoke test can exercise
 * it head-lessly, without synthesising pointer events.
 */

import { pickInFabric, pickInTexture, paneToWorld } from '../core/picking.ts';
import { moveControlPoint, setCornerUv } from '../core/editor.ts';
import { weldTopology } from '../core/diagnostics.ts';
import type { MeshDocument, Selection, Vec2 } from '../core/types.ts';
import type { App } from './app.ts';

export interface FabricPaneGeometry {
  /** CSS pixels of the fabric pane. */
  width: number;
  height: number;
  offsetX: number;
}

/**
 * Pointer-down in the fabric pane. Returns the resulting selection, or a drag
 * handle descriptor the controller should keep until pointer-up.
 */
export function pointerDownFabric(
  app: App,
  pane: FabricPaneGeometry,
  cssX: number,
  cssY: number,
): { dragging: boolean; selection: Selection } {
  const localX = cssX - pane.offsetX;
  const rect = { width: pane.width, height: pane.height };
  const camera = app.camera;
  const hit = pickInFabric(app.document, camera, rect, localX, cssY);
  if (hit.kind === 'vertex' && hit.vertex !== null) {
    const started = app.beginVertexDrag(hit.vertex);
    return { dragging: started, selection: { kind: 'vertex', vertex: hit.vertex } };
  }
  if (hit.kind === 'seam' && hit.seamId !== null) {
    app.select({ kind: 'seam', seam: hit.seamId });
    return { dragging: false, selection: { kind: 'seam', seam: hit.seamId } };
  }
  if (hit.kind === 'triangle' && hit.triangleId !== null) {
    app.select({ kind: 'triangle', triangle: hit.triangleId });
    return { dragging: false, selection: { kind: 'triangle', triangle: hit.triangleId } };
  }
  app.clearSelection();
  return { dragging: false, selection: { kind: 'none' } };
}

/** Pointer-move during a vertex drag. */
export function pointerMoveFabric(
  app: App,
  pane: FabricPaneGeometry,
  cssX: number,
  cssY: number,
): void {
  if (!app.dragging) return;
  const localX = cssX - pane.offsetX;
  const rect = { width: pane.width, height: pane.height };
  const world = paneToWorld(app.camera, rect, localX, cssY);
  app.updateVertexDrag(world);
}

/** Pointer-up ends a drag. */
export function pointerUpFabric(app: App, cancelled = false): void {
  if (!app.dragging) return;
  if (cancelled) app.cancelVertexDrag();
  else app.endVertexDrag();
}

/**
 * Pointer-down in the texture pane. Dragging a corner edits that corner's UV,
 * which is how a split seam is created or repaired. The returned `base` is the
 * document at gesture start; call `endUvDrag` on pointer-up to commit one step.
 */
export function pointerDownTexture(
  app: App,
  pane: FabricPaneGeometry,
  cssX: number,
  cssY: number,
): {
  editing: { triangleId: number; corner: 0 | 1 | 2; base: MeshDocument } | null;
  selection: Selection;
} {
  const localX = cssX - pane.offsetX;
  const rect = { width: pane.width, height: pane.height };
  const hit = pickInTexture(app.document, rect, localX, cssY);
  if (hit.triangleId !== null && hit.corner !== null) {
    app.select({ kind: 'triangle', triangle: hit.triangleId });
    return {
      editing: { triangleId: hit.triangleId, corner: hit.corner, base: app.document },
      selection: app.selection,
    };
  }
  if (hit.triangleId !== null) {
    app.select({ kind: 'triangle', triangle: hit.triangleId });
    return { editing: null, selection: app.selection };
  }
  app.clearSelection();
  return { editing: null, selection: { kind: 'none' } };
}

/**
 * Applies a UV delta to a triangle corner. Uses the document captured at
 * pointer-down so repeated moves during a drag accumulate correctly.
 */
export function applyUvDrag(
  app: App,
  editing: { triangleId: number; corner: 0 | 1 | 2; base: MeshDocument },
  delta: Vec2,
): void {
  const tri = editing.base.triangles.find((t) => t.id === editing.triangleId);
  if (!tri) return;
  const uv = { x: tri.uvs[editing.corner].x + delta.x, y: tri.uvs[editing.corner].y + delta.y };
  const next = setCornerUv(editing.base, editing.triangleId, editing.corner, uv);
  app.replaceDocument('拖动 UV 角点', next, editing.base);
}

/** Commits or cancels a UV drag. */
export function endUvDrag(app: App, cancelled = false): void {
  if (cancelled) app.cancelGesture();
  else app.commitGesture();
}

/**
 * Finds which fabric edge two triangles share, if exactly one, and returns the
 * edge endpoints. Used by the seam declaration panel.
 */
export function sharedEdge(doc: MeshDocument, a: number, b: number): { vertices: [number, number]; kind: 'shared' } | { reason: string } {
  const topology = weldTopology(doc.vertices);
  const triA = doc.triangles.find((t) => t.id === a);
  const triB = doc.triangles.find((t) => t.id === b);
  if (!triA || !triB) return { reason: '三角形不存在' };
  const welds: number[] = [];
  for (const va of triA.vertices) {
    for (const vb of triB.vertices) {
      const w = topology.vertexWeld[va];
      if (topology.vertexWeld[vb] === w && !welds.includes(w)) welds.push(w);
    }
  }
  if (welds.length !== 2) return { reason: '两个三角形没有共用一条边' };
  const representative = (w: number): number => topology.weldVertex[w];
  return { vertices: [representative(welds[0]), representative(welds[1])], kind: 'shared' };
}

/** Moves a welded group by a fixed delta (used for keyboard nudging). */
export function nudgeControlPoint(app: App, index: number, delta: Vec2): void {
  const base = app.document.vertices[index];
  if (!base) return;
  const next = moveControlPoint(app.document, index, { x: base.x + delta.x, y: base.y + delta.y });
  if (next.moved.length === 0) return;
  app.moveWithHistory('微调控制点', next.document);
}

export { pickInFabric, pickInTexture, paneToWorld };
