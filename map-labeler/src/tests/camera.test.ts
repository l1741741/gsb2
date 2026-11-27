import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../core/camera.js';
import { rect } from '../core/geometry.js';

test('相机地图/屏幕坐标往返一致（含旋转）', () => {
  const camera = new Camera(800, 600);
  camera.centerX = 500;
  camera.centerY = 300;
  camera.scale = 2;
  camera.rotation = Math.PI / 7;
  const map = { x: 612.5, y: 188.25 };
  const screen = camera.toScreen(map);
  const back = camera.toMap(screen);
  assert.ok(Math.abs(back.x - map.x) < 1e-9);
  assert.ok(Math.abs(back.y - map.y) < 1e-9);
});

test('fitToMapBounds 完整容纳地图并居中', () => {
  const camera = new Camera(400, 400);
  camera.fitToMapBounds(rect(0, 0, 100, 50), 0);
  const corners = [
    camera.toScreen({ x: 0, y: 0 }),
    camera.toScreen({ x: 100, y: 50 }),
  ];
  assert.ok(corners[0].x >= 0 && corners[0].y >= 0);
  assert.ok(corners[1].x <= 400 && corners[1].y <= 400);
  assert.equal(camera.rotation, 0);
});

test('viewBoundsInMap 在旋转后给出覆盖视口的保守包围盒', () => {
  const camera = new Camera(200, 200);
  camera.rotation = Math.PI / 4;
  camera.scale = 1;
  const bounds = camera.viewBoundsInMap();
  // 视口中心对应的地图点必须在包围盒内
  const center = { x: camera.centerX, y: camera.centerY };
  assert.ok(center.x >= bounds.x && center.x <= bounds.x + bounds.width);
  assert.ok(center.y >= bounds.y && center.y <= bounds.y + bounds.height);
  // 旋转 45° 时包围盒必然大于视口本身
  assert.ok(bounds.width > 200);
});

test('resize 后 fit 重算保证规格变化时仍适配', () => {
  const camera = new Camera(1280, 720);
  camera.fitToMapBounds(rect(0, 0, 1000, 640), 24);
  const wideScale = camera.scale;
  camera.resize(420, 900);
  camera.fitToMapBounds(rect(0, 0, 1000, 640), 24);
  assert.ok(camera.scale < wideScale, '窄屏缩放比例应更小');
});
