/**
 * 确定性离散时隙模拟器。
 *
 * 每个时隙 t 的处理顺序(车辆一律按 id 排序,结果与显示速度、机器无关):
 *   1. 卸货完成(until == t)的车辆送达,释放月台车位;
 *   2. "离开"一轮:到达路段终点(plannedExit == t)或滞留重试(plannedExit < t)
 *      的车辆,尝试进入下一路段;进不去且节点有等待车位则下车等待,
 *      否则滞留在原路段上(占用延长)——窄巷死锁即由此产生;
 *   3. 到点起步(depart == t)的车辆进入出发节点;
 *   4. 在节点等待的车辆尝试进入下一路段;
 *   5. 死锁检测:构造"等待-占用"图,发现环即判定死锁并停机;
 *   6. 截止判定 / 全部送达判定。
 *
 * 占用一律半开区间 [enter, exit):同一时隙离开与进入互不冲突。
 */

import {
  YardMap, Plan, VehiclePlan,
  nodeOf, edgeOf, vehicleOf, otherEnd, dirOf, waitCapacityOf, dockSlotsOf,
} from './model.js';

export type Dir = 1 | -1;

export interface EdgeOcc {
  vehicle: string;
  enter: number;
  exit: number | null; // null = 仍在占用(途中或滞留)
  dir: Dir;
}

export interface DockOcc {
  vehicle: string;
  start: number; // 预约/占用起点(到达时隙)
  end: number;   // 卸货完成时隙
}

export type VehiclePhase =
  | 'pending'    // 未到起步时隙
  | 'atNode'     // 在节点等待
  | 'onEdge'     // 在路段上(行驶中或滞留)
  | 'unloading'  // 在月台卸货
  | 'delivered'  // 已送达
  | 'failed';    // 计划错误

export interface VehicleState {
  phase: VehiclePhase;
  node: string | null;   // atNode / unloading 时有效
  edge: string | null;   // onEdge 时有效
  dir: Dir;
  enter: number;         // 进入当前路段的时隙
  plannedExit: number;   // 预计离开当前路段的时隙(滞留时成为过去)
  routeIndex: number;    // 下一条要走的路段在 plan.route 中的下标
  until: number;         // unloading:卸货完成时隙
  waitingSince: number | null;
}

export type EventKind =
  | 'depart' | 'depart-delayed'
  | 'enter-edge' | 'exit-edge'
  | 'wait-start' | 'wait-end'
  | 'dock-start' | 'delivered'
  | 'plan-error';

export interface SimEvent {
  tick: number;
  kind: EventKind;
  vehicle: string;
  edge?: string;
  node?: string;
  detail?: string;
}

export type ConflictKind = 'deadlock' | 'deadline' | 'plan-error';

export interface Conflict {
  tick: number;
  kind: ConflictKind;
  vehicles: string[];
  /** 冲突位置:每辆车所在的路段或节点 id。 */
  location: string[];
  detail: string;
}

export type SimStatus = 'running' | 'success' | 'deadlock' | 'deadline' | 'error';

const WIDE_DIR_CAPACITY = 2;

export class Sim {
  readonly map: YardMap;
  readonly plan: Plan;
  readonly maxTick: number;

  tick = 0;
  states: Record<string, VehicleState> = {};
  edgeOcc: Record<string, EdgeOcc[]> = {};
  dockOcc: Record<string, DockOcc[]> = {};
  events: SimEvent[] = [];
  conflicts: Conflict[] = [];
  status: SimStatus = 'running';
  /** 每辆车当前被谁挡住,供 UI 展示。 */
  blockedBy: Record<string, string[]> = {};

  constructor(map: YardMap, plan: Plan, maxTick = 4000) {
    this.map = map;
    this.plan = plan;
    this.maxTick = maxTick;
    for (const v of map.vehicles) {
      this.states[v.id] = {
        phase: 'pending', node: null, edge: null, dir: 1,
        enter: 0, plannedExit: 0, routeIndex: 0, until: 0, waitingSince: null,
      };
    }
    for (const e of map.edges) this.edgeOcc[e.id] = [];
    for (const n of map.nodes) if (n.kind === 'dock') this.dockOcc[n.id] = [];
    for (const v of map.vehicles) {
      const err = validateRoute(map, v.id, plan[v.id]);
      if (err) {
        this.events.push({ tick: 0, kind: 'plan-error', vehicle: v.id, detail: err });
        this.conflicts.push({ tick: 0, kind: 'plan-error', vehicles: [v.id], location: [v.start], detail: err });
        this.status = 'error';
        return;
      }
    }
  }

  get done(): boolean {
    return this.status !== 'running';
  }

  private emit(e: SimEvent): void {
    this.events.push(e);
  }

  /** 与区间 [t, t+len) 重叠、且不是本车的路段占用者。 */
  private edgeBlockers(edgeId: string, dir: Dir, t: number, len: number, self: string): string[] {
    const edge = edgeOf(this.map, edgeId);
    const overlapping = this.edgeOcc[edgeId]!.filter(
      (o) => o.vehicle !== self && o.enter < t + len && (o.exit === null || t < o.exit),
    );
    if (edge.narrow) {
      return overlapping.map((o) => o.vehicle);
    }
    const sameDir = overlapping.filter((o) => o.dir === dir);
    return sameDir.length >= WIDE_DIR_CAPACITY ? sameDir.map((o) => o.vehicle) : [];
  }

  /** 与区间 [start, end) 冲突的月台占用/预约者(不含本车)。 */
  private dockBlockers(dockId: string, start: number, end: number, self: string): string[] {
    const slots = dockSlotsOf(nodeOf(this.map, dockId));
    const occ = (this.dockOcc[dockId] ?? []).filter(
      (o) => o.vehicle !== self && o.start < end && start < o.end,
    );
    if (occ.length === 0) return [];
    const blockers = new Set<string>();
    for (let s = start; s < end; s++) {
      let used = 0;
      for (const o of occ) if (o.start <= s && s < o.end) { used++; blockers.add(o.vehicle); }
      if (used >= slots) return [...blockers].sort();
    }
    return [];
  }

  private waitUsed(nodeId: string): number {
    let n = 0;
    for (const id of Object.keys(this.states)) {
      const s = this.states[id]!;
      if (s.phase === 'atNode' && s.node === nodeId) n++;
    }
    return n;
  }

  private startWaiting(id: string, t: number, detail: string): void {
    const s = this.states[id]!;
    if (s.waitingSince === null) {
      s.waitingSince = t;
      this.emit({ tick: t, kind: 'wait-start', vehicle: id, edge: s.edge ?? undefined, node: s.node ?? undefined, detail });
    }
  }

  private stopWaiting(id: string, t: number): void {
    const s = this.states[id]!;
    if (s.waitingSince !== null) {
      s.waitingSince = null;
      this.emit({ tick: t, kind: 'wait-end', vehicle: id });
    }
  }

  /**
   * 纯查询:车辆从节点 from 现在(t)进入计划下一路段,会被谁挡住。
   * 返回 null 表示可以进入;返回数组(可能为空,表示计划错误)表示进不去。
   */
  private nextMoveBlockers(id: string, from: string, t: number): string[] | null {
    const s = this.states[id]!;
    const vp: VehiclePlan = this.plan[id]!;
    if (s.routeIndex >= vp.route.length) {
      this.failPlan(id, t, `路线在节点 ${from} 处已走完,但未到达目的地月台`);
      return [];
    }
    const edgeId = vp.route[s.routeIndex]!;
    const edge = edgeOf(this.map, edgeId);
    const exitNode = otherEnd(edge, from);
    if (exitNode === null) {
      this.failPlan(id, t, `路段 ${edgeId} 不能从 ${from} 驶入(方向不符或不相连)`);
      return [];
    }
    const isFinal = s.routeIndex === vp.route.length - 1;
    const destDock = vehicleOf(this.map, id).destDock;
    if (isFinal && exitNode !== destDock) {
      this.failPlan(id, t, `路线终点是 ${exitNode},但本车目的地是 ${destDock}`);
      return [];
    }
    if (!isFinal && nodeOf(this.map, exitNode).kind === 'dock') {
      this.failPlan(id, t, `路线中途穿过月台 ${exitNode},月台只能作为终点`);
      return [];
    }
    const dir = dirOf(edge, from);
    const edgeB = this.edgeBlockers(edgeId, dir, t, edge.ticks, id);
    if (edgeB.length > 0) return edgeB;
    if (isFinal) {
      const arrive = t + edge.ticks;
      const unload = vehicleOf(this.map, id).unloadTicks;
      const dockB = this.dockBlockers(destDock, arrive, arrive + unload, id);
      if (dockB.length > 0) return dockB;
    }
    return null;
  }

  /** 执行进入下一路段(调用前须确认 nextMoveBlockers 返回 null)。 */
  private enterNext(id: string, from: string, t: number): void {
    const s = this.states[id]!;
    const vp = this.plan[id]!;
    const edgeId = vp.route[s.routeIndex]!;
    const edge = edgeOf(this.map, edgeId);
    const dir = dirOf(edge, from);
    const isFinal = s.routeIndex === vp.route.length - 1;
    if (isFinal) {
      const destDock = vehicleOf(this.map, id).destDock;
      const arrive = t + edge.ticks;
      const unload = vehicleOf(this.map, id).unloadTicks;
      this.dockOcc[destDock]!.push({ vehicle: id, start: arrive, end: arrive + unload });
    }
    s.routeIndex++;
    s.phase = 'onEdge';
    s.edge = edgeId;
    s.node = null;
    s.dir = dir;
    s.enter = t;
    s.plannedExit = t + edge.ticks;
    this.edgeOcc[edgeId]!.push({ vehicle: id, enter: t, exit: null, dir });
    this.emit({ tick: t, kind: 'enter-edge', vehicle: id, edge: edgeId });
  }

  private failPlan(id: string, t: number, detail: string): void {
    const s = this.states[id]!;
    if (s.phase === 'failed') return;
    s.phase = 'failed';
    this.emit({ tick: t, kind: 'plan-error', vehicle: id, detail });
    this.conflicts.push({ tick: t, kind: 'plan-error', vehicles: [id], location: [s.node ?? s.edge ?? ''], detail });
    this.status = 'error';
  }

  private closeEdgeOcc(id: string, edgeId: string, t: number): void {
    const occ = this.edgeOcc[edgeId]!;
    for (let i = occ.length - 1; i >= 0; i--) {
      if (occ[i]!.vehicle === id && occ[i]!.exit === null) {
        occ[i]!.exit = t;
        return;
      }
    }
  }

  /** 推进一个时隙。 */
  step(): void {
    if (this.done) return;
    const t = this.tick;
    const ids = this.map.vehicles.map((v) => v.id).sort();

    // 1. 卸货完成
    for (const id of ids) {
      const s = this.states[id]!;
      if (s.phase === 'unloading' && s.until === t) {
        s.phase = 'delivered';
        this.emit({ tick: t, kind: 'delivered', vehicle: id, node: s.node ?? undefined });
        s.node = null;
      }
    }

    // 2. 离开:到达路段终点或滞留中的车辆,按 id 序尝试继续
    const leavers = ids.filter((id) => {
      const s = this.states[id]!;
      return s.phase === 'onEdge' && s.plannedExit <= t;
    });
    for (const id of leavers) {
      const s = this.states[id]!;
      const prevEdge = s.edge!;
      const edge = edgeOf(this.map, prevEdge);
      const node = s.dir === 1 ? edge.b : edge.a;
      if (s.routeIndex >= this.plan[id]!.route.length) {
        // 到达终点月台(车位已在进入末段时预约)
        this.closeEdgeOcc(id, prevEdge, t);
        this.emit({ tick: t, kind: 'exit-edge', vehicle: id, edge: prevEdge });
        s.phase = 'unloading';
        s.node = node;
        s.edge = null;
        s.until = t + vehicleOf(this.map, id).unloadTicks;
        this.stopWaiting(id, t);
        delete this.blockedBy[id];
        this.emit({ tick: t, kind: 'dock-start', vehicle: id, node });
        continue;
      }
      const blockers = this.nextMoveBlockers(id, node, t);
      if (blockers === null) {
        this.closeEdgeOcc(id, prevEdge, t);
        this.emit({ tick: t, kind: 'exit-edge', vehicle: id, edge: prevEdge });
        this.enterNext(id, node, t);
        this.stopWaiting(id, t);
        delete this.blockedBy[id];
      } else if (blockers.length === 0) {
        this.closeEdgeOcc(id, prevEdge, t); // 计划错误,已记录
      } else {
        this.blockedBy[id] = blockers;
        if (this.waitUsed(node) < waitCapacityOf(nodeOf(this.map, node))) {
          this.closeEdgeOcc(id, prevEdge, t);
          this.emit({ tick: t, kind: 'exit-edge', vehicle: id, edge: prevEdge });
          s.phase = 'atNode';
          s.node = node;
          s.edge = null;
          this.startWaiting(id, t, `在 ${node} 等待,被 ${blockers.join('、')} 挡住`);
        } else {
          this.startWaiting(id, t, `滞留在 ${prevEdge},节点 ${node} 无等待车位`);
        }
      }
    }

    // 3. 起步
    for (const id of ids) {
      const s = this.states[id]!;
      if (s.phase !== 'pending') continue;
      const depart = this.plan[id]!.depart;
      if (depart > t) continue;
      const start = vehicleOf(this.map, id).start;
      if (this.waitUsed(start) >= waitCapacityOf(nodeOf(this.map, start))) {
        if (depart === t) this.emit({ tick: t, kind: 'depart-delayed', vehicle: id, node: start, detail: '出发节点等待车位已满' });
        continue;
      }
      s.phase = 'atNode';
      s.node = start;
      this.emit({ tick: t, kind: 'depart', vehicle: id, node: start });
    }

    // 4. 节点等待车辆尝试进入下一路段
    for (const id of ids) {
      const s = this.states[id]!;
      if (s.phase !== 'atNode') continue;
      const blockers = this.nextMoveBlockers(id, s.node!, t);
      if (blockers === null) {
        this.enterNext(id, s.node!, t);
        this.stopWaiting(id, t);
        delete this.blockedBy[id];
      } else if (blockers.length > 0) {
        this.blockedBy[id] = blockers;
        this.startWaiting(id, t, `在 ${s.node} 等待,被 ${blockers.join('、')} 挡住`);
      }
    }

    // 5. 死锁检测
    this.detectDeadlock(t);
    if (this.done) { this.tick = t + 1; return; }

    // 6. 截止 / 成功判定
    if (t >= this.map.deadline) {
      const late = ids.filter((id) => {
        const ph = this.states[id]!.phase;
        return ph !== 'delivered' && ph !== 'failed';
      });
      if (late.length > 0) {
        for (const id of late) {
          const s = this.states[id]!;
          this.conflicts.push({
            tick: t, kind: 'deadline', vehicles: [id],
            location: [s.edge ?? s.node ?? vehicleOf(this.map, id).start],
            detail: `超过截止时隙 ${this.map.deadline} 仍未送达`,
          });
        }
        this.status = 'deadline';
        this.tick = t + 1;
        return;
      }
    }
    if (ids.every((id) => this.states[id]!.phase === 'delivered')) {
      this.status = 'success';
    }
    if (t > this.maxTick) {
      this.conflicts.push({ tick: t, kind: 'deadlock', vehicles: [], location: [], detail: '超过最大模拟时隙,判定无法推进' });
      this.status = 'deadlock';
    }
    this.tick = t + 1;
  }

  /**
   * 等待-占用图:等待/滞留车辆 -> 它下一步被谁挡住。
   * 只取"下一步移动的阻挡者"(路段占用者、月台车位占用者):
   * 节点等待车位只是车辆排队的位置,不构成分死锁的等待关系——
   * 滞留车辆在下一路段清空后会直接进入,并不需要等待车位。
   * blockedBy 每时隙对等待/滞留车辆重算,因此图中被等的一定是
   * 当前同样动不了的车辆;有环即永远无法推进。
   */
  private waitForEdges(): Map<string, string[]> {
    const g = new Map<string, string[]>();
    for (const id of Object.keys(this.states).sort()) {
      const blockers = this.blockedBy[id];
      if (blockers && blockers.length > 0) g.set(id, blockers);
    }
    return g;
  }

  private detectDeadlock(t: number): void {
    const g = this.waitForEdges();
    const mark = new Map<string, number>(); // 0=未访问 1=在栈上 2=已完成
    const stack: string[] = [];
    const visit = (v: string): string[] | null => {
      mark.set(v, 1);
      stack.push(v);
      for (const w of g.get(v) ?? []) {
        const st = mark.get(w) ?? 0;
        if (st === 1) return stack.slice(stack.indexOf(w)).concat(w);
        if (st === 0) {
          const r = visit(w);
          if (r) return r;
        }
      }
      stack.pop();
      mark.set(v, 2);
      return null;
    };
    for (const v of [...g.keys()].sort()) {
      if ((mark.get(v) ?? 0) === 0) {
        const cycle = visit(v);
        if (cycle) {
          const vehicles = cycle.slice(0, -1);
          const location = vehicles.map((id) => {
            const s = this.states[id]!;
            return s.edge ?? s.node ?? '';
          });
          this.conflicts.push({
            tick: t, kind: 'deadlock', vehicles, location,
            detail: `互相等待形成死锁: ${vehicles.join(' → ')} → ${vehicles[0]}`,
          });
          this.status = 'deadlock';
          return;
        }
      }
    }
  }

  run(toTick: number): void {
    while (!this.done && this.tick < toTick) this.step();
  }

  runToEnd(): void {
    while (!this.done) this.step();
  }

  /** 可 JSON 序列化的快照(用于暂停/回退/存档后的确定性重放)。 */
  snapshot(): SimSnapshot {
    return JSON.parse(JSON.stringify({
      tick: this.tick, states: this.states, edgeOcc: this.edgeOcc, dockOcc: this.dockOcc,
      events: this.events, conflicts: this.conflicts, status: this.status, blockedBy: this.blockedBy,
    })) as SimSnapshot;
  }

  static restore(map: YardMap, plan: Plan, snap: SimSnapshot): Sim {
    const sim = new Sim(map, plan);
    sim.tick = snap.tick;
    sim.states = snap.states;
    sim.edgeOcc = snap.edgeOcc;
    sim.dockOcc = snap.dockOcc;
    sim.events = snap.events;
    sim.conflicts = snap.conflicts;
    sim.status = snap.status;
    sim.blockedBy = snap.blockedBy;
    return sim;
  }
}

export interface SimSnapshot {
  tick: number;
  states: Record<string, VehicleState>;
  edgeOcc: Record<string, EdgeOcc[]>;
  dockOcc: Record<string, DockOcc[]>;
  events: SimEvent[];
  conflicts: Conflict[];
  status: SimStatus;
  blockedBy: Record<string, string[]>;
}

/** 静态路线校验:连通性、方向、终点必须是本车目的地月台、中途不穿过月台。 */
export function validateRoute(map: YardMap, vehicleId: string, vp: VehiclePlan | undefined): string | null {
  if (!vp) return '缺少计划';
  if (!Number.isInteger(vp.depart) || vp.depart < 0) return '起步时隙必须是非负整数';
  if (vp.route.length === 0) return '路线为空';
  const v = vehicleOf(map, vehicleId);
  let at = v.start;
  for (let i = 0; i < vp.route.length; i++) {
    const edgeId = vp.route[i]!;
    const edge = map.edges.find((e) => e.id === edgeId);
    if (!edge) return `路线包含未知路段 ${edgeId}`;
    const next = otherEnd(edge, at);
    if (next === null) return `路段 ${edgeId} 不能从 ${at} 驶入`;
    if (i < vp.route.length - 1 && nodeOf(map, next).kind === 'dock') {
      return `路线中途穿过月台 ${next}`;
    }
    at = next;
  }
  if (at !== v.destDock) return `路线终点是 ${at},目的地月台是 ${v.destDock}`;
  return null;
}
