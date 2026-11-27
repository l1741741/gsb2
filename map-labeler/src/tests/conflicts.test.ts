import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../core/camera.js';
import { HeuristicTextMeasurer } from '../core/text-measurer.js';
import { resolveStyle } from '../core/model.js';
import { layoutLabels } from '../core/layout.js';
import { buildExportManifest } from '../render/export.js';
import { validateFloorplanInput } from '../core/model.js';
import { leaderAttachPoint, detectConflicts } from '../core/conflicts.js';
import { rect } from '../core/geometry.js';

const measurer = new HeuristicTextMeasurer();
const style = resolveStyle();

test('leaderAttachPoint 取标签边缘上离锚点最近的点', () => {
  const r = rect(100, 100, 80, 40);
  const outside = leaderAttachPoint({ x: 40, y: 120 }, r);
  assert.deepEqual(outside, { x: 100, y: 120 });
  const inside = leaderAttachPoint({ x: 120, y: 110 }, r);
  assert.deepEqual(inside, { x: 120, y: 100 });
});

test('连线穿过禁放区被检测为 leader-cross', () => {
  const input = validateFloorplanInput({
    map: { bounds: rect(0, 0, 1000, 640) },
    forbidden: [{ id: 'wall', x: 300, y: 80, width: 40, height: 500 }],
    anchors: [{ id: 'a', x: 100, y: 120, text: '墙左侧标签', priority: 5 }],
  });
  const camera = new Camera(1280, 720);
  camera.fitToMapBounds(input.map.bounds);
  const result = layoutLabels({
    canvasWidth: 1280,
    canvasHeight: 720,
    scale: camera.scale,
    viewBounds: camera.viewBoundsInMap(),
    mapBounds: input.map.bounds,
    forbidden: input.forbidden ?? [],
    anchors: input.anchors,
    style,
    measurer,
    // 把标签钉在墙右侧，迫使连线穿墙
    manualOverrides: { a: { x: 400, y: 100 } },
  });
  const label = result.labels[0];
  assert.ok(label.conflicts.some((c) => c.kind === 'leader-cross' && c.targetId === 'wall'));
});

test('detectConflicts 对两张重叠标签双向报告', () => {
  const labels = [
    {
      anchorId: 'a', anchor: { x: 0, y: 0 }, text: '甲', priority: 5,
      rect: rect(100, 100, 100, 40), pixelWidth: 100, pixelHeight: 40,
      folded: false, pinned: false, manualRect: null, conflicts: [],
    },
    {
      anchorId: 'b', anchor: { x: 300, y: 300 }, text: '乙', priority: 4,
      rect: rect(150, 110, 100, 40), pixelWidth: 100, pixelHeight: 40,
      folded: false, pinned: false, manualRect: null, conflicts: [],
    },
  ];
  const map = detectConflicts({
    labels,
    forbidden: [],
    anchors: [
      { id: 'a', x: 0, y: 0, text: '甲', priority: 5 },
      { id: 'b', x: 300, y: 300, text: '乙', priority: 4 },
    ],
    mapBounds: rect(0, 0, 1000, 1000),
    viewBounds: rect(0, 0, 1000, 1000),
    gap: 0,
  });
  assert.ok(map.get('a')!.some((c) => c.kind === 'label-overlap' && c.targetId === 'b'));
  assert.ok(map.get('b')!.some((c) => c.kind === 'label-overlap' && c.targetId === 'a'));
});

test('导出清单同时含地图坐标与屏幕坐标，摘要计数准确', () => {
  const input = validateFloorplanInput({
    map: { bounds: rect(0, 0, 1000, 640) },
    anchors: [
      { id: 'a', x: 100, y: 100, text: '甲', priority: 5 },
      { id: 'b', x: 800, y: 500, text: '乙', priority: 1 },
    ],
  });
  const camera = new Camera(1280, 720);
  camera.fitToMapBounds(input.map.bounds);
  const result = layoutLabels({
    canvasWidth: 1280,
    canvasHeight: 720,
    scale: camera.scale,
    viewBounds: camera.viewBoundsInMap(),
    mapBounds: input.map.bounds,
    forbidden: [],
    anchors: input.anchors,
    style,
    measurer,
  });
  const manifest = buildExportManifest(input, result.labels, camera, '2026-11-28T00:00:00.000Z');
  assert.equal(manifest.anchors.length, 2);
  assert.equal(manifest.labelBoxes.length, 2);
  assert.equal(manifest.leaderLines.length, 2);
  assert.equal(manifest.summary.total, 2);
  const box = manifest.labelBoxes.find((b) => b.anchorId === 'a')!;
  assert.ok(box.map && box.screen);
  // 屏幕矩形 = 地图矩形经相机变换
  const tl = camera.toScreen({ x: box.map!.x, y: box.map!.y });
  assert.ok(Math.abs(tl.x - box.screen!.x) < 1e-9);
  assert.ok(Math.abs(tl.y - box.screen!.y) < 1e-9);
  assert.ok(JSON.stringify(manifest).includes('coordinateSystem'));
});
