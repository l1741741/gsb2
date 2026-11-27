import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTransformInfo } from '../src/core/export-meta.js';
import { createDefaultTemplate } from '../src/core/templates.js';
import { mapPoint } from '../src/core/geometry.js';

test('transform info round-trips paper coords through matrices', () => {
  const config = createDefaultTemplate();
  const info = buildTransformInfo({
    sourceFile: 'page01.jpg',
    sourceWidth: 2000,
    sourceHeight: 3000,
    config,
    outputWidth: 1654,
    outputHeight: 2340,
    pageKey: 'page01.jpg#1#2',
    source: 'template',
  });

  assert.equal(info.sourceFile, 'page01.jpg');
  assert.equal(info.cornerOrder.length, 4);
  assert.equal(info.corners.sourcePixels.length, 4);

  const m = info.matricesRowMajor;
  // 四个纸面角点经 paper->sourcePx 矩阵必须回到记录的源像素角点
  const paperCorners = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  paperCorners.forEach(([u, v], i) => {
    const s = mapPoint(m.paperNormalizedToSourcePixels, u, v);
    const expected = info.corners.sourcePixels[i];
    assert.ok(Math.abs(s.x - expected.x) < 1e-6, `corner ${i} x`);
    assert.ok(Math.abs(s.y - expected.y) < 1e-6, `corner ${i} y`);
  });

  // 任意纸面点 -> 源 -> 纸面 往返
  const p = { x: 0.37, y: 0.61 };
  const srcN = mapPoint(m.paperNormalizedToSourceNormalized, p.x, p.y);
  const back = mapPoint(m.sourceNormalizedToPaperNormalized, srcN.x, srcN.y);
  assert.ok(Math.abs(back.x - p.x) < 1e-9);
  assert.ok(Math.abs(back.y - p.y) < 1e-9);

  // 导出像素坐标与纸面归一化是纯缩放关系
  const px = mapPoint(m.paperNormalizedToPaperPixels, 0.5, 0.25);
  assert.ok(Math.abs(px.x - 827) < 1e-6);
  assert.ok(Math.abs(px.y - 585) < 1e-6);
});

test('transform info includes region paper coordinates', () => {
  const config = createDefaultTemplate();
  config.regions = [{ id: 'z', type: 'mask', x: 0.1, y: 0.2, w: 0.3, h: 0.05 }];
  const info = buildTransformInfo({
    sourceFile: 'a.png', sourceWidth: 10, sourceHeight: 10, config,
    outputWidth: 100, outputHeight: 141,
  });
  assert.equal(info.regions.length, 1);
  assert.equal(info.regions[0].paperNormalized.x, 0.1);
  assert.equal(info.regions[0].paperMmApprox.w, 63); // 0.3*210
});
