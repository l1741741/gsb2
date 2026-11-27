import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScene, sceneSegments } from '../src/scene.js';
import {
  buildDimGrid,
  buildLightPolygons,
  lightIlluminance,
  lightSignature,
  probePoint,
} from '../src/lighting.js';

function twoLampScene() {
  return loadScene({
    walls: [{ id: 'wall', from: { x: 100, y: -200 }, to: { x: 100, y: 400 } }],
    lights: [
      { id: 'A', x: 0, y: 0, range: 300, power: 1 },
      { id: 'B', x: 0, y: 100, range: 300, power: 1 },
    ],
    settings: { threshold: 0.2, cellSize: 20 },
  });
}

test('照度随距离衰减，墙后贡献为 0', () => {
  const scene = twoLampScene();
  const polygons = buildLightPolygons(scene, sceneSegments(scene));
  const near = lightIlluminance(scene.lights[0], { x: 10, y: 0 }, polygons.get('A'));
  const far = lightIlluminance(scene.lights[0], { x: 150, y: 0 }, polygons.get('A'));
  assert.ok(near > far);
  assert.equal(far, 0);
  // 射程外照度为 0。
  assert.equal(lightIlluminance(scene.lights[0], { x: 0, y: -305 }, polygons.get('A')), 0);
});

test('多灯按固定顺序叠加，探针列出每盏贡献灯且总量为各贡献之和', () => {
  const scene = twoLampScene();
  const segments = sceneSegments(scene);
  const polygons = buildLightPolygons(scene, segments);
  const probe = probePoint(scene, segments, { x: 20, y: 40 }, polygons);
  assert.deepEqual(probe.contributions.map((c) => c.lightId), ['A', 'B']);
  const sum = probe.contributions.reduce((acc, c) => acc + c.illuminance, 0);
  assert.ok(Math.abs(probe.total - sum) < 1e-12);
  // 静止灯 B 的贡献在重复探针间保持不变。
  const again = probePoint(scene, segments, { x: 20, y: 40 }, polygons);
  assert.equal(again.contributions.find((c) => c.lightId === 'B').illuminance,
    probe.contributions.find((c) => c.lightId === 'B').illuminance);
});

test('禁用灯具不产生贡献，重新启用后恢复', () => {
  const scene = twoLampScene();
  const segments = sceneSegments(scene);
  const before = probePoint(scene, segments, { x: 30, y: 20 });
  assert.ok(before.contributions.some((c) => c.lightId === 'A'));
  scene.lights[0].enabled = false;
  const disabled = probePoint(scene, segments, { x: 30, y: 20 });
  assert.ok(!disabled.contributions.some((c) => c.lightId === 'A'));
  assert.ok(disabled.total < before.total);
  scene.lights[0].enabled = true;
  const restored = probePoint(scene, segments, { x: 30, y: 20 });
  assert.equal(restored.total, before.total);
});

test('门限暗区网格只覆盖低于门限的世界坐标单元，且与相机无关', () => {
  const scene = twoLampScene();
  const segments = sceneSegments(scene);
  const grid = buildDimGrid(scene, segments);
  assert.ok(grid.cells.length > 0);
  for (const cell of grid.cells) {
    const center = { x: cell.x + cell.size / 2, y: cell.y + cell.size / 2 };
    assert.ok(probePoint(scene, segments, center).total < scene.settings.threshold);
  }
  // 再次构建结果一致，保证同参数可复核。
  const again = buildDimGrid(scene, segments);
  assert.deepEqual(again.cells, grid.cells);
});

test('灯位或门限变化会改变缓存签名', () => {
  const scene = twoLampScene();
  const before = lightSignature(scene);
  scene.lights[0].x += 25;
  assert.notEqual(lightSignature(scene), before);
  scene.lights[0].x -= 25;
  scene.settings.threshold = 0.4;
  assert.notEqual(lightSignature(scene), before);
});
