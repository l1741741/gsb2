/**
 * 浏览器交互应用：参数调节、撤销/重做、多距离批处理、
 * PNG/JSON 导出、自交定位高亮。纯前端、无构建步骤。
 */
import {
  EXAMPLES,
  DEFAULT_PARAMS,
  DEFAULT_SCENE_OPTIONS,
  DEFAULT_STYLE,
  buildBatchExport,
  describeInputs,
  drawScene,
  offsetContours,
  stableStringify,
  validateContour,
} from '../browser.js';
import type {
  ContourInput,
  JoinKind,
  OffsetParams,
  OffsetResult,
} from '../geometry/types.js';
import type { ValidationReport } from '../geometry/validate.js';

interface Snapshot {
  input: ContourInput;
  params: OffsetParams;
}

const state = {
  input: structuredClone(EXAMPLES[0].input),
  params: { ...DEFAULT_PARAMS },
  validation: null as ValidationReport | null,
  result: null as OffsetResult | null,
  batchDistances: [0, -2, -4, -8] as number[],
  scene: { ...DEFAULT_SCENE_OPTIONS },
  undoStack: [] as Snapshot[],
  redoStack: [] as Snapshot[],
};

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;

function pushUndo(): void {
  state.undoStack.push({
    input: structuredClone(state.input),
    params: structuredClone(state.params),
  });
  if (state.undoStack.length > 50) state.undoStack.shift();
  state.redoStack.length = 0;
}

function restore(s: Snapshot): void {
  state.input = structuredClone(s.input);
  state.params = structuredClone(s.params);
  syncControls();
  recompute();
}

function undo(): void {
  const s = state.undoStack.pop();
  if (!s) return;
  state.redoStack.push({
    input: structuredClone(state.input),
    params: structuredClone(state.params),
  });
  restore(s);
}

function redo(): void {
  const s = state.redoStack.pop();
  if (!s) return;
  state.undoStack.push({
    input: structuredClone(state.input),
    params: structuredClone(state.params),
  });
  restore(s);
}

/** 核心：校验 → 偏移 → 渲染。校验失败时只画原图与问题标记，绝不带病计算。 */
function recompute(): void {
  state.validation = validateContour(state.input);
  if (state.validation.valid) {
    state.result = offsetContours(state.input.loops, state.params);
  } else {
    state.result = null;
  }
  render();
  renderReport();
}

function render(): void {
  drawScene(
    ctx,
    {
      inputLoops: state.input.loops,
      result: state.result,
      validation: state.validation,
    },
    state.scene,
    DEFAULT_STYLE,
  );
}

function renderReport(): void {
  const report = document.getElementById('report')!;
  const v = state.validation!;
  if (!v.valid) {
    report.innerHTML =
      `<div class="err">输入轮廓存在 ${v.issues.length} 个问题，已阻止偏移计算：</div><ul>` +
      v.issues
        .map(
          (i) =>
            `<li><b>[${i.kind}]</b> ${i.message}` +
            (i.point ? ` <code>(${i.point.x.toFixed(3)}, ${i.point.y.toFixed(3)})</code>` : '') +
            `</li>`,
        )
        .join('') +
      '</ul>';
    return;
  }
  const r = state.result!;
  const comps = r.components
    .map(
      (c, i) =>
        `<li>组件 ${i + 1}：外环 ${c.filter((l) => l.role === 'outer').length}，` +
        `孔洞 ${c.filter((l) => l.role === 'hole').length}（环 id: ${c.map((l) => l.id).join(', ')}）</li>`,
    )
    .join('');
  report.innerHTML = `
    <div class="ok">校验通过。距离 ${r.params.distance}，角型 ${r.params.join}</div>
    <ul>
      <li>实体组件：${r.components.length}（拆分即新连通关系）</li>
      <li>外环 ${r.stats.outerCount}，孔洞 ${r.stats.holeCount}，删除/新增细片 ${r.stats.sliverCount}</li>
      <li>删除材料面积 ${r.stats.removedArea.toFixed(3)}，新增材料面积 ${r.stats.addedArea.toFixed(3)}</li>
    </ul>
    <ul>${comps}</ul>`;
}

function syncControls(): void {
  (document.getElementById('distance') as HTMLInputElement).value = String(state.params.distance);
  (document.getElementById('distance-val') as HTMLElement).textContent = String(state.params.distance);
  (document.getElementById('join') as HTMLSelectElement).value = state.params.join;
  (document.getElementById('miter') as HTMLInputElement).value = String(state.params.miterLimit);
  (document.getElementById('arc') as HTMLInputElement).value = String(state.params.arcTolerance);
  (document.getElementById('example') as HTMLSelectElement).value = state.input.name;
}

function download(filename: string, content: Blob): void {
  const url = URL.createObjectURL(content);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** 当前单距离结果导出 PNG（浏览器原生编码，与 Node 端共用同一绘制函数）。 */
function exportPng(): void {
  canvas.toBlob((blob) => {
    if (blob) download(`${state.input.name}-d${state.params.distance}.png`, blob);
  }, 'image/png');
}

/** 一组距离的稳定 JSON：同输入同参数字节一致，可用于核对坐标。 */
function exportJson(): void {
  const distances = state.batchDistances;
  const info = describeInputs(state.input.loops);
  const runs = distances.map((distance) => {
    const params: OffsetParams = { ...state.params, distance };
    return { params, result: offsetContours(state.input.loops, params) };
  });
  const payload = buildBatchExport(
    state.input,
    info,
    state.validation!,
    runs,
    '2026-01-01T00:00:00.000Z',
  );
  download(`${state.input.name}-results.json`, new Blob([stableStringify(payload)], { type: 'application/json' }));
}

/** 批处理：把多个距离的预览各渲染一次并打包成多文件下载（逐个 PNG）。 */
function exportBatchPng(): void {
  const saved = state.params.distance;
  for (const distance of state.batchDistances) {
    state.params.distance = distance;
    recompute();
    canvas.toBlob((blob) => {
      if (blob) download(`${state.input.name}-d${distance}.png`, blob);
    }, 'image/png');
  }
  state.params.distance = saved;
  recompute();
}

function loadExample(name: string): void {
  const ex = EXAMPLES.find((e) => e.input.name === name);
  if (!ex) return;
  pushUndo();
  state.input = structuredClone(ex.input);
  state.batchDistances = [...ex.distances];
  (document.getElementById('batch') as HTMLInputElement).value = ex.distances.join(',');
  recompute();
}

/** 从文本框载入自定义轮廓 JSON：{ name, loops: [[{x,y},...]] }。 */
function loadCustomJson(): void {
  const text = (document.getElementById('json-input') as HTMLTextAreaElement).value;
  try {
    const parsed = JSON.parse(text) as ContourInput;
    if (!parsed.loops || !Array.isArray(parsed.loops)) throw new Error('缺少 loops 数组');
    pushUndo();
    state.input = parsed;
    recompute();
  } catch (e) {
    alert(`JSON 解析失败：${(e as Error).message}`);
  }
}

function bind(): void {
  document.getElementById('distance')!.addEventListener('input', (e) => {
    pushUndo();
    state.params.distance = Number((e.target as HTMLInputElement).value);
    (document.getElementById('distance-val')!).textContent = String(state.params.distance);
    recompute();
  });
  document.getElementById('join')!.addEventListener('change', (e) => {
    pushUndo();
    state.params.join = (e.target as HTMLSelectElement).value as JoinKind;
    recompute();
  });
  document.getElementById('miter')!.addEventListener('input', (e) => {
    pushUndo();
    state.params.miterLimit = Number((e.target as HTMLInputElement).value);
    recompute();
  });
  document.getElementById('arc')!.addEventListener('input', (e) => {
    pushUndo();
    state.params.arcTolerance = Number((e.target as HTMLInputElement).value);
    recompute();
  });
  document.getElementById('example')!.addEventListener('change', (e) =>
    loadExample((e.target as HTMLSelectElement).value),
  );
  document.getElementById('batch')!.addEventListener('input', (e) => {
    state.batchDistances = (e.target as HTMLInputElement).value
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
  });
  document.getElementById('btn-undo')!.addEventListener('click', undo);
  document.getElementById('btn-redo')!.addEventListener('click', redo);
  document.getElementById('btn-png')!.addEventListener('click', exportPng);
  document.getElementById('btn-json')!.addEventListener('click', exportJson);
  document.getElementById('btn-batch-png')!.addEventListener('click', exportBatchPng);
  document.getElementById('btn-load-json')!.addEventListener('click', loadCustomJson);

  for (const opt of ['showOriginal', 'showResult', 'showSlivers', 'showIssues', 'showLabels', 'showOrientation']) {
    document.getElementById(opt)!.addEventListener('change', (e) => {
      (state.scene as Record<string, boolean>)[opt] = (e.target as HTMLInputElement).checked;
      render();
    });
  }

  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
  });
}

function init(): void {
  const sel = document.getElementById('example') as HTMLSelectElement;
  sel.innerHTML = EXAMPLES.map((e) => `<option value="${e.input.name}">${e.input.name}</option>`).join('');
  (document.getElementById('json-input') as HTMLTextAreaElement).value = JSON.stringify(
    EXAMPLES[0].input,
    null,
    2,
  );
  (document.getElementById('batch') as HTMLInputElement).value = state.batchDistances.join(',');
  bind();
  syncControls();
  recompute();
}

init();
