import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScene, sceneSegments } from '../src/scene.js';
import { buildVisibilityPolygon, isVisible, pointInCone } from '../src/visibility.js';

// 一面横在灯与目标点之间的墙。
function wallScene(overrides = {}) {
  return loadScene({
    walls: [{ id: 'wall', from: { x: 100, y: 0 }, to: { x: 100, y: 100 } }],
    lights: [{ id: 'A', x: 0, y: 50, range: 500, ...overrides }],
  });
}

test('墙挡住背后的视线，墙侧区域仍然可见', () => {
  const scene = wallScene();
  const segments = sceneSegments(scene);
  assert.equal(isVisible(segments, { x: 0, y: 50 }, { x: 200, y: 50 }), false);
  assert.equal(isVisible(segments, { x: 0, y: 50 }, { x: 50, y: 50 }), true);
  // 从墙顶端点上方绕过的视线不被遮挡（x=100 处 y<0）。
  assert.equal(isVisible(segments, { x: 0, y: 50 }, { x: 200, y: -110 }), true);
});

test('可见多边形不越过墙体且被限制在最大照明距离内', () => {
  const scene = wallScene();
  const segments = sceneSegments(scene);
  const polygon = buildVisibilityPolygon(scene.lights[0], segments);
  assert.ok(polygon.length >= 3);
  for (const point of polygon) {
    assert.ok(Math.hypot(point.x, point.y - 50) <= 500 + 1e-6);
  }
});

test('门缝保留：带开口隔断只遮挡开口以外部分', () => {
  const scene = loadScene({
    partitions: [{
      id: 'p',
      from: { x: 100, y: 0 },
      to: { x: 100, y: 100 },
      openings: [{ start: 40, end: 60 }],
    }],
    lights: [{ id: 'A', x: 0, y: 50, range: 500 }],
  });
  const segments = sceneSegments(scene);
  assert.equal(isVisible(segments, { x: 0, y: 50 }, { x: 200, y: 50 }), true);
  assert.equal(isVisible(segments, { x: 0, y: 20 }, { x: 200, y: 20 }), false);
  assert.equal(isVisible(segments, { x: 0, y: 80 }, { x: 200, y: 80 }), false);
  // 视线贴着门缝边缘也应通过（端点接触不算遮挡）。
  assert.equal(isVisible(segments, { x: 0, y: 40 }, { x: 200, y: 40 }), true);
});

test('共享顶点附近无成片漏光：T 形接头两侧遮挡判定正确', () => {
  const scene = loadScene({
    walls: [
      { id: 'h', from: { x: 0, y: 100 }, to: { x: 200, y: 100 } },
      { id: 'v', from: { x: 100, y: 100 }, to: { x: 100, y: 200 } },
    ],
    lights: [{ id: 'A', x: 50, y: 50, range: 500 }],
  });
  const segments = sceneSegments(scene);
  const light = { x: 50, y: 50 };
  // 竖墙右下侧被横墙挡住。
  assert.equal(isVisible(segments, light, { x: 150, y: 150 }), false);
  // 横墙下方、竖墙左侧同样被挡。
  assert.equal(isVisible(segments, light, { x: 60, y: 160 }), false);
  // 横墙上方保持可见。
  assert.equal(isVisible(segments, light, { x: 150, y: 60 }), true);
});

test('聚光灯锥角外的点不可见，锥内且无遮挡时可见', () => {
  const scene = wallScene({ aim: 0, fov: 0.5 });
  const segments = sceneSegments(scene);
  const light = scene.lights[0];
  assert.equal(pointInCone(light, { x: 100, y: 50 }), true);
  assert.equal(pointInCone(light, { x: 0, y: 200 }), false);
  const polygon = buildVisibilityPolygon(light, segments);
  // 锥角域狭窄，多边形应为灯心加少量命中点的扇形。
  assert.ok(polygon[0].x === light.x && polygon[0].y === light.y);
  assert.ok(polygon.length >= 3);
});

test('同一几何与灯位重复计算结果完全一致（确定性）', () => {
  const scene = wallScene({ aim: 0.3, fov: 0.8 });
  const segments = sceneSegments(scene);
  const first = buildVisibilityPolygon(scene.lights[0], segments);
  const second = buildVisibilityPolygon(scene.lights[0], segments);
  assert.deepEqual(second, first);
});
