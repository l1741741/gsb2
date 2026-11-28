/**
 * App-level tests: the controller ties commands, history and diagnostics
 * together. These run head-lessly in Node, exercising the same code the
 * browser runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { App, DEFAULT_VIEW } from '../src/app/app.ts';
import { localDetailHtml, seamListHtml, summaryHtml } from '../src/app/panels.ts';
import { buildDiagnostics } from '../src/core/diagnostics.ts';
import { parseFabricMesh } from '../src/core/formats.ts';
import { buildMeshJson } from '../src/core/export.ts';
import { quadGrid } from './fixtures.ts';

function sampleApp(name: 'gingham' | 'split' | 'flipped'): App {
  const text = readFileSync(new URL(`../samples/${name}.fabricmesh`, import.meta.url), 'utf8');
  return new App({ document: parseFabricMesh(text).document });
}

test('loading the gingham sample starts from a clean diagnostic state', () => {
  const app = sampleApp('gingham');
  assert.equal(app.diagnostics.flippedTriangles, 0);
  assert.equal(app.diagnostics.overStretchedTriangles, 0);
  assert.equal(app.diagnostics.accidentalSplits, 0);
});

test('dragging a control point changes diagnostics, and undo restores them exactly', () => {
  const app = sampleApp('gingham');
  const before = app.diagnostics.fingerprint;
  const started = app.beginVertexDrag(18);
  assert.equal(started, true);
  app.updateVertexDrag({ x: 400, y: 402 });
  app.endVertexDrag();
  const after = app.diagnostics.fingerprint;
  assert.notEqual(before, after);
  assert.ok(app.diagnostics.flippedTriangles >= 1);
  const undone = app.undo();
  assert.equal(undone, true);
  assert.equal(app.diagnostics.fingerprint, before);
  // Redo returns to the exact same bad state.
  assert.equal(app.redo(), true);
  assert.equal(app.diagnostics.fingerprint, after);
});

test('a full drag is exactly one undo step', () => {
  const app = sampleApp('gingham');
  app.beginVertexDrag(18);
  for (let i = 0; i < 10; i++) app.updateVertexDrag({ x: 300 + i, y: 300 + i * 2 });
  app.endVertexDrag();
  assert.equal(app.snapshot().history.depth, 1);
  assert.equal(app.snapshot().history.undoLabel, '拖动顶点 18');
});

test('cancelling a drag restores the pre-drag geometry and creates no step', () => {
  const app = sampleApp('gingham');
  app.beginVertexDrag(18);
  app.updateVertexDrag({ x: 999, y: 999 });
  app.cancelVertexDrag();
  assert.equal(app.snapshot().history.depth, 0);
  assert.equal(app.document.vertices[18].x, 300);
  assert.equal(app.document.vertices[18].y, 300);
});

test('pinned control points refuse dragging and say so', () => {
  const app = sampleApp('flipped');
  app.togglePinned(18);
  assert.equal(app.document.vertices[18].pinned, true);
  const started = app.beginVertexDrag(18);
  assert.equal(started, false);
  assert.ok(app.statusMessage.includes('固定'));
});

test('declaring and deleting a seam is undoable', () => {
  const app = sampleApp('gingham');
  // The sample ships with one declared seam; add a second on another edge.
  const existing = app.document.seams.length;
  assert.equal(app.declareSeam(0, 1, 'split', 'test-seam'), true);
  assert.equal(app.document.seams.length, existing + 1);
  assert.equal(app.undo(), true);
  assert.equal(app.document.seams.length, existing);
  assert.equal(app.redo(), true);
  assert.ok(app.document.seams.some((s) => s.id === 'test-seam'));
  assert.equal(app.removeSeam('test-seam'), true);
  assert.equal(app.document.seams.length, existing);
});

test('declaring a seam on non-adjacent triangles reports a reason and changes nothing', () => {
  const app = sampleApp('gingham');
  const before = app.document;
  assert.equal(app.declareSeam(0, 5, 'split', 'bad'), false);
  assert.equal(app.document, before);
  assert.ok(app.statusMessage.includes('没有共用'));
});

test('threshold edits are undoable and re-flow diagnostics', () => {
  const app = sampleApp('flipped');
  const before = app.diagnostics.fingerprint;
  assert.equal(app.updateThresholds({ stretchThreshold: 3 }), true);
  assert.notEqual(app.diagnostics.fingerprint, before);
  assert.equal(app.undo(), true);
  assert.equal(app.diagnostics.fingerprint, before);
});

test('bad patch mode is a view option and does not touch the document', () => {
  const app = sampleApp('flipped');
  const fingerprint = app.document.vertices.map((v) => `${v.x},${v.y}`).join(';');
  app.setBadPatchMode('disable');
  assert.equal(app.view.badPatchMode, 'disable');
  assert.equal(app.document.vertices.map((v) => `${v.x},${v.y}`).join(';'), fingerprint);
  app.setBadPatchMode('retain');
  assert.equal(app.view.badPatchMode, 'retain');
});

test('exported JSON reloads to the same fingerprint and diagnostics regardless of history', () => {
  const app = sampleApp('flipped');
  // Do and undo several edits first, so history is non-empty at export time.
  app.beginVertexDrag(18);
  app.updateVertexDrag({ x: 350, y: 350 });
  app.endVertexDrag();
  app.undo();
  const json = buildMeshJson(app.document, { textureDigest: null, now: () => new Date('2026-01-01T00:00:00Z') });
  const reloaded = new App({ document: quadGrid() });
  const report = reloaded.loadJson(json, 'exported.json');
  assert.equal(report.mismatches.length, 0, report.mismatches.join(' | '));
  assert.equal(
    buildDiagnostics(reloaded.document).documentFingerprint,
    buildDiagnostics(app.document).documentFingerprint,
  );
  assert.equal(reloaded.diagnostics.fingerprint, app.diagnostics.fingerprint);
  assert.equal(reloaded.snapshot().history.depth, 0);
});

test('summary and panel HTML render from a snapshot without a DOM', () => {
  const app = sampleApp('split');
  const snapshot = app.snapshot();
  const html = summaryHtml(snapshot);
  assert.ok(html.includes('断拼缝'));
  assert.ok(html.includes('连续拼缝'));
  const seams = seamListHtml(snapshot, app.resolvedSeams());
  assert.ok(seams.includes('seam-cut-0'));
  assert.ok(seams.includes('split-ok') || seams.includes('断开'));
  // Selecting a seam shows its sample table.
  app.select({ kind: 'seam', seam: 'seam-cut-0' });
  const detail = localDetailHtml(app.snapshot());
  assert.equal(detail.label, '拼缝 seam-cut-0');
  assert.ok(detail.html.includes('UV(A)'));
  // Selecting a triangle shows numeric diagnostics.
  app.select({ kind: 'triangle', triangle: 11 });
  const triangleDetail = localDetailHtml(app.snapshot());
  assert.ok(triangleDetail.html.includes('雅可比'));
});

test('undo/redo hotkeys are represented by controller state, not DOM events', () => {
  const app = sampleApp('gingham');
  assert.equal(app.snapshot().history.canUndo, false);
  app.beginVertexDrag(12);
  app.updateVertexDrag({ x: 250, y: 150 });
  app.endVertexDrag();
  assert.equal(app.snapshot().history.canUndo, true);
  assert.equal(app.undo(), true);
  assert.equal(app.snapshot().history.canRedo, true);
  assert.equal(app.redo(), true);
});

test('default view options are the documented ones', () => {
  const app = sampleApp('gingham');
  assert.deepEqual(app.view, DEFAULT_VIEW);
  assert.equal(DEFAULT_VIEW.badPatchMode, 'retain');
  assert.equal(DEFAULT_VIEW.showBoundary, true);
  assert.equal(DEFAULT_VIEW.showSeams, true);
});
