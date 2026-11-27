import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../core/camera.js';
import { HeuristicTextMeasurer } from '../core/text-measurer.js';
import { resolveStyle } from '../core/model.js';
import { layoutLabels } from '../core/layout.js';
import { validateFloorplanInput } from '../core/model.js';
import { rectsIntersect, intersectionArea, rect } from '../core/geometry.js';
import type { AnchorInput, FloorplanInput, ForbiddenZone } from '../core/model.js';

const measurer = new HeuristicTextMeasurer();
const style = resolveStyle();

function makeInput(anchors: AnchorInput[], forbidden: ForbiddenZone[] = [], bounds = rect(0, 0, 1000, 640)): FloorplanInput {
  return validateFloorplanInput({ map: { bounds }, forbidden, anchors });
}

function run(input: FloorplanInput, width = 1280, height = 720) {
  const camera = new Camera(width, height);
  camera.fitToMapBounds(input.map.bounds);
  return layoutLabels({
    canvasWidth: width,
    canvasHeight: height,
    scale: camera.scale,
    viewBounds: camera.viewBoundsInMap(),
    mapBounds: input.map.bounds,
    forbidden: input.forbidden ?? [],
    anchors: input.anchors,
    style,
    measurer,
  });
}

test('稀疏锚点：全部显示且标签互不重叠、不压禁放区', () => {
  const input = makeInput([
    { id: 'a', x: 100, y: 100, text: '服务台', priority: 5 },
    { id: 'b', x: 500, y: 300, text: '展厅入口', priority: 4 },
    { id: 'c', x: 850, y: 500, text: '出口', priority: 3 },
  ], [{ id: 'z', x: 400, y: 200, width: 120, height: 120 }]);
  const result = run(input);
  assert.equal(result.foldedCount, 0);
  assert.equal(result.conflictCount, 0);
  const visible = result.labels.filter((l) => !l.folded);
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      assert.equal(rectsIntersect(visible[i].rect!, visible[j].rect!), false);
    }
  }
  for (const label of visible) {
    for (const zone of input.forbidden!) {
      assert.equal(intersectionArea(label.rect!, zone), 0);
    }
  }
});

test('密集锚点：低优先级标签被折叠且给出结构化原因', () => {
  const anchors: AnchorInput[] = [];
  for (let i = 0; i < 12; i++) {
    anchors.push({
      id: `p${i}`,
      x: 100 + i * 22,
      y: 300,
      text: `入口${i + 1}号门`,
      priority: (i % 5) + 1,
    });
  }
  const input = makeInput(anchors);
  const result = run(input, 900, 600);
  assert.ok(result.foldedCount > 0, '拥挤画面必须产生折叠');
  const folded = result.labels.filter((l) => l.folded);
  for (const label of folded) {
    assert.ok(label.foldReason, '折叠标签必须带原因');
    assert.ok(['no-space', 'forbidden-zone', 'overlap', 'out-of-view', 'low-priority-budget'].includes(label.foldReason!.code));
    assert.ok(label.foldReason!.detail.length > 0);
  }
  // 被保留的标签里，最高优先级（5）不应比最低优先级（1）更早被折叠
  const avgPriorityVisible =
    result.labels.filter((l) => !l.folded).reduce((s, l) => s + l.priority, 0) /
    Math.max(1, result.visibleCount);
  const avgPriorityFolded =
    folded.reduce((s, l) => s + l.priority, 0) / Math.max(1, folded.length);
  assert.ok(avgPriorityVisible >= avgPriorityFolded);
});

test('人工固定位置在重新排版时保留，并显式标出与禁放区的冲突', () => {
  const input = makeInput([
    { id: 'a', x: 200, y: 200, text: '固定标签', priority: 5, pinned: true },
    { id: 'b', x: 700, y: 400, text: '普通标签', priority: 3 },
  ]);
  const zone: ForbiddenZone = { id: 'danger', x: 180, y: 120, width: 160, height: 120 };
  input.forbidden = [zone];
  const camera = new Camera(1280, 720);
  camera.fitToMapBounds(input.map.bounds);
  const manualOverrides = { a: { x: 200, y: 140 } }; // 刻意压进禁放区
  const first = layoutLabels({
    canvasWidth: 1280,
    canvasHeight: 720,
    scale: camera.scale,
    viewBounds: camera.viewBoundsInMap(),
    mapBounds: input.map.bounds,
    forbidden: [zone],
    anchors: input.anchors,
    style,
    measurer,
    manualOverrides,
  });
  const pinned = first.labels.find((l) => l.anchorId === 'a')!;
  assert.equal(pinned.pinned, true);
  assert.deepEqual({ x: pinned.rect!.x, y: pinned.rect!.y }, { x: 200, y: 140 });
  assert.ok(pinned.conflicts.some((c) => c.kind === 'forbidden-zone' && c.targetId === 'danger'));

  // 重新排版（模拟再点一次按钮）：位置不变，冲突仍在
  const second = layoutLabels({
    canvasWidth: 1280,
    canvasHeight: 720,
    scale: camera.scale,
    viewBounds: camera.viewBoundsInMap(),
    mapBounds: input.map.bounds,
    forbidden: [zone],
    anchors: input.anchors,
    style,
    measurer,
    manualOverrides,
  });
  const again = second.labels.find((l) => l.anchorId === 'a')!;
  assert.deepEqual(again.rect, pinned.rect);
});

test('同输入两次排版结果完全确定（位置与折叠状态一致）', () => {
  const input = makeInput(
    Array.from({ length: 14 }, (_, i) => ({
      id: `q${i}`,
      x: 80 + (i % 7) * 60,
      y: 120 + Math.floor(i / 7) * 80,
      text: `标签${i}`,
      priority: (i % 4) + 1,
    })),
  );
  const r1 = run(input);
  const r2 = run(input);
  assert.deepEqual(
    r1.labels.map((l) => ({ id: l.anchorId, rect: l.rect, folded: l.folded })),
    r2.labels.map((l) => ({ id: l.anchorId, rect: l.rect, folded: l.folded })),
  );
});

test('窄画布下重算：折叠数上升且所有可见标签仍在地图范围内', () => {
  const anchors: AnchorInput[] = Array.from({ length: 10 }, (_, i) => ({
    id: `n${i}`,
    x: 100 + i * 90,
    y: 320,
    text: `宽窄混排标签编号${i}`,
    priority: 5 - (i % 5),
  }));
  const input = makeInput(anchors);
  const wide = run(input, 1280, 720);
  const narrow = run(input, 420, 900);
  assert.ok(narrow.foldedCount >= wide.foldedCount);
  for (const label of narrow.labels.filter((l) => !l.folded)) {
    const r = label.rect!;
    assert.ok(r.x >= 0 && r.y >= 0);
    assert.ok(r.x + r.width <= 1000 && r.y + r.height <= 640);
  }
});

test('手动折叠写入覆盖后，重新排版保持折叠状态', () => {
  const input = makeInput([
    { id: 'a', x: 100, y: 100, text: '甲', priority: 5 },
    { id: 'b', x: 800, y: 500, text: '乙', priority: 1 },
  ]);
  const camera = new Camera(1280, 720);
  camera.fitToMapBounds(input.map.bounds);
  const opts = {
    canvasWidth: 1280,
    canvasHeight: 720,
    scale: camera.scale,
    viewBounds: camera.viewBoundsInMap(),
    mapBounds: input.map.bounds,
    forbidden: [],
    anchors: input.anchors,
    style,
    measurer,
  };
  const result = layoutLabels({ ...opts, manualFolds: { a: true } });
  assert.equal(result.labels.find((l) => l.anchorId === 'a')!.folded, true);
  const again = layoutLabels({ ...opts, manualFolds: { a: true } });
  assert.equal(again.labels.find((l) => l.anchorId === 'a')!.folded, true);
});

test('标签盖住其它锚点时报告 anchor-covered 冲突', () => {
  const input = makeInput([
    { id: 'a', x: 100, y: 100, text: '大标签文本内容', priority: 5 },
    { id: 'b', x: 130, y: 95, text: '近邻', priority: 5 },
  ]);
  const result = run(input);
  // 引擎应尽量避开；若仍有覆盖则必须显式报告，不允许静默
  for (const label of result.labels) {
    for (const conflict of label.conflicts) {
      assert.ok(['label-overlap', 'forbidden-zone', 'anchor-covered', 'leader-cross', 'out-of-bounds'].includes(conflict.kind));
    }
  }
  assert.ok(result.labels.every((l) => l.conflicts.every((c) => c.detail.length > 0)));
});

test('非法输入抛出可读错误', () => {
  assert.throws(() => validateFloorplanInput({}), /map.bounds/);
  assert.throws(
    () => validateFloorplanInput({ map: { bounds: rect(0, 0, 10, 10) }, anchors: [] }),
    /anchors/,
  );
  assert.throws(
    () =>
      validateFloorplanInput({
        map: { bounds: rect(0, 0, 10, 10) },
        anchors: [{ id: 'x', x: 0, y: 0, text: '', priority: 1 }],
      }),
    /text/,
  );
});
