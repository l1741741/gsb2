/**
 * Command stack with undo/redo.
 *
 * Each entry is an immutable snapshot pair of the MeshDocument. Snapshots are
 * cheap (documents are small) and make undo order-independent: undoing
 * restores exact geometry, so diagnostics after undo match diagnostics at the
 * moment that state was first reached.
 *
 * A drag is coalesced: `beginDrag` records the pre-drag document, updates
 * during the drag replace the pending document, and `endDrag` commits one
 * undo step. A drag that ends where it started commits nothing.
 */

import type { MeshDocument } from './types.ts';

export interface HistoryEntry {
  label: string;
  before: MeshDocument;
  after: MeshDocument;
}

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  depth: number;
  index: number;
}

export interface HistoryOptions {
  /** Maximum retained undo steps. */
  limit?: number;
  /** Called whenever the stack changes. */
  onChange?: () => void;
}

export class History {
  #entries: HistoryEntry[] = [];
  #index = 0;
  #limit: number;
  #onChange: () => void;
  #dragBefore: MeshDocument | null = null;
  #dragLabel = '';

  constructor(options: HistoryOptions = {}) {
    this.#limit = Math.max(1, options.limit ?? 200);
    this.#onChange = options.onChange ?? (() => {});
  }

  get state(): HistoryState {
    const undoEntry = this.#index > 0 ? this.#entries[this.#index - 1] : null;
    const redoEntry = this.#index < this.#entries.length ? this.#entries[this.#index] : null;
    return {
      canUndo: this.#index > 0,
      canRedo: this.#index < this.#entries.length,
      undoLabel: undoEntry?.label ?? null,
      redoLabel: redoEntry?.label ?? null,
      depth: this.#entries.length,
      index: this.#index,
    };
  }

  get dragging(): boolean {
    return this.#dragBefore !== null;
  }

  /** Records a committed change. A no-op change (identical document) is ignored. */
  push(label: string, before: MeshDocument, after: MeshDocument): void {
    if (sameDocument(before, after)) return;
    this.#entries.length = this.#index;
    this.#entries.push({ label, before, after });
    if (this.#entries.length > this.#limit) {
      this.#entries.splice(0, this.#entries.length - this.#limit);
    }
    this.#index = this.#entries.length;
    this.#onChange();
  }

  /** Starts a coalesced drag. Call before the first mutation of the gesture. */
  beginDrag(label: string, before: MeshDocument): void {
    this.#dragBefore = before;
    this.#dragLabel = label;
  }

  /** Ends the drag, committing a single step if anything changed. */
  endDrag(after: MeshDocument): void {
    const before = this.#dragBefore;
    const label = this.#dragLabel;
    this.#dragBefore = null;
    this.#dragLabel = '';
    if (!before) return;
    this.push(label, before, after);
  }

  /** Aborts a drag and returns the document to restore, or null. */
  cancelDrag(): MeshDocument | null {
    const before = this.#dragBefore;
    this.#dragBefore = null;
    this.#dragLabel = '';
    return before;
  }

  /**
   * Returns the snapshot to restore, or null at the bottom of the stack.
   * The recorded `before` is authoritative: undo restores the exact state the
   * step started from, even if the live document drifted.
   */
  undo(): MeshDocument | null {
    if (this.#index === 0) return null;
    const entry = this.#entries[this.#index - 1];
    this.#index -= 1;
    this.#onChange();
    return cloneDocument(entry.before);
  }

  redo(): MeshDocument | null {
    if (this.#index >= this.#entries.length) return null;
    const entry = this.#entries[this.#index];
    this.#index += 1;
    this.#onChange();
    return cloneDocument(entry.after);
  }

  clear(): void {
    this.#entries = [];
    this.#index = 0;
    this.#dragBefore = null;
    this.#dragLabel = '';
    this.#onChange();
  }
}

export function cloneDocument(doc: MeshDocument): MeshDocument {
  const clone: MeshDocument = {
    format: doc.format,
    version: doc.version,
    texture: { ...doc.texture },
    vertices: doc.vertices.map((v) => ({ ...v })),
    triangles: doc.triangles.map((t) => ({
      id: t.id,
      vertices: [t.vertices[0], t.vertices[1], t.vertices[2]],
      uvs: [{ ...t.uvs[0] }, { ...t.uvs[1] }, { ...t.uvs[2] }],
    })),
    seams: doc.seams.map((s) => ({
      id: s.id,
      triangles: [s.triangles[0], s.triangles[1]],
      kind: s.kind,
    })),
    diagnostics: { ...doc.diagnostics },
  };
  if (doc.exported) clone.exported = { ...doc.exported };
  return clone;
}

export function sameDocument(a: MeshDocument, b: MeshDocument): boolean {
  if (a.vertices.length !== b.vertices.length) return false;
  for (let i = 0; i < a.vertices.length; i++) {
    if (a.vertices[i].x !== b.vertices[i].x || a.vertices[i].y !== b.vertices[i].y) return false;
    if (Boolean(a.vertices[i].pinned) !== Boolean(b.vertices[i].pinned)) return false;
  }
  if (a.triangles.length !== b.triangles.length) return false;
  for (let i = 0; i < a.triangles.length; i++) {
    const ta = a.triangles[i];
    const tb = b.triangles[i];
    if (ta.id !== tb.id) return false;
    if (ta.vertices[0] !== tb.vertices[0] || ta.vertices[1] !== tb.vertices[1] || ta.vertices[2] !== tb.vertices[2]) return false;
    for (let k = 0; k < 3; k++) {
      if (ta.uvs[k].x !== tb.uvs[k].x || ta.uvs[k].y !== tb.uvs[k].y) return false;
    }
  }
  if (a.seams.length !== b.seams.length) return false;
  for (let i = 0; i < a.seams.length; i++) {
    const sa = a.seams[i];
    const sb = b.seams[i];
    if (sa.id !== sb.id || sa.kind !== sb.kind) return false;
    if (sa.triangles[0] !== sb.triangles[0] || sa.triangles[1] !== sb.triangles[1]) return false;
  }
  return (
    a.diagnostics.stretchThreshold === b.diagnostics.stretchThreshold &&
    a.diagnostics.collapseThreshold === b.diagnostics.collapseThreshold &&
    a.diagnostics.seamTolerance === b.diagnostics.seamTolerance
  );
}
