/**
 * 计划编辑规则与存档/重放。
 *
 * 编辑规则(在时隙 t 暂停时):
 *  - 已送达 / 卸货中的车辆:禁止任何修改(防止货物重复送达);
 *  - 起步时隙:仅当车辆尚未起步(pending)时可改,且必须大于当前时隙;
 *  - 路线:已经走过的路段(含正在行驶的路段)是锁定前缀,不可改写;
 *    只能重写剩余后缀,新后缀必须从锁定前缀的终点继续 —— 车辆不会瞬移。
 *
 * 存档 = 初始地图 + 初始计划 + 带时隙的编辑记录 + 当前时隙。
 * 重放 = 从 0 开始逐步模拟,在每条编辑记录的时隙应用编辑,
 * 因此重新载入后能重现同一过程;模拟不依赖墙钟,显示速度不影响结果。
 */

import { YardMap, Plan, VehiclePlan, vehicleOf, otherEnd } from './model.js';
import { Sim, validateRoute } from './sim.js';

export interface Edit {
  tick: number;
  vehicle: string;
  depart?: number;
  route?: string[];
}

export interface SaveFile {
  version: 1;
  map: YardMap;
  initialPlan: Plan;
  edits: Edit[];
  tick: number;
}

/** 车辆已锁定(不可改写)的路线前缀长度。 */
export function lockedPrefixLen(sim: Sim, vehicleId: string): number {
  const s = sim.states[vehicleId]!;
  if (s.phase === 'pending') return 0;
  if (s.phase === 'atNode' || s.phase === 'onEdge') return s.routeIndex;
  return Infinity; // unloading / delivered / failed
}

/**
 * 校验一次编辑。返回 null 表示合法,否则返回错误原因。
 * 注意:校验通过后应直接把 route/depart 写入 plan。
 */
export function validateEdit(sim: Sim, vehicleId: string, edit: Edit): string | null {
  const map = sim.map;
  const s = sim.states[vehicleId];
  if (!s) return `未知车辆 ${vehicleId}`;
  if (s.phase === 'delivered') return '货物已送达,不能再修改';
  if (s.phase === 'unloading') return '车辆正在月台卸货,不能再修改';
  if (s.phase === 'failed') return '该车辆计划已出错,请回退后修改';

  if (edit.depart !== undefined) {
    if (s.phase !== 'pending') return '车辆已起步,不能再改起步时隙';
    if (!Number.isInteger(edit.depart) || edit.depart <= sim.tick) {
      return `起步时隙必须是大于当前时隙 ${sim.tick} 的整数`;
    }
  }

  if (edit.route !== undefined) {
    const cur = sim.plan[vehicleId]!;
    const locked = lockedPrefixLen(sim, vehicleId);
    const prefix = cur.route.slice(0, locked);
    const next = edit.route;
    if (next.length < prefix.length || prefix.some((e, i) => next[i] !== e)) {
      return '不能改写已经走过的路段(车辆不会瞬移)';
    }
    const candidate: VehiclePlan = {
      depart: edit.depart ?? cur.depart,
      route: next,
    };
    const err = validateRoute(map, vehicleId, candidate);
    if (err) return err;
  }
  return null;
}

/** 应用编辑(调用前须通过 validateEdit)。 */
export function applyEdit(plan: Plan, edit: Edit): void {
  const vp = plan[edit.vehicle]!;
  if (edit.depart !== undefined) vp.depart = edit.depart;
  if (edit.route !== undefined) vp.route = [...edit.route];
}

export function deepCopyPlan(plan: Plan): Plan {
  const out: Plan = {};
  for (const [k, v] of Object.entries(plan)) out[k] = { depart: v.depart, route: [...v.route] };
  return out;
}

/**
 * 确定性重放:从初始计划出发,按时隙应用编辑记录,模拟到 targetTick。
 * 返回 (模拟器, 工作计划)。edits 会被按 tick 排序后应用;tick > targetTick 的编辑被忽略。
 */
export function replay(map: YardMap, initialPlan: Plan, edits: Edit[], targetTick: number): { sim: Sim; plan: Plan } {
  const plan = deepCopyPlan(initialPlan);
  const sim = new Sim(map, plan);
  const sorted = [...edits].filter((e) => e.tick <= targetTick).sort((a, b) => a.tick - b.tick);
  let ei = 0;
  while (!sim.done && sim.tick < targetTick) {
    while (ei < sorted.length && sorted[ei]!.tick === sim.tick) {
      applyEdit(plan, sorted[ei]!);
      ei++;
    }
    sim.step();
  }
  while (ei < sorted.length && sorted[ei]!.tick === sim.tick) {
    applyEdit(plan, sorted[ei]!);
    ei++;
  }
  return { sim, plan };
}

export function serialize(map: YardMap, initialPlan: Plan, edits: Edit[], tick: number): string {
  const save: SaveFile = { version: 1, map, initialPlan, edits, tick };
  return JSON.stringify(save, null, 2);
}

export function parseSave(json: string): SaveFile {
  const data = JSON.parse(json) as SaveFile;
  if (data.version !== 1) throw new Error(`不支持的存档版本: ${String(data.version)}`);
  if (!data.map || !data.initialPlan || !Array.isArray(data.edits)) throw new Error('存档格式不完整');
  return data;
}

/** 路线在某一车辆状态下的"可编辑起点"节点:后缀必须从这里继续。 */
export function editableFromNode(map: YardMap, sim: Sim, vehicleId: string): string | null {
  const s = sim.states[vehicleId]!;
  if (s.phase === 'pending') return vehicleOf(map, vehicleId).start;
  if (s.phase === 'atNode') return s.node;
  if (s.phase === 'onEdge') {
    const vp = sim.plan[vehicleId]!;
    // 正在行驶的路段的终点
    const edgeId = vp.route[s.routeIndex - 1];
    if (!edgeId) return null;
    const edge = map.edges.find((e) => e.id === edgeId)!;
    return otherEnd(edge, s.dir === 1 ? edge.a : edge.b);
  }
  return null;
}
