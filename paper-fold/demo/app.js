// 纸模折叠预览的浏览器应用层：文件读取、进度滑动、检测结果呈现、面选中与接缝面板。
// 所有数值逻辑都来自 src/ 下的纯模块，本文件只负责 DOM 与 Canvas 交互。

import { loadModel } from '../src/model.js';
import { solveAt } from '../src/solver.js';
import { analyzeContacts, adjacentPairs, scanProgress } from '../src/intersection.js';
import { allSeamGaps } from '../src/seams.js';
import { OrbitCamera, buildDrawList, drawFaceOutline, drawSegment } from '../src/camera.js';

const SAMPLE_FILES = {
  tube: '正常合拢：四面板方管（三段串联折缝）',
  crossing: '会穿插：对向双折页',
  'invalid-ring': '坏样例：折缝闭合环',
  'invalid-duplicate-id': '坏样例：重复折缝编号',
  'invalid-edge': '坏样例：无效共享边',
};

const COLORS = {
  faceFill: 'rgba(96, 165, 214, 0.55)',
  faceStroke: '#cfe3f5',
  crease: '#ffd166',
  cross: '#ff5d5d',
  touch: '#8be28b',
  selected: '#7cc4ff',
  seam: '#c792ea',
};

const state = {
  model: null,
  rawName: '',
  progress: 0,
  selectedFaces: new Set(),
  camera: null,
  scan: null,
  contactResult: null,
  gapResults: [],
  filterCrossOnly: false,
};

const $ = (sel) => document.querySelector(sel);

const canvas = $('#view');
const ctx = canvas.getContext('2d');
const slider = $('#progress');
const progressLabel = $('#progress-label');

function setStatus(kind, html) {
  const box = $('#status');
  box.className = `status ${kind}`;
  box.innerHTML = html;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

async function loadJsonText(text, label) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    setStatus('error', `<strong>JSON 解析失败：</strong>${escapeHtml(err.message)}`);
    return;
  }
  const result = loadModel(raw);
  if (!result.ok) {
    state.model = null;
    const items = result.errors.map((e) =>
      `<li><code>${escapeHtml(e.code)}</code> <span class="path">${escapeHtml(e.path)}</span> — ${escapeHtml(e.message)}</li>`).join('');
    setStatus('error', `<strong>“${escapeHtml(label)}”无法加载，共 ${result.errors.length} 个问题：</strong><ul class="error-list">${items}</ul>`);
    $('#contact-panel').innerHTML = '';
    $('#seam-panel').innerHTML = '';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }
  activateModel(result.model, label);
  if (result.warnings.length > 0) {
    setStatus('warn', result.warnings.map((w) => escapeHtml(w.message)).join('<br>'));
  } else {
    setStatus('ok', `已加载 <strong>${escapeHtml(label)}</strong>：${result.model.faceOrder.length} 个面、${result.model.creases.size} 条折缝、${result.model.targets.length} 条目标接缝。`);
  }
}

function activateModel(model, label) {
  state.model = model;
  state.rawName = label;
  state.selectedFaces.clear();
  state.progress = 0;
  slider.value = '0';
  state.camera = new OrbitCamera({ width: canvas.width, height: canvas.height, extent: model.extent });
  // 粗扫一次，回答“哪两片先穿过去”；扫描结果只用于时间线标记，不影响逐帧判定。
  state.scan = scanProgress(model, 96);
  renderTimeline();
  update();
}

function renderTimeline() {
  const marker = $('#first-cross-marker');
  if (state.scan?.firstCross) {
    const fc = state.scan.firstCross;
    marker.style.display = 'block';
    marker.style.left = `${fc.progress * 100}%`;
    marker.title = `首个互穿进度 ${(fc.progress * 100).toFixed(1)}%：${fc.pairs.join('、')}`;
  } else {
    marker.style.display = 'none';
  }
}

function update() {
  if (!state.model) return;
  const t = Number(slider.value);
  state.progress = t;
  progressLabel.textContent = `${(t * 100).toFixed(1)}%`;
  const poses = solveAt(state.model, t);
  state.contactResult = analyzeContacts(state.model, poses);
  state.gapResults = allSeamGaps(state.model, poses);
  draw(poses);
  renderContactPanel();
  renderSelectionPanel(poses);
  renderSeamPanel();
}

function renderSelectionPanel(poses) {
  const panel = $('#selection-panel');
  if (state.selectedFaces.size === 0) {
    panel.innerHTML = '<p class="muted">点击画布中的面或接触条目进行选中；再次点击取消，点击空白处清空。</p>';
    return;
  }
  const adjacent = adjacentPairs(state.model);
  const { crossingPairs, touchingPairs } = state.contactResult;
  const ids = [...state.selectedFaces];
  const relations = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const key = [ids[i], ids[j]].sort().join('|');
      let rel = '无接触';
      if (adjacent.has(key)) rel = '邻接（共享折缝，始终接合）';
      else if (crossingPairs.has(key)) rel = '互穿';
      else if (touchingPairs.has(key)) rel = '贴合（仅边界接触）';
      relations.push(`<li><code>${escapeHtml(ids[i])}</code> ↔ <code>${escapeHtml(ids[j])}</code>：${rel}</li>`);
    }
  }
  const creaseInfo = ids.map((id) => {
    const links = [...state.model.creases.values()]
      .filter((c) => c.faces.includes(id))
      .map((c) => {
        const other = c.faces.find((f) => f !== id);
        return `<li class="small muted">折缝 <code>${escapeHtml(c.id)}</code> → <code>${escapeHtml(other)}</code>，${c.direction === 'valley' ? '谷折' : '山折'}，结束角 ${c.endAngle.toFixed(3)} rad，当前转角 ${poses.get(id).hingeAngle.toFixed(3)} rad</li>`;
      });
    return `<div class="face-card"><strong>${escapeHtml(id)}</strong><ul class="seam-list" style="margin-top:4px">${links.join('') || '<li class="small muted">根面，无父折缝</li>'}</ul></div>`;
  }).join('');
  panel.innerHTML = `
    <div>已选 ${ids.length} 个面：${ids.map((id) => `<code>${escapeHtml(id)}</code>`).join('、')}</div>
    ${relations.length ? `<ul class="seam-list" style="margin:8px 0">${relations.join('')}</ul>` : ''}
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${creaseInfo}</div>`;
}

function draw(poses) {
  const { model, camera } = state;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  const drawList = buildDrawList(camera, model.faceOrder, poses);
  const crossPairs = state.contactResult.crossingPairs;
  const touchPairs = state.contactResult.touchingPairs;

  const pairOf = (faceId, other) => [faceId, other].sort().join('|');

  for (const item of drawList) {
    const { faceId, projected } = item;
    let involvedCross = false;
    let involvedTouch = false;
    for (const other of model.faceOrder) {
      if (other === faceId) continue;
      const key = pairOf(faceId, other);
      if (crossPairs.has(key)) involvedCross = true;
      else if (touchPairs.has(key)) involvedTouch = true;
    }
    const selected = state.selectedFaces.has(faceId);
    if (state.filterCrossOnly && !involvedCross) {
      ctx.globalAlpha = 0.18;
    }
    ctx.beginPath();
    projected.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    if (involvedCross) {
      ctx.fillStyle = 'rgba(255, 93, 93, 0.62)';
    } else if (involvedTouch) {
      ctx.fillStyle = 'rgba(139, 226, 139, 0.5)';
    } else {
      ctx.fillStyle = COLORS.faceFill;
    }
    ctx.fill();
    ctx.lineWidth = selected ? 3 : 1;
    ctx.strokeStyle = selected ? COLORS.selected : COLORS.faceStroke;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // 折缝线（正常邻接）。
  ctx.strokeStyle = COLORS.crease;
  ctx.lineWidth = 2.5;
  for (const crease of model.creases.values()) {
    const edge = crease.edgeByFace[crease.parentFace];
    const pts = poses.get(crease.parentFace).points;
    drawSegment(ctx, camera, pts[edge[0]], pts[edge[1]]);
  }

  // 互穿/贴合标记：取两面中心连线，在中点画符号。
  for (const contact of state.contactResult.contacts) {
    const [a, b] = contact.faces;
    const ma = poses.get(a).centroid;
    const mb = poses.get(b).centroid;
    const mid = [(ma[0] + mb[0]) / 2, (ma[1] + mb[1]) / 2, (ma[2] + mb[2]) / 2];
    const s = camera.project(mid);
    ctx.font = 'bold 15px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (contact.kind === 'cross') {
      ctx.fillStyle = COLORS.cross;
      ctx.fillText('✕', s.x, s.y);
    } else {
      ctx.fillStyle = COLORS.touch;
      ctx.fillText('◦', s.x, s.y);
    }
  }

  // 目标接缝边。
  if (state.gapResults.length > 0) {
    ctx.strokeStyle = COLORS.seam;
    ctx.lineWidth = 2;
    ctx.setLineDash([7, 5]);
    for (const { target } of state.gapResults) {
      for (const spec of target.edges) {
        const pts = poses.get(spec.face).points;
        drawSegment(ctx, camera, pts[spec.edge[0]], pts[spec.edge[1]]);
      }
    }
    ctx.setLineDash([]);
  }

  // 选中面的外轮廓加粗描边。
  if (state.selectedFaces.size > 0) {
    ctx.strokeStyle = COLORS.selected;
    ctx.lineWidth = 3.5;
    for (const faceId of state.selectedFaces) {
      drawFaceOutline(ctx, camera, poses.get(faceId).points);
    }
  }
}

function drawGrid() {
  const { camera, model } = state;
  const e = model.extent;
  ctx.strokeStyle = 'rgba(160, 190, 220, 0.12)';
  ctx.lineWidth = 1;
  const step = e / 4;
  for (let k = -4; k <= 8; k += 1) {
    const v = k * step;
    drawSegment(ctx, camera, [v, -step * 2, 0], [v, e + step * 2, 0]);
    drawSegment(ctx, camera, [-step * 2, v, 0], [e + step * 2, v, 0]);
  }
}

function renderContactPanel() {
  const panel = $('#contact-panel');
  const { contacts } = state.contactResult;
  const cross = contacts.filter((c) => c.kind === 'cross');
  const touch = contacts.filter((c) => c.kind === 'touch');
  const parts = [];
  parts.push(`<div class="summary">互穿 <strong class="cross-text">${cross.length}</strong> 对 · 贴合 <strong class="touch-text">${touch.length}</strong> 对（邻接折缝不计入）</div>`);
  if (state.scan?.firstCross) {
    const fc = state.scan.firstCross;
    parts.push(`<div class="first-cross">最早互穿出现在进度 <strong>${(fc.progress * 100).toFixed(1)}%</strong>：${fc.pairs.map((p) => `<code>${escapeHtml(p)}</code>`).join('、')}</div>`);
  } else {
    parts.push('<div class="first-cross ok-text">整个折叠过程未检测到互穿。</div>');
  }
  if (contacts.length === 0) {
    parts.push('<p class="muted">当前进度没有非邻接接触。</p>');
  } else {
    parts.push('<ul class="contact-list">' + contacts.map((c) => {
      const selected = c.faces.every((f) => state.selectedFaces.has(f));
      return `<li class="contact ${c.kind} ${selected ? 'selected' : ''}" data-faces='${JSON.stringify(c.faces).replace(/'/g, '&#39;')}'>
        <span class="badge ${c.kind}">${c.kind === 'cross' ? '互穿' : '贴合'}</span>
        <code>${escapeHtml(c.faces[0])}</code> ↔ <code>${escapeHtml(c.faces[1])}</code>
        ${c.kind === 'touch' ? `<span class="muted">间距 ${c.minDistance.toExponential(2)}</span>` : ''}
      </li>`;
    }).join('') + '</ul>');
  }
  panel.innerHTML = parts.join('');
}

function renderSeamPanel() {
  const panel = $('#seam-panel');
  if (state.gapResults.length === 0) {
    panel.innerHTML = '<p class="muted">该模型没有定义目标接缝。</p>';
    return;
  }
  panel.innerHTML = '<ul class="seam-list">' + state.gapResults.map(({ target, result }) => `
    <li class="${result.closed ? 'closed' : 'open'}">
      <div><strong>${escapeHtml(target.id)}</strong>
        <span class="badge ${result.closed ? 'touch' : 'cross'}">${result.closed ? '已合拢' : '未合拢'}</span>
      </div>
      <div class="muted">端点最大偏差 <strong>${result.gap.toFixed(6)}</strong>
        · 中点偏差 ${result.midpointGap.toFixed(6)}
        · 边长差 ${result.lengthMismatch.toExponential(2)}
        ${result.reversed ? '· 端点反向配对' : ''}
      </div>
      <div class="muted small">涉及面：<code>${escapeHtml(target.edges[0].face)}</code> / <code>${escapeHtml(target.edges[1].face)}</code></div>
    </li>`).join('') + '</ul>';
}

// ---------------------------------------------------------------------------
// 交互：进度滑动、相机轨道、点选面、面板点击联动
// ---------------------------------------------------------------------------

slider.addEventListener('input', update);

$('#filter-cross').addEventListener('change', (e) => {
  state.filterCrossOnly = e.target.checked;
  if (state.model) update();
});

$('#reset-view').addEventListener('click', () => {
  if (!state.model) return;
  state.camera = new OrbitCamera({ width: canvas.width, height: canvas.height, extent: state.model.extent });
  update();
});

let dragging = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  dragging = { x: e.clientX, y: e.clientY, moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || !state.model) return;
  const dx = e.clientX - dragging.x;
  const dy = e.clientY - dragging.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
  state.camera.yaw += dx * 0.01;
  state.camera.pitch = Math.max(0.08, Math.min(Math.PI - 0.08, state.camera.pitch + dy * 0.01));
  dragging.x = e.clientX;
  dragging.y = e.clientY;
  update();
});
canvas.addEventListener('pointerup', (e) => {
  if (!dragging) return;
  const wasClick = !dragging.moved;
  dragging = null;
  if (!wasClick || !state.model) return;
  const rect = canvas.getBoundingClientRect();
  const screen = {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
  const triMap = new Map(state.model.faceOrder.map((id) => [id, solveAt(state.model, state.progress).get(id).triangles]));
  const hit = state.camera.hitFace(screen, triMap);
  if (hit) {
    if (state.selectedFaces.has(hit)) state.selectedFaces.delete(hit);
    else state.selectedFaces.add(hit);
  } else if (!e.shiftKey) {
    state.selectedFaces.clear();
  }
  update();
});
canvas.addEventListener('wheel', (e) => {
  if (!state.model) return;
  e.preventDefault();
  state.camera.zoom *= e.deltaY > 0 ? 0.9 : 1.1;
  state.camera.zoom = Math.max(0.2, Math.min(8, state.camera.zoom));
  update();
}, { passive: false });

$('#contact-panel').addEventListener('click', (e) => {
  const li = e.target.closest('.contact');
  if (!li) return;
  const faces = JSON.parse(li.dataset.faces);
  state.selectedFaces = new Set(faces);
  update();
});

$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  loadJsonText(text, file.name);
});

document.querySelectorAll('[data-sample]').forEach((button) => {
  button.addEventListener('click', async () => {
    const name = button.dataset.sample;
    const res = await fetch(`../samples/${name}.json`);
    const text = await res.text();
    loadJsonText(text, `${name}.json — ${SAMPLE_FILES[name]}`);
  });
});

// 启动时载入正常合拢样例。
(async function boot() {
  const res = await fetch('../samples/tube.json');
  loadJsonText(await res.text(), 'tube.json — 正常合拢样例');
})();
