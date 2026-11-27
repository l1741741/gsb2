import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EPS,
  angleDelta,
  distanceToSegment,
  pointInPolygon,
  properCrossing,
  raySegment,
  wrapAngle,
} from '../src/geometry.js';

test('wrapAngle 将角度规范到 (-PI, PI]', () => {
  assert.equal(wrapAngle(0), 0);
  assert.ok(Math.abs(wrapAngle(Math.PI * 3) - Math.PI) < EPS);
  assert.ok(Math.abs(wrapAngle(-Math.PI * 3) - Math.PI) < EPS);
  assert.ok(Math.abs(wrapAngle(-Math.PI / 2) + Math.PI / 2) < EPS);
});

test('angleDelta 返回有向最小角差', () => {
  assert.ok(Math.abs(angleDelta(Math.PI, -Math.PI)) < EPS);
  assert.ok(Math.abs(angleDelta(0, Math.PI * 1.5) - Math.PI / 2) < EPS);
});

test('raySegment 求射线与线段参数，平行与反向不相交', () => {
  const segment = { a: { x: 10, y: -10 }, b: { x: 10, y: 10 } };
  const hit = raySegment({ x: 0, y: 0 }, 0, segment);
  assert.ok(Math.abs(hit - 10) < EPS);
  assert.equal(raySegment({ x: 0, y: 0 }, Math.PI, segment), null);
  assert.equal(raySegment({ x: 0, y: 0 }, Math.PI / 2, segment), null);
});

test('properCrossing 严格跨立，端点接触不算遮挡', () => {
  const wall = { a: { x: 10, y: 0 }, b: { x: 10, y: 20 } };
  assert.equal(properCrossing({ x: 0, y: 10 }, { x: 20, y: 10 }, wall), true);
  // 视线正好打在墙端点（门缝边缘）应允许通过。
  assert.equal(properCrossing({ x: 0, y: 0 }, { x: 10, y: 0 }, wall), false);
  assert.equal(properCrossing({ x: 0, y: 20 }, { x: 10, y: 20 }, wall), false);
  // 共线不算相交。
  const collinear = { a: { x: 0, y: 10 }, b: { x: 5, y: 10 } };
  assert.equal(properCrossing({ x: 0, y: 10 }, { x: 20, y: 10 }, collinear), false);
});

test('pointInPolygon 处理内部、外部与边界点', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.equal(pointInPolygon({ x: 5, y: 5 }, square), true);
  assert.equal(pointInPolygon({ x: 15, y: 5 }, square), false);
  assert.equal(pointInPolygon({ x: 0, y: 5 }, square), true);
  assert.equal(pointInPolygon({ x: 10, y: 10 }, square), true);
});

test('distanceToSegment 返回点到线段最短距离', () => {
  const segment = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
  assert.equal(distanceToSegment({ x: 5, y: 7 }, segment), 7);
  assert.equal(distanceToSegment({ x: -4, y: 3 }, segment), 5);
});
