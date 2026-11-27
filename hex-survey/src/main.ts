/**
 * main.ts — 页面装配与交互。事实源是 currentMap + actions；
 * 任意时刻的局面都由 replay 纯函数推导。
 */

import { HexRenderer } from './render.js';
import {
  applyAction,
  canObserve,
  createSave,
  getMoveOptions,
  initialState,
  parseSave,
  replay,
  serializeSave,
  stateAtPrefix,
  type GameState,
} from './engine.js';
import {
  getStance,
  getStances,
  heightAt,
  obstacleAt,
  validateMap,
  blockTopAt,
} from './mapio.js';
import { computeViewshed, formatT, formatZ, queryLos, type LosResult } from './los.js';
import { solveFrom, type Solution } from './solve.js';
import { hasTile } from './mapio.js';
import type { Action, MapDef } from './types.js';
import type { Axial } from './hex.js';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少页面元素 #${id}`);
  return el as T;
}

const MAP_FILES = ['./maps/open-plain.json', './maps/ridgeline.json'];
const AUTO_PREFIX = 'hex-survey:auto:v1:';
const LAST_KEY = 'hex-survey:last:v1';

/* ---------------- 全局 UI 状态 ---------------- */

let maps: MapDef[] = [];
let currentMap: MapDef | null = null;
let actions: Action[] = [];
let state: GameState | null = null;
let renderer: HexRenderer | null = null;

let stanceId = 'standard';
let mode: 'play' | 'query' = 'play';
let showCoords = false;
let hover: Axial | null = null;
let selected: Axial | null = null;

let queryA: Axial | null = null;
let queryB: Axial | null = null;
let manualLos: LosResult | null = null;
let liveLos: LosResult | null = null;
/** 视线实验室里把整片可视域原点改成任意 A 格；null 表示用勘测员。 */
let customViewOrigin: Axial | null = null;

let hintSolution: Solution | null = null;
let messageTimer: number | undefined;

const replayCtl = {
  active: false,
  index: 0,
  playing: false,
  interval: undefined as number | undefined,
  frame: null as GameState | null,
};

/* ---------------- 启动 ---------------- */

async function boot(): Promise<void> {
  bindStaticEvents();
  try {
    const loaded = await Promise.all(
      MAP_FILES.map(async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
        const v = validateMap(await res.json());
        if (!v.ok || !v.map) throw new Error(v.errors.join('; '));
        return v.map;
      }),
    );
    maps = loaded;
    renderTabs();

    const lastId = localStorage.getItem(LAST_KEY);
    // restoreAutosave 能从存档内嵌地图恢复，包括上次载入的自定义地图。
    if (lastId && restoreAutosave(lastId)) {
      renderTabs();
    } else {
      const lastMap = maps.find((m) => m.id === lastId);
      selectMap(lastMap ?? maps[0], false);
    }
  } catch (e) {
    showFatal(
      `无法通过 fetch 读取内置地图（${(e as Error).message}）。` +
        `如果你是直接双击 index.html（file://）打开的，浏览器会拦截本地 JSON；` +
        `请在 hex-survey 目录运行 <code>npm start</code> 后访问提示的本地地址，` +
        `或用右上角“载入地图 / 读取存档”选择本地 JSON。`,
    );
  }
}

function showFatal(html: string): void {
  const ov = $('overlay');
  ov.hidden = false;
  ov.innerHTML = `<div class="dialog"><div class="big">🛰️</div><h2>等待本地地图</h2><p>${html}</p>
    <div class="row"><button class="btn primary" data-act="dismiss-overlay">知道了</button></div></div>`;
}

/* ---------------- 关卡切换 / 自动存档 ---------------- */

function selectMap(map: MapDef, restoreAuto: boolean): void {
  stopReplay();
  currentMap = map;
  let restored = false;
  if (restoreAuto) restored = restoreAutosave(map.id);
  if (!restored) {
    actions = [];
    state = initialState(map);
  }
  stanceId = getStances(map)[0].id;
  selected = null;
  queryA = null;
  queryB = null;
  manualLos = null;
  liveLos = null;
  customViewOrigin = null;
  viewCache.key = '';
  hintSolution = null;
  $('autoNote').hidden = !restored;

  if (!renderer) {
    renderer = new HexRenderer($<HTMLCanvasElement>('game'), map);
    renderer.resize();
  } else {
    renderer.setMap(map);
  }
  localStorage.setItem(LAST_KEY, map.id);
  renderTabs();
  renderAll();
}

function restoreAutosave(mapId: string): boolean {
  const text = localStorage.getItem(AUTO_PREFIX + mapId);
  if (!text) return false;
  const parsed = parseSave(text);
  if (!parsed.ok || !parsed.save) return false;
  applyLoadedSave(parsed.save.map, parsed.save.actions);
  $('autoNote').hidden = false;
  return true;
}

function saveAutosave(): void {
  if (!currentMap) return;
  try {
    localStorage.setItem(
      AUTO_PREFIX + currentMap.id,
      serializeSave(createSave(currentMap, actions)),
    );
    localStorage.setItem(LAST_KEY, currentMap.id);
  } catch {
    /* 隐私模式等情况下 localStorage 不可用，忽略 */
  }
}

function discardAutosave(): void {
  if (!currentMap) return;
  localStorage.removeItem(AUTO_PREFIX + currentMap.id);
  $('autoNote').hidden = true;
  actions = [];
  state = initialState(currentMap);
  afterStateChange({ persist: false });
  setMessage('已丢弃自动进度，从起点重新开始。', 'ok');
}

function applyLoadedSave(map: MapDef, loaded: Action[]): void {
  currentMap = map;
  if (!maps.some((x) => x.id === map.id)) maps.push(map);
  actions = loaded.map((a) => structuredClone(a));
  state = replay(map, actions);
  stanceId = getStances(map)[0].id;
  selected = null;
  queryA = null;
  queryB = null;
  manualLos = null;
  hintSolution = null;
  customViewOrigin = null;
  viewCache.key = '';
  if (renderer) renderer.setMap(map);
  renderTabs();
  renderAll();
}

/* ---------------- 事件绑定 ---------------- */

function bindStaticEvents(): void {
  const canvas = $<HTMLCanvasElement>('game');

  new ResizeObserver(() => renderer?.resize()).observe($('canvasWrap'));

  canvas.addEventListener('click', (e) => {
    if (!renderer || !currentMap) return;
    const h = renderer.pick(...eventCss(e));
    if (!h) return;
    if (replayCtl.active) {
      setMessage('回放中：请先退出回放再行动。', '');
      return;
    }
    if (mode === 'query') handleQueryClick(h);
    else handlePlayClick(h);
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!renderer || !currentMap || !state) return;
    const h = renderer.pick(...eventCss(e));
    hover = h;
    if (mode === 'query' && queryA && h && !same(h, queryA)) {
      liveLos = queryLos(currentMap, queryA, activeEye(), h);
    } else {
      liveLos = null;
    }
    canvas.style.cursor = cursorFor(h);
  });

  canvas.addEventListener('mouseleave', () => {
    hover = null;
    liveLos = null;
  });

  $('observeBtn').addEventListener('click', doObserve);
  $('btnUndo').addEventListener('click', undo);
  $('btnRestart').addEventListener('click', restart);
  $('btnHint').addEventListener('click', showHint);
  $('btnReplay').addEventListener('click', openReplay);
  $('btnSave').addEventListener('click', saveToFile);
  $('btnLoadSave').addEventListener('click', () => $<HTMLInputElement>('fileSave').click());
  $('btnLoadMap').addEventListener('click', () => $<HTMLInputElement>('fileMap').click());
  $<HTMLInputElement>('fileSave').addEventListener('change', onLoadSaveFile);
  $<HTMLInputElement>('fileMap').addEventListener('change', onLoadMapFile);
  $('btnDiscardAuto').addEventListener('click', discardAutosave);

  $('modePlay').addEventListener('click', () => setMode('play'));
  $('modeQuery').addEventListener('click', () => setMode('query'));
  $<HTMLInputElement>('toggleCoords').addEventListener('change', (e) => {
    showCoords = (e.target as HTMLInputElement).checked;
  });

  $('queryUsePlayer').addEventListener('click', () => {
    if (!state) return;
    setMode('query');
    queryA = { ...state.player };
    queryB = null;
    manualLos = null;
    customViewOrigin = null;
    viewCache.key = '';
    updateViewInfo();
    renderQuery();
  });
  $('queryClear').addEventListener('click', () => {
    queryA = null;
    queryB = null;
    manualLos = null;
    liveLos = null;
    customViewOrigin = null;
    updateViewInfo();
    renderQuery();
  });
  $('queryViewA').addEventListener('click', () => {
    if (!queryA) {
      setMessage('请先在地图上点选一个 A 观测格。', 'error');
      return;
    }
    customViewOrigin = { ...queryA };
    viewCache.key = '';
    updateViewInfo();
    setMessage(`青色区域现在是任意观测格 (${queryA.q},${queryA.r}) 的可视域。`, 'ok');
  });
  $('queryViewPlayer').addEventListener('click', () => {
    customViewOrigin = null;
    viewCache.key = '';
    updateViewInfo();
  });

  $('replayPrev').addEventListener('click', () => stepReplay(-1));
  $('replayNext').addEventListener('click', () => stepReplay(1));
  $('replayPlay').addEventListener('click', toggleReplayPlay);
  $('replayClose').addEventListener('click', closeReplay);
  $<HTMLInputElement>('replayRange').addEventListener('input', (e) => {
    pauseReplay();
    setReplayIndex(Number((e.target as HTMLInputElement).value));
  });
  $<HTMLSelectElement>('replaySpeed').addEventListener('change', () => {
    if (replayCtl.playing) {
      pauseReplay();
      playReplay();
    }
  });

  $('overlay').addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'restart') restart();
    else if (act === 'replay') openReplay();
    else if (act === 'dismiss-overlay') ($('overlay') as HTMLElement).hidden = true;
  });

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    }
  });

  requestAnimationFrame(drawLoop);
}

function eventCss(e: MouseEvent): [number, number] {
  const rect = $<HTMLCanvasElement>('game').getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

function cursorFor(h: Axial | null): string {
  if (!h || !currentMap || !state || replayCtl.active) return 'crosshair';
  if (mode === 'query') return 'pointer';
  const opt = getMoveOptions(currentMap, state).find((o) => same(o.to, h));
  if (opt?.legal) return 'pointer';
  return 'crosshair';
}

/* ---------------- 模式 ---------------- */

function setMode(next: 'play' | 'query'): void {
  mode = next;
  $('modePlay').classList.toggle('active', next === 'play');
  $('modeQuery').classList.toggle('active', next === 'query');
  $('queryCard').hidden = next !== 'query';
  liveLos = null;
  // 走完整 HUD 渲染：查询模式下需要隐藏结算遮罩并刷新检视/查询面板。
  renderHud();
}

/* ---------------- 行动 ---------------- */

function handlePlayClick(h: Axial): void {
  selected = h;
  if (!currentMap || !state) return;
  const opt = getMoveOptions(currentMap, state).find((o) => same(o.to, h));
  if (opt?.legal) {
    commit({ type: 'move', to: { ...h } });
    return;
  }
  if (opt && !opt.legal && opt.reason) setMessage(opt.reason, 'error');
  else if (!hasTile(currentMap, h.q, h.r)) setMessage('那里不在勘测区域内。', 'error');
  renderInspector();
}

function handleQueryClick(h: Axial): void {
  selected = h;
  if (!queryA || (queryA && queryB)) {
    queryA = { ...h };
    queryB = null;
    manualLos = null;
  } else {
    queryB = { ...h };
    manualLos = queryLos(currentMap!, queryA, activeEye(), queryB);
  }
  renderInspector();
  renderQuery();
}

function doObserve(): void {
  if (!currentMap || !state) return;
  if (replayCtl.active) return;
  if (!canObserve(currentMap, state, stanceId)) {
    const cost = getStance(currentMap, stanceId).cost ?? currentMap.costs.observe;
    setMessage(`预算不足：本次观测需要 ${cost}。可撤回几步。`, 'error');
    return;
  }
  commit({ type: 'observe', stanceId });
}

function commit(a: Action): void {
  if (!currentMap || !state) return;
  // 先用纯函数校验/推进，避免把非法行动塞进日志污染重放与撤回。
  try {
    state = applyAction(state, a, currentMap);
  } catch (e) {
    setMessage((e as Error).message, 'error');
    return;
  }
  actions.push(a);
  afterStateChange();
}

function afterStateChange(opts: { persist?: boolean } = {}): void {
  if (!currentMap) return;
  state = replay(currentMap, actions);
  hintSolution = null;
  if (opts.persist !== false) saveAutosave();
  renderAll();
}

function undo(): void {
  if (!currentMap || replayCtl.active) return;
  if (actions.length === 0) {
    setMessage('没有可撤回的行动。', '');
    return;
  }
  const removed = actions.pop()!;
  afterStateChange();
  setMessage(
    removed.type === 'observe' ? '已撤回观测：预算与发现状态一并还原。' : '已撤回移动：预算已还原。',
    'ok',
  );
}

function restart(): void {
  if (!currentMap) return;
  stopReplay();
  actions = [];
  state = initialState(currentMap);
  hintSolution = null;
  queryA = queryB = null;
  manualLos = null;
  afterStateChange();
  setMessage('已重新开始本关。', 'ok');
}

function showHint(): void {
  if (!currentMap || !state || replayCtl.active) return;
  if (state.status === 'won' || state.foundIds.length === currentMap.beacons.length) {
    setMessage('全部信标都已标定，勘测完成！', 'ok');
    return;
  }
  const sol = solveFrom(currentMap, state.player, state.foundIds, state.budgetLeft);
  if (!sol || sol.actions.length === 0) {
    setMessage('剩余预算内已找不到可行方案——试试撤回几步，或重新规划路线。', 'error');
    return;
  }
  hintSolution = sol;
  const first = sol.actions[0];
  if (first.type === 'move') {
    setMessage(`提示：先走到金色高亮格（最优后续总消耗约 ${sol.totalCost}）。`, 'ok');
  } else {
    stanceId = first.stanceId;
    renderStances();
    setMessage(`提示：现在使用「${getStance(currentMap, stanceId).label}」（消耗 ${getStance(currentMap, stanceId).cost ?? currentMap.costs.observe}）。`, 'ok');
    $('observeBtn').classList.add('hint-pulse');
    window.setTimeout(() => $('observeBtn').classList.remove('hint-pulse'), 2600);
  }
  renderAll();
}

/* ---------------- 文件保存 / 读取 ---------------- */

function saveToFile(): void {
  if (!currentMap) return;
  const save = createSave(currentMap, actions);
  const blob = new Blob([serializeSave(save)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hex-survey-${currentMap.id}-${actions.length}步.json`;
  a.click();
  URL.revokeObjectURL(url);
  setMessage('存档已下载（包含地图与完整行动序列，可随时读回重放）。', 'ok');
}

function onLoadSaveFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    const parsed = parseSave(text);
    input.value = '';
    if (!parsed.ok || !parsed.save) {
      window.alert('存档无效：\n' + parsed.errors.join('\n'));
      return;
    }
    stopReplay();
    const m = parsed.save.map;
    if (!maps.some((x) => x.id === m.id)) maps.push(m);
    applyLoadedSave(m, parsed.save.actions);
    saveAutosave();
    setMessage(`已读取存档并完整重放 ${parsed.save.actions.length} 个行动。`, 'ok');
  });
}

function onLoadMapFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    input.value = '';
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      window.alert(`地图 JSON 解析失败：${(err as Error).message}`);
      return;
    }
    const v = validateMap(raw);
    if (!v.ok || !v.map) {
      window.alert('地图校验失败：\n' + v.errors.join('\n'));
      return;
    }
    const m = v.map;
    const idx = maps.findIndex((x) => x.id === m.id);
    if (idx >= 0) maps[idx] = m;
    else maps.push(m);
    selectMap(m, false);
    setMessage(`已载入本地地图「${m.name}」。`, 'ok');
  });
}

/* ---------------- 回放 ---------------- */

function openReplay(): void {
  if (!currentMap || actions.length === 0) {
    setMessage('本局还没有行动，暂无可重放内容。', '');
    return;
  }
  customViewOrigin = null;
  viewCache.key = '';
  replayCtl.active = true;
  $('replayBar').hidden = false;
  setReplayIndex(0);
  playReplay();
  renderAll();
}

function closeReplay(): void {
  stopReplay();
  renderAll();
}

function stopReplay(): void {
  pauseReplay();
  replayCtl.active = false;
  replayCtl.index = 0;
  replayCtl.frame = null;
  const bar = document.getElementById('replayBar');
  if (bar) bar.hidden = true;
  const btn = document.getElementById('replayPlay');
  if (btn) btn.textContent = '▶';
}

function playReplay(): void {
  if (!currentMap) return;
  if (replayCtl.index >= actions.length) setReplayIndex(0);
  replayCtl.playing = true;
  $('replayPlay').textContent = '⏸';
  const speed = Number($<HTMLSelectElement>('replaySpeed').value);
  replayCtl.interval = window.setInterval(() => {
    if (replayCtl.index >= actions.length) {
      pauseReplay();
      return;
    }
    setReplayIndex(replayCtl.index + 1);
  }, speed);
}

function pauseReplay(): void {
  replayCtl.playing = false;
  if (replayCtl.interval !== undefined) window.clearInterval(replayCtl.interval);
  replayCtl.interval = undefined;
  const btn = document.getElementById('replayPlay');
  if (btn) btn.textContent = '▶';
}

function toggleReplayPlay(): void {
  if (replayCtl.playing) pauseReplay();
  else playReplay();
}

function stepReplay(delta: number): void {
  pauseReplay();
  setReplayIndex(Math.max(0, Math.min(actions.length, replayCtl.index + delta)));
}

function setReplayIndex(k: number): void {
  if (!currentMap) return;
  replayCtl.index = k;
  replayCtl.frame = stateAtPrefix(currentMap, actions, k);
  const range = $<HTMLInputElement>('replayRange');
  range.max = String(actions.length);
  range.value = String(k);
  $('replayLabel').textContent = `${k} / ${actions.length}`;
  renderHud();
}

/* ---------------- 派生视图 ---------------- */

function displayState(): GameState | null {
  if (replayCtl.active && replayCtl.frame) return replayCtl.frame;
  return state;
}

function activeEye(): number {
  if (!currentMap) return 2;
  if (replayCtl.active) {
    for (let i = Math.min(replayCtl.index, actions.length) - 1; i >= 0; i--) {
      const a = actions[i];
      if (a.type === 'observe') return getStance(currentMap, a.stanceId).eye;
    }
  }
  return getStance(currentMap, stanceId).eye;
}

/* ---------------- 渲染循环 ---------------- */

function drawLoop(now: number): void {
  requestAnimationFrame(drawLoop);
  if (!renderer || !currentMap || !state) return;
  const ds = displayState();
  if (!ds) return;
  const eye = activeEye();
  const origin = customViewOrigin ?? ds.player;
  const viewKey = `${currentMap.id}|${origin.q},${origin.r}|${eye}`;
  if (viewCache.key !== viewKey || !viewCache.view) {
    viewCache.key = viewKey;
    viewCache.view = computeViewshed(currentMap, origin, eye);
    updateViewInfo(viewCache.view.visible.size, origin);
  }
  const view = viewCache.view;
  const opts =
    !replayCtl.active && mode === 'play' ? getMoveOptions(currentMap, state) : [];
  const hintAction =
    hintSolution && !replayCtl.active ? hintSolution.actions[0] ?? null : null;

  renderer.draw({
    map: currentMap,
    state: ds,
    view,
    moveOptions: opts,
    hover,
    selected,
    mode,
    queryA,
    queryB,
    queryLos: manualLos,
    liveLos,
    hintAction,
    showCoords,
    time: now,
    playerEyeZ: heightAt(currentMap, ds.player.q, ds.player.r) + eye,
  });
}

const viewCache: { key: string; view: ReturnType<typeof computeViewshed> | null } = {
  key: '',
  view: null,
};

/* ---------------- HUD 渲染 ---------------- */

function renderAll(): void {
  renderTabs();
  renderStances();
  renderHud();
}

function renderTabs(): void {
  const wrap = $('levelTabs');
  wrap.innerHTML = '';
  for (const m of maps) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'level-tab' + (currentMap?.id === m.id ? ' active' : '');
    b.textContent = m.name;
    b.addEventListener('click', () => selectMap(m, true));
    wrap.appendChild(b);
  }
}

function renderStances(): void {
  if (!currentMap) return;
  const list = $('stanceList');
  list.innerHTML = '';
  for (const s of getStances(currentMap)) {
    const label = document.createElement('label');
    label.className = 'stance' + (s.id === stanceId ? ' active' : '');
    const cost = s.cost ?? currentMap.costs.observe;
    label.innerHTML = `
      <input type="radio" name="stance" ${s.id === stanceId ? 'checked' : ''} />
      <span>
        <span class="s-label">${s.label}</span><br/>
        <span class="s-desc">${s.desc ?? `视点 +${s.eye}`}</span>
      </span>
      <span class="s-cost">${cost} 预算</span>`;
    label.querySelector('input')!.addEventListener('change', () => {
      stanceId = s.id;
      manualLos = recomputeManual();
      renderAll();
    });
    list.appendChild(label);
  }
}

function recomputeManual(): LosResult | null {
  if (currentMap && queryA && queryB) {
    return queryLos(currentMap, queryA, activeEye(), queryB);
  }
  return manualLos;
}

function renderHud(): void {
  if (!currentMap || !state) return;
  const map = currentMap;
  const ds = displayState() ?? state;
  const stance = getStance(map, stanceId);
  const observeCostNow = stance.cost ?? map.costs.observe;

  $('levelName').textContent = map.name;
  $('levelBrief').textContent = map.brief;
  const ruling = $('rulingNote');
  if (map.rulingNote) {
    ruling.hidden = false;
    ruling.textContent = '⚖ 裁定：' + map.rulingNote;
  } else ruling.hidden = true;

  const budget = replayCtl.active ? ds.budgetLeft : state.budgetLeft;
  const budgetEl = $('budgetLeft');
  budgetEl.textContent = String(budget);
  budgetEl.classList.toggle('low', budget <= Math.max(2, map.costs.observe));
  $('budgetMax').textContent = String(map.budget);
  const pct = Math.max(0, Math.min(100, (budget / map.budget) * 100));
  const bar = $('budgetBar');
  bar.style.width = pct + '%';
  bar.classList.toggle('low', pct < 35);

  $('statMoves').textContent = String(ds.moves);
  $('statObserves').textContent = String(ds.observes);
  $('beaconProgress').textContent = `${ds.foundIds.length}/${map.beacons.length}`;

  const ul = $('beaconList');
  ul.innerHTML = '';
  for (const b of map.beacons) {
    const found = ds.foundIds.includes(b.id);
    const li = document.createElement('li');
    li.className = found ? 'found' : 'unknown';
    li.innerHTML = `
      <span class="beacon-dot"></span>
      <span>${found ? b.name ?? b.id : '未标定信标'}</span>
      <span class="beacon-state">${found ? '✔ 已标定' : '？ 未知'}</span>`;
    ul.appendChild(li);
  }

  $('costLine').textContent =
    `规则明示：每移动 1 格消耗 ${map.costs.move} 预算；` +
    `每次观测消耗 ${map.costs.observe} 起（当前姿态 ${observeCostNow}）。` +
    (map.visionRange ? ` 视距 ${map.visionRange} 格。` : ' 不限视距。');

  const obsBtn = $<HTMLButtonElement>('observeBtn');
  obsBtn.textContent = `🔭 ${stance.label} · 观测（${observeCostNow} 预算 / 海拔 ${heightAt(map, state.player.q, state.player.r) + stance.eye}）`;
  const can = canObserve(map, state, stanceId) && !replayCtl.active;
  obsBtn.disabled = !can;

  $<HTMLButtonElement>('btnUndo').disabled = actions.length === 0 || replayCtl.active;
  $<HTMLButtonElement>('btnHint').disabled = replayCtl.active;
  $<HTMLButtonElement>('btnReplay').disabled = actions.length === 0;
  $<HTMLButtonElement>('btnSave').disabled = false;

  renderLog(ds);
  renderInspector();
  renderQuery();
  renderTips();
  renderOverlay(ds);
}

function renderLog(ds: GameState): void {
  const ul = $('logList');
  const atBottom = ul.scrollTop + ul.clientHeight >= ul.scrollHeight - 20;
  ul.innerHTML = '';
  for (const e of ds.log) {
    const li = document.createElement('li');
    li.className = e.kind;
    li.textContent = e.text;
    ul.appendChild(li);
  }
  if (atBottom) ul.scrollTop = ul.scrollHeight;
}

function renderTips(): void {
  if (!currentMap) return;
  const ul = $('tipsList');
  ul.innerHTML = '';
  for (const t of currentMap.tips ?? []) {
    const li = document.createElement('li');
    li.textContent = t;
    ul.appendChild(li);
  }
}

function renderOverlay(ds: GameState): void {
  const ov = $('overlay');
  // 回放拖动与视线实验室中不显示结算遮罩，避免挡住地图点选。
  if (replayCtl.active || mode === 'query') {
    ov.hidden = true;
    return;
  }
  if (ds.status === 'won') {
    const spent = currentMap!.budget - ds.budgetLeft;
    const par = currentMap!.parBudget;
    const rating =
      par !== undefined && spent <= par
        ? `<p class="rating">★ 干练勘测员：总消耗 ${spent}，不高于参考 ${par}</p>`
        : `<p>总消耗 ${spent} 预算（参考 ${par ?? '—'}）。</p>`;
    ov.hidden = false;
    ov.innerHTML = `<div class="dialog"><div class="big">🏁</div><h2>勘测完成</h2>
      <p>${currentMap!.name}的 ${currentMap!.beacons.length} 座信标已全部标定。</p>
      ${rating}
      <p>移动 ${ds.moves} 次 · 观测 ${ds.observes} 次</p>
      <div class="row">
        <button class="btn" data-act="replay">↻ 重放本局</button>
        <button class="btn primary" data-act="restart">再玩一次</button>
      </div></div>`;
  } else if (ds.status === 'stalled') {
    ov.hidden = false;
    ov.innerHTML = `<div class="dialog"><div class="big">🧭</div><h2>预算耗尽</h2>
      <p>剩余预算已无法移动或观测。可以撤回几步换条路线，或重新开始；也可以先重放复盘。</p>
      <div class="row">
        <button class="btn" data-act="restart">⟲ 重新开始</button>
        <button class="btn primary" data-act="replay">↻ 重放复盘</button>
      </div></div>`;
  } else {
    ov.hidden = true;
    ov.innerHTML = '';
  }
}

/* ---------------- 地块检视 / 视线说明 ---------------- */

function losVerdictHtml(los: LosResult): string {
  if (los.clear) {
    return `<div class="verdict clear">✔ 视线畅通：该格中心地面在当前观测高度下可见。</div>`;
  }
  const p = los.primary!;
  const kind =
    p.kind === 'wall' ? '石墙' : p.kind === 'terrain' ? '较高中间地形' : '障碍';
  const co = los.blockers
    .filter((b) => b !== p)
    .slice(0, 4)
    .map((b) => `(${b.q},${b.r})`)
    .join('、');
  return `<div class="verdict blocked">✘ 视线被 <b>(${p.q}, ${p.r})</b> 的${kind}首先挡住。
    <br/>该格遮挡顶高 <b>${p.blockTop}</b>；视线在参数 <b>${formatT(p.hitT)}</b> 处
    高度约 <b>${formatZ(p.hitZ)}</b>，随后严格低于遮挡顶。
    ${co ? `<br/>同线其它遮挡格：${co}` : ''}
    </div>`;
}

function renderInspector(): void {
  const box = $('inspector');
  if (!currentMap || !state) return;
  if (!selected) {
    box.innerHTML = `<p class="muted">点击任意地块查看高度、障碍、记录与视线裁定。</p>`;
    return;
  }
  const h = selected;
  const player = state.player;
  const height = heightAt(currentMap, h.q, h.r);
  const o = obstacleAt(currentMap, h.q, h.r);
  const top = blockTopAt(currentMap, h.q, h.r);
  const rec = state.records[`${h.q},${h.r}`];
  const d =
    (Math.abs(state.player.q - h.q) +
      Math.abs(state.player.q - h.q + state.player.r - h.r) +
      Math.abs(state.player.r - h.r)) /
    2;
  const eye = activeEye();
  const los = queryLos(currentMap, state.player, eye, h);
  const opt = getMoveOptions(currentMap, state).find((x) => same(x.to, h));

  box.innerHTML = `
    <dl class="kv">
      <dt>坐标</dt><dd>(${h.q}, ${h.r}) · 距离 ${d}</dd>
      <dt>地块高度</dt><dd>${height} 级</dd>
      <dt>障碍</dt><dd>${o ? `${o.kind}（遮挡顶高 ${top}）` : '无'}</dd>
      <dt>上次记录</dt><dd>${
        rec
          ? `第 ${rec.step} 步记录，观测海拔 ${rec.altitude}${rec.beaconId ? '，标定到信标 ' + rec.beaconId : ''}`
          : '尚未观测记录'
      }</dd>
    </dl>
    ${losVerdictHtml(los)}
    <div class="row-actions">
      ${opt?.legal ? `<button class="btn small primary" id="insMove" type="button">移动到这里（-${opt.cost}）</button>` : ''}
      <button class="btn small" id="insQueryAB" type="button">以此格为 A 查询</button>
      <button class="btn small ghost" id="insQueryB" type="button">查勘测员→此格</button>
    </div>`;

  const moveBtn = document.getElementById('insMove');
  moveBtn?.addEventListener('click', () => commit({ type: 'move', to: { ...h } }));
  document.getElementById('insQueryAB')?.addEventListener('click', () => {
    setMode('query');
    queryA = { ...h };
    queryB = null;
    manualLos = null;
    renderQuery();
  });
  document.getElementById('insQueryB')?.addEventListener('click', () => {
    setMode('query');
    queryA = { ...player };
    queryB = { ...h };
    manualLos = queryLos(currentMap!, queryA, activeEye(), h);
    renderQuery();
  });
}

function renderQuery(): void {
  const box = $('queryResult');
  if (!box || !currentMap) return;
  const eye = activeEye();
  const aChip = queryA
    ? `<span class="pin-chip a">A (${queryA.q},${queryA.r}) · 格高 ${heightAt(currentMap, queryA.q, queryA.r)} + 视点 ${eye}</span>`
    : `<span class="muted small">A 未选</span>`;
  const bChip = queryB
    ? `<span class="pin-chip b">B (${queryB.q},${queryB.r})</span>`
    : `<span class="muted small">B 未选（选完 A 后再点一格；悬停可预览）</span>`;
  let verdict = '<p class="muted small">在地图上点选 A、B 两格。</p>';
  if (manualLos) verdict = losVerdictHtml(manualLos);
  box.innerHTML = `<div class="query-pair">${aChip}${bChip}</div>${verdict}`;
}

/** 任意观测格可视域的说明行；不传参数时按当前缓存刷新。 */
function updateViewInfo(count?: number, origin?: Axial): void {
  const el = document.getElementById('queryViewInfo');
  if (!el) return;
  if (!customViewOrigin) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const o = origin ?? customViewOrigin;
  const n = count ?? viewCache.view?.visible.size;
  el.hidden = false;
  el.innerHTML =
    `👁 青色区域现为任意观测格 <b>(${o.q}, ${o.r})</b> 的整片可视域` +
    (n ? `：<b>${n}</b> 格可见（含观测格自身）。` : '。');
}

/* ---------------- 小工具 ---------------- */

function setMessage(text: string, cls: '' | 'error' | 'ok'): void {
  const el = $<HTMLParagraphElement>('message');
  el.textContent = text;
  el.className = 'message' + (cls ? ' ' + cls : '');
  if (messageTimer !== undefined) window.clearTimeout(messageTimer);
  if (text) {
    messageTimer = window.setTimeout(() => {
      el.textContent = '';
    }, 5200);
  }
}

function same(a: Axial, b: Axial): boolean {
  return a.q === b.q && a.r === b.r;
}

boot();
