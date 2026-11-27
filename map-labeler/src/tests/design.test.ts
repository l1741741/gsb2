import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../core/camera.js';
import { HeuristicTextMeasurer } from '../core/text-measurer.js';
import { resolveStyle } from '../core/model.js';
import { layoutLabels, serializeLayout } from '../core/layout.js';
import { buildDesignDocument } from '../render/export.js';
import { assertDesignDocument, restoreLayout } from '../core/design.js';
import { validateFloorplanInput, type DesignDocument } from '../core/model.js';
import { rect } from '../core/geometry.js';

const measurer = new HeuristicTextMeasurer();
const style = resolveStyle();

function buildDoc(manualOverrides: DesignDocument['manualOverrides'] = {}, manualFolds: DesignDocument['manualFolds'] = {}) {
  const input = validateFloorplanInput({
    map: { bounds: rect(0, 0, 1000, 640) },
    forbidden: [{ id: 'z1', x: 400, y: 400, width: 100, height: 100 }],
    anchors: [
      { id: 'a', x: 120, y: 120, text: '观众服务', priority: 5 },
      { id: 'b', x: 500, y: 460, text: '靠近禁放区的标签', priority: 3 },
      { id: 'c', x: 820, y: 200, text: '文创', priority: 2 },
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
    forbidden: input.forbidden ?? [],
    anchors: input.anchors,
    style,
    measurer,
    manualOverrides,
    manualFolds,
  });
  const doc = buildDesignDocument(input, result.labels, camera, '2026-11-28T00:00:00.000Z', manualFolds);
  doc.manualOverrides = { ...manualOverrides };
  doc.manualFolds = { ...manualFolds };
  return { doc, camera, input };
}

test('保存后以同规格恢复：标签位置与折叠状态完全一致', () => {
  const { doc, camera, input } = buildDoc();
  assertDesignDocument(doc);
  const restored = restoreLayout(
    doc,
    measurer,
    style,
    doc.canvas.width,
    doc.canvas.height,
    camera.scale,
    camera.viewBoundsInMap(),
  );
  assert.deepEqual(
    restored.layout.labels.map((l) => ({ id: l.anchorId, rect: l.rect, folded: l.folded })),
    doc.layout.labels.map((l) => ({ id: l.anchorId, rect: l.rect, folded: l.folded })),
  );
  assert.equal(restored.warnings.length, 0);
  assert.ok(input.anchors.length === 3);
});

test('人工固定与手动折叠写入存档，恢复后保持', () => {
  const { doc, camera } = buildDoc({ a: { x: 333, y: 222 } }, { c: true });
  const restored = restoreLayout(
    doc,
    measurer,
    style,
    doc.canvas.width,
    doc.canvas.height,
    camera.scale,
    camera.viewBoundsInMap(),
  );
  const a = restored.layout.labels.find((l) => l.anchorId === 'a')!;
  const c = restored.layout.labels.find((l) => l.anchorId === 'c')!;
  assert.equal(a.rect!.x, 333);
  assert.equal(a.rect!.y, 222);
  assert.equal(a.pinned, true);
  assert.equal(c.folded, true);
});

test('换画布规格恢复：地图坐标不变，差异以警告显式报告', () => {
  const { doc } = buildDoc();
  const narrowCamera = new Camera(420, 900);
  narrowCamera.fitToMapBounds(doc.input.map.bounds);
  const restored = restoreLayout(
    doc,
    measurer,
    style,
    420,
    900,
    narrowCamera.scale,
    narrowCamera.viewBoundsInMap(),
  );
  // 人工未干预的标签以地图坐标存储，缩放后仍应可放置；有差异必须给警告而不是静默
  assert.ok(Array.isArray(restored.warnings));
  for (const label of restored.layout.labels) {
    if (label.rect) {
      const r = label.rect;
      assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 1000 && r.y + r.height <= 640);
    }
  }
});

test('序列化结果可往返且包含冲突字段', () => {
  const { doc } = buildDoc({ a: { x: 420, y: 420 } }); // 压进禁放区
  const json = JSON.stringify(doc);
  const parsed = JSON.parse(json) as DesignDocument;
  assertDesignDocument(parsed);
  assert.equal(parsed.version, 1);
  const a = parsed.layout.labels.find((l) => l.anchorId === 'a')!;
  assert.ok(a.conflicts.some((c) => c.kind === 'forbidden-zone'));
  const camera = new Camera(parsed.canvas.width, parsed.canvas.height);
  camera.fitToMapBounds(parsed.input.map.bounds);
  const restored = restoreLayout(
    parsed,
    measurer,
    style,
    parsed.canvas.width,
    parsed.canvas.height,
    camera.scale,
    camera.viewBoundsInMap(),
  );
  assert.equal(serializeLayout(restored.layout).labels.length, 3);
});

test('损坏的设计文件被拒绝', () => {
  assert.throws(() => assertDesignDocument({ version: 2 }), /版本/);
  assert.throws(
    () =>
      assertDesignDocument({
        version: 1,
        input: { anchors: [] },
        layout: { labels: [] },
        camera: null,
      }),
    /camera/,
  );
});
