// 档案整页校正工具 · 主控制器
// 状态流：pages / template(全批) / overrides(单页覆盖, 独立存储) / draft(当前页工作副本)

import {
  CORNER_LABELS,
  defaultMinDistance,
  validateQuad,
  rejectionHint,
  normalizedCornersToPixels,
  sourcePixelsToPaperNorm,
  paperNormToSourcePixels,
  mapPoint,
} from '../core/geometry.js';
import { RATIO_PRESETS, ratioValue, autoRatioFromCorners } from '../core/paper.js';
import {
  createDefaultTemplate,
  normalizeConfig,
  loadTemplate,
  saveTemplate,
  loadOverrides,
  saveOverride,
  clearOverride,
  resolveConfig,
  configSignature,
  pageKeyOf,
  loadJSON,
  saveJSON,
  ADOPTED_STORAGE_KEY,
} from '../core/templates.js';
import {
  createRegionId,
  mapRectToSourceQuad,
  checkRegionRoundTrip,
  paperDeltaToMm,
} from '../core/regions.js';
import { CancelToken, runBatch, summarizeRecords } from '../core/batch.js';
import { generateFixtureCanvas } from './fixture-generator.js';
import { getFixtureTruth, FIXTURE_KINDS } from '../core/fixtures.js';
import { SourceView } from './source-view.js';
import { PaperView } from './paper-view.js';
import { IdbResultCache } from './idb-cache.js';
import { processPageFull } from './process-page.js';
import {
  loadImageFile,
  loadImageFromBlob,
  canvasToPngBlob,
  downloadBlob,
  downloadJSON,
  baseName,
  supportsDirectoryPicker,
  pickOutputDirectory,
  writeFileToDirectory,
} from './files.js';

const PREVIEW_WIDTH = 720;

const $ = (id) => document.getElementById(id);
const clone = (v) => JSON.parse(JSON.stringify(v));
const uid = () => `p${Math.random().toString(36).slice(2, 10)}`;

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

const storage = window.localStorage;
const state = {
  pages: [],
  selectedId: null,
  template: loadTemplate(storage),
  overrides: loadOverrides(storage),
  adopted: loadJSON(storage, ADOPTED_STORAGE_KEY, {}),
  draft: null,
  dirty: false,
  selectedRegionId: null,
  showTruth: true,
  cache: new IdbResultCache(),
  dirHandle: null,
  batchRunning: false,
  batchToken: null,
  batchRecords: new Map(),
};

// ---------------------------------------------------------------------------
// 小 UI 工具
// ---------------------------------------------------------------------------

function toast(message, kind = '') {
  const stack = $('toastStack');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

function askChoices({ title, message, choices }) {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title;
    $('modalMessage').textContent = message;
    const actions = $('modalActions');
    actions.innerHTML = '';
    for (const c of choices) {
      const btn = document.createElement('button');
      btn.className = `btn ${c.kind ?? ''}`;
      btn.textContent = c.label;
      btn.addEventListener('click', () => {
        $('modalBackdrop').classList.add('hidden');
        resolve(c.value);
      });
      actions.appendChild(btn);
    }
    $('modalBackdrop').classList.remove('hidden');
  });
}

function selectedPage() {
  return state.pages.find((p) => p.id === state.selectedId) ?? null;
}

// ---------------------------------------------------------------------------
// 视图与 VM
// ---------------------------------------------------------------------------

const sourceView = new SourceView($('sourceCanvas'), {
  tryCorner: handleTryCorner,
  getVM: buildSourceVM,
  onReject: (r) => showHint(r.message, 'error'),
  onCornerCommit: handleCornerCommit,
  onHoverSource: handleHoverSource,
  onPinSource: (p) => {
    const page = selectedPage();
    if (!page || !state.draft) return;
    const H = sourcePixelsToPaperNorm(getCornersPx(page));
    paperView.setPinnedMarker(mapPoint(H, p.x, p.y));
    paperView.render();
  },
});

const paperView = new PaperView($('paperCanvas'), {
  getVM: buildPaperVM,
  onRegionDrawn: handleRegionDrawn,
  onMoveRegion: handleMoveRegion,
  onRegionCommit: handleRegionCommit,
  onSelectRegion: (id) => {
    state.selectedRegionId = id;
    renderRegionList();
    paperView.update(buildPaperVM());
  },
  onHoverPaper: handleHoverPaper,
  onPinPaper: (p) => {
    const page = selectedPage();
    if (!page) return;
    const Hinv = paperNormToSourcePixels(getCornersPx(page));
    sourceView.setPinnedMarker(mapPoint(Hinv, p.x, p.y));
    sourceView.render();
  },
  onToolCommitted: (tool) => syncToolButtons(tool),
});

function getCornersPx(page, cfg = state.draft) {
  return normalizedCornersToPixels(cfg.cornersNormalized, page.width, page.height);
}

function buildCheckpointOverlays(page) {
  if (!page.truth || !state.draft) return [];
  const cornersPx = getCornersPx(page);
  const Hs2p = sourcePixelsToPaperNorm(cornersPx);
  const Hp2s = paperNormToSourcePixels(cornersPx);
  return page.truth.checkpoints.map((cp, index) => ({
    cp,
    index,
    userPaper: mapPoint(Hs2p, cp.source.x, cp.source.y),
    userSource: mapPoint(Hp2s, cp.paper.x, cp.paper.y),
  }));
}

function buildSourceVM() {
  const page = selectedPage();
  if (!page || !state.draft) return null;
  const cornersPx = getCornersPx(page);
  const minDistance = defaultMinDistance(page.width, page.height);
  const issues = validateQuad(cornersPx, { minDistance });
  const Hp2s = paperNormToSourcePixels(cornersPx);
  return {
    cornersPx,
    issues,
    invalid: issues.length > 0,
    badCorners: [...new Set(issues.flatMap((i) => i.corners))],
    regionQuads: state.draft.regions.map((r) => ({
      region: r,
      quad: mapRectToSourceQuad(r, Hp2s),
    })),
    truth: page.truth,
    showTruth: state.showTruth,
    userCheckpoints: state.showTruth ? buildCheckpointOverlays(page) : [],
  };
}

function buildPaperVM() {
  return {
    regions: state.draft?.regions ?? [],
    selectedRegionId: state.selectedRegionId,
    showTruth: state.showTruth,
    checkpointOverlays: selectedPage()?.truth && state.showTruth ? buildCheckpointOverlays(selectedPage()) : [],
  };
}

function refreshAllViews() {
  sourceView.update(buildSourceVM());
  paperView.update(buildPaperVM());
}

// ---------------------------------------------------------------------------
// 提示条 / 联动坐标
// ---------------------------------------------------------------------------

const DEFAULT_HINT = '拖动白色控制柄框住档案四角（顺序：左上 → 右上 → 右下 → 左下）';
function showHint(message, kind = 'info') {
  const bar = $('sourceHint');
  bar.textContent = message;
  bar.className = `hint-bar ${kind}`;
}

let sourceHoverQueued = false;
function handleHoverSource(pointNatural) {
  const page = selectedPage();
  if (!pointNatural) {
    paperView.setLinkedMarker(null);
    paperView.render();
    $('sourceReadout').textContent = '源图坐标：—';
    return;
  }
  if (!page || !state.draft) return;
  if (sourceHoverQueued) return;
  sourceHoverQueued = true;
  requestAnimationFrame(() => {
    sourceHoverQueued = false;
    const H = sourcePixelsToPaperNorm(getCornersPx(page));
    const p = mapPoint(H, pointNatural.x, pointNatural.y);
    paperView.setLinkedMarker(p);
    paperView.render();
    const mmX = (p.x * state.draft.ratio.w).toFixed(1);
    const mmY = (p.y * state.draft.ratio.h).toFixed(1);
    $('sourceReadout').textContent =
      `源图 px (${pointNatural.x.toFixed(0)}, ${pointNatural.y.toFixed(0)}) → 纸面 (${p.x.toFixed(4)}, ${p.y.toFixed(4)}) ≈ (${mmX}, ${mmY}) ${state.draft.ratio.id === 'a4' ? 'mm' : '比例单位'}`;
  });
}

let paperHoverQueued = false;
function handleHoverPaper(paperPoint) {
  const page = selectedPage();
  if (!paperPoint) {
    sourceView.setLinkedMarker(null);
    sourceView.render();
    $('paperReadout').textContent = '纸面坐标：—';
    return;
  }
  if (!page || !state.draft) return;
  if (paperHoverQueued) return;
  paperHoverQueued = true;
  requestAnimationFrame(() => {
    paperHoverQueued = false;
    const Hinv = paperNormToSourcePixels(getCornersPx(page));
    const s = mapPoint(Hinv, paperPoint.x, paperPoint.y);
    sourceView.setLinkedMarker(s);
    sourceView.render();
    $('paperReadout').textContent =
      `纸面 (${paperPoint.x.toFixed(4)}, ${paperPoint.y.toFixed(4)}) → 源图 px (${s.x.toFixed(0)}, ${s.y.toFixed(0)})`;
  });
}

// ---------------------------------------------------------------------------
// 四角拖动（拒绝交叉 / 近重合）
// ---------------------------------------------------------------------------

function handleTryCorner(index, rawPoint) {
  const page = selectedPage();
  if (!page || !state.draft) return { accepted: false };

  // 先把点限制在画面外扩 20% 的范围内，再做合法性校验
  const mx = 0.2;
  const my = 0.2;
  const point = {
    x: Math.min(page.width * (1 + mx), Math.max(-page.width * mx, rawPoint.x)),
    y: Math.min(page.height * (1 + my), Math.max(-page.height * my, rawPoint.y)),
  };

  const minDistance = defaultMinDistance(page.width, page.height);
  const cornersPx = getCornersPx(page);
  const candidate = cornersPx.map((c, i) => (i === index ? point : c));
  const issues = validateQuad(candidate, { minDistance });
  if (issues.length) {
    const hint = rejectionHint(issues, index);
    return { accepted: false, message: hint.message, badCorners: hint.badCorners };
  }

  state.draft.cornersNormalized[index] = { x: point.x / page.width, y: point.y / page.height };
  afterDraftChanged();
  showHint(`「${CORNER_LABELS[index]}」已移动，四角关系有效。`, 'ok');
  schedulePreview();
  schedulePrecision();
  updateDirtyUI();
  return { accepted: true };
}

function handleCornerCommit() {
  if (pageHasOverride()) persistOverride();
  renderPageList();
  renderFixturePrecision();
  showHint(DEFAULT_HINT, 'info');
}

// ---------------------------------------------------------------------------
// 预览（降采样 + 防抖透视）
// ---------------------------------------------------------------------------

const previewCache = new WeakMap();
function getPreviewSource(page) {
  if (previewCache.has(page)) return previewCache.get(page);
  const maxDim = 1000;
  const k = Math.min(1, maxDim / Math.max(page.width, page.height));
  const width = Math.max(1, Math.round(page.width * k));
  const height = Math.max(1, Math.round(page.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(page.image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const preview = { imageData, width, height };
  previewCache.set(page, preview);
  return preview;
}

let previewTimer = 0;
let previewSeq = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 90);
}

async function runPreview() {
  const page = selectedPage();
  if (!page || !state.draft) return;
  const seq = ++previewSeq;
  try {
    const pv = getPreviewSource(page);
    const previewConfig = { ...clone(state.draft), outputWidth: PREVIEW_WIDTH };
    const { composePage } = await import('../core/compose.js');
    const composed = await composePage(pv.imageData, previewConfig, { yieldRows: 64 });
    if (seq !== previewSeq || state.selectedId !== page.id) return;
    const frame = document.createElement('canvas');
    frame.width = composed.width;
    frame.height = composed.height;
    frame.getContext('2d').putImageData(
      new ImageData(composed.image.data, composed.width, composed.height),
      0, 0,
    );
    paperView.setFrameCanvas(frame);
    paperView.update(buildPaperVM());
    $('paperSize').textContent =
      `预览 ${composed.width}×${composed.height} · 导出宽 ${state.draft.outputWidth}px`;
  } catch (err) {
    if (err?.code !== 'CANCELLED') console.error('预览失败', err);
  }
}

// ---------------------------------------------------------------------------
// 模板 / 覆盖 / dirty
// ---------------------------------------------------------------------------

function pageHasOverride(page = selectedPage()) {
  return !!page && Object.prototype.hasOwnProperty.call(state.overrides, page.key);
}

function afterDraftChanged() {
  state.draft = normalizeConfig(state.draft);
  const isOverride = pageHasOverride();
  if (isOverride) persistOverride(false);
  // 覆盖页自动保存，不显示 dirty；模板跟随页与已保存模板比较
  state.dirty = !isOverride && configSignature(state.draft) !== configSignature(state.template);
  updateDirtyUI();
}

function persistOverride(showToastFlag = true) {
  const page = selectedPage();
  if (!page || !state.draft) return;
  state.overrides = saveOverride(storage, state.overrides, page.key, state.draft);
  state.dirty = false;
  updateDirtyUI();
  renderPageList();
  if (showToastFlag) toast('本页覆盖已独立保存', 'ok');
}

function commitTemplate() {
  state.template = normalizeConfig(state.draft);
  saveTemplate(storage, state.template);
  state.dirty = false;
  updateDirtyUI();
  renderPageList();
  toast('全批模板已保存；所有未覆盖页面使用此设定', 'ok');
}

function commitOverrideAsNew() {
  persistOverride();
  updateModeBadge();
  $('clearOverrideBtn').classList.remove('hidden');
}

function updateDirtyUI() {
  $('dirtyBadge').classList.toggle('hidden', !state.dirty);
  updateModeBadge();
}

function updateModeBadge() {
  const badge = $('modeBadge');
  const page = selectedPage();
  if (!page) {
    badge.textContent = '未选择页面';
    badge.className = 'badge template';
    $('clearOverrideBtn').classList.add('hidden');
    return;
  }
  if (pageHasOverride(page)) {
    badge.textContent = '本页独立覆盖（自动保存）';
    badge.className = 'badge override';
    $('clearOverrideBtn').classList.remove('hidden');
  } else {
    badge.textContent = '跟随全批模板';
    badge.className = 'badge template';
    $('clearOverrideBtn').classList.add('hidden');
  }
}

function syncFormFromDraft() {
  const cfg = state.draft ?? createDefaultTemplate();
  // 比例下拉
  const select = $('ratioSelect');
  const known = RATIO_PRESETS.find((p) => p.id === cfg.ratio.id);
  select.value = known ? known.id : 'custom';
  $('ratioCustomFields').classList.toggle('hidden', select.value !== 'custom');
  $('ratioWInput').value = cfg.ratio.w;
  $('ratioHInput').value = cfg.ratio.h;
  $('outputWidthInput').value = cfg.outputWidth;
  // <input type=color> 只接受 #rrggbb，把 #rgb 展开
  const hex = /^#([0-9a-fA-F]{3})$/.exec(cfg.maskColor);
  $('maskColorInput').value = hex
    ? '#' + hex[1].split('').map((c) => c + c).join('')
    : cfg.maskColor;
}

// ---------------------------------------------------------------------------
// 页面载入与列表
// ---------------------------------------------------------------------------

function addPage(page) {
  state.pages.push(page);
}

async function handleFiles(fileList) {
  const files = [...fileList].filter(
    (f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i.test(f.name),
  );
  if (!files.length) {
    toast('没有可读取的图片文件', 'error');
    return;
  }
  let firstNewId = null;
  for (const file of files) {
    const key = pageKeyOf({ name: file.name, size: file.size, lastModified: file.lastModified });
    const existing = state.pages.find((p) => p.key === key);
    if (existing) {
      toast(`跳过重复页面：${file.name}`);
      if (!firstNewId) firstNewId = existing.id;
      continue;
    }
    try {
      const loaded = await loadImageFile(file);
      const page = {
        id: uid(), key, name: file.name, file,
        image: loaded.img, url: loaded.url, width: loaded.width, height: loaded.height,
        status: 'idle', progress: 0, result: null, adopted: !!state.adopted[key],
      };
      addPage(page);
      firstNewId ??= page.id;
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  renderPageList();
  if (firstNewId && !selectedPage()) selectPage(firstNewId);
  else if (firstNewId) selectPage(firstNewId);
  void refreshCachedResults();
}

async function addFixture(kind) {
  if (!FIXTURE_KINDS.includes(kind)) return;
  const existing = state.pages.find((p) => p.key === `fixture:${kind}`);
  if (existing) {
    selectPage(existing.id);
    toast('该示例已在批次中，已为你定位');
    return;
  }
  toast(`正在生成${getFixtureTruth(kind).name}…`);
  const canvas = await generateFixtureCanvas(kind);
  const blob = await canvasToPngBlob(canvas);
  const loaded = await loadImageFromBlob(blob);
  const truth = getFixtureTruth(kind);
  const page = {
    id: uid(),
    key: `fixture:${kind}`,
    name: `[示例]${truth.name}.png`,
    image: loaded.img,
    url: loaded.url,
    width: loaded.width,
    height: loaded.height,
    status: 'idle',
    progress: 0,
    result: null,
    truth,
    isFixture: true,
    adopted: false,
  };
  addPage(page);
  renderPageList();
  selectPage(page.id);
}

function removePage(id) {
  const idx = state.pages.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const [page] = state.pages.splice(idx, 1);
  if (page.url) URL.revokeObjectURL(page.url);
  if (state.selectedId === id) {
    state.selectedId = null;
    const next = state.pages[Math.min(idx, state.pages.length - 1)];
    if (next) selectPage(next.id);
    else {
      state.draft = null;
      sourceView.setPage(null);
      sourceView.update(null);
      paperView.setFrameCanvas(null);
      paperView.update(null);
      renderRegionList();
      updateModeBadge();
      $('fixtureCard').classList.add('hidden');
      $('pageList').innerHTML = '<li class="empty-tip">还没有图片。<br>点「添加图片」或「生成核对示例」开始。</li>';
    }
  }
  renderPageList();
}

function clearPages() {
  if (state.batchRunning) {
    toast('批处理进行中，请先取消', 'error');
    return;
  }
  for (const p of state.pages) if (p.url) URL.revokeObjectURL(p.url);
  state.pages = [];
  state.selectedId = null;
  state.draft = null;
  renderPageList();
  sourceView.setPage(null);
  sourceView.update(null);
  paperView.setFrameCanvas(null);
  paperView.update(null);
  renderRegionList();
  updateModeBadge();
  $('fixtureCard').classList.add('hidden');
  $('currentResult').textContent = '尚未导出。';
  $('downloadPngBtn').disabled = true;
  $('downloadJsonBtn').disabled = true;
  $('adoptBtn').disabled = true;
}

function selectPage(id) {
  state.selectedId = id;
  state.selectedRegionId = null;
  const page = selectedPage();
  if (!page) return;
  const { config } = resolveConfig(state.template, state.overrides, page.key);
  state.draft = clone(config);
  state.dirty = configSignature(state.draft) !== configSignature(state.template) && !pageHasOverride(page);
  // 覆盖页 dirty 恒为 false（自动保存）
  if (pageHasOverride(page)) state.dirty = false;

  sourceView.setPage(page);
  sourceView.update(buildSourceVM());
  paperView.ui.pinnedMarker = null;
  paperView.ui.linkedMarker = null;
  paperView.setFrameCanvas(null);
  paperView.update(buildPaperVM());
  schedulePreview();

  $('sourceSize').textContent = `${page.width} × ${page.height} px`;
  $('sourceReadout').textContent = '源图坐标：—';
  $('paperReadout').textContent = '纸面坐标：—';
  showHint(DEFAULT_HINT, 'info');

  syncFormFromDraft();
  renderRegionList();
  updateModeBadge();
  updateDirtyUI();
  renderPageList();
  renderFixtureCard();
  renderCurrentResult();
}

function renderPageList() {
  const ul = $('pageList');
  $('pageCount').textContent = state.pages.length;
  if (!state.pages.length) {
    ul.innerHTML = '<li class="empty-tip">还没有图片。<br>点「添加图片」或「生成核对示例」开始。</li>';
    return;
  }
  ul.innerHTML = '';
  for (const page of state.pages) {
    const li = document.createElement('li');
    li.className = `page-item ${page.id === state.selectedId ? 'selected' : ''}`;
    li.addEventListener('click', () => selectPage(page.id));

    const thumb = document.createElement('img');
    thumb.className = 'thumb';
    thumb.src = page.url;
    thumb.alt = '';
    li.appendChild(thumb);

    const main = document.createElement('div');
    main.className = 'pi-main';
    const name = document.createElement('div');
    name.className = 'pi-name';
    name.textContent = page.name;
    name.title = page.name;
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'pi-meta';
    meta.textContent = `${page.width}×${page.height}`;
    main.appendChild(meta);

    const badges = document.createElement('div');
    badges.className = 'pi-badges';
    const addTag = (text, cls) => {
      const t = document.createElement('span');
      t.className = `tag ${cls}`;
      t.textContent = text;
      badges.appendChild(t);
    };
    if (page.isFixture) addTag('示例', 'fixture');
    addTag(pageHasOverride(page) ? '本页覆盖' : '模板', pageHasOverride(page) ? 'override' : '');
    if (page.status === 'processing') addTag(`处理中 ${Math.round((page.progress ?? 0) * 100)}%`, 'processing');
    if (page.status === 'success') addTag('成功', 'success');
    if (page.status === 'cached') addTag('缓存可采用', 'cached');
    if (page.status === 'error') addTag('失败', 'error');
    if (page.status === 'cancelled') addTag('已取消', 'cancelled');
    if (state.adopted[page.key]) addTag('✓ 已采用', 'adopted');
    main.appendChild(badges);
    li.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'pi-actions';
    if (page.result) {
      const adopt = document.createElement('button');
      adopt.className = 'icon-btn';
      adopt.title = state.adopted[page.key] ? '取消采用标记' : '采用此结果';
      adopt.textContent = state.adopted[page.key] ? '★' : '✓';
      adopt.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleAdopt(page);
      });
      actions.appendChild(adopt);
    }
    const remove = document.createElement('button');
    remove.className = 'icon-btn';
    remove.title = '移除该页';
    remove.textContent = '✕';
    remove.addEventListener('click', (e) => {
      e.stopPropagation();
      removePage(page.id);
    });
    actions.appendChild(remove);
    li.appendChild(actions);

    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// 区域
// ---------------------------------------------------------------------------

function handleRegionDrawn(rect) {
  if (!state.draft) return;
  const region = {
    id: createRegionId(),
    type: rect.type === 'keep' ? 'keep' : 'mask',
    shape: 'rect',
    x: rect.x, y: rect.y, w: rect.w, h: rect.h,
    label: '',
    enabled: true,
  };
  state.draft.regions.push(region);
  state.selectedRegionId = region.id;
  afterDraftChanged();
  renderRegionList();
  refreshAllViews();
  schedulePreview();
  toast(`已添加${region.type === 'mask' ? '遮挡' : '保留'}区（纸面 ${rect.w.toFixed(3)}×${rect.h.toFixed(3)}）`);
}

function handleMoveRegion(id, x, y) {
  const r = state.draft?.regions.find((z) => z.id === id);
  if (!r) return;
  r.x = x;
  r.y = y;
}

function handleRegionCommit(moved) {
  // 纯点击选中没有改动坐标，不必重算/持久化
  if (!moved) return;
  afterDraftChanged();
  renderRegionList();
  schedulePreview();
}

function deleteRegion(id) {
  if (!state.draft) return;
  state.draft.regions = state.draft.regions.filter((r) => r.id !== id);
  if (state.selectedRegionId === id) state.selectedRegionId = null;
  afterDraftChanged();
  renderRegionList();
  refreshAllViews();
  schedulePreview();
}

function renderRegionList() {
  const ul = $('regionList');
  ul.innerHTML = '';
  const regions = state.draft?.regions ?? [];
  if (!regions.length) {
    const li = document.createElement('li');
    li.className = 'tip';
    li.textContent = '暂无区域。用上方「保留区 / 遮挡区」工具在纸面图上拖框。';
    ul.appendChild(li);
    return;
  }
  regions.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = `region-row ${r.id === state.selectedRegionId ? 'selected' : ''}`;
    li.addEventListener('click', () => {
      state.selectedRegionId = r.id;
      renderRegionList();
      paperView.update(buildPaperVM());
    });
    const dot = document.createElement('span');
    dot.className = `dot ${r.type}`;
    li.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = `${r.type === 'mask' ? '遮挡' : '保留'}${i + 1}`;
    li.appendChild(name);
    const coords = document.createElement('span');
    coords.className = 'r-coords';
    coords.textContent = `${r.x.toFixed(3)},${r.y.toFixed(3)} ${r.w.toFixed(3)}×${r.h.toFixed(3)}`;
    coords.title = '纸面归一化 x,y,w,h';
    li.appendChild(coords);
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.title = '删除区域';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteRegion(r.id);
    });
    li.appendChild(del);
    ul.appendChild(li);
  });
}

function verifyRegions() {
  const page = selectedPage();
  const box = $('regionVerifyResult');
  if (!page || !state.draft?.regions.length) {
    box.innerHTML = '<span class="tip">当前页没有区域可校验。</span>';
    return;
  }
  const cornersPx = getCornersPx(page);
  const Hs2p = sourcePixelsToPaperNorm(cornersPx);
  const Hp2s = paperNormToSourcePixels(cornersPx);
  let worst = 0;
  let worstId = '';
  for (const r of state.draft.regions) {
    const check = checkRegionRoundTrip(r, Hs2p, Hp2s);
    if (check.maxPaperError > worst) {
      worst = check.maxPaperError;
      worstId = r.id;
    }
  }
  const outPx = state.draft.outputWidth;
  const approxPx = worst * outPx;
  const ok = worst < 1e-6;
  box.innerHTML = `<div class="${ok ? 'ok-box' : 'bad-box'}">
    区域 ${state.draft.regions.length} 个；四角↔纸面往返最大误差
    <b>${worst.toExponential(2)}</b>（纸面归一化）≈ 导出宽上 ${approxPx.toExponential(2)} px。
    ${ok ? '✓ 遮挡/保留区仍位于预期纸面坐标。' : `误差偏大的区域：${worstId}`}
    <br><span style="opacity:.85">重新拖动四角后，左图投影会即时更新；区域本身的纸面坐标保持不变。</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// 示例核对与精度表
// ---------------------------------------------------------------------------

let precisionTimer = 0;
function schedulePrecision() {
  clearTimeout(precisionTimer);
  precisionTimer = setTimeout(renderFixturePrecision, 120);
}

function renderFixtureCard() {
  const page = selectedPage();
  const card = $('fixtureCard');
  if (!page?.truth) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  $('fixtureDesc').textContent = page.truth.description;
  $('applyTruthBtn').classList.remove('hidden');
  renderFixturePrecision();
}

function renderFixturePrecision() {
  const page = selectedPage();
  if (!page?.truth || !state.draft) return;
  const overlays = buildCheckpointOverlays(page);
  const tbody = $('checkpointTableBody');
  tbody.innerHTML = '';
  let maxMm = 0;
  let maxSourcePx = 0;
  overlays.forEach((o) => {
    const dx = o.userPaper.x - o.cp.paper.x;
    const dy = o.userPaper.y - o.cp.paper.y;
    const errMm = paperDeltaToMm(dx, dy, state.draft.ratio);
    const errPx = Math.hypot(
      o.userSource.x - o.cp.source.x,
      o.userSource.y - o.cp.source.y,
    );
    maxMm = Math.max(maxMm, errMm);
    maxSourcePx = Math.max(maxSourcePx, errPx);

    const tr = document.createElement('tr');
    const cls = errMm < 2 ? 'style="color:var(--ok);font-weight:700"' : errMm < 8 ? 'style="color:var(--warn);font-weight:700"' : 'style="color:var(--danger);font-weight:700"';
    tr.innerHTML = `
      <td>P${o.index + 1}</td>
      <td>${o.cp.label}</td>
      <td class="num">${o.cp.paper.x.toFixed(3)}, ${o.cp.paper.y.toFixed(3)}</td>
      <td class="num">${o.cp.paperMm.x.toFixed(0)}, ${o.cp.paperMm.y.toFixed(0)}</td>
      <td class="num" ${cls}>${errMm.toFixed(2)} mm / ${errPx.toFixed(1)}px</td>`;
    tbody.appendChild(tr);
  });

  const level = maxMm < 2 ? 'good' : maxMm < 8 ? 'mid' : 'bad';
  const summary = $('precisionSummary');
  summary.className = `precision ${level}`;
  summary.innerHTML = `最大核对偏差 <span class="big">${maxMm.toFixed(2)} mm</span>
    （源图 ${maxSourcePx.toFixed(1)} px）<br>
    <span class="meta">蓝点=自生成真值，橙叉=当前四角反算；点「应用示例真值四角」应接近 0 误差。</span>`;
}

function applyTruthCorners() {
  const page = selectedPage();
  if (!page?.truth) return;
  state.draft.cornersNormalized = clone(page.truth.cornersNormalized);
  afterDraftChanged();
  refreshAllViews();
  schedulePreview();
  renderFixturePrecision();
  toast('已填入示例真值四角，核对偏差应接近 0', 'ok');
}

// ---------------------------------------------------------------------------
// 采用 / 结果
// ---------------------------------------------------------------------------

function resultCacheKey(page, cfg) {
  return `${page.key}::${configSignature(cfg)}`;
}

function toggleAdopt(page) {
  if (state.adopted[page.key]) {
    delete state.adopted[page.key];
    toast(`已取消采用：${page.name}`);
  } else {
    const sig = page.result?.sig ?? configSignature(resolveConfig(state.template, state.overrides, page.key).config);
    state.adopted[page.key] = { signature: sig, at: new Date().toISOString() };
    toast(`已采用：${page.name}`, 'ok');
  }
  saveJSON(storage, ADOPTED_STORAGE_KEY, state.adopted);
  renderPageList();
  renderCurrentResult();
}

function renderCurrentResult() {
  const page = selectedPage();
  const pngBtn = $('downloadPngBtn');
  const jsonBtn = $('downloadJsonBtn');
  const adoptBtn = $('adoptBtn');
  if (!page?.result) {
    pngBtn.disabled = true;
    jsonBtn.disabled = true;
    adoptBtn.disabled = true;
    $('currentResult').textContent = page
      ? (page.status === 'processing' ? '正在处理…' : '尚未导出。')
      : '尚未导出。';
    return;
  }
  pngBtn.disabled = false;
  jsonBtn.disabled = false;
  adoptBtn.disabled = false;
  const r = page.result;
  const adopted = !!state.adopted[page.key];
  $('currentResult').innerHTML =
    `<span class="ok-text">✓ 已生成 ${r.width}×${r.height} PNG（${(r.blob.size / 1024).toFixed(0)} KB）与坐标转换信息。</span><br>` +
    (adopted ? '★ 本页已标记采用。' : '可下载，或点「采用此结果」留档。');
}

async function refreshCachedResults() {
  // 重新载入同批文件后，若设定签名一致，从 IndexedDB 找回成功结果
  for (const page of state.pages) {
    if (page.result) continue;
    const { config } = resolveConfig(state.template, state.overrides, page.key);
    const cacheKey = resultCacheKey(page, config);
    const cached = await state.cache.get(cacheKey);
    if (cached?.blob) {
      page.result = cached;
      page.status = 'cached';
      renderPageList();
      if (state.selectedId === page.id) renderCurrentResult();
    }
  }
}

// ---------------------------------------------------------------------------
// 单页导出
// ---------------------------------------------------------------------------

async function exportCurrentPage() {
  const page = selectedPage();
  if (!page || !state.draft) {
    toast('请先选择一张图片', 'error');
    return;
  }
  const btn = $('exportCurrentBtn');
  btn.disabled = true;
  $('currentResult').textContent = '正在按原图分辨率校正与编码…';
  try {
    const cfg = clone(state.draft);
    const result = await processPageFull(
      page,
      cfg,
      { configSource: state.dirty ? 'unsaved-draft' : (pageHasOverride(page) ? 'override' : 'template') },
    );
    result.sig = configSignature(cfg);
    result.cacheKey = resultCacheKey(page, cfg);
    await state.cache.set(result.cacheKey, result);
    page.result = result;
    page.status = 'success';
    renderCurrentResult();
    renderPageList();
    const base = baseName(page.name);
    downloadBlob(result.blob, `${base}.png`);
    downloadJSON(result.info, `${base}.transform.json`);
    toast('本页 PNG 与转换信息已导出', 'ok');
  } catch (err) {
    console.error(err);
    $('currentResult').textContent = `导出失败：${err.message}`;
    toast(`导出失败：${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 批量处理
// ---------------------------------------------------------------------------

async function processOneForBatch(page, token, index, total) {
  page.status = 'processing';
  page.progress = 0;
  renderPageList();
  const { config, source } = resolveConfig(state.template, state.overrides, page.key);
  const sig = configSignature(config);
  const cacheKey = resultCacheKey(page, config);

  const result = await processPageFull(
    page,
    config,
    { configSource: source, adopted: !!state.adopted[page.key] },
    {
      signal: token,
      onProgress: (f) => {
        page.progress = f;
        const overall = ((index + f) / total) * 100;
        $('progressFill').style.width = `${overall.toFixed(1)}%`;
        $('progressLabel').textContent = `正在处理 ${index + 1}/${total}：${page.name}（${Math.round(f * 100)}%）`;
      },
    },
  );
  result.sig = sig;
  result.cacheKey = cacheKey;
  await state.cache.set(cacheKey, result);
  page.result = result;
  page.status = 'success';
  page.progress = 1;
  return result;
}

async function chooseBatchOutputMode() {
  if (!supportsDirectoryPicker()) return 'downloads';
  const folderChoice = state.dirHandle
    ? { label: `写入已选文件夹「${state.dirHandle.name}」`, value: 'folder', kind: 'primary' }
    : { label: '选择文件夹写入（推荐）', value: 'folder-pick', kind: 'primary' };
  const value = await askChoices({
    title: '批量导出方式',
    message: '支持 File System Access 的浏览器可直接把每页 PNG + JSON 写入一个文件夹；也可以改用浏览器下载（可能需要允许“下载多个文件”）。',
    choices: [
      folderChoice,
      { label: '用浏览器下载', value: 'downloads' },
      { label: '暂不写出，只保留结果', value: 'memory' },
      { label: '取消', value: 'cancel', kind: 'ghost' },
    ],
  });
  if (value === 'folder') return 'folder';
  if (value === 'folder-pick') {
    try {
      state.dirHandle = await pickOutputDirectory();
      $('dirName').textContent = `输出文件夹：${state.dirHandle.name}`;
      return 'folder';
    } catch {
      toast('已取消选择文件夹');
      return 'cancel';
    }
  }
  return value;
}

async function startBatch() {
  if (state.batchRunning) return;
  if (!state.pages.length) {
    toast('批次为空，请先添加图片或示例', 'error');
    return;
  }
  if (selectedPage() && state.dirty) {
    const choice = await askChoices({
      title: '当前页有未保存的调整',
      message: '批量导出使用已保存的全批模板或单页覆盖。先保存当前调整，还是取消？',
      choices: [
        { label: '存入全批模板', value: 'template', kind: 'primary' },
        { label: '存为本页覆盖', value: 'override' },
        { label: '取消', value: 'cancel', kind: 'ghost' },
      ],
    });
    if (choice === 'cancel' || choice === undefined) return;
    if (choice === 'template') commitTemplate();
    if (choice === 'override') commitOverrideAsNew();
  }

  const outputMode = await chooseBatchOutputMode();
  if (outputMode === 'cancel') return;

  state.batchRunning = true;
  state.batchToken = new CancelToken();
  state.batchRecords = new Map();
  $('batchExportBtn').disabled = true;
  $('cancelBatchBtn').disabled = false;
  $('progressSection').classList.remove('hidden');
  $('progressFill').style.width = '0%';
  $('batchSummary').textContent = '';

  const pages = [...state.pages];
  const total = pages.length;

  const records = await runBatch(
    pages,
    {
      getCached: async (page) => {
        const { config } = resolveConfig(state.template, state.overrides, page.key);
        const cacheKey = resultCacheKey(page, config);
        const cached = await state.cache.get(cacheKey);
        return cached?.blob ? { cacheKey, result: cached } : null;
      },
      processPage: (page, token) => {
        const index = pages.indexOf(page);
        return processOneForBatch(page, token, index, total);
      },
      onUpdate: (record) => handleBatchRecord(record, outputMode),
    },
    state.batchToken,
  );

  state.batchRunning = false;
  $('batchExportBtn').disabled = false;
  $('cancelBatchBtn').disabled = true;
  const summary = summarizeRecords(records);
  $('progressFill').style.width = '100%';
  $('progressLabel').textContent = state.batchToken.cancelled
    ? `已停止：${summary.adoptable} 页成功/缓存可采用，${summary.cancelled} 页取消`
    : `全部完成：${summary.success} 新成功，${summary.cached} 缓存，${summary.error} 失败`;
  renderBatchSummary(records);
  renderPageList();

  if (outputMode === 'downloads') await downloadAllSuccessful(records);
  if (outputMode === 'memory') toast('结果已保留在各页，可逐页下载或采用');
}

async function handleBatchRecord(record, outputMode) {
  state.batchRecords.set(record.pageId, record);
  const page = state.pages.find((p) => p.id === record.pageId);
  if (page) {
    if (record.status === 'success') {
      page.status = 'success';
      page.result = record.result;
    } else if (record.status === 'cached') {
      page.status = 'cached';
      page.result = record.result;
    } else if (record.status === 'error') {
      page.status = 'error';
      page.error = record.error;
    } else if (record.status === 'cancelled') {
      page.status = 'cancelled';
    }
  }
  renderPageList();
  renderBatchSummary([...state.batchRecords.values()]);
  if (record.pageId === state.selectedId) renderCurrentResult();

  if ((record.status === 'success' || record.status === 'cached') && record.result && outputMode === 'folder' && state.dirHandle) {
    try {
      const base = baseName(page?.name ?? record.pageId);
      await writeFileToDirectory(state.dirHandle, `${base}.png`, record.result.blob);
      await writeFileToDirectory(
        state.dirHandle,
        `${base}.transform.json`,
        new Blob([JSON.stringify(record.result.info, null, 2)], { type: 'application/json' }),
      );
    } catch (err) {
      toast(`写入文件夹失败：${err.message}`, 'error');
    }
  }
}

function renderBatchSummary(records) {
  const s = summarizeRecords(records);
  $('batchSummary').innerHTML =
    `<span>新成功 <b style="color:var(--ok)">${s.success}</b></span>` +
    `<span>缓存采用 <b style="color:var(--ok)">${s.cached}</b></span>` +
    `<span>失败 <b style="color:var(--danger)">${s.error}</b></span>` +
    `<span>已取消 <b>${s.cancelled}</b></span>` +
    `<span>可直接采用/导出 <b>${s.adoptable}</b> 页</span>`;
}

async function downloadAllSuccessful(recordsArg) {
  const records = recordsArg
    ?? state.pages
      .filter((p) => p.result)
      .map((p) => ({ pageId: p.id, status: 'success', result: p.result }));
  let n = 0;
  for (const r of records) {
    if (r.status !== 'success' && r.status !== 'cached') continue;
    const page = state.pages.find((p) => p.id === r.pageId);
    if (!page || !r.result) continue;
    const base = baseName(page.name);
    downloadBlob(r.result.blob, `${base}.png`);
    downloadJSON(r.result.info, `${base}.transform.json`);
    n += 1;
    await new Promise((res) => setTimeout(res, 350));
  }
  if (n) toast(`已触发 ${n} 页的 PNG + JSON 下载；若浏览器询问，请允许下载多个文件`, 'ok');
}

// ---------------------------------------------------------------------------
// 模板 / 覆盖 JSON 导入导出
// ---------------------------------------------------------------------------

function exportTemplateFile() {
  downloadJSON(state.template, 'page-corrector-template.json');
}

function importJSONFile(input, handler) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      handler(JSON.parse(String(reader.result)));
    } catch (err) {
      toast(`JSON 解析失败：${err.message}`, 'error');
    } finally {
      input.value = '';
    }
  };
  reader.readAsText(file);
}

function importTemplate(raw) {
  state.template = normalizeConfig(raw);
  saveTemplate(storage, state.template);
  if (selectedPage() && !pageHasOverride()) {
    state.draft = clone(state.template);
    state.dirty = false;
    selectPage(state.selectedId);
  }
  toast('全批模板已导入并保存', 'ok');
}

function exportOverridesFile() {
  downloadJSON(state.overrides, 'page-corrector-overrides.json');
}

function importOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    toast('覆盖文件格式应为 { pageKey: config }', 'error');
    return;
  }
  let count = 0;
  for (const [key, cfg] of Object.entries(raw)) {
    state.overrides[key] = normalizeConfig(cfg);
    count += 1;
  }
  saveJSON(storage, 'page-corrector:overrides:v1', state.overrides);
  if (selectedPage()) selectPage(state.selectedId);
  renderPageList();
  toast(`已导入并合并 ${count} 条单页覆盖`, 'ok');
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function syncToolButtons(tool) {
  document.querySelectorAll('[data-tool]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === tool);
  });
  paperView.setTool(tool);
}

function bindEvents() {
  $('addFilesBtn').addEventListener('click', () => $('fileInput').click());
  $('addFilesBtn2').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    handleFiles(e.target.files);
    e.target.value = ''; // 允许再次选择同一个文件
  });

  $('clearPagesBtn').addEventListener('click', clearPages);

  // 示例菜单
  const menuBtn = $('fixtureMenuBtn');
  const menu = $('fixtureMenu');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.parentElement.classList.toggle('open');
  });
  document.addEventListener('click', () => menu.parentElement.classList.remove('open'));
  menu.querySelectorAll('[data-fixture]').forEach((b) =>
    b.addEventListener('click', () => addFixture(b.dataset.fixture)));
  $('addAllFixturesBtn').addEventListener('click', async () => {
    for (const kind of FIXTURE_KINDS) await addFixture(kind);
  });

  $('truthToggle').addEventListener('change', (e) => {
    state.showTruth = e.target.checked;
    refreshAllViews();
  });

  document.querySelectorAll('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => syncToolButtons(b.dataset.tool)));

  // 模板/覆盖
  $('saveTemplateBtn').addEventListener('click', () => {
    if (!state.draft) return toast('请先选择页面', 'error');
    commitTemplate();
  });
  $('saveOverrideBtn').addEventListener('click', () => {
    if (!state.draft) return toast('请先选择页面', 'error');
    commitOverrideAsNew();
  });
  $('resetDraftBtn').addEventListener('click', () => {
    const page = selectedPage();
    if (!page) return;
    const { config } = resolveConfig(state.template, state.overrides, page.key);
    state.draft = clone(config);
    state.dirty = false;
    syncFormFromDraft();
    refreshAllViews();
    schedulePreview();
    updateDirtyUI();
    toast('已还原为已保存设定');
  });
  $('clearOverrideBtn').addEventListener('click', () => {
    const page = selectedPage();
    if (!page) return;
    state.overrides = clearOverride(storage, state.overrides, page.key);
    state.draft = clone(state.template);
    state.dirty = false;
    selectPage(page.id);
    toast('已清除本页覆盖，恢复跟随全批模板', 'ok');
  });
  $('applyTruthBtn').addEventListener('click', applyTruthCorners);

  // 纸张设定
  const ratioSelect = $('ratioSelect');
  for (const p of RATIO_PRESETS) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    ratioSelect.appendChild(opt);
  }
  ratioSelect.addEventListener('change', () => {
    if (!state.draft) return;
    const preset = RATIO_PRESETS.find((p) => p.id === ratioSelect.value);
    if (preset) {
      state.draft.ratio = preset.custom
        ? { id: 'custom', w: Number($('ratioWInput').value) || 210, h: Number($('ratioHInput').value) || 297 }
        : { id: preset.id, w: preset.w, h: preset.h };
    }
    $('ratioCustomFields').classList.toggle('hidden', ratioSelect.value !== 'custom');
    afterDraftChanged();
    schedulePreview();
  });

  const onCustomRatio = () => {
    if (!state.draft || ratioSelect.value !== 'custom') return;
    const w = Math.max(1, Number($('ratioWInput').value) || 1);
    const h = Math.max(1, Number($('ratioHInput').value) || 1);
    state.draft.ratio = { id: 'custom', w, h };
    afterDraftChanged();
    schedulePreview();
  };
  $('ratioWInput').addEventListener('change', onCustomRatio);
  $('ratioHInput').addEventListener('change', onCustomRatio);
  $('ratioAutoBtn').addEventListener('click', () => {
    const page = selectedPage();
    if (!page || !state.draft) return;
    const r = autoRatioFromCorners(getCornersPx(page));
    ratioSelect.value = 'custom';
    $('ratioCustomFields').classList.remove('hidden');
    const w = Math.round(r * 1000);
    const h = 1000;
    $('ratioWInput').value = w;
    $('ratioHInput').value = h;
    state.draft.ratio = { id: 'custom', w, h };
    afterDraftChanged();
    schedulePreview();
    toast(`按四角平均边长估算比例 ${r.toFixed(3)}`);
  });

  $('outputWidthInput').addEventListener('change', (e) => {
    if (!state.draft) return;
    const v = Math.min(8000, Math.max(200, Math.round(Number(e.target.value) || 1654)));
    e.target.value = v;
    state.draft.outputWidth = v;
    afterDraftChanged();
    $('paperSize').textContent = '';
    schedulePreview();
  });
  $('maskColorInput').addEventListener('input', (e) => {
    if (!state.draft) return;
    state.draft.maskColor = e.target.value;
    afterDraftChanged();
    schedulePreview();
  });

  $('verifyRegionsBtn').addEventListener('click', verifyRegions);
  $('downloadCheckpointsBtn').addEventListener('click', () => {
    const page = selectedPage();
    if (!page?.truth) return;
    downloadJSON(
      { fixture: page.truth.kind, name: page.truth.name, ...getFixtureTruth(page.truth.kind) },
      `${baseName(page.name)}.checkpoints.json`,
    );
  });

  // 本页导出
  $('exportCurrentBtn').addEventListener('click', exportCurrentPage);
  $('downloadPngBtn').addEventListener('click', () => {
    const p = selectedPage();
    if (p?.result) downloadBlob(p.result.blob, `${baseName(p.name)}.png`);
  });
  $('downloadJsonBtn').addEventListener('click', () => {
    const p = selectedPage();
    if (p?.result) downloadJSON(p.result.info, `${baseName(p.name)}.transform.json`);
  });
  $('adoptBtn').addEventListener('click', () => {
    const p = selectedPage();
    if (p) toggleAdopt(p);
  });

  // 批量
  $('pickDirBtn').addEventListener('click', async () => {
    try {
      state.dirHandle = await pickOutputDirectory();
      if (state.dirHandle) {
        $('dirName').textContent = `输出文件夹：${state.dirHandle.name}（批量时逐页写入）`;
        toast('已选择输出文件夹', 'ok');
      }
    } catch (err) {
      if (err?.name !== 'AbortError') toast(`选择文件夹失败：${err.message}`, 'error');
    }
  });
  $('batchExportBtn').addEventListener('click', startBatch);
  $('cancelBatchBtn').addEventListener('click', () => {
    state.batchToken?.cancel('user');
    $('cancelBatchBtn').disabled = true;
    $('progressLabel').textContent = '正在取消：当前页停止后，不再处理后续页…';
    toast('已请求取消，将在当前大图的下一个像素块停止');
  });
  $('batchDownloadAllBtn').addEventListener('click', () => downloadAllSuccessful());

  // 设定 IO
  $('exportTemplateBtn').addEventListener('click', exportTemplateFile);
  $('importTemplateBtn').addEventListener('click', () => $('templateImportInput').click());
  $('templateImportInput').addEventListener('change', (e) => importJSONFile(e.target, importTemplate));
  $('exportOverridesBtn').addEventListener('click', exportOverridesFile);
  $('importOverridesBtn').addEventListener('click', () => $('overridesImportInput').click());
  $('overridesImportInput').addEventListener('change', (e) => importJSONFile(e.target, importOverrides));

  // Delete 删除选中区域
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedRegionId) {
      e.preventDefault();
      deleteRegion(state.selectedRegionId);
    }
  });
}

// ---------------------------------------------------------------------------
// 无头/自检 API（也方便人工在 DevTools 调试）
// ---------------------------------------------------------------------------

window.__pageCorrector = {
  state,
  views: { get source() { return sourceView; }, get paper() { return paperView; } },
  async addFixture(kind) {
    await addFixture(kind);
    return selectedPage()?.id ?? null;
  },
  listPages() {
    return state.pages.map((p) => ({
      id: p.id, key: p.key, name: p.name, width: p.width, height: p.height,
      status: p.status, adopted: !!state.adopted[p.key], hasResult: !!p.result,
    }));
  },
  selectPage,
  getDraft: () => state.draft ? clone(state.draft) : null,
  saveCurrentTemplate: commitTemplate,
  saveCurrentOverride: commitOverrideAsNew,
  /** 以归一化坐标尝试移动某角，返回是否接受与提示 */
  attemptCornerNormalized(index, nx, ny) {
    const page = selectedPage();
    const natural = { x: nx * page.width, y: ny * page.height };
    const res = handleTryCorner(index, natural);
    if (res.accepted) {
      handleCornerCommit();
      sourceView.update(buildSourceVM());
    }
    return res;
  },
  addMaskRegion(rect) {
    handleRegionDrawn({ type: 'mask', ...rect });
    return state.draft.regions.length;
  },
  verifyRegions: () => {
    verifyRegions();
    return $('regionVerifyResult').textContent;
  },
  applyTruth: applyTruthCorners,
  async runSmokeBatch() {
    // 自检用小宽度，加速无头浏览器
    state.template.outputWidth = 360;
    saveTemplate(storage, state.template);
    for (const p of state.pages) {
      if (pageHasOverride(p)) {
        state.overrides[p.key].outputWidth = 360;
      }
    }
    const token = new CancelToken();
    const records = await runBatch(
      [...state.pages],
      {
        processPage: (page, t) => processOneForBatch(page, t, state.pages.indexOf(page), state.pages.length),
        onUpdate: (r) => handleBatchRecord(r, 'memory'),
      },
      token,
    );
    return {
      summary: summarizeRecords(records),
      records: records.map((r) => ({
        pageId: r.pageId,
        status: r.status,
        blobSize: r.result?.blob?.size ?? null,
        width: r.result?.width ?? null,
        hasInfo: !!r.result?.info?.matricesRowMajor,
      })),
    };
  },
  canvasSignature() {
    const nonBlank = (canvas) => {
      try {
        const ctx = canvas.getContext('2d');
        const d = ctx.getImageData(0, 0, Math.min(canvas.width, 64), Math.min(canvas.height, 64)).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 16) sum += Math.abs(d[i] - d[i + 1]) + Math.abs(d[i + 1] - d[i + 2]);
        return { width: canvas.width, height: canvas.height, variation: sum };
      } catch (e) {
        return { error: String(e) };
      }
    };
    return {
      source: nonBlank($('sourceCanvas')),
      paper: nonBlank($('paperCanvas')),
    };
  },
  precisionSummaryText: () => $('precisionSummary').textContent,
};

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

bindEvents();
updateModeBadge();
syncToolButtons('pan');
$('cancelBatchBtn').disabled = true;
if (!state.pages.length) {
  $('pageList').innerHTML = '<li class="empty-tip">还没有图片。<br>点「添加图片」或「生成核对示例」开始。</li>';
}
toast('工具已就绪：所有处理均在本机浏览器内完成，不上传任何图片');
