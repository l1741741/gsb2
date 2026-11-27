/**
 * 浏览器演示应用：载入 JSON、交互排版、人工固定、折叠与导出。
 * 核心排版全部来自 ../index.js，本文件只负责 DOM、指针事件和文件读写。
 */
import {
  Camera,
  CanvasTextMeasurer,
  MapCanvasRenderer,
  assertDesignDocument,
  buildDesignDocument,
  buildExportManifest,
  detectConflicts,
  hitTestLabel,
  layoutLabels,
  renderToPng,
  resolveStyle,
  restoreLayout,
  validateFloorplanInput,
  type DesignDocument,
  type FloorplanInput,
  type LabelStyle,
  type PlacedLabel,
} from '../index.js';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const presetSelect = document.getElementById('preset') as HTMLSelectElement;
const widthInput = document.getElementById('canvas-w') as HTMLInputElement;
const heightInput = document.getElementById('canvas-h') as HTMLInputElement;
const sidebar = document.getElementById('sidebar')!;
const warningsBox = document.getElementById('warnings')!;
const statBox = document.getElementById('stat')!;

interface AppState {
  input: FloorplanInput;
  style: LabelStyle;
  camera: Camera;
  labels: PlacedLabel[];
  manualOverrides: DesignDocument['manualOverrides'];
  manualFolds: DesignDocument['manualFolds'];
  measurer: CanvasTextMeasurer;
  warnings: string[];
}

let state: AppState | null = null;
const renderer = new MapCanvasRenderer();

// ---- 画布分辨率（CSS 像素与设备像素解耦，导出尺寸仍等于设定规格）----
function applyCanvasSize(width: number, height: number): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function relayout(reason: string): void {
  if (!state) return;
  const { camera, input, style, measurer } = state;
  camera.resize(Number(widthInput.value), Number(heightInput.value));
  const result = layoutLabels({
    canvasWidth: camera.viewportWidth,
    canvasHeight: camera.viewportHeight,
    scale: camera.scale,
    viewBounds: camera.viewBoundsInMap(),
    mapBounds: input.map.bounds,
    forbidden: input.forbidden ?? [],
    anchors: input.anchors,
    style,
    measurer,
    manualOverrides: state.manualOverrides,
    manualFolds: state.manualFolds,
  });
  state.labels = result.labels;
  console.info(`[relayout] ${reason}：显示 ${result.visibleCount}，折叠 ${result.foldedCount}，冲突 ${result.conflictCount}`);
  draw();
  renderSidebar();
}

/** 切换画布规格：保留相机中心与缩放，仅让可视范围随新规格重算。 */
function changeCanvasSize(width: number, height: number, reason: string): void {
  if (!state) return;
  applyCanvasSize(width, height);
  relayout(reason);
}

function draw(): void {
  if (!state) return;
  renderer.draw(ctx, {
    camera: state.camera,
    mapBounds: state.input.map.bounds,
    forbidden: state.input.forbidden ?? [],
    labels: state.labels,
    measurer: state.measurer,
    style: state.style,
  });
}

function fitView(): void {
  if (!state) return;
  state.camera.fitToMapBounds(state.input.map.bounds);
}

function loadFloorplan(input: FloorplanInput, keepCamera = false): void {
  const width = input.canvas?.width ?? 1280;
  const height = input.canvas?.height ?? 720;
  widthInput.value = String(width);
  heightInput.value = String(height);
  presetSelect.value = `${width}x${height}`;
  applyCanvasSize(width, height);
  const camera = new Camera(width, height);
  camera.fitToMapBounds(input.map.bounds);
  state = {
    input,
    style: resolveStyle(input.style),
    camera,
    labels: [],
    manualOverrides: {},
    manualFolds: {},
    measurer: new CanvasTextMeasurer(ctx),
    warnings: [],
  };
  if (keepCamera) fitView();
  warningsBox.textContent = '';
  relayout('载入平面图');
}

function loadDesignDocument(doc: DesignDocument): void {
  const width = doc.canvas.width;
  const height = doc.canvas.height;
  widthInput.value = String(width);
  heightInput.value = String(height);
  presetSelect.value = `${width}x${height}`;
  applyCanvasSize(width, height);
  const camera = new Camera(width, height);
  camera.restore(doc.camera);
  const measurer = new CanvasTextMeasurer(ctx);
  const style = resolveStyle(doc.input.style);
  const { layout, warnings } = restoreLayout(
    doc,
    measurer,
    style,
    width,
    height,
    camera.scale,
    camera.viewBoundsInMap(),
  );
  state = {
    input: doc.input,
    style,
    camera,
    labels: layout.labels,
    manualOverrides: { ...doc.manualOverrides },
    manualFolds: { ...doc.manualFolds },
    measurer,
    warnings,
  };
  warningsBox.textContent = warnings.length ? ['恢复核对：', ...warnings.map((w) => `· ${w}`)].join('\n') : '';
  draw();
  renderSidebar();
}

// ---- 边栏 ----
function renderSidebar(): void {
  if (!state) return;
  sidebar.innerHTML = '';
  const sorted = [...state.labels].sort((a, b) => b.priority - a.priority || a.anchorId.localeCompare(b.anchorId));
  for (const label of sorted) {
    const row = document.createElement('div');
    row.className = ['label-row', label.folded ? 'folded' : '', label.pinned ? 'pinned' : '', label.conflicts.length ? 'conflict' : '']
      .filter(Boolean)
      .join(' ');
    const badges: string[] = [`P${label.priority}`];
    if (label.pinned) badges.push('固定');
    if (label.folded) badges.push('已折叠');
    if (label.conflicts.length) badges.push(`冲突×${label.conflicts.length}`);
    const meta: string[] = [];
    if (label.folded && label.foldReason) meta.push(`原因：${label.foldReason.detail}`);
    for (const conflict of label.conflicts) meta.push(`⚠ ${conflict.detail}`);
    if (label.rect) {
      meta.push(
        `框 map=(${label.rect.x.toFixed(1)}, ${label.rect.y.toFixed(1)}), ${label.rect.width.toFixed(1)}×${label.rect.height.toFixed(1)}`,
      );
    }
    row.innerHTML = `
      <div class="title">
        <span>${escapeHtml(label.text.replace(/\n/g, ' / '))}</span>
        <span>${badges.map((b) => `<span class="badge ${b.startsWith('冲突') ? 'conflict-badge' : b === '已折叠' ? 'folded-badge' : 'priority'}">${b}</span>`).join(' ')}</span>
      </div>
      <div class="meta">${meta.map(escapeHtml).join('<br>') || '—'}</div>`;
    row.addEventListener('click', () => toggleFold(label.anchorId));
    sidebar.appendChild(row);
  }
  const folded = state.labels.filter((l) => l.folded).length;
  const conflicts = state.labels.reduce((sum, l) => sum + l.conflicts.length, 0);
  statBox.textContent = `共 ${state.labels.length} 张 · 显示 ${state.labels.length - folded} · 折叠 ${folded} · 冲突 ${conflicts} 处 · 相机 scale=${state.camera.scale.toFixed(3)} rotation=${((state.camera.rotation * 180) / Math.PI).toFixed(0)}°`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
}

function toggleFold(anchorId: string): void {
  if (!state) return;
  const label = state.labels.find((l) => l.anchorId === anchorId);
  if (!label) return;
  // 手动折叠/展开都写入覆盖；展开后重新排版让引擎重新寻位
  state.manualFolds[anchorId] = !label.folded;
  relayout(`手动${label.folded ? '展开' : '折叠'} ${anchorId}`);
}

// ---- 指针交互：空白平移、标签拖拽固定、双击折叠 ----
interface DragState {
  mode: 'pan' | 'label';
  startX: number;
  startY: number;
  cameraStart: { centerX: number; centerY: number };
  anchorId?: string;
  grabOffset?: { x: number; y: number };
}
let drag: DragState | null = null;

function eventPos(e: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state) return;
  const pos = eventPos(e);
  const hit = hitTestLabel(state.labels, state.camera, pos);
  canvas.setPointerCapture(e.pointerId);
  if (hit) {
    const mapPoint = state.camera.toMap(pos);
    drag = {
      mode: 'label',
      startX: pos.x,
      startY: pos.y,
      cameraStart: { centerX: state.camera.centerX, centerY: state.camera.centerY },
      anchorId: hit.anchorId,
      grabOffset: { x: mapPoint.x - hit.rect!.x, y: mapPoint.y - hit.rect!.y },
    };
  } else {
    drag = {
      mode: 'pan',
      startX: pos.x,
      startY: pos.y,
      cameraStart: { centerX: state.camera.centerX, centerY: state.camera.centerY },
    };
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!state || !drag) return;
  const pos = eventPos(e);
  if (drag.mode === 'pan') {
    const dx = (pos.x - drag.startX) / state.camera.scale;
    const dy = (pos.y - drag.startY) / state.camera.scale;
    const cos = Math.cos(state.camera.rotation);
    const sin = Math.sin(state.camera.rotation);
    // 屏幕位移反向映射到地图位移
    state.camera.centerX = drag.cameraStart.centerX - (cos * dx - sin * dy);
    state.camera.centerY = drag.cameraStart.centerY - (sin * dx + cos * dy);
    draw();
  } else if (drag.anchorId && drag.grabOffset) {
    const mapPoint = state.camera.toMap(pos);
    const label = state.labels.find((l) => l.anchorId === drag!.anchorId);
    if (!label || !label.rect) return;
    // 拖拽只更新这张固定标签的几何并做全局冲突复检，不重排其它标签，避免画面抖动
    label.rect = { ...label.rect, x: mapPoint.x - drag.grabOffset.x, y: mapPoint.y - drag.grabOffset.y };
    label.pinned = true;
    label.manualRect = { ...label.rect };
    state.manualOverrides[label.anchorId] = { x: label.rect.x, y: label.rect.y };
    recomputeConflicts();
  }
});

/** 仅重跑冲突检测（拖拽中使用）：标签几何不变，只刷新冲突徽章与红框。 */
function recomputeConflicts(): void {
  if (!state) return;
  const conflictMap = detectConflicts({
    labels: state.labels,
    forbidden: state.input.forbidden ?? [],
    anchors: state.input.anchors,
    mapBounds: state.input.map.bounds,
    viewBounds: state.camera.viewBoundsInMap(),
    gap: 6 / state.camera.scale,
  });
  for (const label of state.labels) {
    label.conflicts = conflictMap.get(label.anchorId) ?? [];
  }
  draw();
  renderSidebar();
}

canvas.addEventListener('pointerup', () => {
  if (drag?.mode === 'label') relayout('人工固定标签');
  drag = null;
});

canvas.addEventListener('dblclick', (e) => {
  if (!state) return;
  const hit = hitTestLabel(state.labels, state.camera, eventPos(e));
  if (hit) toggleFold(hit.anchorId);
});

// 滚轮：缩放；Shift+滚轮：旋转
canvas.addEventListener('wheel', (e) => {
  if (!state) return;
  e.preventDefault();
  if (e.shiftKey) {
    state.camera.rotation += e.deltaY > 0 ? Math.PI / 12 : -Math.PI / 12;
    draw();
    return;
  }
  const pos = eventPos(e);
  const before = state.camera.toMap(pos);
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  state.camera.scale = Math.min(40, Math.max(0.05, state.camera.scale * factor));
  const after = state.camera.toMap(pos);
  state.camera.centerX += before.x - after.x;
  state.camera.centerY += before.y - after.y;
  relayout('缩放查看');
}, { passive: false });

// ---- 工具栏 ----
document.getElementById('rerun')!.addEventListener('click', () => relayout('手动触发'));
document.getElementById('reset-view')!.addEventListener('click', () => {
  fitView();
  relayout('适配视图');
});
document.getElementById('rotate-l')!.addEventListener('click', () => {
  if (!state) return;
  state.camera.rotation -= Math.PI / 12;
  draw();
});
document.getElementById('rotate-r')!.addEventListener('click', () => {
  if (!state) return;
  state.camera.rotation += Math.PI / 12;
  draw();
});

presetSelect.addEventListener('change', () => {
  if (presetSelect.value === 'custom') return;
  const [w, h] = presetSelect.value.split('x').map(Number);
  widthInput.value = String(w);
  heightInput.value = String(h);
  changeCanvasSize(w, h, `画布规格改为 ${w}×${h}`);
});

document.getElementById('apply-size')!.addEventListener('click', () => {
  const w = Number(widthInput.value);
  const h = Number(heightInput.value);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 200) {
    alert('画布宽高需为不小于 200 的数字');
    return;
  }
  changeCanvasSize(w, h, `画布规格改为 ${w}×${h}`);
});

document.getElementById('clear-manual')!.addEventListener('click', () => {
  if (!state) return;
  state.manualOverrides = {};
  state.manualFolds = {};
  warningsBox.textContent = '';
  state.warnings = [];
  relayout('清除人工改动');
});

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('export-png')!.addEventListener('click', () => {
  if (!state) return;
  const dataUrl = renderToPng(state.input, state.labels, state.camera, state.measurer, state.style);
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = 'floorplan-labels.png';
  a.click();
});

document.getElementById('export-manifest')!.addEventListener('click', () => {
  if (!state) return;
  const manifest = buildExportManifest(state.input, state.labels, state.camera, new Date().toISOString());
  download('floorplan-manifest.json', JSON.stringify(manifest, null, 2), 'application/json');
});

document.getElementById('save-design')!.addEventListener('click', () => {
  if (!state) return;
  const doc = buildDesignDocument(state.input, state.labels, state.camera, new Date().toISOString(), state.manualFolds);
  // 把边栏覆盖一并写回（buildDesignDocument 已从 label 状态提取，这里保持单一数据源）
  doc.manualOverrides = { ...state.manualOverrides };
  doc.manualFolds = { ...state.manualFolds };
  download('floorplan-design.json', JSON.stringify(doc, null, 2), 'application/json');
});

async function pickFile(input: HTMLInputElement): Promise<unknown> {
  const file = input.files?.[0];
  if (!file) throw new Error('未选择文件');
  return JSON.parse(await file.text()) as unknown;
}

document.getElementById('file-input')!.addEventListener('change', async (e) => {
  try {
    const raw = await pickFile(e.target as HTMLInputElement);
    loadFloorplan(validateFloorplanInput(raw));
  } catch (error) {
    alert(`载入失败：${error instanceof Error ? error.message : String(error)}`);
  }
  (e.target as HTMLInputElement).value = '';
});

document.getElementById('design-input')!.addEventListener('change', async (e) => {
  try {
    const raw = await pickFile(e.target as HTMLInputElement);
    loadDesignDocument(assertDesignDocument(raw));
  } catch (error) {
    alert(`载入失败：${error instanceof Error ? error.message : String(error)}`);
  }
  (e.target as HTMLInputElement).value = '';
});

// ---- 启动：自动加载同目录样例 ----
async function boot(): Promise<void> {
  applyCanvasSize(1280, 720);
  try {
    const response = await fetch('/demo/sample-floorplan.json');
    const raw = await response.json();
    loadFloorplan(validateFloorplanInput(raw));
  } catch (error) {
    console.warn('样例自动加载失败，请手动选择 JSON：', error);
  }
}
void boot();
