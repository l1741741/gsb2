/**
 * Browser entry point: wires the DOM to the App controller and MeshView.
 *
 * All editing logic lives in src/core and src/app; this file is deliberately
 * thin so the same commands are exercised by the headless tests. It is also
 * exported to `window.__meshPreview` so the browser smoke test can drive the
 * real page.
 */

import { App } from './app/app.ts';
import {
  applyUvDrag,
  endUvDrag,
  pointerDownFabric,
  pointerDownTexture,
  pointerMoveFabric,
  pointerUpFabric,
} from './app/interactions.ts';
import { localDetailHtml, seamListHtml, summaryHtml } from './app/panels.ts';
import { documentFingerprint } from './core/diagnostics.ts';
import { buildFabricMeshText, buildMeshJson, buildPreview, digestTexture } from './core/export.ts';

import { pickInFabric } from './core/picking.ts';
import type { MeshDocument, SeamKind, Vec2 } from './core/types.ts';
import { MeshView, paneLayout, type Camera } from './webgl/view.ts';

/* ------------------------------------------------------------------ DOM */

const canvas = document.querySelector<HTMLCanvasElement>('#view');
if (!canvas) throw new Error('missing #view canvas');
const glError = document.querySelector<HTMLDivElement>('#gl-error')!;
const glErrorText = document.querySelector<HTMLParagraphElement>('#gl-error-text')!;

const elements = {
  summary: document.querySelector<HTMLDivElement>('#summary')!,
  status: document.querySelector<HTMLParagraphElement>('#status')!,
  selectionLabel: document.querySelector<HTMLSpanElement>('#selection-label')!,
  localDetail: document.querySelector<HTMLDivElement>('#local-detail')!,
  seamList: document.querySelector<HTMLDivElement>('#seam-list')!,
  seamForm: document.querySelector<HTMLFormElement>('#seam-form')!,
  seamA: document.querySelector<HTMLInputElement>('#seam-a')!,
  seamB: document.querySelector<HTMLInputElement>('#seam-b')!,
  seamKind: document.querySelector<HTMLSelectElement>('#seam-kind')!,
  seamId: document.querySelector<HTMLInputElement>('#seam-id')!,
  thresholdStretch: document.querySelector<HTMLInputElement>('#threshold-stretch')!,
  thresholdCollapse: document.querySelector<HTMLInputElement>('#threshold-collapse')!,
  thresholdSeam: document.querySelector<HTMLInputElement>('#threshold-seam')!,
  historyDepth: document.querySelector<HTMLSpanElement>('#history-depth')!,
  exportReport: document.querySelector<HTMLDivElement>('#export-report')!,
  undo: document.querySelector<HTMLButtonElement>('#undo')!,
  redo: document.querySelector<HTMLButtonElement>('#redo')!,
  fit: document.querySelector<HTMLButtonElement>('#fit')!,
  fps: document.querySelector<HTMLSpanElement>('#fps')!,
  textureInput: document.querySelector<HTMLInputElement>('#texture-input')!,
  meshInput: document.querySelector<HTMLInputElement>('#mesh-input')!,
  reloadMesh: document.querySelector<HTMLInputElement>('#reload-mesh')!,
};

/* ------------------------------------------------------------- state */

let textureImage: import('./core/png.ts').RgbaImage | null = null;

const app = new App({
  document: emptyDocument(),
  onChange: () => scheduleRender(),
});

let view: MeshView | null = null;
let glUnavailable = false;
try {
  view = new MeshView(canvas);
  // Only reveal the fallback overlay when initialisation actually fails.
  glError.hidden = true;
} catch (error) {
  glUnavailable = true;
  glError.hidden = false;
  glErrorText.textContent = `${(error as Error).message}。诊断数值与导出仍然可用。`;
}

/* ------------------------------------------------------- camera & render */

function canvasMetrics(): { width: number; height: number; dpr: number } {
  const rect = canvas!.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
    dpr: Math.min(2, window.devicePixelRatio || 1),
  };
}

function cameraForView(): Camera {
  return { centerX: app.camera.centerX, centerY: app.camera.centerY, scale: app.camera.scale };
}

function fit(): void {
  const layout = paneLayout(canvasMetrics());
  app.fitToViewport(layout.fabric.width, layout.fabric.height);
}

let renderQueued = false;

function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    draw();
    updatePanels();
  });
}

const renderStats = { frames: 0, last: 0 };

function draw(): void {
  const metrics = canvasMetrics();
  if (!view || glUnavailable) {
    drawCpuFallback(metrics);
    return;
  }
  view.render(canvas!, app.document, app.diagnostics, cameraForView(), metrics, app.view, {
    vertex: app.selection.kind === 'vertex' ? app.selection.vertex ?? null : null,
    triangleId: app.selection.kind === 'triangle' ? app.selection.triangle ?? null : null,
    seamId: app.selection.kind === 'seam' ? app.selection.seam ?? null : null,
  });
  const now = performance.now();
  renderStats.frames += 1;
  if (renderStats.last === 0) renderStats.last = now;
  if (now - renderStats.last > 600) {
    elements.fps.textContent = `${Math.round((renderStats.frames * 1000) / (now - renderStats.last))} fps`;
    renderStats.frames = 0;
    renderStats.last = now;
  }
}

/**
 * CPU fallback: draws the reference raster, so diagnostics and inspection stay
 * usable when a browser refuses WebGL2.
 */
function drawCpuFallback(metrics: { width: number; height: number }): void {
  if (!textureImage) return;
  const context = canvas!.getContext('2d');
  if (!context) return;
  const width = Math.max(1, Math.min(1200, Math.round(metrics.width)));
  const height = Math.max(1, Math.min(1200, Math.round(metrics.height)));
  if (canvas!.width !== width || canvas!.height !== height) {
    canvas!.width = width;
    canvas!.height = height;
  }
  const raster = buildPreview(app.document, textureImage, { width, height, padding: 16 }).raster;
  const imageData = new ImageData(new Uint8ClampedArray(raster.data), width, height);
  context.putImageData(imageData, 0, 0);
}

/* ------------------------------------------------------------- panels */

function updatePanels(): void {
  const snapshot = app.snapshot();
  elements.historyDepth.textContent = `${snapshot.history.depth} 步`;
  elements.undo.disabled = !snapshot.history.canUndo;
  elements.redo.disabled = !snapshot.history.canRedo;
  elements.status.textContent = app.statusMessage;
  elements.summary.innerHTML = summaryHtml(snapshot);
  elements.thresholdStretch.value = String(snapshot.document.diagnostics.stretchThreshold);
  elements.thresholdCollapse.value = String(snapshot.document.diagnostics.collapseThreshold);
  elements.thresholdSeam.value = String(snapshot.document.diagnostics.seamTolerance);
  elements.seamList.innerHTML = seamListHtml(snapshot, app.resolvedSeams());
  const detail = localDetailHtml(snapshot);
  elements.selectionLabel.textContent = detail.label;
  elements.localDetail.innerHTML = detail.html;
}

/* -------------------------------------------------------- pointer input */

let fabricDrag: { dragging: boolean } | null = null;
let uvDrag: { triangleId: number; corner: 0 | 1 | 2; base: MeshDocument; startX: number; startY: number } | null = null;
let panning: { x: number; y: number } | null = null;
let spaceHeld = false;

function panes(): ReturnType<typeof paneLayout> {
  return paneLayout({ ...canvasMetrics() });
}

canvas.addEventListener('pointerdown', (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const layout = panes();
  canvas.setPointerCapture(event.pointerId);

  if (spaceHeld || event.button === 1) {
    panning = { x, y };
    canvas.style.cursor = 'grabbing';
    return;
  }

  if (x >= layout.texture.x) {
    const result = pointerDownTexture(app, { width: layout.texture.width, height: layout.texture.height, offsetX: layout.texture.x }, x, y);
    if (result.editing) {
      uvDrag = { ...result.editing, startX: x, startY: y };
      canvas.style.cursor = 'crosshair';
    }
    scheduleRender();
    return;
  }

  fabricDrag = pointerDownFabric(app, { width: layout.fabric.width, height: layout.fabric.height, offsetX: layout.fabric.x }, x, y);
  if (fabricDrag.dragging) canvas.style.cursor = 'grabbing';
  scheduleRender();
});

canvas.addEventListener('pointermove', (event) => {
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const layout = panes();

  if (panning) {
    app.panBy(x - panning.x, y - panning.y);
    panning = { x, y };
    scheduleRender();
    return;
  }
  if (uvDrag) {
    const side = Math.min(layout.texture.width, layout.texture.height) * 0.84;
    applyUvDrag(app, uvDrag, { x: (x - uvDrag.startX) / side, y: (y - uvDrag.startY) / side });
    scheduleRender();
    return;
  }
  if (fabricDrag?.dragging) {
    pointerMoveFabric(app, { width: layout.fabric.width, height: layout.fabric.height, offsetX: layout.fabric.x }, x, y);
    scheduleRender();
    return;
  }
  // Cursor hint on hover.
  if (x >= layout.texture.x) {
    canvas.style.cursor = 'crosshair';
    return;
  }
  const hover = pickInFabric(app.document, app.camera, layout.fabric, x - layout.fabric.x, y);
  canvas.style.cursor = hover.kind === 'vertex' ? 'grab' : hover.kind === 'seam' ? 'pointer' : 'default';
});

canvas.addEventListener('pointerup', () => {
  if (panning) {
    panning = null;
    canvas.style.cursor = spaceHeld ? 'grab' : 'default';
    return;
  }
  if (uvDrag) {
    endUvDrag(app, false);
    uvDrag = null;
    canvas.style.cursor = 'crosshair';
    scheduleRender();
    return;
  }
  if (fabricDrag?.dragging) {
    pointerUpFabric(app, false);
    fabricDrag = null;
    canvas.style.cursor = 'grab';
    scheduleRender();
  }
});

canvas.addEventListener('pointercancel', () => {
  if (uvDrag) {
    endUvDrag(app, true);
    uvDrag = null;
  }
  if (fabricDrag?.dragging) pointerUpFabric(app, true);
  fabricDrag = null;
  panning = null;
});

canvas.addEventListener(
  'wheel',
  (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const layout = panes();
    if (x >= layout.texture.x) return;
    event.preventDefault();
    const world = paneToWorldLocal(layout.fabric.width, layout.fabric.height, app.camera, x, y);
    app.zoomAt(Math.exp(-event.deltaY * 0.0015), world.x, world.y);
    scheduleRender();
  },
  { passive: false },
);

function paneToWorldLocal(width: number, height: number, camera: Camera, x: number, y: number): Vec2 {
  return {
    x: (x - width / 2) / camera.scale + camera.centerX,
    y: (y - height / 2) / camera.scale + camera.centerY,
  };
}

window.addEventListener('keydown', (event) => {
  if (event.key === ' ' && !isTyping(event.target)) {
    spaceHeld = true;
    if (!panning) canvas.style.cursor = 'grab';
    event.preventDefault();
  }
  if (isTyping(event.target)) return;
  const meta = event.metaKey || event.ctrlKey;
  if (meta && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) app.redo();
    else app.undo();
    scheduleRender();
  } else if (meta && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    app.redo();
    scheduleRender();
  } else if ((event.key === 'Delete' || event.key === 'Backspace') && app.selection.kind === 'vertex' && app.selection.vertex !== undefined) {
    event.preventDefault();
    app.togglePinned(app.selection.vertex);
    scheduleRender();
  }
});

window.addEventListener('keyup', (event) => {
  if (event.key === ' ') {
    spaceHeld = false;
    canvas.style.cursor = 'default';
  }
});

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA';
}

/* -------------------------------------------------------------- buttons */

document.querySelectorAll<HTMLButtonElement>('[data-channel]').forEach((button) => {
  button.addEventListener('click', () => {
    app.setChannel(button.dataset.channel as 'texture' | 'stretch' | 'wireframe');
    document.querySelectorAll('[data-channel]').forEach((other) => other.classList.toggle('active', other === button));
  });
});

document.querySelectorAll<HTMLButtonElement>('[data-badpatch]').forEach((button) => {
  button.addEventListener('click', () => {
    app.setBadPatchMode(button.dataset.badpatch as 'retain' | 'disable');
    document.querySelectorAll('[data-badpatch]').forEach((other) => other.classList.toggle('active', other === button));
  });
});

elements.undo.addEventListener('click', () => app.undo());
elements.redo.addEventListener('click', () => app.redo());
elements.fit.addEventListener('click', () => fit());

const bindToggle = (id: string, key: 'showBoundary' | 'showSeams' | 'showHandles' | 'showGrid'): void => {
  document.querySelector<HTMLInputElement>(id)!.addEventListener('change', (event) => {
    app.setViewOptions({ [key]: (event.target as HTMLInputElement).checked });
  });
};
bindToggle('#toggle-boundary', 'showBoundary');
bindToggle('#toggle-seams', 'showSeams');
bindToggle('#toggle-handles', 'showHandles');
bindToggle('#toggle-grid', 'showGrid');

elements.seamForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const a = Number.parseInt(elements.seamA.value, 10);
  const b = Number.parseInt(elements.seamB.value, 10);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    app.setStatus('请输入两个三角形编号');
    return;
  }
  const id = elements.seamId.value.trim() || `seam-${a}-${b}`;
  if (app.declareSeam(a, b, elements.seamKind.value as SeamKind, id)) {
    app.select({ kind: 'seam', seam: id });
    elements.seamId.value = '';
  }
});

elements.seamList.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const deleteButton = target.closest<HTMLButtonElement>('[data-action="delete-seam"]');
  if (deleteButton) {
    event.stopPropagation();
    app.removeSeam(deleteButton.dataset.seam ?? '');
    return;
  }
  const row = target.closest<HTMLElement>('.seam-row');
  if (row?.dataset.seam) app.select({ kind: 'seam', seam: row.dataset.seam });
});

elements.localDetail.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
  if (!button) return;
  if (button.dataset.action === 'toggle-pin' && app.selection.vertex !== undefined) {
    app.togglePinned(app.selection.vertex);
  } else if (button.dataset.action === 'frame-vertex' && app.selection.vertex !== undefined) {
    const vertex = app.document.vertices[app.selection.vertex];
    app.setCamera({ centerX: vertex.x, centerY: vertex.y });
  }
});

const applyThresholds = (): void => {
  app.updateThresholds({
    stretchThreshold: Number.parseFloat(elements.thresholdStretch.value),
    collapseThreshold: Number.parseFloat(elements.thresholdCollapse.value),
    seamTolerance: Number.parseFloat(elements.thresholdSeam.value),
  });
};
elements.thresholdStretch.addEventListener('change', applyThresholds);
elements.thresholdCollapse.addEventListener('change', applyThresholds);
elements.thresholdSeam.addEventListener('change', applyThresholds);

/* -------------------------------------------------------------- samples */

document.querySelectorAll<HTMLButtonElement>('[data-sample]').forEach((button) => {
  button.addEventListener('click', () => {
    void loadSample(button.dataset.sample as 'gingham' | 'split' | 'flipped');
  });
});

async function loadSample(kind: 'gingham' | 'split' | 'flipped'): Promise<void> {
  try {
    const meshResponse = await fetch(`./samples/${kind}.fabricmesh`);
    if (!meshResponse.ok) throw new Error(`HTTP ${meshResponse.status}`);
    const report = app.loadText(await meshResponse.text(), `${kind}.fabricmesh`);
    await loadTextureFromUrl('./samples/gingham.png', 'gingham.png');
    app.setStatus(`已载入样例「${sampleLabel(kind)}」：${report.summary}`);
    fit();
    scheduleRender();
  } catch (error) {
    app.setStatus(`载入样例失败: ${(error as Error).message}`);
    scheduleRender();
  }
}

function sampleLabel(kind: string): string {
  if (kind === 'split') return '断开拼缝';
  if (kind === 'flipped') return '翻面三角形';
  return '格纹';
}

/* ------------------------------------------------------------- textures */

async function loadTextureFromUrl(url: string, name: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  applyTexture(bitmap, name);
}

function applyTexture(source: TexImageSource, name: string): void {
  const width = 'width' in source ? Number((source as { width: number }).width) : 0;
  const height = 'height' in source ? Number((source as { height: number }).height) : 0;
  textureImage = rasterizeTexture(source, width, height);
  if (view && !glUnavailable) view.setTexture(source, width, height);
  app.attachTexture(name, width, height);
  scheduleRender();
}

/** Flattens any TexImageSource into an RGBA buffer for the CPU rasteriser. */
function rasterizeTexture(source: TexImageSource, width: number, height: number): import('./core/png.ts').RgbaImage {
  if (width <= 0 || height <= 0) return { width: 1, height: 1, data: new Uint8Array([120, 122, 128, 255]) };
  const scratch = new OffscreenCanvas(width, height);
  const context = scratch.getContext('2d');
  if (!context) throw new Error('无法创建 2D 上下文读取纹理');
  context.drawImage(source as CanvasImageSource, 0, 0, width, height);
  return { width, height, data: new Uint8Array(context.getImageData(0, 0, width, height).data) };
}

elements.textureInput.addEventListener('change', async () => {
  const file = elements.textureInput.files?.[0];
  if (!file) return;
  try {
    applyTexture(await createImageBitmap(file), file.name);
    app.setStatus(`已载入纹理 ${file.name}`);
  } catch (error) {
    app.setStatus(`纹理载入失败: ${(error as Error).message}`);
  }
  elements.textureInput.value = '';
});

/* --------------------------------------------------------------- mesh io */

elements.meshInput.addEventListener('change', async () => {
  const file = elements.meshInput.files?.[0];
  if (!file) return;
  await loadMeshFile(file);
  elements.meshInput.value = '';
});

elements.reloadMesh.addEventListener('change', async () => {
  const file = elements.reloadMesh.files?.[0];
  if (!file) return;
  await loadMeshFile(file);
  elements.reloadMesh.value = '';
});

async function loadMeshFile(file: File): Promise<void> {
  try {
    const text = await file.text();
    const report = file.name.toLowerCase().endsWith('.json')
      ? app.loadJson(text, file.name)
      : app.loadText(text, file.name);
    const textureName = report.document.texture.name;
    if (textureName && textureName !== 'untitled') {
      try {
        await loadTextureFromUrl(`./samples/${textureName}`, textureName);
      } catch {
        app.setStatus(`已载入网格，但找不到纹理 ${textureName}，请手动载入 PNG`);
        scheduleRender();
      }
    }
    showMismatches(report.mismatches);
    fit();
    scheduleRender();
  } catch (error) {
    app.setStatus(`网格载入失败: ${(error as Error).message}`);
    scheduleRender();
  }
}

function showMismatches(mismatches: string[]): void {
  if (mismatches.length === 0) {
    elements.exportReport.textContent = '';
    elements.exportReport.style.color = '';
    return;
  }
  elements.exportReport.textContent = `导入校验发现问题:\n- ${mismatches.join('\n- ')}`;
  elements.exportReport.style.color = '#ff8fa3';
}

/* ---------------------------------------------------------------- export */

document.querySelector<HTMLButtonElement>('#export-mesh')!.addEventListener('click', () => {
  const json = buildMeshJson(app.document, {
    textureDigest: textureImage ? digestTexture(textureImage) : null,
    now: () => new Date(),
  });
  download(`mesh-${stamp()}.json`, new Blob([json], { type: 'application/json' }));
  elements.exportReport.style.color = '';
  elements.exportReport.textContent = `已导出 mesh.json · ${app.document.triangles.length} 三角形 · ${app.document.seams.length} 声明拼缝\n几何指纹 ${documentFingerprint(app.document)}\n诊断指纹 ${app.diagnostics.fingerprint}`;
});

document.querySelector<HTMLButtonElement>('#export-preview')!.addEventListener('click', () => {
  if (!textureImage) {
    app.setStatus('请先载入一张 PNG 纹理');
    return;
  }
  const preview = buildPreview(app.document, textureImage, {
    width: 900,
    height: 900,
    skipInvalid: app.view.badPatchMode === 'disable',
  });
  download(`preview-${stamp()}.png`, new Blob([preview.png.slice() as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
  elements.exportReport.style.color = '';
  elements.exportReport.textContent = `已导出预览 PNG ${preview.width}×${preview.height}\n诊断指纹 ${preview.diagnosticsFingerprint}\n像素摘要 ${preview.digest}`;
});

document.querySelector<HTMLButtonElement>('#export-fabricmesh')!.addEventListener('click', () => {
  download(`mesh-${stamp()}.fabricmesh`, new Blob([buildFabricMeshText(app.document)], { type: 'text/plain' }));
  elements.exportReport.style.color = '';
  elements.exportReport.textContent = '已导出 .fabricmesh 文本网格';
});

function download(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function stamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/* --------------------------------------------------------------- startup */

window.addEventListener('resize', () => scheduleRender());

function emptyDocument(): MeshDocument {
  return {
    format: 'fabric-mesh-preview',
    version: 1,
    texture: { name: 'untitled', width: 0, height: 0 },
    vertices: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ],
    triangles: [
      { id: 0, vertices: [0, 1, 2], uvs: [{ x: 0.25, y: 0.25 }, { x: 0.5, y: 0.25 }, { x: 0.25, y: 0.5 }] },
    ],
    seams: [],
    diagnostics: { stretchThreshold: 1.35, collapseThreshold: 0.02, seamTolerance: 1e-3 },
  };
}

void loadSample('gingham');

/* Exposed for the browser smoke test (tests/browser.smoke.mjs). */
interface MeshPreviewHarness {
  app: App;
  glUnavailable: boolean;
  draw: () => void;
  /** Draws and re-renders the inspector panels synchronously. */
  refresh: () => void;
  loadSample: typeof loadSample;
  fit: () => void;
  getState: () => {
    triangles: number;
    flipped: number;
    collapsed: number;
    overStretched: number;
    accidentalSplits: number;
    splitSeams: number;
    invalidSeams: number;
    historyDepth: number;
    canUndo: boolean;
    fingerprint: string;
    diagnosticsFingerprint: string;
    canvasPixels: { width: number; height: number };
    summaryHtml: string;
    detailHtml: string;
    detailLabel: string;
    panelsMatch: boolean;
  };
  pickAt: (cssX: number, cssY: number) => { kind: string; vertex: number | null; triangleId: number | null; seamId: string | null };
  dragVertex: (index: number, worldX: number, worldY: number) => boolean;
}

declare global {
  interface Window {
    __meshPreview?: MeshPreviewHarness;
  }
}

window.__meshPreview = {
  app,
  glUnavailable,
  draw,
  refresh: () => {
    draw();
    updatePanels();
  },
  loadSample,
  fit,
  getState: () => {
    const snapshot = app.snapshot();
    const summary = summaryHtml(snapshot);
    const detail = localDetailHtml(snapshot);
    return {
      triangles: app.document.triangles.length,
      flipped: app.diagnostics.flippedTriangles,
      collapsed: app.diagnostics.collapsedTriangles,
      overStretched: app.diagnostics.overStretchedTriangles,
      accidentalSplits: app.diagnostics.accidentalSplits,
      splitSeams: app.diagnostics.splitSeams,
      invalidSeams: app.diagnostics.invalidSeams,
      historyDepth: snapshot.history.depth,
      canUndo: snapshot.history.canUndo,
      fingerprint: documentFingerprint(app.document),
      diagnosticsFingerprint: app.diagnostics.fingerprint,
      canvasPixels: { width: canvas!.width, height: canvas!.height },
      summaryHtml: summary,
      detailHtml: detail.html,
      detailLabel: detail.label,
      panelsMatch: elements.summary.innerHTML === summary && elements.localDetail.innerHTML === detail.html,
    };
  },
  pickAt: (cssX: number, cssY: number) => {
    const layout = panes();
    const hit = pickInFabric(app.document, app.camera, layout.fabric, cssX - (cssX >= layout.texture.x ? layout.texture.x : layout.fabric.x), cssY);
    return { kind: hit.kind, vertex: hit.vertex, triangleId: hit.triangleId, seamId: hit.seamId };
  },
  dragVertex: (index: number, worldX: number, worldY: number) => {
    if (!app.beginVertexDrag(index)) return false;
    app.updateVertexDrag({ x: worldX, y: worldY });
    app.endVertexDrag();
    return true;
  },
};
