// 弧形展墙贴图预览：展开图 / 墙体预览双视图，离线运行，无网络请求。

import {
  makeWall,
  validateWall,
  validateArtwork,
  validateAnchors,
  wallSpanDeg,
  isFullCircle,
  arcLengthMm,
  normalizeArcMm,
  artworkCoverageAtArc,
  anchorEdgeDistances,
  projectPoint,
} from './geometry.js';
import { serializeProject, parseProject } from './project.js';

const WALL_FILL = '#e8e4da';
const WALL_GRID = '#cfc9ba';
const SEAM_COLOR = '#d23c3c';
const ANCHOR_COLOR = '#1c6dd9';
const ANCHOR_SELECTED = '#e08a00';

const state = {
  wall: makeWall({ radiusMm: 3000, startAngleDeg: 0, endAngleDeg: 200, heightMm: 2600 }),
  artwork: null, // { image, imageName, offsetMm, widthMm, bottomMm, heightMm }
  anchors: [],
  selectedAnchorId: null,
  view: 'unwrap', // 'unwrap' | 'wall'
  side: 'front', // 'front' | 'back'（翻面观看）
  viewOffsetDeg: 0, // 环绕视角偏移
  addAnchorMode: false,
  composite: null, // 展开合成画布缓存 { canvas, pxPerMm }
};

const canvas = document.querySelector('#canvas');
const ctx = canvas.getContext('2d');
const messagesEl = document.querySelector('#messages');
const hintEl = document.querySelector('#hint');

// ---------- 消息 ----------

function showMessages(errors = [], infos = []) {
  messagesEl.innerHTML = '';
  for (const text of infos) {
    const div = document.createElement('div');
    div.className = 'msg ok';
    div.textContent = text;
    messagesEl.append(div);
  }
  for (const text of errors) {
    const div = document.createElement('div');
    div.className = 'msg error';
    div.textContent = text;
    messagesEl.append(div);
  }
}

// ---------- 展开合成（贴图 + 墙面，裁切预览也用它） ----------

function buildComposite() {
  const wall = state.wall;
  const length = arcLengthMm(wall);
  const pxPerMm = Math.min(1, 4096 / length, 2048 / wall.heightMm);
  const w = Math.max(2, Math.round(length * pxPerMm));
  const h = Math.max(2, Math.round(wall.heightMm * pxPerMm));
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const c = off.getContext('2d');
  c.fillStyle = WALL_FILL;
  c.fillRect(0, 0, w, h);

  // 每 500mm 一条淡参考线
  c.strokeStyle = WALL_GRID;
  c.lineWidth = 1;
  for (let x = 500; x < length; x += 500) {
    c.beginPath();
    c.moveTo(x * pxPerMm, 0);
    c.lineTo(x * pxPerMm, h);
    c.stroke();
  }

  const artwork = state.artwork;
  if (artwork?.image) {
    const dx = artwork.offsetMm * pxPerMm;
    const dy = (wall.heightMm - artwork.bottomMm - artwork.heightMm) * pxPerMm;
    const dw = artwork.widthMm * pxPerMm;
    const dh = artwork.heightMm * pxPerMm;
    c.drawImage(artwork.image, dx, dy, dw, dh);
    if (isFullCircle(wall)) {
      // 满圈：画面跨起止缝时把回绕部分一并画出（空白区不受影响）
      c.drawImage(artwork.image, dx - length * pxPerMm, dy, dw, dh);
      c.drawImage(artwork.image, dx + length * pxPerMm, dy, dw, dh);
    }
  }
  state.composite = { canvas: off, pxPerMm };
}

// ---------- 展开图视图 ----------

function unwrapTransform() {
  const wall = state.wall;
  const length = arcLengthMm(wall);
  const margin = 48;
  const scale = Math.min(
    (canvas.width - margin * 2) / length,
    (canvas.height - margin * 2) / wall.heightMm,
  );
  return {
    scale,
    ox: (canvas.width - length * scale) / 2,
    oy: (canvas.height - wall.heightMm * scale) / 2,
    toX: (arcMm) => (canvas.width - length * scale) / 2 + arcMm * scale,
    toY: (heightMm) => (canvas.height - wall.heightMm * scale) / 2 + (wall.heightMm - heightMm) * scale,
  };
}

function renderUnwrap() {
  const wall = state.wall;
  const length = arcLengthMm(wall);
  const t = unwrapTransform();
  const wPx = length * t.scale;
  const hPx = wall.heightMm * t.scale;

  // 墙面（合成结果即裁切预览内容）
  ctx.drawImage(state.composite.canvas, t.ox, t.oy, wPx, hPx);
  ctx.strokeStyle = '#5a5346';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(t.ox, t.oy, wPx, hPx);

  // 刻度标注（每 1000mm）
  ctx.fillStyle = '#6b6353';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'center';
  for (let x = 0; x <= length + 1e-6; x += 1000) {
    ctx.fillText(`${(x / 1000).toFixed(x % 1000 === 0 ? 0 : 1)}m`, t.toX(x), t.oy + hPx + 14);
  }

  if (isFullCircle(wall)) {
    // 起止缝标记 + 接缝对照带：把墙另一端的内容接到缝外，便于核对跨缝接续
    const stripMm = Math.min(400, length / 8);
    const stripPx = stripMm * t.scale;
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.drawImage(
      state.composite.canvas,
      0, 0, stripMm * state.composite.pxPerMm, state.composite.canvas.height,
      t.ox + wPx, t.oy, stripPx, hPx,
    );
    ctx.drawImage(
      state.composite.canvas,
      state.composite.canvas.width - stripMm * state.composite.pxPerMm, 0,
      stripMm * state.composite.pxPerMm, state.composite.canvas.height,
      t.ox - stripPx, t.oy, stripPx, hPx,
    );
    ctx.restore();
    ctx.strokeStyle = SEAM_COLOR;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(t.ox, t.oy - 6);
    ctx.lineTo(t.ox, t.oy + hPx + 6);
    ctx.moveTo(t.ox + wPx, t.oy - 6);
    ctx.lineTo(t.ox + wPx, t.oy + hPx + 6);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = SEAM_COLOR;
    ctx.fillText('起止缝', t.ox, t.oy - 10);
  }

  drawAnchors((anchor) => ({ x: t.toX(anchor.arcMm), y: t.toY(anchor.heightMm) }));
  hintEl.textContent = state.addAnchorMode
    ? '添加模式：点击墙面放置定位点'
    : '展开图：点击定位点选中；点「添加定位点」后可点击墙面新增';
}

// ---------- 墙体预览（伪 3D） ----------

function renderWall() {
  const wall = state.wall;
  const length = arcLengthMm(wall);
  const { canvas: comp, pxPerMm } = state.composite;
  const full = isFullCircle(wall);
  const back = state.side === 'back';

  const midAngle = wall.startAngleDeg + wallSpanDeg(wall) / 2 + state.viewOffsetDeg;
  const margin = 40;
  const k = Math.min(
    (canvas.width - margin * 2) / (2 * wall.radiusMm),
    (canvas.height - margin * 2) / wall.heightMm,
  );
  const cx = canvas.width / 2;
  const top = (canvas.height - wall.heightMm * k) / 2;
  const hPx = wall.heightMm * k;

  ctx.fillStyle = '#20242a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 逐列投影：屏幕 x = cx ± R·k·sin(rel)，从合成展开图取 1 列切片。
  // 不足一圈时 arcAt 越界列为 null —— 不取图，空白区不会误重复。
  const stepDeg = 0.25;
  for (let rel = -90; rel <= 90; rel += stepDeg) {
    const facing = Math.cos((rel * Math.PI) / 180);
    if (facing <= 0.02) continue;
    const angleDeg = midAngle + rel;
    let relToStart = angleDeg - wall.startAngleDeg;
    if (full) {
      relToStart = ((relToStart % 360) + 360) % 360;
    } else if (relToStart < 0 || relToStart > wallSpanDeg(wall)) {
      continue; // 视角看到墙面之外：留空，不重复贴图
    }
    const arcMm = wall.radiusMm * relToStart * (Math.PI / 180);
    const sxFloat = (back ? length - arcMm : arcMm) * pxPerMm; // 翻面看内侧，图案镜像
    const sx = Math.min(comp.width - 1, Math.max(0, Math.floor(sxFloat)));
    const x = cx + (back ? -1 : 1) * wall.radiusMm * k * Math.sin((rel * Math.PI) / 180);
    const destW = Math.max(1, wall.radiusMm * k * Math.sin((stepDeg * Math.PI) / 180) * 1.2);
    ctx.drawImage(comp, sx, 0, 1, comp.height, x - destW / 2, top, destW, hPx);
  }

  // 定位点投影（只画朝向观察者的一面）
  drawAnchors((anchor) => {
    const p = projectPoint(wall, anchor.arcMm, anchor.heightMm, {
      centerAngleDeg: midAngle,
      side: state.side,
    });
    if (!p || !p.facing) return null;
    return { x: cx + p.x * k, y: top + (wall.heightMm - p.y) * k };
  });

  hintEl.textContent =
    `墙体预览（${back ? '内侧/翻面' : '外侧'}，视角偏移 ${state.viewOffsetDeg}°）：` +
    '点击定位点选中；距离读数不随翻面改变';
}

// ---------- 定位点绘制与选中 ----------

function drawAnchors(toScreen) {
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  for (const anchor of state.anchors) {
    const p = toScreen(anchor);
    if (!p) continue;
    const selected = anchor.id === state.selectedAnchorId;
    ctx.beginPath();
    ctx.arc(p.x, p.y, selected ? 7 : 5, 0, Math.PI * 2);
    ctx.fillStyle = selected ? ANCHOR_SELECTED : ANCHOR_COLOR;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = selected ? ANCHOR_SELECTED : ANCHOR_COLOR;
    ctx.fillText(anchor.name ?? anchor.id, p.x + 9, p.y - 6);
  }
}

function pickAnchor(screenX, screenY, toScreen) {
  let best = null;
  let bestDist = 14;
  for (const anchor of state.anchors) {
    const p = toScreen(anchor);
    if (!p) continue;
    const d = Math.hypot(p.x - screenX, p.y - screenY);
    if (d < bestDist) {
      bestDist = d;
      best = anchor;
    }
  }
  return best;
}

function onCanvasClick(event) {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;

  if (state.view === 'unwrap') {
    const t = unwrapTransform();
    const hit = pickAnchor(x, y, (a) => ({ x: t.toX(a.arcMm), y: t.toY(a.heightMm) }));
    if (hit) {
      selectAnchor(hit.id);
      return;
    }
    if (state.addAnchorMode) {
      const arcMm = (x - t.ox) / t.scale;
      const heightMm = state.wall.heightMm - (y - t.oy) / t.scale;
      addAnchor(arcMm, heightMm);
    }
  } else {
    const wall = state.wall;
    const midAngle = wall.startAngleDeg + wallSpanDeg(wall) / 2 + state.viewOffsetDeg;
    const margin = 40;
    const k = Math.min(
      (canvas.width - margin * 2) / (2 * wall.radiusMm),
      (canvas.height - margin * 2) / wall.heightMm,
    );
    const cx = canvas.width / 2;
    const top = (canvas.height - wall.heightMm * k) / 2;
    const hit = pickAnchor(x, y, (a) => {
      const p = projectPoint(wall, a.arcMm, a.heightMm, { centerAngleDeg: midAngle, side: state.side });
      if (!p || !p.facing) return null;
      return { x: cx + p.x * k, y: top + (wall.heightMm - p.y) * k };
    });
    if (hit) selectAnchor(hit.id);
  }
}

function addAnchor(arcMm, heightMm) {
  const arc = normalizeArcMm(state.wall, arcMm);
  if (arc === null) {
    showMessages([`点击位置在墙面之外（距起始边 ${arcMm.toFixed(0)}mm），未添加`]);
    return;
  }
  const n = state.anchors.length + 1;
  const candidate = [...state.anchors, {
    id: `P${n}`,
    name: `P${n}`,
    arcMm: Math.round(arc * 10) / 10,
    heightMm: Math.round(Math.min(Math.max(heightMm, 0), state.wall.heightMm) * 10) / 10,
  }];
  const errors = validateAnchors(state.wall, candidate);
  if (errors.length > 0) {
    showMessages(errors);
    return;
  }
  state.anchors = candidate;
  selectAnchor(`P${n}`);
  showMessages([], [`已添加定位点 P${n}`]);
}

function selectAnchor(id) {
  state.selectedAnchorId = id;
  renderAnchorList();
  renderSelection();
  render();
}

// ---------- 侧栏 ----------

function renderAnchorList() {
  const list = document.querySelector('#anchor-list');
  list.innerHTML = '';
  for (const anchor of state.anchors) {
    const li = document.createElement('li');
    if (anchor.id === state.selectedAnchorId) li.className = 'selected';
    const btn = document.createElement('button');
    btn.textContent = `${anchor.name ?? anchor.id}（${anchor.arcMm}mm, ${anchor.heightMm}mm）`;
    btn.addEventListener('click', () => selectAnchor(anchor.id));
    const del = document.createElement('button');
    del.textContent = '删';
    del.className = 'danger';
    del.addEventListener('click', () => {
      state.anchors = state.anchors.filter((a) => a.id !== anchor.id);
      if (state.selectedAnchorId === anchor.id) state.selectedAnchorId = null;
      renderAnchorList();
      renderSelection();
      render();
    });
    li.append(btn, del);
    list.append(li);
  }
}

function renderSelection() {
  const box = document.querySelector('#selection');
  const anchor = state.anchors.find((a) => a.id === state.selectedAnchorId);
  if (!anchor) {
    box.textContent = '未选中定位点';
    return;
  }
  // 距离只由几何决定：翻面观看时这组读数保持不变
  const d = anchorEdgeDistances(state.wall, anchor);
  const full = isFullCircle(state.wall);
  const edgeLabel = full ? '接缝（起止边重合）' : '起始边 / 结束边';
  box.innerHTML = '';
  const lines = full
    ? [`距接缝（沿弧向）：${Math.min(d.toStartEdgeMm, d.toEndEdgeMm).toFixed(1)}mm`,
       `（顺向 ${d.toStartEdgeMm.toFixed(1)}mm / 逆向 ${d.toEndEdgeMm.toFixed(1)}mm）`]
    : [`距${edgeLabel}：${d.toStartEdgeMm.toFixed(1)}mm / ${d.toEndEdgeMm.toFixed(1)}mm`];
  lines.push(`距底边 / 顶边：${d.toBottomMm.toFixed(1)}mm / ${d.toTopMm.toFixed(1)}mm`);
  const title = document.createElement('strong');
  title.textContent = `${anchor.name ?? anchor.id} 到墙边实际距离`;
  box.append(title, ...lines.flatMap((text) => [document.createElement('br'), document.createTextNode(text)]));
}

function fillWallForm() {
  document.querySelector('#radius').value = state.wall.radiusMm;
  document.querySelector('#start-angle').value = state.wall.startAngleDeg;
  document.querySelector('#end-angle').value = state.wall.endAngleDeg;
  document.querySelector('#wall-height').value = state.wall.heightMm;
}

function fillArtworkForm() {
  const a = state.artwork;
  document.querySelector('#art-offset').value = a?.offsetMm ?? 0;
  document.querySelector('#art-width').value = a?.widthMm ?? '';
  document.querySelector('#art-bottom').value = a?.bottomMm ?? 0;
  document.querySelector('#art-height').value = a?.heightMm ?? '';
}

function readNumber(id) {
  return Number(document.querySelector(id).value);
}

// ---------- 渲染入口 ----------

function render() {
  if (!state.composite) buildComposite();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = state.view === 'unwrap' ? '#faf8f3' : '#20242a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (state.view === 'unwrap') renderUnwrap();
  else renderWall();
  document.querySelector('#view-unwrap').classList.toggle('active', state.view === 'unwrap');
  document.querySelector('#view-wall').classList.toggle('active', state.view === 'wall');
  document.querySelector('#flip').classList.toggle('active', state.side === 'back');
  document.querySelector('#add-anchor').classList.toggle('active', state.addAnchorMode);
  const length = arcLengthMm(state.wall);
  document.querySelector('#wall-info').textContent =
    `展开长度 ${(length / 1000).toFixed(2)}m，跨度 ${wallSpanDeg(state.wall)}°` +
    `（${isFullCircle(state.wall) ? '满圈，起止缝回绕' : '不足一圈，空白区不重复贴图'}）`;
}

function refresh() {
  state.composite = null;
  render();
}

// ---------- 事件 ----------

function bindEvents() {
  document.querySelector('#view-unwrap').addEventListener('click', () => { state.view = 'unwrap'; render(); });
  document.querySelector('#view-wall').addEventListener('click', () => { state.view = 'wall'; render(); });
  document.querySelector('#flip').addEventListener('click', () => {
    state.side = state.side === 'front' ? 'back' : 'front';
    render();
  });
  document.querySelector('#orbit').addEventListener('input', (event) => {
    state.viewOffsetDeg = Number(event.target.value);
    if (state.view !== 'wall') state.view = 'wall';
    render();
  });
  document.querySelector('#add-anchor').addEventListener('click', () => {
    state.addAnchorMode = !state.addAnchorMode;
    render();
  });
  canvas.addEventListener('click', onCanvasClick);

  document.querySelector('#apply-wall').addEventListener('click', () => {
    const params = {
      radiusMm: readNumber('#radius'),
      startAngleDeg: readNumber('#start-angle'),
      endAngleDeg: readNumber('#end-angle'),
      heightMm: readNumber('#wall-height'),
    };
    const errors = validateWall(params);
    if (errors.length > 0) {
      showMessages(errors);
      return;
    }
    const wall = makeWall(params);
    const more = [
      ...validateArtwork(wall, state.artwork),
      ...validateAnchors(wall, state.anchors),
    ];
    if (more.length > 0) {
      showMessages(more);
      return;
    }
    state.wall = wall;
    showMessages([], ['墙面参数已更新']);
    refresh();
    renderSelection();
  });

  document.querySelector('#apply-artwork').addEventListener('click', () => {
    const next = {
      ...(state.artwork ?? {}),
      offsetMm: readNumber('#art-offset'),
      widthMm: readNumber('#art-width'),
      bottomMm: readNumber('#art-bottom'),
      heightMm: readNumber('#art-height'),
    };
    const errors = validateArtwork(state.wall, next);
    if (errors.length > 0) {
      showMessages(errors);
      return;
    }
    state.artwork = next;
    showMessages([], ['画面布置已更新']);
    refresh();
  });

  document.querySelector('#png-input').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.addEventListener('load', () => {
      URL.revokeObjectURL(url);
      const keep = state.artwork ?? {};
      state.artwork = {
        image,
        imageName: file.name,
        imageWidthPx: image.naturalWidth,
        imageHeightPx: image.naturalHeight,
        offsetMm: keep.offsetMm ?? 0,
        widthMm: keep.widthMm ?? Math.round(arcLengthMm(state.wall)),
        bottomMm: keep.bottomMm ?? 0,
        heightMm: keep.heightMm ?? state.wall.heightMm,
      };
      fillArtworkForm();
      showMessages([], [`已载入 ${file.name}（${image.naturalWidth}×${image.naturalHeight}px）`]);
      refresh();
    });
    image.addEventListener('error', () => {
      URL.revokeObjectURL(url);
      showMessages([`无法读取 PNG：${file.name}`]);
    });
    image.src = url;
    event.target.value = '';
  });

  document.querySelector('#export-project').addEventListener('click', () => {
    const json = serializeProject({
      wall: state.wall,
      artwork: state.artwork,
      anchors: state.anchors,
    });
    download('wall-project.json', new Blob([json], { type: 'application/json' }));
    showMessages([], ['已导出项目 JSON（含展开坐标）']);
  });

  document.querySelector('#export-png').addEventListener('click', () => {
    state.composite.canvas.toBlob((blob) => {
      download('wall-unwrap-crop.png', blob);
      showMessages([], ['已导出裁切预览 PNG（墙面展开范围）']);
    });
  });

  document.querySelector('#project-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const result = parseProject(await file.text());
    if (!result.ok) {
      showMessages(result.errors);
      return;
    }
    const { wall, artwork, anchors } = result.project;
    state.wall = wall;
    state.anchors = anchors;
    state.selectedAnchorId = null;
    if (artwork?.imageDataUrl) {
      const image = new Image();
      image.addEventListener('load', () => {
        state.artwork = { ...artwork, image };
        fillArtworkForm();
        refresh();
      });
      image.src = artwork.imageDataUrl;
      state.artwork = artwork;
    } else {
      state.artwork = artwork;
      if (artwork) {
        showMessages([], [`项目未内嵌图像，请手动导入 PNG（${artwork.imageName ?? '画面文件'}）`]);
      }
    }
    fillWallForm();
    fillArtworkForm();
    renderAnchorList();
    renderSelection();
    showMessages([], [`已导入项目：${anchors.length} 个定位点${artwork ? '，含画面布置' : ''}`]);
    refresh();
  });
}

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- 启动 ----------

function init() {
  fillWallForm();
  fillArtworkForm();
  bindEvents();
  renderAnchorList();
  renderSelection();
  refresh();
}

init();
