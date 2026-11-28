/**
 * Picking and pane-transform tests.
 *
 * Picking must agree with the transforms the view uses, so these tests pin
 * down both directions of the mapping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  paneToUv,
  paneToWorld,
  pickInFabric,
  pickInTexture,
  pxToUvDelta,
  uvToPane,
  worldToPane,
} from '../src/core/picking.ts';
import { quadGrid } from './fixtures.ts';

const camera = { centerX: 100, centerY: 100, scale: 2 };
const rect = { width: 400, height: 400 };

test('pane/world transforms round-trip', () => {
  const pane = worldToPane(camera, rect, { x: 150, y: 50 });
  const back = paneToWorld(camera, rect, pane.x, pane.y);
  assert.ok(Math.abs(back.x - 150) < 1e-9);
  assert.ok(Math.abs(back.y - 50) < 1e-9);
  // World centre maps to the pane centre.
  const centre = worldToPane(camera, rect, { x: 100, y: 100 });
  assert.deepEqual(centre, { x: 200, y: 200 });
});

test('uv/pane transforms round-trip and centre on the unit square', () => {
  const pane = uvToPane(rect, { x: 0.5, y: 0.5 });
  assert.deepEqual(pane, { x: 200, y: 200 });
  const back = paneToUv(rect, pane.x, pane.y);
  assert.ok(Math.abs(back.x - 0.5) < 1e-9);
  assert.ok(Math.abs(back.y - 0.5) < 1e-9);
});

test('pxToUvDelta matches the uv/pane scale', () => {
  const delta = pxToUvDelta(rect, 10, -10);
  const a = uvToPane(rect, { x: 0.5, y: 0.5 });
  const b = uvToPane(rect, { x: 0.5 + delta.x, y: 0.5 + delta.y });
  assert.ok(Math.abs(b.x - a.x - 10) < 1e-9);
  assert.ok(Math.abs(b.y - a.y + 10) < 1e-9);
});

test('picking prioritises control points over seams over triangles', () => {
  const doc = quadGrid();
  // A point exactly on vertex 4 (100, 100).
  const onVertex = worldToPane(camera, rect, { x: 100, y: 100 });
  const vertexHit = pickInFabric(doc, camera, rect, onVertex.x, onVertex.y);
  assert.equal(vertexHit.kind, 'vertex');
  assert.equal(vertexHit.vertex, 4);

  // A point on the interior edge at x = 100 between y = 100.5 and 150 (not on a vertex).
  const onSeam = worldToPane(camera, rect, { x: 100, y: 120 });
  const seamHit = pickInFabric(doc, camera, rect, onSeam.x, onSeam.y);
  assert.equal(seamHit.kind, 'seam');

  // A point inside a triangle, away from edges.
  const inside = worldToPane(camera, rect, { x: 30, y: 70 });
  const triHit = pickInFabric(doc, camera, rect, inside.x, inside.y);
  assert.equal(triHit.kind, 'triangle');
  assert.ok(triHit.triangleId !== null);
});

test('picking in texture space finds a corner first, then a UV triangle', () => {
  const doc = quadGrid();
  // Corner UV of vertex 4 is (0.5, 0.5) by the fixture's mapping.
  const corner = uvToPane(rect, { x: 0.5, y: 0.5 });
  const hit = pickInTexture(doc, rect, corner.x, corner.y);
  assert.notEqual(hit.corner, null);
  assert.ok(hit.triangleId !== null);

  // An interior point of a UV triangle (0.05, 0.05) lies in the first triangle.
  const inside = uvToPane(rect, { x: 0.05, y: 0.05 });
  const insideHit = pickInTexture(doc, rect, inside.x, inside.y);
  assert.equal(insideHit.corner, null);
  assert.equal(insideHit.triangleId, 0);

  // Far outside the unit square picks nothing.
  const outside = uvToPane(rect, { x: 2, y: 2 });
  const outsideHit = pickInTexture(doc, rect, outside.x, outside.y);
  assert.equal(outsideHit.triangleId, null);
});
