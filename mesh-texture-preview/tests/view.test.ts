/**
 * Pane layout and camera math. These are the same functions the WebGL view
 * uses, so a bug here would show up as misaligned overlays in the browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { paneLayout, screenToUv, uvToScreen, screenToWorld, metricColour, boundarySegments } from '../src/webgl/view.ts';
import { uvAffine, worldAffine } from '../src/webgl/glutil.ts';
import { quadGrid, splitPair } from './fixtures.ts';

test('pane layout splits the canvas with a gutter and no overlap', () => {
  const layout = paneLayout({ width: 1000, height: 500, dpr: 1 });
  assert.equal(layout.fabric.x, 0);
  assert.equal(layout.texture.x, layout.fabric.width + layout.gutter);
  assert.equal(layout.fabric.width + layout.gutter + layout.texture.width, 1000);
  assert.equal(layout.fabric.height, 500);
  assert.equal(layout.texture.height, 500);
});

test('world affine maps a camera centre to clip (0,0)', () => {
  const affine = worldAffine({ centerX: 100, centerY: 100, scale: 2 }, { width: 400, height: 400 });
  const clipX = 100 * affine[0] + affine[2];
  const clipY = 100 * affine[1] + affine[3];
  assert.ok(Math.abs(clipX) < 1e-12);
  assert.ok(Math.abs(clipY) < 1e-12);
  // A world point one pane-half-width to the right lands at clip x = 1.
  const worldHalfWidth = 200 / 2;
  assert.ok(Math.abs((100 + worldHalfWidth) * affine[0] + affine[2] - 1) < 1e-12);
});

test('uv affine maps the unit square centre to clip (0,0)', () => {
  const affine = uvAffine({ width: 400, height: 400 }, 0.84);
  assert.ok(Math.abs(0.5 * affine[0] + affine[2]) < 1e-12);
  assert.ok(Math.abs(0.5 * affine[1] + affine[3]) < 1e-12);
});

test('screenToWorld is the inverse of the camera transform', () => {
  const camera = { centerX: 100, centerY: 100, scale: 2 };
  const rect = { x: 0, y: 0, width: 400, height: 400 };
  assert.deepEqual(screenToWorld(camera, rect, 200, 200), { x: 100, y: 100 });
  const world = screenToWorld(camera, rect, 200 + 40, 200 - 40);
  assert.equal(world.x, 120);
  assert.equal(world.y, 80);
});

test('screenToUv inverts uvToScreen', () => {
  const rect = { x: 0, y: 0, width: 400, height: 400 };
  for (const uv of [
    { x: 0.3, y: 0.7 },
    { x: 0.5, y: 0.5 },
    { x: 0.1, y: 0.9 },
  ]) {
    const screen = uvToScreen(rect, uv);
    const back = screenToUv(rect, screen.x, screen.y);
    assert.ok(Math.abs(back.x - uv.x) < 1e-9, `x ${uv.x}`);
    assert.ok(Math.abs(back.y - uv.y) < 1e-9, `y ${uv.y}`);
  }
});

test('metricColour distinguishes valid, stretched, compressed and flipped', () => {
  const base = {
    id: 0,
    uvs: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
    points: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
    areaTex: 0,
    areaFabric: 0,
    determinant: 1,
    stretch: 1,
    minStretch: 1,
    anisotropy: 1,
    stretchRatio: 1,
    deformation: 1,
    compressed: false,
    flipped: false,
    collapsed: false,
    overStretched: false,
    invalid: false,
    bad: false,
  };
  assert.deepEqual(metricColour({ ...base }), [0.32, 0.78, 0.55]);
  // The stretch ramp is monotone: more deformation moves the colour further.
  const mild = metricColour({ ...base, overStretched: true, deformation: 1.61 });
  const severe = metricColour({ ...base, overStretched: true, deformation: 3 });
  assert.ok(severe[0] >= mild[0]);
  assert.ok(severe[1] <= mild[1]);
  assert.deepEqual(metricColour({ ...base, flipped: true }), [1.0, 0.12, 0.55]);
  assert.deepEqual(metricColour({ ...base, collapsed: true }), [0.85, 0.2, 0.2]);
});

test('boundarySegments finds only single-triangle edges, welded across a split seam', () => {
  const grid = boundarySegments(quadGrid());
  assert.equal(grid.length, 8);
  // The split pair's outer boundary is 4 edges (two per triangle), while the
  // shared seam is welded and therefore not a boundary.
  const split = boundarySegments(splitPair(0.25));
  assert.equal(split.length, 4);
});
