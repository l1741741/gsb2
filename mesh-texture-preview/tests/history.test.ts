import test from 'node:test';
import assert from 'node:assert/strict';
import { History, cloneDocument, sameDocument } from '../src/core/history.ts';
import { normalizeDocument, MeshFormatError, DEFAULT_DIAGNOSTICS } from '../src/core/document.ts';
import { declareSeam, moveControlPoint, setCornerUv, setPinned, weldedGroup } from '../src/core/editor.ts';
import { buildDiagnostics, documentFingerprint } from '../src/core/diagnostics.ts';
import { quadGrid, splitPair } from './fixtures.ts';

test('history records steps, undoes and redoes exact documents', () => {
  const a = quadGrid();
  const b = cloneDocument(a);
  b.vertices[4] = { x: 120, y: 140 };
  const history = new History();
  history.push('move', a, b);
  assert.equal(history.state.canUndo, true);
  assert.equal(history.state.canRedo, false);
  const undone = history.undo();
  assert.ok(undone);
  assert.equal(documentFingerprint(undone), documentFingerprint(a));
  assert.equal(history.state.canUndo, false);
  assert.equal(history.state.canRedo, true);
  const redone = history.redo();
  assert.ok(redone);
  assert.equal(documentFingerprint(redone), documentFingerprint(b));
});

test('history ignores a no-op push', () => {
  const a = quadGrid();
  const history = new History();
  history.push('noop', a, cloneDocument(a));
  assert.equal(history.state.depth, 0);
  assert.equal(history.state.canUndo, false);
});

test('a new push after undo discards the redo branch', () => {
  const a = quadGrid();
  const b = cloneDocument(a);
  b.vertices[0] = { x: 5, y: 5 };
  const c = cloneDocument(b);
  c.vertices[0] = { x: 9, y: 9 };
  const history = new History();
  history.push('one', a, b);
  history.push('two', b, c);
  history.undo();
  history.push('three', a, b);
  assert.equal(history.state.canRedo, false);
});

test('a drag coalesces into one undo step', () => {
  const a = quadGrid();
  const history = new History();
  let current = a;
  history.beginDrag('drag vertex 4', a);
  for (let step = 1; step <= 5; step++) {
    current = cloneDocument(a);
    current.vertices[4] = { x: 100 + step, y: 100 + step };
  }
  history.endDrag(current);
  assert.equal(history.state.depth, 1);
  assert.equal(history.state.undoLabel, 'drag vertex 4');
});

test('a drag that ends where it started commits nothing', () => {
  const a = quadGrid();
  const history = new History();
  history.beginDrag('drag', a);
  const same = cloneDocument(a);
  history.endDrag(same);
  assert.equal(history.state.depth, 0);
  assert.equal(history.dragging, false);
});

test('a cancelled drag returns the pre-drag document', () => {
  const a = quadGrid();
  const history = new History();
  history.beginDrag('drag', a);
  // The live document during a drag is held by the caller; cancelling returns
  // the pre-drag state recorded by beginDrag.
  const restored = history.cancelDrag();
  assert.ok(restored);
  assert.equal(documentFingerprint(restored), documentFingerprint(a));
  assert.equal(history.state.depth, 0);
});

test('moving a control point moves every welded duplicate together', () => {
  const doc = splitPair(0.25);
  const group = weldedGroup(doc, 1);
  assert.deepEqual(group.sort(), [1, 3]);
  const result = moveControlPoint(doc, 1, { x: 120, y: 10 });
  assert.equal(result.document.vertices[1].x, 120);
  assert.equal(result.document.vertices[3].x, 120);
  // UVs are untouched: moving fabric stretches the texture.
  assert.deepEqual(result.document.triangles[1].uvs[1], doc.triangles[1].uvs[1]);
});

test('moveControlPoint refuses to move a pinned group', () => {
  const doc = splitPair(0.25);
  const pinned = setPinned(doc, 1, true);
  const result = moveControlPoint(pinned, 1, { x: 999, y: 0 });
  assert.equal(result.moved.length, 0);
  assert.equal(result.document.vertices[1].x, doc.vertices[1].x);
});

test('setPinned marks the whole welded group and clearing removes the flag', () => {
  const doc = splitPair(0.25);
  const pinned = setPinned(doc, 1, true);
  assert.equal(pinned.vertices[1].pinned, true);
  assert.equal(pinned.vertices[3].pinned, true);
  const cleared = setPinned(pinned, 3, false);
  assert.equal(cleared.vertices[1].pinned, undefined);
  assert.equal(cleared.vertices[3].pinned, undefined);
});

test('setCornerUv edits exactly one corner of one triangle', () => {
  const doc = quadGrid();
  const next = setCornerUv(doc, 2, 1, { x: 0.75, y: 0.25 });
  assert.deepEqual(next.triangles[2].uvs[1], { x: 0.75, y: 0.25 });
  // Every other corner is untouched.
  assert.deepEqual(next.triangles[2].uvs[0], doc.triangles[2].uvs[0]);
  assert.deepEqual(next.triangles[3].uvs, doc.triangles[3].uvs);
});

test('declareSeam on a shared edge updates the intent, keeping one declaration', () => {
  const doc = quadGrid();
  const first = declareSeam(doc, 0, 1, 'continuous', 'my-seam');
  assert.equal(first.reason, undefined);
  assert.equal(first.document.seams.length, 1);
  assert.equal(first.document.seams[0].id, 'my-seam');
  // Redeclaring the same triangles switches the kind on the existing entry.
  const second = declareSeam(first.document, 1, 0, 'split', 'ignored');
  assert.equal(second.document.seams.length, 1);
  assert.equal(second.document.seams[0].kind, 'split');
  assert.equal(second.document.seams[0].id, 'my-seam');
});

test('declareSeam rejects non-adjacent triangles with a reason', () => {
  const doc = quadGrid();
  const result = declareSeam(doc, 0, 2, 'split', 'bad');
  assert.ok(result.reason);
  assert.equal(result.document, doc);
});

test('normalizeDocument fills defaults and deep-copies input', () => {
  const raw = {
    format: 'fabric-mesh-preview',
    version: 1,
    vertices: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    triangles: [{ vertices: [0, 1, 2], uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }],
  };
  const doc = normalizeDocument(raw);
  assert.deepEqual(doc.diagnostics, DEFAULT_DIAGNOSTICS);
  assert.equal(doc.triangles[0].id, 0);
  assert.deepEqual(doc.seams, []);
  (raw.vertices[0] as { x: number }).x = 99;
  assert.equal(doc.vertices[0].x, 0, 'input must not be aliased');
});

test('normalizeDocument reports every structural problem at once', () => {
  assert.throws(() => {
    normalizeDocument({
      format: 'wrong',
      version: 2,
      vertices: [{ x: 0, y: 0 }, { x: 'nope', y: 0 }, { x: 0, y: 1 }],
      triangles: [{ vertices: [0, 1, 9], uvs: [{ x: 0, y: 0 }] }],
      seams: [{ id: 's', triangles: [0, 0], kind: 'weird' }],
    });
  }, (error: unknown) => {
    assert.ok(error instanceof MeshFormatError);
    assert.ok(error.problems.length >= 5, `problems: ${error.problems.join(' | ')}`);
    return true;
  });
});

test('undo after an edit restores diagnostics exactly', () => {
  const doc = quadGrid();
  const before = buildDiagnostics(doc);
  const moved = moveControlPoint(doc, 4, { x: 160, y: 160 });
  const after = buildDiagnostics(moved.document);
  assert.notEqual(before.fingerprint, after.fingerprint);
  const history = new History();
  history.push('move', doc, moved.document);
  const restored = history.undo();
  assert.ok(restored);
  assert.equal(buildDiagnostics(restored).fingerprint, before.fingerprint);
});

test('sameDocument compares geometry, UVs, seams and thresholds', () => {
  const a = quadGrid();
  const b = cloneDocument(a);
  assert.equal(sameDocument(a, b), true);
  b.diagnostics.stretchThreshold = 1.5;
  assert.equal(sameDocument(a, b), false);
  const c = cloneDocument(a);
  c.seams = [{ id: 'x', triangles: [0, 1], kind: 'continuous' }];
  assert.equal(sameDocument(a, c), false);
});
