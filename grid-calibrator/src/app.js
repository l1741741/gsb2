import { configToJson, parseConfig } from './config.js';
import { modelSignature, recomputeFit } from './calibration.js';
import {
  SAMPLE_OUTPUT,
  createSyntheticPoints,
  measureWarp,
} from './distortion.js';
import {
  addPoint,
  checkImageDimensions,
  checkpointKeys,
  createDocument,
  createId,
  createRegularMarkers,
  movePoint,
  nextMissingGridLabel,
  removePoint,
  selectPoint,
  setCrop,
  setGridDimensions,
  setOutput,
  UndoStack,
  updatePoint,
} from './state.js';
import {
  generateCalibrationSample,
  generateCheckSample,
} from './synthetic.js';
import {
  defaultCrop,
  largestValidRectangle,
  outputSize,
  renderCorrection,
} from './warp.js';
import {
  fitView,
  hitTestPoint,
  screenToImage,
  zoomAt,
  createView,
} from './viewport.js';
import {
  drawAlignedGrid,
  drawCalibrationView,
  drawCorrectedFrame,
  drawOriginalView,
  drawValidRectangle,
} from './view-renderer.js';

const $ = (id) => document.getElementById(id);

const canvas = $('stage');
const wrap = $('canvasWrap');
const ctx = canvas.getContext('2d');

let doc = createDocument();
let history = new UndoStack(doc);
let view = createView();
let currentView = 'calibrate';
let tool = 'select';
let showLabels = true;

let calibrationImage = null;
let extraTargets = [];
let targetId = 'calibration';
let warpMeasurement = null;

let correctionCache = null;
let correctionStatus = 'idle';
let correctionError = '';
let buildToken = 0;

let gesture = null;
let cssWidth = 0;
let cssHeight = 0;
let dpr = 1;

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = src;
  });
}

function setStatus(message) {
  $('statusBar').textContent = message;
}

function estimateCellPx(width, height, columns, rows) {
  const spacingX = (width * 0.76) / Math.max(1, columns - 1);
  const spacingY = (height * 0.76) / Math.max(1, rows - 1);
  return Math.max(8, Math.round((spacingX + spacingY) / 2));
}

function commitEdit(nextDoc) {
  const result = recomputeFit(nextDoc);
  doc = history.commit(result.doc);
  afterDocChanged();
}

function afterDocChanged() {
  syncControlsFromDoc();
  updateHistoryButtons();
  syncPanels();
  renderStage();
  if (currentView === 'corrected' || currentView === 'grid') {
    void ensureCorrection();
  }
}

function updateHistoryButtons() {
  $('undoBtn').disabled = !history.canUndo;
  $('redoBtn').disabled = !history.canRedo;
}

function resizeCanvas() {
  // Use the canvas's own CSS box (not the bordered wrapper) so backing pixels
  // and pointer getBoundingClientRect() use exactly the same dimensions.
  const rect = canvas.getBoundingClientRect();
  cssWidth = Math.max(1, rect.width);
  cssHeight = Math.max(1, rect.height);
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(cssWidth * dpr);
  const pixelHeight = Math.round(cssHeight * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
}

function currentNaturalSize() {
  if (currentView === 'calibrate') {
    return {
      width: calibrationImage?.naturalWidth || doc.image?.width || 0,
      height: calibrationImage?.naturalHeight || doc.image?.height || 0,
    };
  }
  if (currentView === 'original') {
    const target = getCurrentTarget();
    return { width: target?.width || 0, height: target?.height || 0 };
  }
  return outputSize(doc.output);
}

function fitCurrentView() {
  resizeCanvas();
  const size = currentNaturalSize();
  view = fitView(size.width, size.height, cssWidth, cssHeight);
  updateZoomLabel();
  renderStage();
  if (currentView === 'corrected' || currentView === 'grid') {
    void ensureCorrection();
  }
}

function updateZoomLabel() {
  $('zoomLabel').textContent = `${Math.round(view.scale * 100)}%`;
}

function getCurrentTarget() {
  if (targetId === 'calibration') {
    if (calibrationImage && doc.image) {
      return {
        id: 'calibration',
        name: doc.image.name || 'calibration.png',
        image: calibrationImage,
        width: doc.image.width,
        height: doc.image.height,
      };
    }
  }
  const extra = extraTargets.find((target) => target.id === targetId);
  if (extra) return extra;
  if (calibrationImage && doc.image) {
    targetId = 'calibration';
    return getCurrentTarget();
  }
  return extraTargets[0] ?? null;
}

function getCompatibility(target) {
  if (!target) {
    return { compatible: false, code: 'no_image', message: '没有可预览的图片。' };
  }
  if (target.id === 'calibration') return { compatible: true, code: 'ok', message: '当前为标定图本身。' };
  return checkImageDimensions(target, doc.image);
}

function renderTargetOptions() {
  const select = $('targetSelect');
  select.innerHTML = '';

  if (doc.image) {
    const option = document.createElement('option');
    option.value = 'calibration';
    option.textContent = `标定图本身（${doc.image.width}×${doc.image.height}）`;
    select.appendChild(option);
  }

  for (const target of extraTargets) {
    const compatibility = checkImageDimensions(target, doc.image);
    const option = document.createElement('option');
    option.value = target.id;
    option.textContent = `${target.name}（${target.width}×${target.height}）${compatibility.compatible ? '' : ' ⚠尺寸不符'}`;
    select.appendChild(option);
  }

  const hasTarget = [...select.options].some((option) => option.value === targetId);
  if (!hasTarget) targetId = select.options[0]?.value ?? '';
  select.value = targetId;
}

function currentCorrectionKey(target) {
  if (!target || !doc.activeModel) return null;
  return JSON.stringify({
    target: target.id,
    size: [target.width, target.height],
    model: modelSignature(doc.activeModel),
    output: doc.output,
  });
}

async function ensureCorrection() {
  const target = getCurrentTarget();
  const compatibility = getCompatibility(target);
  correctionError = '';

  if (!doc.image) {
    correctionStatus = 'blocked';
    syncPanels();
    return null;
  }
  if (!target || !compatibility.compatible || !doc.activeModel) {
    correctionStatus = 'blocked';
    syncPanels();
    renderStage();
    return null;
  }

  const key = currentCorrectionKey(target);
  if (correctionCache?.key === key && correctionStatus === 'ready') {
    return correctionCache;
  }

  const token = ++buildToken;
  correctionStatus = 'working';
  syncPanels();

  // Let the status/banner paint before the synchronous pixel loop.
  await new Promise((resolve) => window.setTimeout(resolve, 30));

  try {
    const size = outputSize(doc.output);
    if (size.width > 12000 || size.height > 12000 || size.width * size.height > 48_000_000) {
      throw new Error('输出尺寸过大：请减小网格间距或缩小裁切范围。');
    }
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = target.width;
    sourceCanvas.height = target.height;
    const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    sourceCtx.drawImage(target.image, 0, 0, target.width, target.height);
    const imageData = sourceCtx.getImageData(0, 0, target.width, target.height);

    const frame = renderCorrection(
      { data: imageData.data, width: target.width, height: target.height },
      doc.activeModel,
      doc.output,
    );

    if (token !== buildToken) return null;

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = frame.width;
    outputCanvas.height = frame.height;
    const outputCtx = outputCanvas.getContext('2d');
    const outputImageData = new ImageData(frame.data, frame.width, frame.height);
    outputCtx.putImageData(outputImageData, 0, 0);

    const validRect = largestValidRectangle(frame.valid, frame.width, frame.height);
    correctionCache = {
      key,
      canvas: outputCanvas,
      frame,
      validRect,
      stats: frame.stats,
    };
    correctionStatus = 'ready';
    syncPanels();
    renderStage();
    return correctionCache;
  } catch (error) {
    if (token !== buildToken) return null;
    correctionStatus = 'error';
    correctionError = error.message;
    syncPanels();
    return null;
  }
}

function syncControlsFromDoc() {
  $('gridColumns').value = doc.grid.columns;
  $('gridRows').value = doc.grid.rows;
  $('cellPxInput').value = doc.output.cellPx;
  $('cropCol0').value = doc.output.crop.col0;
  $('cropRow0').value = doc.output.crop.row0;
  $('cropCol1').value = doc.output.crop.col1;
  $('cropRow1').value = doc.output.crop.row1;
  $('exportMode').value = doc.output.exportMode;
  $('calibrationInfo').textContent = doc.image
    ? `${doc.image.name || 'calibration'} · ${doc.image.width}×${doc.image.height} · ${doc.points.length} 个标记点`
    : '尚未加载标定图。';

  const selected = doc.points.find((point) => point.id === doc.selectedId) ?? null;
  const hasSelection = Boolean(selected);
  for (const id of ['pointRow', 'pointCol', 'pointRole', 'deletePointBtn']) {
    $(id).disabled = !hasSelection;
  }
  if (selected) {
    $('selectedInfo').textContent = `已选中：R${selected.row + 1} C${selected.col + 1}（${selected.role === 'check' ? '检查点' : '拟合点'}）`;
    $('pointRow').value = selected.row + 1;
    $('pointCol').value = selected.col + 1;
    $('pointRole').value = selected.role;
  } else {
    $('selectedInfo').textContent = '未选中交点。';
    $('pointRow').value = '';
    $('pointCol').value = '';
    $('pointRole').value = 'fit';
  }
}

function metricCard(label, value) {
  return `<div class="metric"><span>${label}</span><b>${value}</b></div>`;
}

function syncFitPanel() {
  const status = $('fitStatus');
  const report = doc.fitReport;
  if (!doc.image) {
    status.className = 'status status-idle';
    status.textContent = '等待标定图。';
    $('fitMetrics').innerHTML = '';
    $('residualList').textContent = '暂无检查点。';
    $('warpMeasurements').innerHTML = '';
    return;
  }

  if (!report) {
    status.className = 'status status-idle';
    status.textContent = '尚未拟合。';
  } else if (report.ok) {
    status.className = 'status status-ok';
    status.textContent = report.message;
  } else if (doc.activeModel) {
    status.className = 'status status-warn';
    status.textContent = `⚠ ${report.message} 当前画布和导出保留上一次可用结果。`;
  } else {
    status.className = 'status status-error';
    status.textContent = `⚠ ${report.message}`;
  }

  if (report?.ok) {
    const region = report.regionStats ?? {};
    $('fitMetrics').innerHTML = [
      metricCard('模型阶数', `${report.degree} 次`),
      metricCard('拟合点', report.fitCount),
      metricCard('拟合 RMS', `${report.fitRms.toFixed(2)} px`),
      metricCard('拟合最大', `${report.fitMax.toFixed(2)} px`),
      metricCard('检查 RMS', `${report.checkRms.toFixed(2)} px`),
      metricCard('检查最大', `${report.checkMax.toFixed(2)} px`),
      metricCard('中心检查残差', `${(region.center?.rms ?? 0).toFixed(2)} px`),
      metricCard('边缘检查最大', `${(region.edge?.max ?? 0).toFixed(2)} px`),
    ].join('');

    const details = [...(report.checkDetails ?? [])].sort((a, b) => b.distance - a.distance);
    const maxDistance = Math.max(0.001, ...details.map((item) => item.distance));
    $('residualList').innerHTML = details.length
      ? details.map((item) => `
        <div class="residual-row">
          <span>R${item.row + 1}C${item.col + 1}</span>
          <span class="residual-bar"><i style="width:${Math.max(3, (item.distance / maxDistance) * 100).toFixed(1)}%"></i></span>
          <span>${item.distance.toFixed(2)}px</span>
        </div>`).join('')
      : '未设置检查点；可把某个点的角色改为“检查点”。';
  } else if (doc.activeModel) {
    $('fitMetrics').innerHTML = [
      metricCard('保留模型', `${doc.activeModel.degree} 次`),
      metricCard('拟合点', report.fitCount),
      metricCard('检查点', report.checkCount),
    ].join('');
  } else {
    $('fitMetrics').innerHTML = '';
    $('residualList').textContent = report?.message ?? '暂无可用模型。';
  }

  if (warpMeasurement) {
    const m = warpMeasurement;
    $('warpMeasurements').innerHTML = `
      <div class="measurement-row"><span>生成图中心位移</span><b>${m.centerDisplacement.toFixed(1)} px</b></div>
      <div class="measurement-row"><span>边缘中点平均 / 最大</span><b>${m.edgeMeanDisplacement.toFixed(1)} / ${m.edgeMaxDisplacement.toFixed(1)} px</b></div>
      <div class="measurement-row"><span>四角平均 / 最大</span><b>${m.cornerMeanDisplacement.toFixed(1)} / ${m.cornerMaxDisplacement.toFixed(1)} px</b></div>
    `;
  } else {
    $('warpMeasurements').innerHTML = '';
  }
}

function syncTargetPanel() {
  const target = getCurrentTarget();
  const compatibility = getCompatibility(target);
  const targetStatus = $('targetStatus');
  targetStatus.textContent = compatibility.message + (compatibility.compatible && doc.image
    ? ` 输出裁切：C ${doc.output.crop.col0}→${doc.output.crop.col1}，R ${doc.output.crop.row0}→${doc.output.crop.row1}。`
    : '');
  targetStatus.style.color = compatibility.compatible ? '' : '#991b1b';
  return compatibility;
}

function syncWarpStats() {
  const el = $('warpStats');
  if (correctionCache?.key === currentCorrectionKey(getCurrentTarget())) {
    const { width, height, validRect, stats } = correctionCache;
    el.innerHTML = `输出 <b>${width}×${height}</b>；越界像素 <b>${stats.outOfBoundsPixels}</b>（${(stats.outOfBoundsFraction * 100).toFixed(1)}%）；有效矩形 <b>${validRect.width}×${validRect.height}</b>。`;
  } else if (correctionStatus === 'working') {
    el.textContent = '正在逐像素逆映射并采样…';
  } else if (correctionStatus === 'error') {
    el.textContent = `校正失败：${correctionError}`;
  } else {
    el.textContent = '需要尺寸一致的图片和可用拟合模型后生成结果。';
  }
}

function syncPanels() {
  syncFitPanel();
  syncTargetPanel();
  syncWarpStats();
  updateHistoryButtons();
  updateBanner();
}

function updateBanner() {
  const banner = $('banner');
  const target = getCurrentTarget();
  const compatibility = getCompatibility(target);
  let content = '';
  let type = 'warn';

  if (currentView === 'calibrate') {
    if (doc.fitReport && !doc.fitReport.ok) {
      type = doc.activeModel ? 'warn' : 'error';
      content = doc.activeModel
        ? `⚠ ${doc.fitReport.message}<br>已保留并继续使用上一次可用结果。`
        : `⚠ ${doc.fitReport.message}`;
    }
  } else if (currentView === 'original') {
    if (target && !compatibility.compatible) {
      type = 'error';
      content = compatibility.message;
    }
  } else {
    if (!doc.image) {
      type = 'error';
      content = '请先加载或生成标定图。';
    } else if (!target) {
      type = 'warn';
      content = '请加载或生成一张待校正图片。';
    } else if (!compatibility.compatible) {
      type = 'error';
      content = `${compatibility.message}<br>校正和导出已阻止，不会静默套用。`;
    } else if (!doc.activeModel) {
      type = 'error';
      content = '还没有可用拟合结果：请补足并分散标记点。';
    } else if (correctionStatus === 'working') {
      type = 'warn';
      content = '正在生成校正预览…';
    } else if (correctionStatus === 'error') {
      type = 'error';
      content = `校正渲染失败：${correctionError}`;
    } else if (doc.fitReport && !doc.fitReport.ok && doc.activeModel) {
      type = 'warn';
      content = `当前标记不满足更新条件，预览仍使用上一次可用模型。${doc.fitReport.message}`;
    }
  }

  banner.className = content ? `banner ${type}` : 'banner hidden';
  banner.innerHTML = content;
}

function updateEmptyHint() {
  const hint = $('emptyHint');
  const strong = hint.querySelector('strong');
  const span = hint.querySelector('span');
  let hidden = false;
  let title = '';
  let detail = '';

  if (currentView === 'calibrate') {
    hidden = Boolean(calibrationImage);
    title = '从一张标定网格开始';
    detail = '点击左侧“生成弯曲标定网格”，或加载自己的标定图并铺设点阵。';
  } else if (currentView === 'original') {
    const target = getCurrentTarget();
    hidden = Boolean(target?.image);
    title = '没有可预览的原图';
    detail = '请加载待校正图片，或生成自带的弯曲检查图。';
  } else {
    const key = currentCorrectionKey(getCurrentTarget());
    hidden = Boolean(correctionCache?.key === key);
    title = correctionStatus === 'working' ? '正在生成校正图' : '校正结果将显示在这里';
    detail = '需要可用标定模型，以及与标定图尺寸完全一致的待校正图片。';
  }

  hint.classList.toggle('hidden', hidden);
  if (!hidden) {
    strong.textContent = title;
    span.textContent = detail;
  }
}

function renderStage() {
  resizeCanvas();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  canvas.classList.toggle('checkerboard', currentView === 'corrected' || currentView === 'grid');

  if (currentView === 'calibrate') {
    if (calibrationImage) {
      drawCalibrationView(ctx, {
        image: calibrationImage,
        width: doc.image.width,
        height: doc.image.height,
        view,
        doc,
        showLabels,
      });
    }
  } else if (currentView === 'original') {
    drawOriginalView(ctx, { target: getCurrentTarget(), view });
  } else {
    const target = getCurrentTarget();
    const key = currentCorrectionKey(target);
    if (correctionCache?.key === key) {
      drawCorrectedFrame(ctx, correctionCache.canvas, view);
      if (currentView === 'grid') {
        drawAlignedGrid(ctx, {
          view,
          crop: doc.output.crop,
          cellPx: doc.output.cellPx,
          columns: doc.grid.columns,
          rows: doc.grid.rows,
        });
      }
      drawValidRectangle(ctx, correctionCache.validRect, view);
    }
  }

  updateZoomLabel();
  updateEmptyHint();
}

async function loadCalibrationFile(file) {
  const dataUrl = await readFileAsDataUrl(file);
  const image = await loadImageElement(dataUrl);
  const columns = Number($('gridColumns').value) || 11;
  const rows = Number($('gridRows').value) || 8;
  const points = createRegularMarkers({
    columns,
    rows,
    imageWidth: image.naturalWidth,
    imageHeight: image.naturalHeight,
  });
  const nextDoc = createDocument({
    image: { name: file.name, width: image.naturalWidth, height: image.naturalHeight, dataUrl },
    columns,
    rows,
    points,
    cellPx: estimateCellPx(image.naturalWidth, image.naturalHeight, columns, rows),
  });
  const result = recomputeFit(nextDoc);
  doc = result.doc;
  history = new UndoStack(doc);
  calibrationImage = image;
  warpMeasurement = null;
  targetId = 'calibration';
  correctionCache = null;
  renderTargetOptions();
  syncControlsFromDoc();
  afterDocChanged();
  currentView = 'calibrate';
  updateTabClasses();
  requestAnimationFrame(() => fitCurrentView());
  setStatus(`已加载标定图 ${file.name}（${image.naturalWidth}×${image.naturalHeight}）。请把点拖到真实交点。`);
}

async function loadSampleCalibration() {
  setStatus('正在生成数字弯曲标定网格…');
  const sample = await generateCalibrationSample();
  const checkKeys = checkpointKeys(sample.warp.columns, sample.warp.rows);
  const points = createSyntheticPoints(
    sample.warp,
    (col, row) => (checkKeys.has(`${col}:${row}`) ? 'check' : 'fit'),
  );

  const nextDoc = createDocument({
    image: {
      name: 'digital-bent-grid.png',
      width: sample.width,
      height: sample.height,
      dataUrl: sample.dataUrl,
    },
    columns: sample.warp.columns,
    rows: sample.warp.rows,
    points,
    cellPx: SAMPLE_OUTPUT.cellPx,
    crop: { ...SAMPLE_OUTPUT.crop },
  });
  const result = recomputeFit(nextDoc);
  doc = result.doc;
  history = new UndoStack(doc);
  calibrationImage = sample.image;
  warpMeasurement = measureWarp(sample.warp);
  targetId = 'calibration';
  correctionCache = null;
  renderTargetOptions();
  syncControlsFromDoc();
  afterDocChanged();
  currentView = 'calibrate';
  updateTabClasses();
  requestAnimationFrame(() => fitCurrentView());
  setStatus('已生成带已知弯曲量的标定网格，红点是不参与拟合的检查点。');
}

async function loadSampleCheck() {
  const isMatchingSample = calibrationImage
    && doc.image?.name === 'digital-bent-grid.png'
    && doc.image?.width === 960
    && doc.image?.height === 720;

  if (!isMatchingSample) {
    const hasUserWork = Boolean(calibrationImage || doc.points.length || doc.activeModel);
    const shouldLoadSampleCalibration = !hasUserWork
      || (typeof window.confirm === 'function'
        && window.confirm('生成配套检查图时可同时载入自带弯曲网格。\n\n确定要替换当前标定图、标记和撤销历史吗？\n点“取消”则只生成检查图，并继续使用当前标定（尺寸不符会被拦截）。'));
    if (shouldLoadSampleCalibration) await loadSampleCalibration();
  }

  const sample = await generateCheckSample();
  const target = {
    id: 'sample-check',
    name: 'digital-bent-check.png',
    image: sample.image,
    width: sample.width,
    height: sample.height,
    dataUrl: sample.dataUrl,
  };
  extraTargets = extraTargets.filter((item) => item.id !== target.id);
  extraTargets.push(target);
  targetId = target.id;
  correctionCache = null;
  renderTargetOptions();
  $('targetSelect').value = targetId;
  currentView = 'corrected';
  updateTabClasses();
  requestAnimationFrame(() => fitCurrentView());
  setStatus('已生成同尺寸弯曲检查图；可切换原图、校正图和对齐网格。');
}

async function loadTargetFiles(fileList) {
  const files = [...fileList];
  let firstNewId = null;
  for (const file of files) {
    const dataUrl = await readFileAsDataUrl(file);
    const image = await loadImageElement(dataUrl);
    const target = {
      id: createId('target'),
      name: file.name,
      image,
      dataUrl,
      width: image.naturalWidth,
      height: image.naturalHeight,
    };
    extraTargets.push(target);
    firstNewId ??= target.id;
  }
  if (firstNewId) {
    targetId = firstNewId;
    correctionCache = null;
    renderTargetOptions();
    $('targetSelect').value = targetId;
    currentView = 'original';
    updateTabClasses();
    requestAnimationFrame(() => fitCurrentView());
    syncPanels();
    setStatus(`已加载 ${files.length} 张待校正图片；尺寸不符的图片会被明确拦截。`);
  }
}

function updateTabClasses() {
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === currentView);
  });
}

function pointerPosition(event) {
  return screenToImage(event.clientX, event.clientY, canvas.getBoundingClientRect(), view);
}

function onPointerDown(event) {
  const target = getCurrentTarget();
  const hasViewImage = currentView === 'calibrate'
    ? Boolean(calibrationImage)
    : Boolean(target?.image);
  if (!hasViewImage) return;

  event.preventDefault();
  canvas.setPointerCapture(event.pointerId);
  const position = pointerPosition(event);

  if (currentView === 'calibrate') {
    const hit = hitTestPoint(doc.points, position, view, canvas.getBoundingClientRect(), 11);

    if (hit) {
      doc = selectPoint(doc, hit.id);
      gesture = {
        type: 'marker',
        id: hit.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
      };
      canvas.style.cursor = 'grabbing';
      syncControlsFromDoc();
      renderStage();
      return;
    }

    if (tool === 'add-fit' || tool === 'add-check') {
      const label = nextMissingGridLabel(doc);
      commitEdit(addPoint(doc, {
        ...label,
        x: position.x,
        y: position.y,
        role: tool === 'add-check' ? 'check' : 'fit',
      }));
      setStatus(`已添加 R${label.row + 1} C${label.col + 1}，可在左侧修改行列。`);
      return;
    }
  }

  gesture = {
    type: 'pan',
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    originX: view.x,
    originY: view.y,
  };
  canvas.style.cursor = 'grabbing';
}

function onPointerMove(event) {
  const position = pointerPosition(event);

  if (!gesture) {
    if (currentView === 'calibrate' && calibrationImage) {
      const hit = hitTestPoint(doc.points, position, view, canvas.getBoundingClientRect(), 11);
      canvas.style.cursor = hit ? 'grab' : tool === 'select' ? 'grab' : 'crosshair';
    } else if (currentView !== 'calibrate' && getCurrentTarget()?.image) {
      canvas.style.cursor = 'grab';
    }
    return;
  }

  if (gesture.type === 'marker') {
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 3) {
      gesture.moved = true;
    }
    if (gesture.moved) {
      const moved = movePoint(doc, gesture.id, position.x, position.y);
      const result = recomputeFit(moved);
      doc = result.doc;
      renderStage();
      syncFitPanel();
      updateHistoryButtons();
    }
    return;
  }

  view.x = gesture.originX + event.clientX - gesture.startClientX;
  view.y = gesture.originY + event.clientY - gesture.startClientY;
  renderStage();
}

function finishPointer(event, cancelled = false) {
  if (!gesture) return;
  if (canvas.hasPointerCapture?.(gesture.pointerId)) {
    canvas.releasePointerCapture(gesture.pointerId);
  }

  if (gesture.type === 'marker') {
    if (cancelled) {
      doc = history.current;
    } else if (gesture.moved) {
      const result = recomputeFit(doc);
      doc = history.commit(result.doc);
      setStatus('交点拖动已记录，可撤销。');
    }
    canvas.style.cursor = '';
    gesture = null;
    afterDocChanged();
    return;
  }

  canvas.style.cursor = '';
  gesture = null;
}

async function exportPng() {
  const target = getCurrentTarget();
  const compatibility = getCompatibility(target);
  if (!compatibility.compatible) throw new Error(compatibility.message);
  if (!doc.activeModel) throw new Error('没有可用标定模型。');

  setStatus('正在渲染全分辨率校正 PNG…');
  const cache = await ensureCorrection();
  if (!cache) throw new Error(correctionError || '校正结果尚未生成。');

  let outputCanvas = cache.canvas;
  let suffix = 'corrected-padded';
  if (doc.output.exportMode === 'valid') {
    const rect = cache.validRect;
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error('找不到有效的非透明矩形。');
    }
    outputCanvas = document.createElement('canvas');
    outputCanvas.width = rect.width;
    outputCanvas.height = rect.height;
    const outputCtx = outputCanvas.getContext('2d');
    outputCtx.drawImage(
      cache.canvas,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      0,
      0,
      rect.width,
      rect.height,
    );
    suffix = 'valid-rect';
  }

  const blob = await new Promise((resolve) => outputCanvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('浏览器未能编码 PNG。');
  const baseName = (target.name || 'image').replace(/\.[^.]+$/, '');
  downloadBlob(`${baseName}-${suffix}.png`, blob);
  setStatus(`已导出 ${outputCanvas.width}×${outputCanvas.height} PNG。`);
}

function bindEvents() {
  $('calibrationInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      try { await loadCalibrationFile(file); }
      catch (error) { setStatus(error.message); }
    }
  });

  $('sampleCalibrationBtn').addEventListener('click', () => {
    loadSampleCalibration().catch((error) => setStatus(error.message));
  });
  $('sampleCheckBtn').addEventListener('click', () => {
    loadSampleCheck().catch((error) => setStatus(error.message));
  });
  $('imageInput').addEventListener('change', async (event) => {
    try { await loadTargetFiles(event.target.files); }
    catch (error) { setStatus(error.message); }
    event.target.value = '';
  });

  $('targetSelect').addEventListener('change', (event) => {
    targetId = event.target.value;
    correctionCache = null;
    fitCurrentView();
    syncPanels();
  });

  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => {
      currentView = button.dataset.view;
      updateTabClasses();
      correctionCache = null;
      fitCurrentView();
      syncPanels();
    });
  });

  $('zoomInBtn').addEventListener('click', () => {
    resizeCanvas();
    view = zoomAt(view, cssWidth / 2, cssHeight / 2, 1.2);
    renderStage();
  });
  $('zoomOutBtn').addEventListener('click', () => {
    resizeCanvas();
    view = zoomAt(view, cssWidth / 2, cssHeight / 2, 1 / 1.2);
    renderStage();
  });
  $('zoomFitBtn').addEventListener('click', fitCurrentView);

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', (event) => finishPointer(event, false));
  canvas.addEventListener('pointercancel', (event) => finishPointer(event, true));
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cssX = event.clientX - rect.left;
    const cssY = event.clientY - rect.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    view = zoomAt(view, cssX, cssY, factor);
    renderStage();
  }, { passive: false });

  $('toolSelect').addEventListener('click', () => setTool('select'));
  $('toolAddFit').addEventListener('click', () => setTool('add-fit'));
  $('toolAddCheck').addEventListener('click', () => setTool('add-check'));
  $('showLabels').addEventListener('change', (event) => {
    showLabels = event.target.checked;
    renderStage();
  });

  $('undoBtn').addEventListener('click', () => {
    doc = history.undo();
    afterHistoryNavigation();
  });
  $('redoBtn').addEventListener('click', () => {
    doc = history.redo();
    afterHistoryNavigation();
  });
  window.addEventListener('keydown', (event) => {
    const modifier = event.ctrlKey || event.metaKey;
    if (!modifier || event.key.toLowerCase() !== 'z') return;
    if (event.target.closest?.('input, select, textarea, [contenteditable="true"]')) return;
    event.preventDefault();
    doc = event.shiftKey ? history.redo() : history.undo();
    afterHistoryNavigation();
  });

  $('applyGridBtn').addEventListener('click', () => {
    const columns = Number.parseInt($('gridColumns').value, 10);
    const rows = Number.parseInt($('gridRows').value, 10);
    if (!Number.isFinite(columns) || !Number.isFinite(rows)) return;
    commitEdit(setGridDimensions(doc, columns, rows));
    requestAnimationFrame(fitCurrentView);
  });

  $('layGridBtn').addEventListener('click', () => {
    if (!doc.image || !calibrationImage) {
      setStatus('请先加载标定图，再铺设初始点阵。');
      return;
    }
    const points = createRegularMarkers({
      columns: doc.grid.columns,
      rows: doc.grid.rows,
      imageWidth: doc.image.width,
      imageHeight: doc.image.height,
    });
    commitEdit({
      ...doc,
      points,
      selectedId: null,
      output: {
        ...doc.output,
        cellPx: estimateCellPx(doc.image.width, doc.image.height, doc.grid.columns, doc.grid.rows),
        crop: defaultCrop(doc.grid.columns, doc.grid.rows),
      },
    });
    setStatus('已铺设规则初始点阵；请逐点拖到真实网格交点。');
    requestAnimationFrame(fitCurrentView);
  });

  for (const id of ['pointRow', 'pointCol']) {
    $(id).addEventListener('change', () => {
      const selected = doc.points.find((point) => point.id === doc.selectedId);
      if (!selected) return;
      const row = Math.max(1, Number.parseInt($('pointRow').value, 10) || 1) - 1;
      const col = Math.max(1, Number.parseInt($('pointCol').value, 10) || 1) - 1;
      commitEdit(updatePoint(doc, selected.id, { row, col }));
    });
  }
  $('pointRole').addEventListener('change', () => {
    const selected = doc.points.find((point) => point.id === doc.selectedId);
    if (!selected) return;
    commitEdit(updatePoint(doc, selected.id, { role: $('pointRole').value }));
  });
  $('deletePointBtn').addEventListener('click', () => {
    if (!doc.selectedId) return;
    commitEdit(removePoint(doc, doc.selectedId));
  });

  $('cellPxInput').addEventListener('change', () => {
    const cellPx = Math.min(512, Math.max(8, Number($('cellPxInput').value) || 80));
    commitEdit(setOutput(doc, { cellPx }));
  });
  for (const key of ['Col0', 'Row0', 'Col1', 'Row1']) {
    $(`crop${key}`).addEventListener('change', () => {
      const crop = {
        col0: Number($('cropCol0').value),
        row0: Number($('cropRow0').value),
        col1: Number($('cropCol1').value),
        row1: Number($('cropRow1').value),
      };
      const allFinite = Object.values(crop).every((value) => Number.isFinite(value));
      if (!allFinite || crop.col1 <= crop.col0 || crop.row1 <= crop.row0) {
        setStatus('裁切范围无效：请输入有限数字，且右/下边界必须大于左/上边界。');
        syncControlsFromDoc();
        return;
      }
      commitEdit(setCrop(doc, crop));
      requestAnimationFrame(fitCurrentView);
    });
  }
  $('resetCropBtn').addEventListener('click', () => {
    commitEdit(setCrop(doc, defaultCrop(doc.grid.columns, doc.grid.rows)));
    requestAnimationFrame(fitCurrentView);
  });
  $('exportMode').addEventListener('change', () => {
    commitEdit(setOutput(doc, { exportMode: $('exportMode').value }));
  });

  $('exportPngBtn').addEventListener('click', () => {
    exportPng().catch((error) => {
      correctionStatus = 'error';
      correctionError = error.message;
      setStatus(error.message);
      syncPanels();
    });
  });

  $('saveConfigBtn').addEventListener('click', () => {
    const json = configToJson(doc);
    downloadBlob('grid-calibration-config.json', new Blob([json], { type: 'application/json' }));
    setStatus('标定配置已保存（含标记、模型、尺寸和裁切范围）。');
  });

  $('loadConfigBtn').addEventListener('click', () => $('configInput').click());
  $('configInput').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const loaded = parseConfig(await file.text());
      doc = loaded;
      history = new UndoStack(doc);
      calibrationImage = null;
      if (doc.image?.dataUrl) calibrationImage = await loadImageElement(doc.image.dataUrl);
      targetId = 'calibration';
      correctionCache = null;
      warpMeasurement = null;
      renderTargetOptions();
      syncControlsFromDoc();
      updateTabClasses();
      afterDocChanged();
      requestAnimationFrame(fitCurrentView);
      setStatus('配置已恢复；保存/恢复使用同一模型与裁切，导出结果一致。');
    } catch (error) {
      setStatus(`恢复配置失败：${error.message}`);
    }
  });

  new ResizeObserver(() => {
    resizeCanvas();
    renderStage();
  }).observe(wrap);
}

function setTool(nextTool) {
  tool = nextTool;
  for (const [id, value] of [
    ['toolSelect', 'select'],
    ['toolAddFit', 'add-fit'],
    ['toolAddCheck', 'add-check'],
  ]) {
    $(id).classList.toggle('active', tool === value);
  }
  canvas.style.cursor = tool === 'select' ? 'grab' : 'crosshair';
}

function afterHistoryNavigation() {
  correctionCache = null;
  syncControlsFromDoc();
  renderTargetOptions();
  updateHistoryButtons();
  syncPanels();
  renderStage();
  requestAnimationFrame(fitCurrentView);
  setStatus(history.canUndo ? '已撤销一步。' : history.canRedo ? '已重做一步。' : '历史已更新。');
}

function init() {
  bindEvents();
  syncControlsFromDoc();
  renderTargetOptions();
  updateTabClasses();
  resizeCanvas();
  syncPanels();
  renderStage();
  requestAnimationFrame(() => fitCurrentView());
}

init();
