import { simulate } from '../src/core/sim.ts';
import { frameAround, frameIndexAt, sampleAt, buildLegs, buildTimeline, progressAt } from '../src/core/replay.ts';
import { compareRuns } from '../src/core/compare.ts';
import { validateLevel, validatePlan, normalizePlan, clampSheet, normalizeHeading } from '../src/core/level.ts';
import { upcomingChanges, zoneWinds } from '../src/core/wind.ts';
import { LEVELS } from '../src/levels/index.ts';
import { STARTER_PLANS } from '../src/levels/plans.ts';
import { bearingToCanvasAngle, bearingToVector } from '../src/core/math.ts';
import { computeViewport, hitTest, renderScene, screenToWorld, worldToScreen } from './render.ts';
import { previewTrajectory, predictCrossings } from '../src/core/prediction.ts';
import { commandAt } from '../src/core/command.ts';
import type { CoursePlan, EditableCommand, Level, RunRecord, Vec2 } from '../src/core/types.ts';

/* ------------------------------------------------------------------ */
/* 应用状态                                                            */
/* ------------------------------------------------------------------ */

interface AppState {
  level: Level;
  /** 玩家编辑中的航线（暂停区）。执行前不会影响任何记录。 */
  draft: CoursePlan;
  /** 当前记录；null 表示尚未执行。 */
  record: RunRecord | null;
  /** 已保存为基线的记录。 */
  baseline: RunRecord | null;
  /** 基线对应的关卡快照（用于区分关卡变化）。 */
  baselineLevel: Level | null;
  /** 回放时刻（秒）；只在 record 存在时有意义。 */
  playhead: number;
  playing: boolean;
  speed: number;
  refreshRate: number;
  /** 上次动画帧的时间戳，用于墙钟推进。 */
  lastTimestamp: number | null;
  showPrediction: boolean;
  showZones: boolean;
  showLabels: boolean;
  hoveredGate: string | null;
  hoveredObstacle: string | null;
  pointer: Vec2 | null;
  compareText: string | null;
  /** 选中的控制点索引（同步高亮到画布）。 */
  selectedCommand: number | null;
}

const REFRESH_OPTIONS = [30, 60, 120, 144];

function initialDraft(level: Level): CoursePlan {
  const starter = STARTER_PLANS[level.id];
  return starter
    ? { version: 1, levelId: level.id, commands: starter.commands.map((command) => ({ ...command })) }
    : { version: 1, levelId: level.id, commands: [] };
}

const state: AppState = {
  level: LEVELS[0]!,
  draft: initialDraft(LEVELS[0]!),
  record: null,
  baseline: null,
  baselineLevel: null,
  playhead: 0,
  playing: false,
  speed: 1,
  refreshRate: 60,
  lastTimestamp: null,
  showPrediction: true,
  showZones: true,
  showLabels: true,
  hoveredGate: null,
  hoveredObstacle: null,
  pointer: null,
  compareText: null,
  selectedCommand: null,
};

/* ------------------------------------------------------------------ */
/* DOM 引用                                                            */
/* ------------------------------------------------------------------ */

const canvas = requireElement<HTMLCanvasElement>('#scene');
const context = canvas.getContext('2d');
const levelSwitch = requireElement<HTMLDivElement>('#level-switch');
const hud = requireElement<HTMLDivElement>('#hud');
const eventsList = requireElement<HTMLUListElement>('#events');
const planBody = requireElement<HTMLTableSectionElement>('#plan-body');
const recordsPanel = requireElement<HTMLDivElement>('#records');
const comparePanel = requireElement<HTMLDivElement>('#compare');
const levelInfo = requireElement<HTMLDivElement>('#level-info');
const briefing = requireElement<HTMLUListElement>('#briefing');
const windNow = requireElement<HTMLDivElement>('#wind-now');
const windChanges = requireElement<HTMLDivElement>('#wind-changes');
const levelHash = requireElement<HTMLSpanElement>('#level-hash');
const planHash = requireElement<HTMLSpanElement>('#plan-hash');
const timeline = requireElement<HTMLInputElement>('#timeline');
const timelineCurrent = requireElement<HTMLSpanElement>('#timeline-current');
const timelineTotal = requireElement<HTMLSpanElement>('#timeline-total');
const btnPlay = requireElement<HTMLButtonElement>('#btn-play');
const btnPause = requireElement<HTMLButtonElement>('#btn-pause');
const btnRestart = requireElement<HTMLButtonElement>('#btn-restart');
const btnClear = requireElement<HTMLButtonElement>('#btn-clear');
const btnAdd = requireElement<HTMLButtonElement>('#btn-add');
const newTime = requireElement<HTMLInputElement>('#new-time');
const newHeading = requireElement<HTMLInputElement>('#new-heading');
const newSheet = requireElement<HTMLInputElement>('#new-sheet');
const newSheetValue = requireElement<HTMLOutputElement>('#new-sheet-value');
const btnResetPlan = requireElement<HTMLButtonElement>('#btn-reset-plan');
const btnExportPlan = requireElement<HTMLButtonElement>('#btn-export-plan');
const btnImportPlan = requireElement<HTMLButtonElement>('#btn-import-plan');
const btnSaveRun = requireElement<HTMLButtonElement>('#btn-save-run');
const btnCompare = requireElement<HTMLButtonElement>('#btn-compare');
const refreshSelect = requireElement<HTMLSelectElement>('#refresh-rate');
const speedSelect = requireElement<HTMLSelectElement>('#speed');

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`缺少元素 ${selector}`);
  return element;
}

/* ------------------------------------------------------------------ */
/* 初始化                                                              */
/* ------------------------------------------------------------------ */

buildLevelSwitch();
bindControls();
resetLevelView();
refreshAll();
requestAnimationFrame(loop);

function buildLevelSwitch(): void {
  levelSwitch.replaceChildren();
  for (const level of LEVELS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = level.name;
    button.dataset.levelId = level.id;
    button.addEventListener('click', () => selectLevel(level.id));
    levelSwitch.append(button);
  }
}

function selectLevel(id: string): void {
  const level = LEVELS.find((item) => item.id === id);
  if (!level) return;
  state.level = level;
  state.draft = initialDraft(level);
  state.record = null;
  state.playhead = 0;
  state.playing = false;
  state.selectedCommand = null;
  state.compareText = null;
  resetLevelView();
  refreshAll();
}

function resetLevelView(): void {
  newTime.value = '0';
  newHeading.value = '90';
  newSheet.value = '1';
  newSheetValue.value = '1.00';
}

function bindControls(): void {
  refreshSelect.addEventListener('change', () => {
    state.refreshRate = Number(refreshSelect.value);
    // 刷新率只影响“墙钟 → 关卡时间”的推进节奏；仿真始终按固定步长。
    renderCanvas();
  });
  speedSelect.addEventListener('change', () => {
    state.speed = Number(speedSelect.value);
  });

  btnPlay.addEventListener('click', () => startExecution());
  btnPause.addEventListener('click', () => {
    if (!state.record) return;
    state.playing = !state.playing;
    state.lastTimestamp = null;
    updatePlaybackButtons();
  });
  btnRestart.addEventListener('click', () => {
    if (!state.record) return;
    state.playhead = 0;
    state.playing = false;
    updatePlaybackButtons();
    renderCanvas();
    refreshHud();
    refreshEvents();
  });
  btnClear.addEventListener('click', () => {
    state.record = null;
    state.playhead = 0;
    state.playing = false;
    state.compareText = null;
    refreshAll();
  });

  newSheet.addEventListener('input', () => {
    newSheetValue.value = Number(newSheet.value).toFixed(2);
  });
  btnAdd.addEventListener('click', () => {
    const time = clampNumber(Number(newTime.value), 0, state.level.duration);
    const heading = normalizeHeading(Number(newHeading.value));
    const sheet = clampSheet(Number(newSheet.value));
    addCommand(time, heading, sheet);
    refreshAll();
  });

  btnResetPlan.addEventListener('click', () => {
    state.draft = initialDraft(state.level);
    state.selectedCommand = null;
    refreshAll();
  });
  btnExportPlan.addEventListener('click', () => {
    const text = JSON.stringify(normalizePlan(state.draft), null, 2);
    void navigator.clipboard?.writeText(text).catch(() => undefined);
    window.prompt('航线 JSON（已尝试复制到剪贴板）', text);
  });
  btnImportPlan.addEventListener('click', () => {
    const text = window.prompt('粘贴航线 JSON');
    if (!text) return;
    importPlanText(text);
  });

  btnSaveRun.addEventListener('click', () => {
    if (!state.record) return;
    state.baseline = state.record;
    state.baselineLevel = state.level;
    refreshRecords();
  });
  btnCompare.addEventListener('click', () => {
    if (!state.record || !state.baseline || !state.baselineLevel) {
      state.compareText = '需要先执行一次航线，并把某次记录保存为基线。';
      refreshCompare();
      return;
    }
    const comparison = compareRuns(state.baselineLevel, state.level, state.baseline, state.record);
    state.compareText = formatComparison(comparison);
    refreshCompare(comparison);
  });

  timeline.addEventListener('input', () => {
    if (!state.record) return;
    const ratio = Number(timeline.value);
    state.playhead = Math.min(state.record.summary.finishTime, ratio * state.record.summary.finishTime);
    state.playing = false;
    renderCanvas();
    refreshHud();
    refreshEvents();
    updateTimelineLabels();
  });

  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    const point = {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
    const viewport = computeViewport(state.level, canvas.width, canvas.height);
    const hit = hitTest(state.level, viewport, point);
    const changed = hit.gate !== state.hoveredGate || hit.obstacle !== state.hoveredObstacle;
    state.hoveredGate = hit.gate;
    state.hoveredObstacle = hit.obstacle;
    state.pointer = screenToWorld(viewport, point);
    if (changed) renderCanvas();
  });
  canvas.addEventListener('mouseleave', () => {
    state.pointer = null;
    state.hoveredGate = null;
    state.hoveredObstacle = null;
    renderCanvas();
  });
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/* ------------------------------------------------------------------ */
/* 航线编辑                                                            */
/* ------------------------------------------------------------------ */

function editableCommands(): EditableCommand[] {
  return normalizePlan(state.draft).commands.map((command, index) => ({
    ...command,
    key: `command-${index}-${command.time}`,
  }));
}

function addCommand(time: number, heading: number, sheet: number): void {
  const commands = [...state.draft.commands, { time, heading, sheet }];
  state.draft = { version: 1, levelId: state.level.id, commands };
  state.selectedCommand = null;
}

function updateCommand(index: number, patch: Partial<{ time: number; heading: number; sheet: number }>): void {
  const commands = normalizePlan(state.draft).commands.map((command, commandIndex) =>
    commandIndex === index ? { ...command, ...patch } : command,
  );
  state.draft = { version: 1, levelId: state.level.id, commands };
}

function removeCommand(index: number): void {
  const commands = normalizePlan(state.draft).commands.filter((_, commandIndex) => commandIndex !== index);
  state.draft = { version: 1, levelId: state.level.id, commands };
}

function importPlanText(text: string): void {
  try {
    const parsed = JSON.parse(text) as CoursePlan;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.commands)) {
      window.alert('不是有效的航线 JSON');
      return;
    }
    state.draft = normalizePlan({
      version: 1,
      levelId: state.level.id,
      commands: parsed.commands.map((command) => ({
        time: Number(command.time),
        heading: Number(command.heading),
        sheet: Number(command.sheet),
      })),
    });
    refreshAll();
  } catch (error) {
    window.alert(`解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 执行与回放                                                          */
/* ------------------------------------------------------------------ */

function startExecution(): void {
  const validation = validatePlan(state.level, state.draft);
  if (!validation.ok) {
    window.alert(`航线无法执行：\n${validation.errors.join('\n')}`);
    return;
  }
  // 仿真在按钮按下时一次性算完；之后所有播放都只是在记录上滑动。
  // 因此刷新率与倍速不可能改变过标顺序或事件时刻。
  state.record = simulate(state.level, normalizePlan(state.draft), { maxSteps: 900_000 });
  state.playhead = 0;
  state.playing = true;
  state.lastTimestamp = null;
  state.compareText = null;
  refreshAll();
}

function loop(timestamp: number): void {
  if (state.playing && state.record) {
    if (state.lastTimestamp === null) state.lastTimestamp = timestamp;
    const wallDelta = Math.min(0.25, (timestamp - state.lastTimestamp) / 1000);
    state.lastTimestamp = timestamp;
    state.playhead = Math.min(
      state.record.summary.finishTime,
      state.playhead + wallDelta * state.speed,
    );
    if (state.playhead >= state.record.summary.finishTime) {
      state.playing = false;
      updatePlaybackButtons();
    }
    renderCanvas();
    refreshHud();
    refreshEvents();
    updateTimelineLabels();
  }
  requestAnimationFrame(loop);
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function renderCanvas(): void {
  const viewport = computeViewport(state.level, canvas.width, canvas.height);
  void viewport;

  const currentFrame = currentDisplayFrame();
  const trail = buildTrail();
  const prediction = state.showPrediction ? buildPrediction() : [];
  const events = buildEventMarkers();

  renderScene(
    context,
    {
      level: state.level,
      frame: currentFrame,
      trail,
      predicted: prediction,
      selectedCommand: null,
      progress: state.record ? progressAt(state.record, state.playhead) : 0,
      events,
      time: state.record ? state.playhead : 0,
      showPrediction: state.showPrediction,
      showZones: state.showZones,
      showLabels: state.showLabels,
      hoveredGate: state.hoveredGate,
      hoveredObstacle: state.hoveredObstacle,
      pointer: state.pointer,
    },
    canvas.width,
    canvas.height,
  );
}

function currentDisplayFrame(): RunRecord['frames'][number] | null {
  if (state.record) return sampleAt(state.record, state.playhead);
  // 尚未执行：显示起点姿态，便于玩家在编辑时看清初始状态。
  const command = commandAt(state.level, state.draft, 0);
  return {
    time: 0,
    position: state.level.start.position,
    heading: state.level.start.heading,
    track: state.level.start.heading,
    speed: state.level.start.speed,
    sheet: state.level.start.sheet,
    windSpeed: 0,
    windDirection: 0,
    zoneId: null,
    zoneName: '',
  };
  void command;
}

function buildTrail(): Vec2[] {
  const record = state.record;
  if (!record) return [];
  const tail = [];
  const lastIndex = frameIndexAt(record, state.playhead);
  for (let index = 0; index <= lastIndex; index++) {
    const frame = record.frames[index];
    if (frame) tail.push(frame.position);
  }
  const current = sampleAt(record, state.playhead);
  tail.push(current.position);
  return tail;
}

function buildPrediction(): Vec2[] {
  // 预计航迹：从当前显示时刻的船位出发，用同一套运动学和风场往后推演。
  const record = state.record;
  if (record) {
    const current = sampleAt(record, state.playhead);
    const preview = previewTrajectory(state.level, record.plan, {
      fromTime: state.playhead,
      fromState: {
        position: current.position,
        heading: current.heading,
        speed: current.speed,
        sheet: current.sheet,
      },
      sampleEvery: 0.4,
      horizon: Math.max(0, state.level.duration - state.playhead),
    });
    return preview.map((frame) => frame.position);
  }
  const preview = previewTrajectory(state.level, state.draft, { sampleEvery: 0.6 });
  return preview.map((frame) => frame.position);
}

function buildEventMarkers(): Array<{ kind: 'gate' | 'issue' | 'dock'; time: number; position: Vec2; label: string }> {
  const record = state.record;
  const markers: Array<{ kind: 'gate' | 'issue' | 'dock'; time: number; position: Vec2; label: string }> = [];
  if (!record) return markers;
  for (const crossing of record.summary.crossings) {
    if (crossing.time > state.playhead + 1e-9) continue;
    markers.push({
      kind: 'gate',
      time: crossing.time,
      position: crossing.position,
      label: crossing.order > 0 ? `浮标 ${crossing.order}` : '非次序过标',
    });
  }
  for (const issue of record.summary.issues) {
    if (issue.time > state.playhead + 1e-9) continue;
    markers.push({ kind: 'issue', time: issue.time, position: issue.position, label: issue.message });
  }
  if (record.summary.outcome === 'docked' && record.summary.finishTime <= state.playhead + 1e-9) {
    markers.push({
      kind: 'dock',
      time: record.summary.finishTime,
      position: record.summary.finalPosition,
      label: '靠泊',
    });
  }
  return markers;
}

/* ------------------------------------------------------------------ */
/* 侧栏刷新                                                            */
/* ------------------------------------------------------------------ */

function refreshAll(): void {
  refreshLevelSwitchActive();
  refreshLevelInfo();
  refreshPlanTable();
  refreshPlanHash();
  refreshRecords();
  refreshCompare();
  refreshHud();
  refreshEvents();
  refreshWind();
  refreshPlayback();
  updateTimelineLabels();
  renderCanvas();
}

function refreshLevelSwitchActive(): void {
  for (const button of levelSwitch.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.levelId === state.level.id);
  }
}

function refreshLevelInfo(): void {
  const validation = validateLevel(state.level);
  levelHash.textContent = validation.ok ? `关卡 ${shortHash(state.level.id)}` : '关卡配置有误';
  levelInfo.replaceChildren();
  const summary = document.createElement('div');
  summary.innerHTML = `<strong>${state.level.name}</strong> · ${state.level.subtitle}`;
  levelInfo.append(summary);

  const stats = document.createElement('div');
  const zones = state.level.windZones.length;
  stats.textContent = `时长 ${state.level.duration}s · ${state.level.route.length} 个浮标 · ${zones} 个风区 · ${state.level.obstacles.length} 处障碍`;
  levelInfo.append(stats);

  briefing.replaceChildren();
  for (const line of state.level.briefing) {
    const item = document.createElement('li');
    item.textContent = line;
    briefing.append(item);
  }
}

function refreshPlanTable(): void {
  const commands = editableCommands();
  planBody.replaceChildren();
  if (commands.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.textContent = '还没有控制点：小艇会保持初始航向与帆位直到关卡结束。';
    row.append(cell);
    planBody.append(row);
    return;
  }

  for (let index = 0; index < commands.length; index++) {
    const command = commands[index]!;
    const row = document.createElement('tr');
    if (state.selectedCommand === index) row.classList.add('active');

    const number = document.createElement('td');
    number.textContent = String(index + 1);
    row.append(number);

    const timeCell = document.createElement('td');
    const timeInput = document.createElement('input');
    timeInput.type = 'number';
    timeInput.min = '0';
    timeInput.max = String(state.level.duration);
    timeInput.step = '0.25';
    timeInput.value = String(command.time);
    timeInput.addEventListener('change', () => {
      updateCommand(index, { time: Number(timeInput.value) });
      refreshAll();
    });
    timeCell.append(timeInput);
    row.append(timeCell);

    const headingCell = document.createElement('td');
    const headingInput = document.createElement('input');
    headingInput.type = 'number';
    headingInput.min = '0';
    headingInput.max = '359';
    headingInput.step = '1';
    headingInput.value = String(Math.round(command.heading));
    headingInput.addEventListener('change', () => {
      updateCommand(index, { heading: Number(headingInput.value) });
      refreshAll();
    });
    headingCell.append(headingInput);
    row.append(headingCell);

    const sheetCell = document.createElement('td');
    const sheetWrap = document.createElement('div');
    const sheetInput = document.createElement('input');
    sheetInput.type = 'range';
    sheetInput.min = '0';
    sheetInput.max = '1';
    sheetInput.step = '0.01';
    sheetInput.value = String(command.sheet);
    const sheetValue = document.createElement('span');
    sheetValue.className = 'sheet-value';
    sheetValue.textContent = command.sheet.toFixed(2);
    sheetInput.addEventListener('input', () => {
      sheetValue.textContent = Number(sheetInput.value).toFixed(2);
    });
    sheetInput.addEventListener('change', () => {
      updateCommand(index, { sheet: Number(sheetInput.value) });
      refreshAll();
    });
    sheetWrap.append(sheetInput, sheetValue);
    sheetCell.append(sheetWrap);
    row.append(sheetCell);

    const actions = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'del';
    remove.textContent = '×';
    remove.title = '删除该控制点';
    remove.addEventListener('click', () => {
      removeCommand(index);
      state.selectedCommand = null;
      refreshAll();
    });
    actions.append(remove);
    row.append(actions);

    planBody.append(row);
  }
}

function refreshPlanHash(): void {
  const normalized = normalizePlan(state.draft);
  planHash.textContent = `${normalized.commands.length} 条 · ${shortHash(JSON.stringify(normalized.commands))}`;
}

function refreshRecords(): void {
  recordsPanel.replaceChildren();
  if (state.record) {
    recordsPanel.append(recordCard('当前记录', state.record));
  }
  if (state.baseline) {
    recordsPanel.append(recordCard('基线记录', state.baseline));
  }
  if (!state.record && !state.baseline) {
    const empty = document.createElement('div');
    empty.textContent = '还没有记录：编排航线后点“执行航线”。';
    recordsPanel.append(empty);
  }
}

function recordCard(label: string, record: RunRecord): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'record';
  const title = document.createElement('b');
  title.textContent = `${label} · ${outcomeText(record.summary.outcome)}`;
  card.append(title);

  const detail = document.createElement('div');
  detail.textContent =
    `过标 ${record.summary.routeProgress}/${state.level.route.length} · 结束 ${record.summary.finishTime.toFixed(2)}s · ` +
    `指令 ${record.commandHash} · 关卡 ${record.levelHash}`;
  card.append(detail);

  const legs = buildLegs(record);
  if (legs.length > 0) {
    const legRow = document.createElement('div');
    legRow.style.marginTop = '4px';
    legRow.textContent = `航段：${legs.map((leg) => `${leg.startTime.toFixed(1)}–${leg.endTime.toFixed(1)}s`).join(' / ')}`;
    card.append(legRow);
  }
  return card;
}

function refreshCompare(comparison?: ReturnType<typeof compareRuns>): void {
  comparePanel.replaceChildren();
  if (!comparison) {
    if (state.compareText) {
      const text = document.createElement('div');
      text.textContent = state.compareText;
      comparePanel.append(text);
    }
    return;
  }
  const head = document.createElement('div');
  const causeLabel =
    comparison.cause === 'level'
      ? '差异来自关卡变化'
      : comparison.cause === 'plan'
        ? '差异来自玩家修改'
        : comparison.cause === 'both'
          ? '关卡与玩家修改都变了'
          : '没有变化';
  head.innerHTML = `<span class="cause">${causeLabel}</span>`;
  comparePanel.append(head);

  if (comparison.levelFields.length > 0) {
    const line = document.createElement('div');
    line.textContent = `关卡字段变化：${comparison.levelFields.join('、')}`;
    comparePanel.append(line);
  }

  const changes = document.createElement('ul');
  changes.className = 'change-list';
  const rows: string[] = [];
  for (const change of comparison.commandChanges) {
    if (change.kind === 'changed') {
      rows.push(`指令 #${change.time}s 的${fieldLabel(change.field)}：${formatValue(change.before)} → ${formatValue(change.after)}`);
    } else if (change.kind === 'added') {
      rows.push(`新增控制点（${formatValue(change.after)}）`);
    } else {
      rows.push(`删除控制点（${formatValue(change.before)}）`);
    }
  }
  for (const row of comparison.resultChanges) rows.push(row);

  for (const row of rows) {
    const item = document.createElement('li');
    item.textContent = row;
    changes.append(item);
  }
  comparePanel.append(changes);

  if (comparison.firstDivergence) {
    const divergence = document.createElement('div');
    divergence.style.marginTop = '6px';
    divergence.textContent = `首个分歧点：${comparison.firstDivergence}`;
    comparePanel.append(divergence);
  }
}

function fieldLabel(field: 'time' | 'heading' | 'sheet' | undefined): string {
  if (field === 'time') return '时间';
  if (field === 'heading') return '航向';
  if (field === 'sheet') return '收帆点';
  return '字段';
}

function formatValue(value: number | undefined): string {
  return value === undefined ? '—' : String(value);
}

function refreshHud(): void {
  const frame = currentDisplayFrame();
  hud.replaceChildren();
  const heading = document.createElement('h3');
  heading.textContent = '当前状态';
  hud.append(heading);

  if (!frame) return;
  const rows: Array<[string, string]> = [
    ['关卡时间', `${(state.record ? state.playhead : 0).toFixed(2)} s`],
    ['航向', `${Math.round(frame.heading)}°`],
    ['航迹', `${Math.round(frame.track)}°`],
    ['艇速', `${frame.speed.toFixed(2)} m/s`],
    ['收帆点', frame.sheet.toFixed(2)],
    ['风', `${Math.round(frame.windDirection)}° · ${frame.windSpeed.toFixed(1)} m/s`],
    ['风区', frame.zoneName || '—'],
  ];
  if (state.record) {
    rows.push(['已通过浮标', `${progressAt(state.record, state.playhead)} / ${state.level.route.length}`]);
    rows.push(['预计结束', `${state.record.summary.finishTime.toFixed(1)} s`]);
  }
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.textContent = label;
    const content = document.createElement('b');
    content.textContent = value;
    row.append(name, content);
    hud.append(row);
  }
}

function refreshEvents(): void {
  eventsList.replaceChildren();
  const record = state.record;
  if (!record) {
    const empty = document.createElement('li');
    empty.textContent = '执行航线后，这里会列出过标、擦碰、超速与靠泊事件。';
    eventsList.append(empty);
    return;
  }
  const timelineEvents = buildTimeline(record, upcomingWindLabels());
  for (const event of timelineEvents) {
    if (event.time > state.playhead + 1e-9 && event.kind !== 'wind') continue;
    const item = document.createElement('li');
    const time = document.createElement('span');
    time.className = 't';
    time.textContent = `${event.time.toFixed(2)}s`;
    const label = document.createElement('span');
    label.className = event.kind === 'issue' ? 'bad' : event.kind === 'gate' || event.kind === 'dock' ? 'ok' : '';
    label.textContent = event.label;
    item.append(time, label);
    eventsList.append(item);
  }
  if (record.summary.issues.length === 0 && record.summary.outcome === 'docked') {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'ok';
    label.textContent = `全部完成 · 进港速度 ${(record.summary.dockSpeed ?? 0).toFixed(2)} m/s`;
    item.append(label);
    eventsList.append(item);
  }
}

function upcomingWindLabels(): Array<{ time: number; label: string }> {
  const changes = upcomingChanges(state.level, 0);
  return changes.map((change) => ({
    time: change.time,
    label: `风变：${change.zoneLabel} ${Math.round(change.direction)}° ${change.speed.toFixed(1)} m/s`,
  }));
}

function refreshWind(): void {
  const time = state.record ? state.playhead : 0;
  const zones = zoneWinds(state.level, time);
  windNow.replaceChildren();
  for (const zone of zones) {
    const cell = document.createElement('div');
    const name = document.createElement('span');
    name.textContent = zone.zoneName;
    const value = document.createElement('b');
    value.textContent = `${Math.round(zone.wind.direction)}° · ${zone.wind.speed.toFixed(1)} m/s`;
    cell.append(name, value);
    windNow.append(cell);
  }

  windChanges.replaceChildren();
  const upcoming = upcomingChanges(state.level, time);
  const past = state.level.windChanges
    .filter((change) => change.time <= time)
    .map((change) => ({
      time: change.time,
      zoneLabel:
        change.zoneId === null
          ? '全部水域'
          : change.zoneId === 'open'
            ? '开阔水域'
            : state.level.windZones.find((zone) => zone.id === change.zoneId)?.name ?? change.zoneId,
      direction: change.direction,
      speed: change.speed,
      note: change.note,
      future: false,
    }))
    .sort((a, b) => b.time - a.time);

  for (const change of [...past.slice(0, 2), ...upcoming]) {
    const row = document.createElement('div');
    row.className = 'change';
    if (change.time > time) row.classList.add('future');
    else row.classList.add('past');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = `${change.time.toFixed(0)}s`;
    const text = document.createElement('span');
    text.textContent = `${change.zoneLabel} ${Math.round(change.direction)}° ${change.speed.toFixed(1)} m/s${change.note ? `（${change.note}）` : ''}`;
    row.append(t, text);
    windChanges.append(row);
  }
}

function refreshPlayback(): void {
  const hasRecord = Boolean(state.record);
  timeline.disabled = !hasRecord;
  btnPlay.textContent = hasRecord ? '重跑当前航线' : '执行航线';
  btnPlay.disabled = false;
  btnPause.disabled = !hasRecord;
  btnRestart.disabled = !hasRecord;
  updatePlaybackButtons();
}

function updatePlaybackButtons(): void {
  btnPause.textContent = state.playing ? '暂停' : '继续';
  btnPause.disabled = !state.record || state.record.summary.finishTime <= 0;
}

function updateTimelineLabels(): void {
  const total = state.record?.summary.finishTime ?? 0;
  timelineCurrent.textContent = `${(state.record ? state.playhead : 0).toFixed(2)}s`;
  timelineTotal.textContent = `${total.toFixed(2)}s`;
  timeline.max = String(Math.max(0.001, total));
  timeline.value = String(Math.max(0, Math.min(total, state.record ? state.playhead : 0)));
  if (state.record) {
    for (const leg of buildLegs(state.record)) {
      if (state.playhead >= leg.startTime && state.playhead <= leg.endTime) {
        timeline.title = leg.label;
        break;
      }
    }
  }
}

function outcomeText(outcome: RunRecord['summary']['outcome']): string {
  if (outcome === 'docked') return '靠泊成功';
  if (outcome === 'failed') return '航次失败';
  return '超时未完成';
}

function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

function formatComparison(comparison: ReturnType<typeof compareRuns>): string {
  const cause =
    comparison.cause === 'level'
      ? '差异来自关卡变化'
      : comparison.cause === 'plan'
        ? '差异来自玩家修改'
        : comparison.cause === 'both'
          ? '关卡与玩家修改都变了'
          : '没有变化';
  return `${cause}${comparison.firstDivergence ? `：${comparison.firstDivergence}` : ''}`;
}

/* 供调试与自动化测试使用：暴露少量只读操作。 */
declare global {
  interface Window {
    __sailingDebug?: {
      state: () => { levelId: string; playhead: number; hasRecord: boolean; outcome: string | null };
      execute: (plan?: CoursePlan) => RunRecord;
      setPlan: (plan: CoursePlan) => void;
      seek: (time: number) => void;
    };
  }
}

window.__sailingDebug = {
  state: () => ({
    levelId: state.level.id,
    playhead: state.playhead,
    hasRecord: Boolean(state.record),
    outcome: state.record?.summary.outcome ?? null,
  }),
  execute: (plan?: CoursePlan) => {
    if (plan) state.draft = normalizePlan(plan);
    const record = simulate(state.level, normalizePlan(state.draft), { maxSteps: 900_000 });
    state.record = record;
    state.playhead = 0;
    state.playing = false;
    refreshAll();
    return record;
  },
  setPlan: (plan: CoursePlan) => {
    state.draft = normalizePlan(plan);
    refreshAll();
  },
  seek: (time: number) => {
    if (!state.record) return;
    state.playhead = Math.min(state.record.summary.finishTime, Math.max(0, time));
    state.playing = false;
    renderCanvas();
    refreshHud();
    refreshEvents();
    updateTimelineLabels();
  },
};

export { bearingToCanvasAngle, bearingToVector, frameAround, worldToScreen, REFRESH_OPTIONS };
