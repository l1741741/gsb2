// 演示页：加载本地 JSON，逐层渲染 SVG，支持缩放/平移/导出。
// 屏幕上的 SVG 与导出的 SVG 来自同一个生成器（renderFloorSvg），几何必然一致。

import { loadPlan } from '../src/model.js';
import { renderFloorSvg } from '../src/svg.js';
import { buildFloorLayout } from '../src/layout.js';

const wrap = document.getElementById('canvasWrap');
const errorsEl = document.getElementById('errors');
const floorTabs = document.getElementById('floorTabs');

const state = {
  plan: null,
  errors: [],
  floorId: null,
  views: new Map(), // floorId -> { scale, panX, panY }
};

function view() {
  if (!state.views.has(state.floorId)) {
    state.views.set(state.floorId, { scale: 1, panX: 40, panY: 40 });
  }
  return state.views.get(state.floorId);
}

function render() {
  if (!state.plan || !state.floorId) return;
  const rect = wrap.getBoundingClientRect();
  const v = view();
  const svg = renderFloorSvg(state.plan, state.floorId, {
    scale: v.scale, panX: v.panX, panY: v.panY,
    width: Math.max(rect.width, 100), height: Math.max(rect.height, 100),
  });
  wrap.innerHTML = svg; // 屏幕显示与导出使用同一字符串
  renderErrors();
  renderTabs();
}

function renderErrors() {
  if (state.errors.length === 0) {
    errorsEl.innerHTML = '<h2>校验</h2><p class="ok">✓ 数据校验通过，没有断开的链路。</p>';
    return;
  }
  const items = state.errors.map((e) => {
    const tags = [
      e.route && `<span class="tag">路线 ${escapeHtml(e.route)}</span>`,
      e.floor && `<span class="tag">楼层 ${escapeHtml(e.floor)}</span>`,
      e.node && `<span class="tag">节点 ${escapeHtml(e.node)}</span>`,
    ].filter(Boolean).join('');
    return `<li>${tags}${escapeHtml(e.message)}</li>`;
  }).join('');
  errorsEl.innerHTML = `<h2>校验发现 ${state.errors.length} 处问题</h2><ul>${items}</ul>`;
}

function renderTabs() {
  floorTabs.innerHTML = '';
  for (const f of state.plan.floors) {
    const b = document.createElement('button');
    b.textContent = f.name;
    b.className = f.id === state.floorId ? 'active' : '';
    b.onclick = () => { state.floorId = f.id; render(); };
    floorTabs.appendChild(b);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fitView() {
  const layout = buildFloorLayout(state.plan, state.floorId, 1);
  const b = layout.bounds;
  if (!Number.isFinite(b.minX)) return;
  const rect = wrap.getBoundingClientRect();
  const margin = 80;
  const sx = (rect.width - margin * 2) / Math.max(b.maxX - b.minX, 1);
  const sy = (rect.height - margin * 2) / Math.max(b.maxY - b.minY, 1);
  const scale = Math.min(sx, sy, 2);
  const v = view();
  v.scale = scale;
  v.panX = margin - b.minX * scale + (rect.width - margin * 2 - (b.maxX - b.minX) * scale) / 2;
  v.panY = margin - b.minY * scale + (rect.height - margin * 2 - (b.maxY - b.minY) * scale) / 2;
}

function loadData(data, sourceName) {
  try {
    const { plan, errors } = loadPlan(data);
    state.plan = plan;
    state.errors = errors;
    state.floorId = plan.floors[0]?.id ?? null;
    state.views.clear();
    if (state.floorId) fitView();
    render();
  } catch (e) {
    errorsEl.innerHTML = `<h2>无法载入 ${escapeHtml(sourceName)}</h2><p>${escapeHtml(e.message)}</p>`;
  }
}

// ---- 交互：滚轮缩放（以光标为中心）、拖拽平移 ----
wrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  const v = view();
  const rect = wrap.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;
  const next = Math.min(8, Math.max(0.2, v.scale * Math.exp(-e.deltaY * 0.0012)));
  const wx = (cx - v.panX) / v.scale;
  const wy = (cy - v.panY) / v.scale;
  v.scale = next;
  v.panX = cx - wx * next;
  v.panY = cy - wy * next;
  render();
}, { passive: false });

let drag = null;
wrap.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY };
  wrap.classList.add('dragging');
  wrap.setPointerCapture(e.pointerId);
});
wrap.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const v = view();
  v.panX += e.clientX - drag.x;
  v.panY += e.clientY - drag.y;
  drag = { x: e.clientX, y: e.clientY };
  render();
});
wrap.addEventListener('pointerup', () => { drag = null; wrap.classList.remove('dragging'); });

document.getElementById('fitBtn').onclick = () => { fitView(); render(); };

document.getElementById('exportBtn').onclick = () => {
  const rect = wrap.getBoundingClientRect();
  const v = view();
  const svg = renderFloorSvg(state.plan, state.floorId, {
    scale: v.scale, panX: v.panX, panY: v.panY,
    width: Math.max(rect.width, 100), height: Math.max(rect.height, 100),
  });
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `evac-${state.floorId}.svg`;
  a.click();
  URL.revokeObjectURL(a.href);
};

document.getElementById('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      loadData(JSON.parse(reader.result), file.name);
    } catch (parseErr) {
      errorsEl.innerHTML = `<h2>无法解析 ${escapeHtml(file.name)}</h2><p>${escapeHtml(parseErr.message)}</p>`;
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

document.getElementById('demoBtn').onclick = async () => {
  const resp = await fetch('./data/demo.json');
  loadData(await resp.json(), '示范数据');
};

window.addEventListener('resize', render);

document.getElementById('demoBtn').click();
