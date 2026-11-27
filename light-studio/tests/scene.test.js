import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScene, partitionSegments, sceneSegments, serializeScene } from '../src/scene.js';
import { Camera } from '../src/camera.js';

test('带开口隔断展开后跳过门缝段', () => {
  const scene = loadScene({
    partitions: [{
      id: 'p',
      from: { x: 100, y: 0 },
      to: { x: 100, y: 100 },
      openings: [{ start: 40, end: 60 }],
    }],
  });
  const segments = partitionSegments(scene.partitions[0]);
  assert.equal(segments.length, 2);
  assert.deepEqual(segments.map((s) => [s.a.y, s.b.y]), [[0, 40], [60, 100]]);
});

test('柱子展开为闭合多边形线段，首尾相接', () => {
  const scene = loadScene({
    columns: [{ id: 'c', center: { x: 0, y: 0 }, radius: 10 }],
  });
  const segments = sceneSegments(scene);
  assert.equal(segments.length, 32);
  assert.deepEqual(segments.at(-1).b, segments[0].a);
  for (const segment of segments) {
    assert.equal(segment.kind, 'column');
  }
});

test('校验拒绝非法轴对齐线段、重复 id 与越界锥角', () => {
  assert.throws(() => loadScene({
    walls: [{ id: 'w', from: { x: 0, y: 0 }, to: { x: 10, y: 10 } }],
  }), /轴对齐/);
  assert.throws(() => loadScene({
    walls: [
      { id: 'x', from: { x: 0, y: 0 }, to: { x: 10, y: 0 } },
      { id: 'x', from: { x: 0, y: 5 }, to: { x: 10, y: 5 } },
    ],
  }), /id 重复/);
  assert.throws(() => loadScene({ lights: [{ id: 'l', x: 0, y: 0, fov: 5 }] }), /fov/);
});

test('序列化后重新加载得到等价场景', () => {
  const scene = loadScene({
    partitions: [{ id: 'p', from: { x: 0, y: 0 }, to: { x: 0, y: 100 }, openings: [{ start: 10, end: 20 }] }],
    lights: [{ id: 'l', x: 5, y: 6, aim: 1, fov: 0.4, range: 200 }],
    settings: { threshold: 0.3, cellSize: 12 },
  });
  const roundTrip = loadScene(serializeScene(scene));
  assert.deepEqual(serializeScene(roundTrip), serializeScene(scene));
});

test('相机只改变坐标映射，世界距离在缩放平移下保持不变', () => {
  const camera = new Camera();
  camera.zoomAt({ x: 400, y: 300 }, 2.5);
  camera.pan(30, -15);
  const world = { x: 120, y: 80 };
  const screen = camera.worldToScreen(world);
  const back = camera.screenToWorld(screen);
  assert.ok(Math.abs(back.x - world.x) < 1e-9);
  assert.ok(Math.abs(back.y - world.y) < 1e-9);
  const a = camera.worldToScreen({ x: 0, y: 0 });
  const b = camera.worldToScreen({ x: 10, y: 0 });
  assert.ok(Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - 25) < 1e-9);
});

test('fitBounds 保证世界矩形完整落入画布', () => {
  const camera = new Camera();
  camera.fitBounds(800, 600, { width: 400, height: 200 });
  const corners = [
    camera.worldToScreen({ x: 0, y: 0 }),
    camera.worldToScreen({ x: 400, y: 200 }),
  ];
  assert.ok(corners[0].x >= 24 && corners[0].y >= 24);
  assert.ok(corners[1].x <= 776 && corners[1].y <= 576);
});
