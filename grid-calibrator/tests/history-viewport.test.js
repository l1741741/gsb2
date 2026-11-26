import test from 'node:test';
import assert from 'node:assert/strict';

import { movePoint, UndoStack, createDocument } from '../src/state.js';
import { screenToImage, zoomAt, fitView } from '../src/viewport.js';

test('a coalesced marker drag can be undone back to the pre-drag position', () => {
  const doc = createDocument({
    points: [{ id: 'p1', col: 2, row: 3, x: 100, y: 120, role: 'fit' }],
  });
  const history = new UndoStack(doc);

  // Pointer moves produce immutable transient documents.
  let dragging = movePoint(doc, 'p1', 104, 126);
  dragging = movePoint(dragging, 'p1', 110, 132);
  assert.equal(dragging.points[0].x, 110);

  // Pointer-up commits one history entry for the whole drag.
  history.commit(dragging);
  assert.equal(history.current.points[0].x, 110);
  assert.equal(history.canUndo, true);

  const undone = history.undo();
  assert.equal(undone.points[0].x, 100);
  assert.equal(undone.points[0].y, 120);

  const redone = history.redo();
  assert.equal(redone.points[0].x, 110);
  assert.equal(redone.points[0].y, 132);
});

test('screen-to-image conversion stays aligned after zoom and pan', () => {
  let view = fitView(1000, 800, 800, 600);
  const rect = { left: 40, top: 20 };

  const before = screenToImage(
    rect.left + 400,
    rect.top + 300,
    rect,
    view,
  );
  view = zoomAt(view, 400, 300, 2);
  const after = screenToImage(
    rect.left + 400,
    rect.top + 300,
    rect,
    view,
  );

  assert.ok(Math.abs(before.x - after.x) < 1e-10);
  assert.ok(Math.abs(before.y - after.y) < 1e-10);

  view.x += 37;
  view.y -= 19;
  const p = screenToImage(rect.left + 250, rect.top + 180, rect, view);
  const expectedX = (250 - view.x) / view.scale;
  assert.equal(p.x, expectedX);
});
