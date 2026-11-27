import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeRectDrag,
  mapRectToSourceQuad,
  checkRegionRoundTrip,
  paperDeltaToMm,
} from '../src/core/regions.js';
import {
  sourcePixelsToPaperNorm,
  paperNormToSourcePixels,
} from '../src/core/geometry.js';

test('normalizeRectDrag handles reversed drags and clamps to 0..1', () => {
  assert.deepEqual(normalizeRectDrag(0.8, 0.7, 0.2, 0.3), { x: 0.2, y: 0.3, w: 0.6, h: 0.4 });
  const clamped = normalizeRectDrag(-2, -1, 2, 2);
  assert.deepEqual(clamped, { x: 0, y: 0, w: 1, h: 1 });
});

test('region projects to a source quad and round-trips after corner change', () => {
  let corners = [
    { x: 100, y: 80 },
    { x: 900, y: 60 },
    { x: 940, y: 900 },
    { x: 60, y: 880 },
  ];
  let Hs2p = sourcePixelsToPaperNorm(corners);
  let Hp2s = paperNormToSourcePixels(corners);
  const region = { x: 0.2, y: 0.25, w: 0.3, h: 0.15 };

  const quad = mapRectToSourceQuad(region, Hp2s);
  assert.equal(quad.length, 4);
  // 投影四边形必须落在源图角点张成的区域附近（这里只检查坐标有限且在图内）
  for (const p of quad) {
    assert.ok(p.x > 0 && p.x < 1000);
    assert.ok(p.y > 0 && p.y < 1000);
  }

  const check1 = checkRegionRoundTrip(region, Hs2p, Hp2s);
  assert.ok(check1.maxPaperError < 1e-9);

  // 重新修改四角后：区域纸面坐标不变，新的投影仍然能精确往返，
  // 说明遮挡仍位于预期纸面坐标。
  corners = [
    { x: 140, y: 120 },
    { x: 860, y: 70 },
    { x: 980, y: 820 },
    { x: 90, y: 940 },
  ];
  Hs2p = sourcePixelsToPaperNorm(corners);
  Hp2s = paperNormToSourcePixels(corners);
  const check2 = checkRegionRoundTrip(region, Hs2p, Hp2s);
  assert.ok(check2.maxPaperError < 1e-9);

  // 源图位置确实随新角点发生了变化
  const quad2 = mapRectToSourceQuad(region, Hp2s);
  assert.ok(Math.hypot(quad2[0].x - quad[0].x, quad2[0].y - quad[0].y) > 1);
});

test('paperDeltaToMm scales by ratio units', () => {
  assert.equal(paperDeltaToMm(1, 0, { w: 210, h: 297 }), 210);
  assert.equal(paperDeltaToMm(0, 1, { w: 210, h: 297 }), 297);
});
