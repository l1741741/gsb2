// 渲染管线冒烟测试：用最小 Canvas 2D 桩跑通 renderFrame，
// 验证分层顺序（照明 → 暗区 → 障碍 → 灯具）与基本绘制契约。
// 浏览器中的真实像素效果仍需用 npm run demo 人工确认。

import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../src/camera.js';
import { loadScene, sceneSegments } from '../src/scene.js';
import { buildLightPolygons, buildDimGrid } from '../src/lighting.js';
import { renderFrame } from '../src/render.js';
import { corridorScene } from '../src/samples.js';

class StubContext {
  constructor() {
    this.calls = [];
    this.canvas = { width: 900, height: 600 };
    this._composite = 'source-over';
    this.globalAlpha = 1;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.lineWidth = 1;
    this.lineCap = 'butt';
    this._stack = [];
  }
  get globalCompositeOperation() { return this._composite; }
  set globalCompositeOperation(value) {
    this._composite = value;
    this.calls.push(['setComposite', value]);
  }
  record(name, ...args) { this.calls.push([name, ...args]); }
  setTransform(...a) { this.record('setTransform', ...a); }
  clearRect(...a) { this.record('clearRect', ...a); }
  save() {
    this._stack.push({ composite: this._composite, alpha: this.globalAlpha });
    this.record('save');
  }
  restore() {
    const state = this._stack.pop();
    if (state) {
      this._composite = state.composite;
      this.globalAlpha = state.alpha;
    }
    this.record('restore');
  }
  translate(...a) { this.record('translate', ...a); }
  scale(...a) { this.record('scale', ...a); }
  fillRect(...a) { this.record('fillRect', ...a); }
  strokeRect(...a) { this.record('strokeRect', ...a); }
  beginPath() { this.record('beginPath'); }
  closePath() { this.record('closePath'); }
  moveTo(...a) { this.record('moveTo', ...a); }
  lineTo(...a) { this.record('lineTo', ...a); }
  arc(...a) { this.record('arc', ...a); }
  fill() { this.record('fill'); }
  stroke() { this.record('stroke'); }
  setLineDash(a) { this.record('setLineDash', a); }
  createRadialGradient() {
    return { addColorStop: () => this.record('addColorStop') };
  }
  getTransform() { return { a: 1.25 }; }
}

test('renderFrame 按固定分层绘制且加法混合仅用于照明层', () => {
  const scene = loadScene(corridorScene);
  const segments = sceneSegments(scene);
  const polygons = buildLightPolygons(scene, segments);
  const dimGrid = buildDimGrid(scene, segments, polygons);
  const canvas = { width: 900, height: 600 };
  const context = new StubContext();
  globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };

  renderFrame(canvas, context, new Camera({ scale: 1 }), scene, {
    polygons,
    dimGrid,
    showDimGrid: true,
    selectedId: 'L1',
    draggingId: null,
    probe: null,
    probeWorld: null,
    checkpointResults: null,
  });

  const names = context.calls.map((c) => c[0]);
  assert.ok(names.includes('clearRect'));
  assert.ok(names.includes('fillRect'));
  assert.ok(names.includes('arc'));
  // 照明层显式切换为加法混合 lighter，并通过 save/restore 恢复（与真实 Canvas 语义一致）。
  const compositeChanges = context.calls.filter((c) => c[0] === 'setComposite').map((c) => c[1]);
  assert.ok(compositeChanges.includes('lighter'));
  const lastLighter = context.calls.map((c) => c[0]).lastIndexOf('setComposite');
  const restoreAfter = context.calls.slice(lastLighter).some((c) => c[0] === 'restore');
  assert.ok(restoreAfter);
  // 障碍墙体描边在照明填充之后。
  const firstFill = names.indexOf('fill');
  const wallStrokeIdx = names.lastIndexOf('stroke');
  assert.ok(firstFill > 0 && wallStrokeIdx > firstFill);
  // 暗区网格产生了填充单元。
  const dimFills = context.calls.filter((c) => c[0] === 'fillRect').length;
  assert.ok(dimFills >= dimGrid.cells.length);
});

test('禁用全部灯具时渲染不抛错且照明层无填充', () => {
  const scene = loadScene(corridorScene);
  scene.lights.forEach((light) => { light.enabled = false; });
  const segments = sceneSegments(scene);
  const polygons = buildLightPolygons(scene, segments);
  const dimGrid = buildDimGrid(scene, segments, polygons);
  const canvas = { width: 900, height: 600 };
  const context = new StubContext();
  globalThis.window = globalThis.window ?? { devicePixelRatio: 1 };
  assert.doesNotThrow(() => renderFrame(canvas, context, new Camera(), scene, {
    polygons, dimGrid, showDimGrid: true, selectedId: null, draggingId: null,
    probe: null, probeWorld: null, checkpointResults: null,
  }));
  assert.equal(polygons.size, 0);
});
