/**
 * Application controller: owns the document, history, selection, view
 * options and camera. The DOM layer only reads from it and calls commands.
 *
 * Keeping the controller DOM-free means it can be driven head-to-head in tests
 * and in the browser smoke test without a page.
 */

import { buildDiagnostics, resolveSeams, weldTopology } from '../core/diagnostics.ts';
import { normalizeDocument, withTextureInfo } from '../core/document.ts';
import { importMeshJson, importMeshText, type ImportReport } from '../core/importer.ts';
import { History, cloneDocument, type HistoryState } from '../core/history.ts';
import {
  addControlPoint,
  declareSeam,
  moveControlPoint,
  removeSeam,
  renameSeam,
  setCornerUv,
  setPinned,
  setThresholds,
} from '../core/editor.ts';

import type {
  BadPatchMode,
  DiagnosticsSnapshot,
  MeshDocument,
  Selection,
  Vec2,
  ViewChannel,
  ViewOptions,
} from '../core/types.ts';

export interface AppOptions {
  document: MeshDocument;
  /** Called whenever anything observable changes. */
  onChange?: () => void;
  /** Maximum undo depth. */
  historyLimit?: number;
}

export interface CameraState {
  centerX: number;
  centerY: number;
  scale: number;
}

export interface Snapshot {
  document: MeshDocument;
  diagnostics: DiagnosticsSnapshot;
  history: HistoryState;
  selection: Selection;
  view: ViewOptions;
  camera: CameraState;
  statusMessage: string;
  importReport: ImportReport | null;
}

const DEFAULT_VIEW: ViewOptions = {
  channel: 'texture',
  showGrid: false,
  showBoundary: true,
  showSeams: true,
  showHandles: true,
  showUvLabels: true,
  badPatchMode: 'retain',
};

export class App {
  #document: MeshDocument;
  #diagnostics: DiagnosticsSnapshot;
  #history: History;
  #selection: Selection = { kind: 'none' };
  #view: ViewOptions = { ...DEFAULT_VIEW };
  #camera: CameraState = { centerX: 0, centerY: 0, scale: 1 };
  #status = '';
  #importReport: ImportReport | null = null;
  #onChange: () => void;
  #dragBefore: MeshDocument | null = null;
  #dragLabel = '';
  /** Start state of a repeated-edit gesture (UV drags), committed on end. */
  #pendingGesture: { label: string; base: MeshDocument } | null = null;

  constructor(options: AppOptions) {
    this.#document = cloneDocument(options.document);
    this.#diagnostics = buildDiagnostics(this.#document);
    this.#onChange = options.onChange ?? (() => {});
    this.#history = new History({
      limit: options.historyLimit ?? 200,
      onChange: () => this.#emit(),
    });
    this.#frameDocument();
  }

  /* ---------------------------------------------------------- accessors */

  get document(): MeshDocument {
    return this.#document;
  }

  get diagnostics(): DiagnosticsSnapshot {
    return this.#diagnostics;
  }

  get camera(): CameraState {
    return this.#camera;
  }

  get selection(): Selection {
    return this.#selection;
  }

  get view(): ViewOptions {
    return this.#view;
  }

  get statusMessage(): string {
    return this.#status;
  }

  get dragging(): boolean {
    return this.#dragBefore !== null;
  }

  get importReport(): ImportReport | null {
    return this.#importReport;
  }

  snapshot(): Snapshot {
    return {
      document: this.#document,
      diagnostics: this.#diagnostics,
      history: this.#history.state,
      selection: this.#selection,
      view: this.#view,
      camera: this.#camera,
      statusMessage: this.#status,
      importReport: this.#importReport,
    };
  }

  /* ------------------------------------------------------------ mutation */

  #emit(): void {
    this.#diagnostics = buildDiagnostics(this.#document);
    this.#onChange();
  }

  #commit(label: string, next: MeshDocument): void {
    if (next === this.#document) return;
    this.#history.push(label, this.#document, next);
    this.#document = next;
    this.#emit();
  }

  /**
   * Replaces the document from a specific base, for repeated edits during a
   * gesture (UV drags). The history entry is committed once per gesture by the
   * caller, which records `base` as the before-state.
   */
  replaceDocument(label: string, next: MeshDocument, base: MeshDocument): void {
    if (next === base) return;
    this.#document = next;
    this.#pendingGesture = { label, base };
    this.#emit();
  }

  /** Commits a single non-gesture document replacement as one undo step. */
  moveWithHistory(label: string, next: MeshDocument): void {
    this.#commit(label, next);
  }

  /** Live document during a drag, for instrumentation and tests. */
  get liveDragSnapshot(): MeshDocument | null {
    return this.#dragBefore;
  }

  #frameDocument(): void {
    const topology = weldTopology(this.#document.vertices);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of topology.weldPosition) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) return;
    this.#camera.centerX = (minX + maxX) / 2;
    this.#camera.centerY = (minY + maxY) / 2;
    this.#cameraExtent = Math.max(maxX - minX, maxY - minY, 1);
  }

  #cameraExtent = 1;

  /** Fits the whole mesh into a viewport of the given CSS size. */
  fitToViewport(width: number, height: number, margin = 1.15): void {
    const extent = this.#cameraExtent;
    const scale = Math.min(width, height) / (extent * margin);
    this.#camera.scale = Math.max(0.05, scale);
    this.#emit();
  }

  setCamera(camera: Partial<CameraState>): void {
    if (camera.centerX !== undefined) this.#camera.centerX = camera.centerX;
    if (camera.centerY !== undefined) this.#camera.centerY = camera.centerY;
    if (camera.scale !== undefined) this.#camera.scale = Math.max(0.02, Math.min(200, camera.scale));
    this.#emit();
  }

  zoomAt(factor: number, anchorX: number, anchorY: number): void {
    const newScale = Math.max(0.02, Math.min(200, this.#camera.scale * factor));
    const ratio = this.#camera.scale / newScale;
    this.#camera.centerX = anchorX + (this.#camera.centerX - anchorX) * ratio;
    this.#camera.centerY = anchorY + (this.#camera.centerY - anchorY) * ratio;
    this.#camera.scale = newScale;
    this.#emit();
  }

  panBy(dx: number, dy: number): void {
    this.#camera.centerX -= dx / this.#camera.scale;
    this.#camera.centerY -= dy / this.#camera.scale;
    this.#emit();
  }

  /* ---------------------------------------------------------- selection */

  select(selection: Selection): void {
    this.#selection = selection;
    this.#emit();
  }

  clearSelection(): void {
    this.#selection = { kind: 'none' };
    this.#emit();
  }

  setStatus(message: string): void {
    this.#status = message;
    this.#emit();
  }

  setViewOptions(patch: Partial<ViewOptions>): void {
    this.#view = { ...this.#view, ...patch };
    this.#emit();
  }

  setBadPatchMode(mode: BadPatchMode): void {
    this.#view = { ...this.#view, badPatchMode: mode };
    this.#emit();
  }

  setChannel(channel: ViewChannel): void {
    this.#view = { ...this.#view, channel };
    this.#emit();
  }

  /* ------------------------------------------------------------- dragging */

  /** Starts a drag on a control point; returns false if the vertex is not draggable. */
  beginVertexDrag(index: number): boolean {
    if (!this.#document.vertices[index]) return false;
    if (this.#document.vertices[index].pinned) {
      this.#status = '该控制点已固定，无法拖动';
      this.#emit();
      return false;
    }
    const group = weldTopology(this.#document.vertices);
    const weld = group.vertexWeld[index];
    const members = this.#document.vertices.filter((_, i) => group.vertexWeld[i] === weld);
    if (members.some((v) => v.pinned)) {
      this.#status = '该控制点与固定点重合，无法单独拖动';
      this.#emit();
      return false;
    }
    this.#dragBefore = this.#document;
    this.#dragLabel = `拖动顶点 ${index}`;
    this.#history.beginDrag(this.#dragLabel, this.#document);
    this.#selection = { kind: 'vertex', vertex: index };
    this.#status = '';
    this.#emit();
    return true;
  }

  /** Moves the dragged control point to a fabric position (live, uncommitted). */
  updateVertexDrag(position: Vec2): void {
    if (!this.#dragBefore || this.#selection.kind !== 'vertex' || this.#selection.vertex === undefined) return;
    const { document, moved } = moveControlPoint(this.#document, this.#selection.vertex, position);
    if (moved.length === 0) return;
    this.#document = document;
    this.#emit();
  }

  /** Commits the drag as one undo step. */
  endVertexDrag(): void {
    if (!this.#dragBefore) return;
    this.#dragBefore = null;
    this.#history.endDrag(this.#document);
    this.#emit();
  }

  /** Cancels a drag, restoring the pre-drag document. */
  cancelVertexDrag(): void {
    if (!this.#dragBefore) return;
    this.#dragBefore = null;
    const before = this.#history.cancelDrag();
    if (before) {
      this.#document = before;
      this.#emit();
    }
  }

  /* ------------------------------------------------------------- commands */

  undo(): boolean {
    if (this.#history.state.canUndo === false) {
      this.#status = '没有可撤销的操作';
      this.#emit();
      return false;
    }
    const restored = this.#history.undo();
    if (!restored) return false;
    this.#document = restored;
    this.#status = '';
    this.#emit();
    return true;
  }

  redo(): boolean {
    const restored = this.#history.redo();
    if (!restored) {
      this.#status = '没有可重做的操作';
      this.#emit();
      return false;
    }
    this.#document = restored;
    this.#status = '';
    this.#emit();
    return true;
  }

  togglePinned(index: number): void {
    if (!this.#document.vertices[index]) return;
    const pinned = !this.#document.vertices[index].pinned;
    const next = setPinned(this.#document, index, pinned);
    this.#commit(pinned ? `固定顶点 ${index}` : `取消固定顶点 ${index}`, next);
  }

  setCorner(triangleId: number, corner: 0 | 1 | 2, uv: Vec2): void {
    const before = this.#document;
    const next = setCornerUv(before, triangleId, corner, uv);
    this.#commit(`设置三角形 ${triangleId} 角点 ${corner} 的 UV`, next);
  }

  declareSeam(triangleA: number, triangleB: number, kind: 'continuous' | 'split', id: string): boolean {
    const result = declareSeam(this.#document, triangleA, triangleB, kind, id);
    if (result.reason) {
      this.#status = result.reason;
      this.#emit();
      return false;
    }
    this.#commit(`声明拼缝 ${id} (${kind})`, result.document);
    return true;
  }

  removeSeam(id: string): boolean {
    const before = this.#document;
    const next = removeSeam(before, id);
    if (next === before) return false;
    this.#commit(`删除拼缝 ${id}`, next);
    return true;
  }

  renameSeam(id: string, nextId: string): boolean {
    const before = this.#document;
    const next = renameSeam(before, id, nextId);
    if (next === before) {
      this.#status = '拼缝 id 为空或已重复';
      this.#emit();
      return false;
    }
    this.#commit(`重命名拼缝 ${id} → ${nextId}`, next);
    return true;
  }

  updateThresholds(patch: Partial<MeshDocument['diagnostics']>): boolean {
    try {
      const next = setThresholds(this.#document, patch);
      this.#commit('调整诊断阈值', next);
      return true;
    } catch (error) {
      this.#status = (error as Error).message;
      this.#emit();
      return false;
    }
  }

  addControlPoint(position: Vec2, pinned = false): number {
    const { document, index } = addControlPoint(this.#document, position, pinned);
    this.#commit(`新增控制点 ${index}`, document);
    return index;
  }

  /** Loads a new document, resetting history, selection and camera framing. */
  load(document: MeshDocument, report: ImportReport | null = null): void {
    this.#document = cloneDocument(normalizeDocument(document));
    this.#history.clear();
    this.#selection = { kind: 'none' };
    this.#importReport = report;
    this.#status = report?.summary ?? '';
    this.#frameDocument();
    this.#emit();
  }

  loadJson(text: string, fileName: string): ImportReport {
    const report = importMeshJson(text, fileName);
    const document = report.document;
    this.load(document, report);
    return report;
  }

  loadText(text: string, fileName: string): ImportReport {
    const report = importMeshText(text, fileName);
    const document = report.document;
    this.load(document, report);
    return report;
  }

  /** Attaches texture metadata after the PNG is decoded (no undo step). */
  attachTexture(name: string, width: number, height: number): void {
    const next = withTextureInfo(this.#document, name, width, height);
    this.#document = next;
    this.#emit();
  }

  /** Ends a repeated-edit gesture, committing one undo step. */
  commitGesture(): void {
    const pending = this.#pendingGesture;
    this.#pendingGesture = null;
    if (!pending) return;
    if (pending.base === this.#document) return;
    this.#history.push(pending.label, pending.base, this.#document);
    this.#emit();
  }

  /** Cancels a repeated-edit gesture, restoring its start document. */
  cancelGesture(): void {
    const pending = this.#pendingGesture;
    this.#pendingGesture = null;
    if (!pending) return;
    this.#document = pending.base;
    this.#emit();
  }

  /** Resolved seams for panels and overlays. */
  resolvedSeams() {
    return resolveSeams(this.#document);
  }
}

export { DEFAULT_VIEW };
