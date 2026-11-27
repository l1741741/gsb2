// 灯光预演工具主应用：状态管理、指针交互、面板绑定与导入导出。
// 照明计算全部在世界坐标中进行；每盏灯的可见多边形单独缓存，
// 拖动某盏灯时只有该灯重算，静止灯结果保持不变，因此不会随绘制闪动。

import { Camera } from '../src/camera.js';
import { buildDimGrid, lightSignature, probePoint } from '../src/lighting.js';
import { loadScene, sceneSegments, serializeScene } from '../src/scene.js';
import { renderFrame } from '../src/render.js';
import { sampleScenes } from '../src/samples.js';
import { buildVisibilityPolygon } from '../src/visibility.js';

const canvas = document.querySelector('#canvas');
const context = canvas.getContext('2d');
const els = {
  sample: document.querySelector('#sample-select'),
  reset: document.querySelector('#reset-sample'),
  threshold: document.querySelector('#threshold'),
  cellSize: document.querySelector('#cell-size'),
  toggleDim: document.querySelector('#toggle-dim'),
  fitView: document.querySelector('#fit-view'),
  probeMode: document.querySelector('#probe-mode'),
  clearProbe: document.querySelector('#clear-probe'),
  lightList: document.querySelector('#light-list'),
  editor: document.querySelector('#light-editor'),
  editorTitle: document.querySelector('#editor-title'),
  leX: document.querySelector('#le-x'),
  leY: document.querySelector('#le-y'),
  leAim: document.querySelector('#le-aim'),
  leFov: document.querySelector('#le-fov'),
  leRange: document.querySelector('#le-range'),
  lePower: document.querySelector('#le-power'),
  leColor: document.querySelector('#le-color'),
  runChecks: document.querySelector('#run-checks'),
  checkList: document.querySelector('#check-list'),
  exportJson: document.querySelector('#export-json'),
  exportPng: document.querySelector('#export-png'),
  importJson: document.querySelector('#import-json'),
  status: document.querySelector('#status'),
  probeCard: document.querySelector('#probe-card'),
};

const state = {
  scene: null,
  segments: [],
  camera: new Camera(),
  // 每盏灯的可见多边形缓存，键为灯 id。
  polygonCache: new Map(),
  lightHashes: new Map(),
  geometryHash: '',
  dimGrid: null,
  dimHash: '',
  showDimGrid: true,
  selectedId: null,
  draggingId: null,
  dragMode: null, // 'move' | 'aim'
  probeMode: false,
  probe: null,
  probeWorld: null,
  checkpointResults: null,
  activeSample: 'corridor',
};

function setStatus(message, isError = false) {
  els.status.textContent = message;
  els.status.style.color = isError ? '#ff8a9a' : '#67e8f9';
}

// ---------- 场景装载与缓存 ----------

function hash(value) {
  return JSON.stringify(value);
}

function lightHash(light) {
  return hash([light.x, light.y, light.aim, light.fov, light.range, light.power, light.enabled]);
}

function loadSample(key) {
  const sample = sampleScenes.find((item) => item.key === key) ?? sampleScenes[0];
  state.activeSample = sample.key;
  state.scene = loadScene(sample.data);
  state.segments = sceneSegments(state.scene);
  state.geometryHash = hash(state.segments.map((s) => [s.a, s.b]));
  state.polygonCache = new Map();
  state.lightHashes = new Map();
  state.dimGrid = null;
  state.dimHash = '';
  state.selectedId = null;
  state.draggingId = null;
  state.probe = null;
  state.probeWorld = null;
  state.checkpointResults = null;
  refreshSettingsInputs();
  refreshLightList();
  fitView();
  scheduleRender();
  setStatus(`已载入样例：${state.scene.name}`);
}

function recomputeLight(light) {
  if (light.enabled === false) {
    state.polygonCache.delete(light.id);
    state.lightHashes.set(light.id, lightHash(light));
    return;
  }
  const polygon = buildVisibilityPolygon(light, state.segments);
  state.polygonCache.set(light.id, polygon.length >= 3 ? polygon : []);
  state.lightHashes.set(light.id, lightHash(light));
}

function ensurePolygons() {
  let changed = false;
  for (const light of state.scene.lights) {
    const signature = lightHash(light);
    if (state.lightHashes.get(light.id) !== signature) {
      recomputeLight(light);
      changed = true;
    }
  }
  return changed;
}

function ensureDimGrid(force = false) {
  const signature = lightSignature(state.scene) + state.geometryHash;
  if (force || state.dimHash !== signature) {
    state.dimGrid = buildDimGrid(state.scene, state.segments, state.polygonCache);
    state.dimHash = signature;
  }
}

// ---------- 渲染 ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    draw();
  });
}

function draw() {
  ensurePolygons();
  ensureDimGrid();
  renderFrame(canvas, context, state.camera, state.scene, {
    polygons: state.polygonCache,
    dimGrid: state.dimGrid,
    showDimGrid: state.showDimGrid,
    selectedId: state.selectedId,
    draggingId: state.draggingId,
    probe: state.probe,
    probeWorld: state.probeWorld,
    checkpointResults: state.checkpointResults,
  });
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  scheduleRender();
}

function fitView() {
  const rect = canvas.getBoundingClientRect();
  state.camera.fitBounds(rect.width, rect.height, state.scene.bounds);
  scheduleRender();
}

// ---------- 坐标与拾取 ----------

function pointerWorld(event) {
  const rect = canvas.getBoundingClientRect();
  return state.camera.screenToWorld({ x: event.clientX - rect.left, y: event.clientY - rect.top });
}

function pickLight(worldPoint) {
  let best = null;
  let bestDistance = 14 / state.camera.scale + 6;
  for (const light of state.scene.lights) {
    const d = Math.hypot(light.x - worldPoint.x, light.y - worldPoint.y);
    if (d < bestDistance) {
      best = light;
      bestDistance = d;
    }
  }
  return best;
}

function clampToBounds(point) {
  return {
    x: Math.min(state.scene.bounds.width, Math.max(0, point.x)),
    y: Math.min(state.scene.bounds.height, Math.max(0, point.y)),
  };
}

// ---------- 指针交互 ----------

let panStart = null;

canvas.addEventListener('pointerdown', (event) => {
  canvas.setPointerCapture(event.pointerId);
  const world = pointerWorld(event);
  const light = pickLight(world);
  if (state.probeMode) {
    state.probeWorld = world;
    state.probe = probePoint(state.scene, state.segments, world, state.polygonCache);
    renderProbeCard();
    scheduleRender();
    return;
  }
  if (light) {
    state.selectedId = light.id;
    state.draggingId = light.id;
    state.dragMode = event.altKey ? 'aim' : 'move';
    refreshLightList();
    fillEditor();
  } else {
    state.selectedId = null;
    panStart = { x: event.clientX, y: event.clientY, camX: state.camera.x, camY: state.camera.y };
    canvas.classList.add('panning');
    refreshLightList();
  }
});

canvas.addEventListener('pointermove', (event) => {
  if (state.draggingId) {
    const light = state.scene.lights.find((item) => item.id === state.draggingId);
    const world = clampToBounds(pointerWorld(event));
    if (state.dragMode === 'move') {
      light.x = Math.round(world.x);
      light.y = Math.round(world.y);
    } else {
      light.aim = Math.atan2(world.y - light.y, world.x - light.x);
    }
    fillEditor();
    refreshProbe();
    scheduleRender();
    return;
  }
  if (panStart) {
    state.camera.x = panStart.camX + (event.clientX - panStart.x);
    state.camera.y = panStart.camY + (event.clientY - panStart.y);
    scheduleRender();
  }
});

function endPointer(event) {
  if (state.draggingId) {
    state.draggingId = null;
    state.dragMode = null;
    scheduleRender();
  }
  panStart = null;
  canvas.classList.remove('panning');
  if (event.pointerId !== undefined && canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
  const factor = Math.exp(-event.deltaY * 0.0012);
  state.camera.zoomAt(screen, state.camera.scale * factor);
  scheduleRender();
}, { passive: false });

// ---------- 面板：设置 ----------

function refreshSettingsInputs() {
  els.threshold.value = state.scene.settings.threshold;
  els.cellSize.value = state.scene.settings.cellSize;
}

els.threshold.addEventListener('change', () => {
  const value = Number.parseFloat(els.threshold.value);
  if (!Number.isFinite(value) || value < 0) {
    setStatus('门限必须是非负数字', true);
    refreshSettingsInputs();
    return;
  }
  state.scene.settings.threshold = value;
  state.dimHash = '';
  state.checkpointResults = null;
  refreshProbe();
  scheduleRender();
});

els.cellSize.addEventListener('change', () => {
  const value = Number.parseFloat(els.cellSize.value);
  if (!Number.isFinite(value) || value <= 0) {
    setStatus('网格单元必须是正数', true);
    refreshSettingsInputs();
    return;
  }
  state.scene.settings.cellSize = value;
  state.dimHash = '';
  scheduleRender();
});

els.toggleDim.addEventListener('click', () => {
  state.showDimGrid = !state.showDimGrid;
  els.toggleDim.textContent = state.showDimGrid ? '隐藏暗区' : '显示暗区';
  scheduleRender();
});

els.fitView.addEventListener('click', fitView);

els.probeMode.addEventListener('click', () => {
  state.probeMode = !state.probeMode;
  els.probeMode.classList.toggle('active', state.probeMode);
  els.probeMode.textContent = `探针模式：${state.probeMode ? '开' : '关'}`;
  canvas.classList.toggle('probing', state.probeMode);
});

els.clearProbe.addEventListener('click', () => {
  state.probe = null;
  state.probeWorld = null;
  els.probeCard.classList.add('hidden');
  scheduleRender();
});

// ---------- 面板：灯具列表与编辑器 ----------

function refreshLightList() {
  els.lightList.innerHTML = '';
  for (const light of state.scene.lights) {
    const item = document.createElement('li');
    item.className = 'light-item';
    if (light.id === state.selectedId) item.classList.add('selected');
    if (light.enabled === false) item.classList.add('off');

    const dot = document.createElement('span');
    dot.className = 'light-dot';
    dot.style.background = light.enabled === false ? '#5a6570' : light.color;
    item.append(dot);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = `${light.id} · ${light.name}`;
    item.append(name);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = light.enabled === false ? '启用' : '禁用';
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      light.enabled = !light.enabled;
      state.checkpointResults = null;
      if (light.enabled === false && state.selectedId === light.id) {
        state.selectedId = null;
      }
      refreshLightList();
      fillEditor();
      refreshProbe();
      scheduleRender();
    });
    item.append(toggle);

    item.addEventListener('click', () => {
      state.selectedId = light.id;
      refreshLightList();
      fillEditor();
    });
    els.lightList.append(item);
  }
}

function selectedLight() {
  return state.scene.lights.find((light) => light.id === state.selectedId) ?? null;
}

function fillEditor() {
  const light = selectedLight();
  if (!light) {
    els.editor.classList.add('hidden');
    return;
  }
  els.editor.classList.remove('hidden');
  els.editorTitle.textContent = `灯具参数 — ${light.id}`;
  els.leX.value = Math.round(light.x);
  els.leY.value = Math.round(light.y);
  els.leAim.value = Math.round((light.aim * 180) / Math.PI);
  els.leFov.value = Math.round((light.fov * 180) / Math.PI);
  els.leRange.value = light.range;
  els.lePower.value = light.power;
  els.leColor.value = light.color;
}

function bindNumber(input, apply) {
  input.addEventListener('change', () => {
    const light = selectedLight();
    if (!light) return;
    const value = Number.parseFloat(input.value);
    if (!Number.isFinite(value)) {
      fillEditor();
      return;
    }
    apply(light, value);
    state.checkpointResults = null;
    fillEditor();
    refreshLightList();
    refreshProbe();
    scheduleRender();
  });
}

bindNumber(els.leX, (light, value) => { light.x = value; });
bindNumber(els.leY, (light, value) => { light.y = value; });
bindNumber(els.leAim, (light, value) => { light.aim = (value * Math.PI) / 180; });
bindNumber(els.leFov, (light, value) => {
  light.fov = Math.min(Math.PI, Math.max(0.02, (value * Math.PI) / 180));
});
bindNumber(els.leRange, (light, value) => { if (value > 0) light.range = value; });
bindNumber(els.lePower, (light, value) => { if (value > 0) light.power = value; });
els.leColor.addEventListener('change', () => {
  const light = selectedLight();
  if (!light) return;
  light.color = els.leColor.value;
  refreshLightList();
  refreshProbe();
  scheduleRender();
});

// ---------- 探针卡片 ----------

// 灯位/开关变化后，若探针仍在场上则按新参数重算读数。
function refreshProbe() {
  if (!state.probeWorld) return;
  state.probe = probePoint(state.scene, state.segments, state.probeWorld, state.polygonCache);
  renderProbeCard();
}

function renderProbeCard() {
  const probe = state.probe;
  if (!probe) {
    els.probeCard.classList.add('hidden');
    return;
  }  const rows = probe.contributions.length
    ? probe.contributions.map((c) => `<tr><td>${c.name} (${c.lightId})</td><td>${c.illuminance.toFixed(4)}</td></tr>`).join('')
    : '<tr><td colspan="2">无任何灯照亮该点</td></tr>';
  const verdict = probe.belowThreshold
    ? `<span class="dim">低于门限 ${state.scene.settings.threshold}</span>`
    : `<span class="lit">高于门限 ${state.scene.settings.threshold}</span>`;
  els.probeCard.innerHTML = `
    <h2>探针读数</h2>
    <div>世界坐标：(${probe.point.x.toFixed(1)}, ${probe.point.y.toFixed(1)})</div>
    <div>总照度：${probe.total.toFixed(4)} · ${verdict}</div>
    <table>${rows}</table>`;
  els.probeCard.classList.remove('hidden');
}

// ---------- 检查点复核 ----------

function evaluateCheckpoints() {
  ensurePolygons();
  const results = new Map();
  for (const checkpoint of state.scene.checkpoints) {
    const probe = probePoint(state.scene, state.segments, checkpoint, state.polygonCache);
    const ids = probe.contributions.map((c) => c.lightId);
    let pass = false;
    let detail = '';
    if (checkpoint.expect === 'dark') {
      pass = ids.length === 0;
      detail = pass ? '无灯贡献，符合全暗预期' : `意外被 ${ids.join(', ')} 照亮`;
    } else if (checkpoint.expect === 'partial') {
      pass = ids.length >= 2;
      detail = pass ? `${ids.join(', ')} 在此相交` : `仅 ${ids.join(', ') || '无'} 贡献，期望至少两盏`;
    } else {
      const anyVisible = ids.length >= 1;
      const expectedOk = !checkpoint.lights || checkpoint.lights.every((id) => ids.includes(id));
      pass = anyVisible && expectedOk;
      detail = `照亮灯具：${ids.join(', ') || '无'}`;
    }
    results.set(checkpoint.id, { pass, detail, total: probe.total, ids });
  }
  state.checkpointResults = results;
  renderCheckList();
  scheduleRender();
}

function renderCheckList() {
  els.checkList.innerHTML = '';
  if (!state.checkpointResults) return;
  for (const checkpoint of state.scene.checkpoints) {
    const result = state.checkpointResults.get(checkpoint.id);
    const item = document.createElement('li');
    item.className = `check-item ${result.pass ? 'pass' : 'fail'}`;
    const label = { dark: '应全暗', partial: '部分相交', visible: '直接可见' }[checkpoint.expect];
    item.innerHTML = `
      <div><strong>${checkpoint.id}</strong> · ${label}
        <span class="verdict">${result.pass ? '✓ 通过' : '✗ 不符'}</span></div>
      <div class="detail">${checkpoint.note || ''}<br>${result.detail}；总照度 ${result.total.toFixed(4)}</div>`;
    els.checkList.append(item);
  }
}

els.runChecks.addEventListener('click', () => {
  evaluateCheckpoints();
  const failed = [...state.checkpointResults.values()].filter((r) => !r.pass).length;
  setStatus(failed === 0 ? '检查点全部通过' : `${failed} 个检查点与预期不符`, failed > 0);
});

// ---------- 导入 / 导出 ----------

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

els.exportJson.addEventListener('click', () => {
  // 复核快照随方案一起导出：相同 JSON 重新导入后可按相同门限/灯位复核。
  const payload = {
    ...serializeScene(state.scene),
    review: {
      exportedAt: new Date().toISOString(),
      threshold: state.scene.settings.threshold,
      cellSize: state.scene.settings.cellSize,
      checkpoints: state.scene.checkpoints.map((cp) => {
        const probe = probePoint(state.scene, state.segments, cp, state.polygonCache);
        return {
          id: cp.id,
          expect: cp.expect,
          total: probe.total,
          contributors: probe.contributions.map((c) => c.lightId),
          belowThreshold: probe.belowThreshold,
        };
      }),
    },
  };
  download(`${state.activeSample}-plan.json`, JSON.stringify(payload, null, 2), 'application/json');
  setStatus('方案 JSON 已导出（含复核快照）');
});

els.exportPng.addEventListener('click', () => {
  ensurePolygons();
  ensureDimGrid(true);
  draw();
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.activeSample}-preview.png`;
    anchor.click();
    URL.revokeObjectURL(url);
    setStatus('预览 PNG 已导出');
  }, 'image/png');
});

els.importJson.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    state.scene = loadScene(data);
    state.segments = sceneSegments(state.scene);
    state.geometryHash = hash(state.segments.map((s) => [s.a, s.b]));
    state.polygonCache = new Map();
    state.lightHashes = new Map();
    state.dimGrid = null;
    state.dimHash = '';
    state.selectedId = null;
    state.probe = null;
    state.probeWorld = null;
    state.checkpointResults = null;
    state.activeSample = file.name.replace(/\.json$/i, '') || 'imported';
    refreshSettingsInputs();
    refreshLightList();
    fillEditor();
    fitView();
    setStatus(`已导入方案：${state.scene.name}（门限 ${state.scene.settings.threshold}，可直接复核）`);
  } catch (error) {
    setStatus(`导入失败：${error.message}`, true);
  } finally {
    event.target.value = '';
  }
});

// ---------- 样例选择与启动 ----------

for (const sample of sampleScenes) {
  const option = document.createElement('option');
  option.value = sample.key;
  option.textContent = sample.label;
  els.sample.append(option);
}
els.sample.addEventListener('change', () => loadSample(els.sample.value));
els.reset.addEventListener('click', () => loadSample(state.activeSample));

window.addEventListener('resize', resizeCanvas);
els.sample.value = state.activeSample;
loadSample('corridor');
resizeCanvas();
