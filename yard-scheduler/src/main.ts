/**
 * 浏览器 UI:地图画布 + 占用时间线 + 计划编辑 + 运行控制 + 存档。
 * 模拟核心见 sim.ts;本文件只负责展示与交互,不改变任何结算规则。
 */

import {
  YardMap, Plan, NodeDef, EdgeDef,
  nodeOf, edgeOf, vehicleOf, otherEnd, edgeBetween, waitCapacityOf, dockSlotsOf,
} from './model.js';
import { Sim, Conflict } from './sim.js';
import { Scenario, SCENARIOS, scenarioById } from './scenarios.js';
import {
  Edit, applyEdit, validateEdit, lockedPrefixLen, editableFromNode,
  replay, serialize, parseSave, deepCopyPlan,
} from './persistence.js';

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const mapCanvas = $<HTMLCanvasElement>('mapCanvas');
const tlCanvas = $<HTMLCanvasElement>('timelineCanvas');
const mapCtx = mapCanvas.getContext('2d')!;
const tlCtx = tlCanvas.getContext('2d')!;
const SAVE_KEY = 'yard-scheduler-save-v1';

// ---------- 全局状态 ----------

interface Ui {
  map: YardMap;
  scenarioId: string; // 场景 id 或 '(存档)'
  initialPlan: Plan;
  plan: Plan;
  edits: Edit[];
  sim: Sim;
  playing: boolean;
  speed: number;
  selected: string;
  routeEditing: boolean;
  draftRoute: string[] | null; // 编辑中的路线草稿
  message: string;
  sidebarDirty: boolean;
}

const ui: Ui = {
  map: null as unknown as YardMap,
  scenarioId: '',
  initialPlan: {},
  plan: {},
  edits: [],
  sim: null as unknown as Sim,
  playing: false,
  speed: 8,
  selected: '',
  routeEditing: false,
  draftRoute: null,
  message: '',
  sidebarDirty: true,
};

function loadScenario(sc: Scenario): void {
  ui.map = sc.map;
  ui.scenarioId = sc.id;
  ui.initialPlan = deepCopyPlan(sc.initialPlan);
  ui.plan = deepCopyPlan(sc.initialPlan);
  ui.edits = [];
  ui.sim = new Sim(ui.map, ui.plan);
  ui.playing = false;
  ui.selected = sc.map.vehicles[0]?.id ?? '';
  ui.routeEditing = false;
  ui.draftRoute = null;
  ui.message = '';
  ui.sidebarDirty = true;
  $('scenarioDesc').textContent = sc.description;
  $('scenarioSelect').querySelectorAll('option').forEach((o) => {
    (o as HTMLOptionElement).selected = (o as HTMLOptionElement).value === sc.id;
  });
}

/** 回退到时隙 t:丢弃 t 之后的编辑,从初始计划确定性重放。 */
function rewindTo(t: number): void {
  t = Math.max(0, Math.min(t, ui.sim.tick));
  ui.edits = ui.edits.filter((e) => e.tick <= t);
  const { sim, plan } = replay(ui.map, ui.initialPlan, ui.edits, t);
  ui.sim = sim;
  ui.plan = plan;
  ui.playing = false;
  ui.routeEditing = false;
  ui.draftRoute = null;
  ui.message = '';
  ui.sidebarDirty = true;
}

function resetAll(): void {
  ui.edits = [];
  rewindTo(0);
}

/** 在当前时隙应用一次编辑。 */
function applyEditNow(vehicle: string, patch: { depart?: number; route?: string[] }): boolean {
  const edit: Edit = { tick: ui.sim.tick, vehicle, ...patch };
  const err = validateEdit(ui.sim, vehicle, edit);
  if (err) {
    ui.message = err;
    ui.sidebarDirty = true;
    return false;
  }
  ui.edits.push(edit);
  applyEdit(ui.plan, edit);
  ui.message = '';
  ui.routeEditing = false;
  ui.draftRoute = null;
  ui.sidebarDirty = true;
  return true;
}

/** 投影:从当前状态按当前计划跑到结束,用于占用时间线与冲突预告。 */
let projCache: { key: string; sim: Sim } | null = null;
function projection(): Sim {
  const key = JSON.stringify([ui.sim.snapshot(), ui.plan]);
  if (projCache && projCache.key === key) return projCache.sim;
  const proj = Sim.restore(ui.map, ui.plan, ui.sim.snapshot());
  proj.runToEnd();
  projCache = { key, sim: proj };
  return proj;
}

function vehicleColor(id: string): string {
  return vehicleOf(ui.map, id).color;
}

// ---------- 地图绘制 ----------

function nodePos(id: string): { x: number; y: number } {
  const n = nodeOf(ui.map, id);
  return { x: n.x, y: n.y };
}

function vehiclePositions(): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  const atNodeCount: Record<string, number> = {};
  for (const v of ui.map.vehicles) {
    const s = ui.sim.states[v.id]!;
    if (s.phase === 'pending') {
      const p = nodePos(v.start);
      pos[v.id] = { x: p.x - 24, y: p.y + 26 };
    } else if (s.phase === 'atNode' || s.phase === 'unloading') {
      const p = nodePos(s.node!);
      const k = (atNodeCount[s.node!] = (atNodeCount[s.node!] ?? 0) + 1) - 1;
      pos[v.id] = { x: p.x + 18 + k * 4, y: p.y - 20 - k * 16 };
    } else if (s.phase === 'onEdge') {
      const e = edgeOf(ui.map, s.edge!);
      const a = nodePos(e.a);
      const b = nodePos(e.b);
      const frac = Math.min(1, Math.max(0, (ui.sim.tick - s.enter) / e.ticks));
      const fx = a.x + (b.x - a.x) * (s.dir === 1 ? frac : 1 - frac);
      const fy = a.y + (b.y - a.y) * (s.dir === 1 ? frac : 1 - frac);
      pos[v.id] = { x: fx, y: fy };
    } else if (s.phase === 'delivered') {
      const p = nodePos(vehicleOf(ui.map, v.id).destDock);
      pos[v.id] = { x: p.x - 26, y: p.y - 24 };
    } else {
      const p = nodePos(v.start);
      pos[v.id] = { x: p.x, y: p.y + 30 };
    }
  }
  return pos;
}

function drawEdge(e: EdgeDef, now: boolean): void {
  const a = nodePos(e.a);
  const b = nodePos(e.b);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  const occupied = (ui.sim.edgeOcc[e.id] ?? []).some((o) => o.exit === null);
  mapCtx.lineWidth = e.narrow ? 3 : 2;
  if (e.narrow) {
    // 窄路段:单线,红色系
    mapCtx.strokeStyle = occupied ? '#ff7a6b' : '#a05248';
    mapCtx.beginPath();
    mapCtx.moveTo(a.x, a.y);
    mapCtx.lineTo(b.x, b.y);
    mapCtx.stroke();
  } else {
    // 宽路段:双线
    mapCtx.strokeStyle = occupied ? '#9fb4cc' : '#4d5766';
    for (const off of [-3, 3]) {
      mapCtx.beginPath();
      mapCtx.moveTo(a.x + nx * off, a.y + ny * off);
      mapCtx.lineTo(b.x + nx * off, b.y + ny * off);
      mapCtx.stroke();
    }
  }
  // 方向箭头
  const drawArrow = (fx: number, fy: number, tx: number, ty: number) => {
    const ang = Math.atan2(ty - fy, tx - fx);
    mapCtx.beginPath();
    mapCtx.moveTo(tx, ty);
    mapCtx.lineTo(tx - 8 * Math.cos(ang - 0.4), ty - 8 * Math.sin(ang - 0.4));
    mapCtx.lineTo(tx - 8 * Math.cos(ang + 0.4), ty - 8 * Math.sin(ang + 0.4));
    mapCtx.closePath();
    mapCtx.fill();
  };
  mapCtx.fillStyle = e.narrow ? '#a05248' : '#4d5766';
  drawArrow(a.x + dx * 0.72, a.y + dy * 0.72, a.x + dx * 0.82, a.y + dy * 0.82);
  if (e.bidirectional) {
    drawArrow(b.x - dx * 0.72, b.y - dy * 0.72, b.x - dx * 0.82, b.y - dy * 0.82);
  }
  // 标签
  mapCtx.fillStyle = '#8b94a3';
  mapCtx.font = '11px sans-serif';
  mapCtx.textAlign = 'center';
  mapCtx.fillText(`${e.id}·${e.ticks}${e.narrow ? '·窄' : ''}`, (a.x + b.x) / 2 + nx * 12, (a.y + b.y) / 2 + ny * 12);
}

function drawNode(n: NodeDef): void {
  const waiting = Object.values(ui.sim.states).filter((s) => s.phase === 'atNode' && s.node === n.id).length;
  const cap = waitCapacityOf(n);
  mapCtx.textAlign = 'center';
  if (n.kind === 'dock') {
    const unloading = Object.values(ui.sim.states).filter((s) => s.phase === 'unloading' && s.node === n.id).length;
    mapCtx.fillStyle = unloading > 0 ? '#2e6da4' : '#23415e';
    mapCtx.strokeStyle = '#4fa3ff';
    mapCtx.lineWidth = 2;
    mapCtx.beginPath();
    mapCtx.rect(n.x - 18, n.y - 14, 36, 28);
    mapCtx.fill();
    mapCtx.stroke();
    mapCtx.fillStyle = '#bcd7f5';
    mapCtx.font = '11px sans-serif';
    mapCtx.fillText(`${n.name}(${unloading}/${dockSlotsOf(n)})`, n.x, n.y - 20);
  } else if (n.kind === 'junction') {
    mapCtx.fillStyle = '#3a4150';
    mapCtx.strokeStyle = cap === 0 ? '#e06c75' : '#8b94a3';
    mapCtx.lineWidth = 2;
    mapCtx.beginPath();
    mapCtx.arc(n.x, n.y, 9, 0, Math.PI * 2);
    mapCtx.fill();
    mapCtx.stroke();
    mapCtx.fillStyle = '#8b94a3';
    mapCtx.font = '11px sans-serif';
    mapCtx.fillText(`${n.name} 等位${waiting}/${cap}`, n.x, n.y - 14);
  } else {
    mapCtx.fillStyle = '#3a4150';
    mapCtx.strokeStyle = '#8b94a3';
    mapCtx.lineWidth = 2;
    mapCtx.beginPath();
    mapCtx.arc(n.x, n.y, 15, 0, Math.PI * 2);
    mapCtx.fill();
    mapCtx.stroke();
    mapCtx.fillStyle = '#c8cfdb';
    mapCtx.font = '11px sans-serif';
    mapCtx.fillText(`${n.name} 等位${waiting}/${cap}`, n.x, n.y - 21);
  }
}

function drawMap(): void {
  mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);

  // 选中车辆的剩余路线高亮
  if (ui.selected) {
    const route = ui.draftRoute ?? ui.plan[ui.selected]?.route ?? [];
    const s = ui.sim.states[ui.selected];
    const from = s ? Math.max(0, s.routeIndex - (s.phase === 'onEdge' ? 1 : 0)) : 0;
    mapCtx.save();
    mapCtx.strokeStyle = vehicleColor(ui.selected) + '66';
    mapCtx.lineWidth = 7;
    mapCtx.lineCap = 'round';
    for (let i = from; i < route.length; i++) {
      const e = ui.map.edges.find((x) => x.id === route[i]);
      if (!e) continue;
      const a = nodePos(e.a);
      const b = nodePos(e.b);
      mapCtx.beginPath();
      mapCtx.moveTo(a.x, a.y);
      mapCtx.lineTo(b.x, b.y);
      mapCtx.stroke();
    }
    mapCtx.restore();
  }

  for (const e of ui.map.edges) drawEdge(e, true);
  for (const n of ui.map.nodes) drawNode(n);

  // 车辆
  const pos = vehiclePositions();
  for (const v of ui.map.vehicles) {
    const s = ui.sim.states[v.id]!;
    const p = pos[v.id]!;
    const selected = v.id === ui.selected;
    mapCtx.save();
    if (s.phase === 'pending') mapCtx.globalAlpha = 0.55;
    mapCtx.fillStyle = v.color;
    mapCtx.strokeStyle = selected ? '#ffffff' : s.phase === 'onEdge' && s.plannedExit <= ui.sim.tick ? '#ff5555' : '#00000055';
    mapCtx.lineWidth = selected ? 2.5 : 1.5;
    if (s.phase === 'pending') mapCtx.setLineDash([3, 3]);
    mapCtx.beginPath();
    mapCtx.rect(p.x - 9, p.y - 9, 18, 18);
    mapCtx.fill();
    mapCtx.stroke();
    mapCtx.setLineDash([]);
    mapCtx.globalAlpha = 1;
    mapCtx.fillStyle = '#fff';
    mapCtx.font = 'bold 10px sans-serif';
    mapCtx.textAlign = 'center';
    mapCtx.fillText(v.name, p.x, p.y + 3.5);
    if (s.phase === 'delivered') {
      mapCtx.fillStyle = '#7ec699';
      mapCtx.fillText('✓', p.x, p.y - 12);
    }
    mapCtx.restore();
  }

  // 冲突位置闪烁标记
  for (const c of ui.sim.conflicts) {
    if (c.tick > ui.sim.tick) continue;
    for (const loc of c.location) {
      const n = ui.map.nodes.find((x) => x.id === loc);
      const e = ui.map.edges.find((x) => x.id === loc);
      let p: { x: number; y: number } | null = null;
      if (n) p = { x: n.x, y: n.y };
      else if (e) {
        const a = nodePos(e.a);
        const b = nodePos(e.b);
        p = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      if (p) {
        mapCtx.strokeStyle = '#e06c75';
        mapCtx.lineWidth = 2;
        mapCtx.beginPath();
        mapCtx.arc(p.x, p.y, 22, 0, Math.PI * 2);
        mapCtx.stroke();
      }
    }
  }

  if (ui.routeEditing) {
    mapCtx.fillStyle = '#e5c07b';
    mapCtx.font = '13px sans-serif';
    mapCtx.textAlign = 'left';
    mapCtx.fillText('路线编辑中:点击地图上的节点追加路段(只能接在当前可编辑后缀的末端)', 10, mapCanvas.height - 10);
  }
}

// ---------- 时间线绘制 ----------

const TL_LABEL_W = 110;
const TL_ROW_H = 24;

function drawTimeline(): void {
  const proj = projection();
  tlCtx.clearRect(0, 0, tlCanvas.width, tlCanvas.height);
  const rows: { id: string; label: string; dock: boolean }[] = [
    ...ui.map.edges.map((e) => ({ id: e.id, label: `${e.id}${e.narrow ? '(窄)' : ''}`, dock: false })),
    ...ui.map.nodes.filter((n) => n.kind === 'dock').map((n) => ({ id: n.id, label: `${n.name}(月台)`, dock: true })),
  ];
  let horizon = ui.map.deadline + 6;
  const extend = (t: number) => { horizon = Math.max(horizon, t + 4); };
  for (const occs of Object.values(proj.edgeOcc)) for (const o of occs) extend(o.exit ?? proj.tick);
  for (const occs of Object.values(proj.dockOcc)) for (const o of occs) extend(o.end);
  extend(ui.sim.tick + 10);

  const W = tlCanvas.width;
  const x = (t: number) => TL_LABEL_W + (t / horizon) * (W - TL_LABEL_W - 12);
  const now = ui.sim.tick;

  tlCtx.font = '11px sans-serif';
  tlCtx.textAlign = 'left';
  rows.forEach((row, i) => {
    const y = 8 + i * TL_ROW_H;
    tlCtx.fillStyle = '#8b94a3';
    tlCtx.fillText(row.label, 6, y + TL_ROW_H / 2 + 4);
    tlCtx.strokeStyle = '#2a303c';
    tlCtx.beginPath();
    tlCtx.moveTo(TL_LABEL_W, y + TL_ROW_H / 2);
    tlCtx.lineTo(W - 12, y + TL_ROW_H / 2);
    tlCtx.stroke();

    const drawInterval = (start: number, end: number | null, color: string) => {
      const e = end ?? horizon;
      const x0 = x(start);
      const x1 = x(e);
      tlCtx.fillStyle = color;
      tlCtx.globalAlpha = end === null ? 0.45 : start >= now ? 0.55 : 0.9;
      tlCtx.fillRect(x0, y + 4, Math.max(2, x1 - x0), TL_ROW_H - 8);
      tlCtx.globalAlpha = 1;
      if (end === null) {
        tlCtx.fillStyle = '#e06c75';
        tlCtx.fillText('滞留', x0 + 2, y + TL_ROW_H / 2 + 4);
      }
    };
    if (!row.dock) {
      for (const o of proj.edgeOcc[row.id] ?? []) drawInterval(o.enter, o.exit, vehicleColor(o.vehicle));
    } else {
      for (const o of proj.dockOcc[row.id] ?? []) drawInterval(o.start, o.end, vehicleColor(o.vehicle));
    }
  });

  // 截止线
  tlCtx.strokeStyle = '#e5c07b';
  tlCtx.setLineDash([4, 4]);
  tlCtx.beginPath();
  tlCtx.moveTo(x(ui.map.deadline), 4);
  tlCtx.lineTo(x(ui.map.deadline), 8 + rows.length * TL_ROW_H);
  tlCtx.stroke();
  tlCtx.setLineDash([]);
  tlCtx.fillStyle = '#e5c07b';
  tlCtx.fillText(`截止 ${ui.map.deadline}`, x(ui.map.deadline) + 3, 12);

  // 冲突标记(已发生 + 投影预告)
  const allConflicts: { c: Conflict; future: boolean }[] = [
    ...ui.sim.conflicts.map((c) => ({ c, future: false })),
    ...proj.conflicts.filter((c) => c.tick >= now).map((c) => ({ c, future: true })),
  ];
  for (const { c, future } of allConflicts) {
    tlCtx.fillStyle = future ? '#e5c07b' : '#e06c75';
    const cx = x(c.tick);
    tlCtx.beginPath();
    tlCtx.moveTo(cx, 2);
    tlCtx.lineTo(cx - 4, 10);
    tlCtx.lineTo(cx + 4, 10);
    tlCtx.closePath();
    tlCtx.fill();
  }

  // 当前时隙线
  tlCtx.strokeStyle = '#ff5555';
  tlCtx.beginPath();
  tlCtx.moveTo(x(now), 4);
  tlCtx.lineTo(x(now), 8 + rows.length * TL_ROW_H);
  tlCtx.stroke();

  // 刻度
  tlCtx.fillStyle = '#5b6572';
  for (let t = 0; t <= horizon; t += 5) {
    tlCtx.fillText(String(t), x(t) - 6, 8 + rows.length * TL_ROW_H + 14);
  }
  tlCanvas.dataset.horizon = String(horizon);
}

// ---------- 侧栏 ----------

function vehicleStateText(id: string): string {
  const s = ui.sim.states[id]!;
  const v = vehicleOf(ui.map, id);
  switch (s.phase) {
    case 'pending': return `待起步(计划 t=${ui.plan[id]!.depart})`;
    case 'atNode': {
      const b = ui.sim.blockedBy[id];
      return `在 ${s.node} 等待${b ? `,被 ${b.join('、')} 挡住` : ''}`;
    }
    case 'onEdge': {
      const stuck = s.plannedExit <= ui.sim.tick;
      return stuck ? `滞留在 ${s.edge}!` : `行驶在 ${s.edge}(t=${s.plannedExit} 到达)`;
    }
    case 'unloading': return `在 ${s.node} 卸货,t=${s.until} 完成`;
    case 'delivered': return `已送达 ${v.destDock} ✓`;
    case 'failed': return '计划错误';
  }
}

function renderSidebar(): void {
  // 车辆列表
  const list = $('vehicleList');
  list.innerHTML = '';
  for (const v of ui.map.vehicles) {
    const row = document.createElement('div');
    row.className = 'vehicleRow' + (v.id === ui.selected ? ' selected' : '');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.style.background = v.color;
    const name = document.createElement('b');
    name.textContent = `${v.name} → ${v.destDock}`;
    const st = document.createElement('span');
    st.className = 'vstate';
    st.textContent = vehicleStateText(v.id);
    row.append(chip, name, st);
    row.onclick = () => { ui.selected = v.id; ui.routeEditing = false; ui.draftRoute = null; ui.sidebarDirty = true; };
    list.appendChild(row);
  }

  // 编辑器
  const ed = $('editor');
  ed.innerHTML = '';
  const vid = ui.selected;
  if (!vid) return;
  const s = ui.sim.states[vid]!;
  const locked = lockedPrefixLen(ui.sim, vid);
  const cur = ui.plan[vid]!;
  const draft = ui.draftRoute ?? cur.route;

  const departRow = document.createElement('div');
  departRow.className = 'row';
  const departInput = document.createElement('input');
  departInput.type = 'number';
  departInput.min = '0';
  departInput.value = String(ui.routeEditing && ui.draftRoute ? cur.depart : cur.depart);
  departInput.id = 'departInput';
  const departBtn = document.createElement('button');
  departBtn.textContent = '改起步时隙';
  departBtn.disabled = s.phase !== 'pending';
  departBtn.onclick = () => {
    const d = parseInt((document.getElementById('departInput') as HTMLInputElement).value, 10);
    applyEditNow(vid, { depart: d });
  };
  departRow.append(document.createTextNode('起步时隙 '), departInput, departBtn);
  if (s.phase !== 'pending') {
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '(已起步,不可改)';
    departRow.appendChild(hint);
  }
  ed.appendChild(departRow);

  const routeRow = document.createElement('div');
  routeRow.className = 'routeChips';
  draft.forEach((e, i) => {
    const chip = document.createElement('span');
    chip.textContent = e;
    if (i < locked) chip.className = 'locked';
    chip.title = i < locked ? '已走过,锁定' : '可编辑';
    routeRow.appendChild(chip);
  });
  ed.appendChild(routeRow);

  const btnRow = document.createElement('div');
  btnRow.className = 'row';
  const editable = locked !== Infinity;
  const mkBtn = (text: string, fn: () => void, disabled = false) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.disabled = disabled;
    b.onclick = fn;
    btnRow.appendChild(b);
  };
  mkBtn(ui.routeEditing ? '停止点选' : '点选编辑路线', () => {
    ui.routeEditing = !ui.routeEditing;
    ui.draftRoute = ui.routeEditing ? [...cur.route] : null;
    ui.sidebarDirty = true;
  }, !editable);
  mkBtn('删除末段', () => {
    if (!ui.draftRoute) ui.draftRoute = [...cur.route];
    if (ui.draftRoute.length > locked) {
      ui.draftRoute.pop();
      ui.routeEditing = true;
      ui.sidebarDirty = true;
    }
  }, !editable || draft.length <= locked);
  mkBtn('应用路线', () => {
    if (ui.draftRoute) applyEditNow(vid, { route: ui.draftRoute });
  }, !editable || !ui.draftRoute || ui.draftRoute.join() === cur.route.join());
  ed.appendChild(btnRow);

  const from = editableFromNode(ui.map, ui.sim, vid);
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = editable
    ? `锁定前缀 ${locked} 段;后缀从节点 ${from ?? '?'} 继续,终点须为 ${vehicleOf(ui.map, vid).destDock}`
    : '车辆已在卸货/送达,计划冻结';
  ed.appendChild(hint);

  $('editorMsg').textContent = ui.message;

  // 冲突列表
  const cl = $('conflictList');
  cl.innerHTML = '';
  const proj = projection();
  const items: { c: Conflict; future: boolean }[] = [
    ...ui.sim.conflicts.map((c) => ({ c, future: false })),
    ...proj.conflicts.filter((c) => c.tick >= ui.sim.tick).map((c) => ({ c, future: true })),
  ];
  if (items.length === 0) {
    cl.innerHTML = '<span class="hint">暂无</span>';
  }
  for (const { c, future } of items) {
    const div = document.createElement('div');
    div.className = 'conflictItem' + (future ? ' future' : '');
    const kindText = c.kind === 'deadlock' ? '死锁' : c.kind === 'deadline' ? '超时' : '计划错误';
    div.textContent = `${future ? '预计 ' : ''}t=${c.tick} [${kindText}] ${c.vehicles.join('、')} @ ${c.location.join('、')}:${c.detail} `;
    const btn = document.createElement('button');
    btn.textContent = `回退到 t=${c.tick}`;
    btn.onclick = () => rewindTo(c.tick);
    div.appendChild(btn);
    cl.appendChild(div);
  }

  // 状态横幅
  const banner = $('statusBanner');
  const statusText: Record<string, [string, string]> = {
    running: [ui.playing ? '运行中' : '已暂停', ''],
    success: ['全部送达 ✓', 'ok'],
    deadlock: ['死锁,请回退修改', 'bad'],
    deadline: ['超过截止时隙', 'bad'],
    error: ['计划错误', 'bad'],
  };
  const [text, cls] = statusText[ui.sim.status]!;
  banner.textContent = text;
  banner.className = cls;
  $('clock').textContent = `时隙 ${ui.sim.tick} / 截止 ${ui.map.deadline}`;
  $('btnPlay').textContent = ui.playing ? '⏸ 暂停' : '▶ 运行';
}

// ---------- 交互 ----------

mapCanvas.addEventListener('click', (ev) => {
  const rect = mapCanvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  // 先选车
  const pos = vehiclePositions();
  for (const v of ui.map.vehicles) {
    const p = pos[v.id]!;
    if (Math.abs(p.x - mx) < 12 && Math.abs(p.y - my) < 12) {
      ui.selected = v.id;
      ui.sidebarDirty = true;
      return;
    }
  }
  // 再点节点(路线编辑)
  const n = ui.map.nodes.find((n) => Math.hypot(n.x - mx, n.y - my) < 16);
  if (!n || !ui.routeEditing || !ui.selected) return;
  const vid = ui.selected;
  if (!ui.draftRoute) ui.draftRoute = [...ui.plan[vid]!.route];
  // 草稿末端节点
  let at = vehicleOf(ui.map, vid).start;
  for (const eid of ui.draftRoute) {
    const e = edgeOf(ui.map, eid);
    at = otherEnd(e, at) ?? at;
  }
  if (n.id === at) return;
  const edge = edgeBetween(ui.map, at, n.id);
  if (!edge) {
    ui.message = `节点 ${at} 与 ${n.id} 之间没有可通行的路段`;
  } else {
    ui.draftRoute.push(edge.id);
    ui.message = '';
  }
  ui.sidebarDirty = true;
});

tlCanvas.addEventListener('click', (ev) => {
  const rect = tlCanvas.getBoundingClientRect();
  const horizon = Number(tlCanvas.dataset.horizon ?? ui.map.deadline + 6);
  const t = Math.round(((ev.clientX - rect.left - TL_LABEL_W) / (tlCanvas.width - TL_LABEL_W - 12)) * horizon);
  if (t < 0) return;
  if (t < ui.sim.tick) rewindTo(t);
  else { ui.playing = false; ui.sim.run(t); ui.sidebarDirty = true; }
});

$('btnPlay').onclick = () => {
  if (ui.sim.done) return;
  ui.playing = !ui.playing;
  ui.sidebarDirty = true;
};
$('btnStep').onclick = () => { ui.playing = false; ui.sim.step(); ui.sidebarDirty = true; };
$('btnRunEnd').onclick = () => { ui.playing = false; ui.sim.runToEnd(); ui.sidebarDirty = true; };
$('btnRunTo').onclick = () => {
  const t = parseInt($<HTMLInputElement>('runToTick').value, 10);
  if (Number.isInteger(t) && t >= 0) {
    if (t < ui.sim.tick) rewindTo(t);
    else { ui.playing = false; ui.sim.run(t); }
    ui.sidebarDirty = true;
  }
};
$('btnRewind').onclick = () => {
  const t = parseInt($<HTMLInputElement>('rewindTick').value, 10);
  if (Number.isInteger(t)) rewindTo(t);
};
$('btnReset').onclick = () => resetAll();
$('speed').oninput = () => {
  ui.speed = parseInt($<HTMLInputElement>('speed').value, 10);
  $('speedLabel').textContent = String(ui.speed);
};

$('btnSave').onclick = () => {
  localStorage.setItem(SAVE_KEY, serialize(ui.map, ui.initialPlan, ui.edits, ui.sim.tick));
  $('ioMsg').textContent = `已保存(t=${ui.sim.tick},${ui.edits.length} 条修改记录)`;
};
$('btnLoad').onclick = () => {
  const json = localStorage.getItem(SAVE_KEY);
  if (!json) { $('ioMsg').textContent = '没有已保存的存档'; return; }
  try {
    loadFromSave(json);
    $('ioMsg').textContent = '读取成功,已重放到存档时隙';
  } catch (e) {
    $('ioMsg').textContent = `读取失败:${(e as Error).message}`;
  }
};
$('btnExport').onclick = () => {
  const blob = new Blob([serialize(ui.map, ui.initialPlan, ui.edits, ui.sim.tick)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `yard-scheduler-${ui.map.name}-t${ui.sim.tick}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('btnImport').onclick = () => $<HTMLInputElement>('importFile').click();
$('importFile').onchange = async () => {
  const f = $<HTMLInputElement>('importFile').files?.[0];
  if (!f) return;
  try {
    loadFromSave(await f.text());
    $('ioMsg').textContent = `已导入 ${f.name}`;
  } catch (e) {
    $('ioMsg').textContent = `导入失败:${(e as Error).message}`;
  }
};

function loadFromSave(json: string): void {
  const save = parseSave(json);
  ui.map = save.map;
  ui.scenarioId = '(存档)';
  ui.initialPlan = deepCopyPlan(save.initialPlan);
  ui.edits = save.edits;
  const { sim, plan } = replay(ui.map, ui.initialPlan, ui.edits, save.tick);
  ui.sim = sim;
  ui.plan = plan;
  ui.playing = false;
  ui.selected = ui.map.vehicles[0]?.id ?? '';
  ui.routeEditing = false;
  ui.draftRoute = null;
  ui.message = '';
  ui.sidebarDirty = true;
  $('scenarioDesc').textContent = '从存档载入的地图与计划';
}

// 场景选择
{
  const sel = $('scenarioSelect');
  for (const sc of SCENARIOS) {
    const o = document.createElement('option');
    o.value = sc.id;
    o.textContent = sc.title;
    sel.appendChild(o);
  }
  sel.onchange = () => loadScenario(scenarioById((sel as HTMLSelectElement).value));
}

// ---------- 主循环 ----------

let lastTime = performance.now();
let acc = 0;
let lastSidebarTick = -1;

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastTime) / 1000);
  lastTime = now;
  if (ui.playing && !ui.sim.done) {
    acc += dt * ui.speed;
    while (acc >= 1 && !ui.sim.done) {
      ui.sim.step();
      acc -= 1;
    }
    if (ui.sim.done) { ui.playing = false; ui.sidebarDirty = true; }
  }
  if (ui.sim.tick !== lastSidebarTick || ui.sidebarDirty) {
    lastSidebarTick = ui.sim.tick;
    ui.sidebarDirty = false;
    renderSidebar();
  }
  drawMap();
  drawTimeline();
  requestAnimationFrame(frame);
}

loadScenario(SCENARIOS[0]!);
requestAnimationFrame(frame);
