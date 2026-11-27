import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rectsIntersect,
  segmentIntersectsRect,
  segmentsIntersect,
  clampRectToBounds,
  inflateRect,
  intersectionArea,
  rect,
} from '../core/geometry.js';

test('rectsIntersect 判定相交与相切', () => {
  assert.equal(rectsIntersect(rect(0, 0, 10, 10), rect(5, 5, 10, 10)), true);
  assert.equal(rectsIntersect(rect(0, 0, 10, 10), rect(10, 0, 10, 10)), false);
  assert.equal(rectsIntersect(rect(0, 0, 10, 10), rect(20, 20, 5, 5)), false);
});

test('inflateRect 与 intersectionArea 量化重叠', () => {
  const inflated = inflateRect(rect(10, 10, 10, 10), 2);
  assert.deepEqual(inflated, rect(8, 8, 14, 14));
  assert.equal(intersectionArea(rect(0, 0, 10, 10), rect(5, 5, 10, 10)), 25);
  assert.equal(intersectionArea(rect(0, 0, 10, 10), rect(20, 20, 5, 5)), 0);
});

test('segmentIntersectsRect：穿过、端点在内与完全在外', () => {
  const r = rect(10, 10, 20, 20);
  assert.equal(segmentIntersectsRect({ x: 0, y: 20 }, { x: 40, y: 20 }, r), true);
  assert.equal(segmentIntersectsRect({ x: 15, y: 15 }, { x: 16, y: 16 }, r), true);
  assert.equal(segmentIntersectsRect({ x: 0, y: 0 }, { x: 5, y: 5 }, r), false);
  // 竖直切线擦边
  assert.equal(segmentIntersectsRect({ x: 30, y: 0 }, { x: 30, y: 40 }, r), true);
});

test('segmentsIntersect：交叉、平行分离与共线重叠', () => {
  assert.equal(
    segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }),
    true,
  );
  assert.equal(
    segmentsIntersect({ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 6, y: 6 }, { x: 10, y: 10 }),
    false,
  );
  assert.equal(
    segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 }),
    true,
  );
});

test('clampRectToBounds 把越界矩形回拉且保持尺寸', () => {
  const bounds = rect(0, 0, 100, 100);
  assert.deepEqual(clampRectToBounds(rect(-20, 50, 30, 20), bounds), rect(0, 50, 30, 20));
  assert.deepEqual(clampRectToBounds(rect(90, 95, 30, 20), bounds), rect(70, 80, 30, 20));
});
