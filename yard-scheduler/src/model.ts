/**
 * 货场调度演练 —— 数据模型。
 *
 * 时间模型:离散整数时隙(tick)。所有占用区间都是半开区间 [start, end):
 * 某车占用路段 [t, t+len) 意味着另一台车可以在 t+len 这一刻进入同一路段。
 * 月台停车位同理。全系统只有这一条边界约定,结算与展示共用。
 */

export type NodeKind = 'yard' | 'junction' | 'dock';

export interface NodeDef {
  id: string;
  name: string;
  x: number;
  y: number;
  kind: NodeKind;
  /** 可在节点内等待的车位上限。缺省:货场 4,岔口 1,月台 0(月台不允许停留)。 */
  waitCapacity?: number;
  /** 仅月台:同时卸货的停车位数。 */
  dockSlots?: number;
}

export interface EdgeDef {
  id: string;
  /** 端点 a -> b;bidirectional 时双向可通行。 */
  a: string;
  b: string;
  /** 通过所需时隙数。 */
  ticks: number;
  bidirectional: boolean;
  /** 窄路段:双向合计同时只允许一台车;宽路段:每个方向允许两台。 */
  narrow: boolean;
}

export interface VehicleDef {
  id: string;
  name: string;
  color: string;
  /** 出发节点。 */
  start: string;
  /** 货物目的地月台。 */
  destDock: string;
  /** 到达月台后卸货所需时隙数。 */
  unloadTicks: number;
}

export interface YardMap {
  name: string;
  /** 截止时隙:所有货物必须在该时隙前(含)送达。 */
  deadline: number;
  nodes: NodeDef[];
  edges: EdgeDef[];
  vehicles: VehicleDef[];
}

/** 一台车的计划:起步时隙 + 依次经过的路段 id。 */
export interface VehiclePlan {
  depart: number;
  route: string[];
}

export type Plan = Record<string, VehiclePlan>;

export function nodeOf(map: YardMap, id: string): NodeDef {
  const n = map.nodes.find((n) => n.id === id);
  if (!n) throw new Error(`未知节点: ${id}`);
  return n;
}

export function edgeOf(map: YardMap, id: string): EdgeDef {
  const e = map.edges.find((e) => e.id === id);
  if (!e) throw new Error(`未知路段: ${id}`);
  return e;
}

export function vehicleOf(map: YardMap, id: string): VehicleDef {
  const v = map.vehicles.find((v) => v.id === id);
  if (!v) throw new Error(`未知车辆: ${id}`);
  return v;
}

export function waitCapacityOf(node: NodeDef): number {
  if (node.waitCapacity !== undefined) return node.waitCapacity;
  if (node.kind === 'yard') return 4;
  if (node.kind === 'junction') return 1;
  return 0; // dock
}

export function dockSlotsOf(node: NodeDef): number {
  return node.dockSlots ?? 1;
}

/**
 * 从 from 端看,这条路段通向的另一个节点;方向不允许时返回 null。
 * dir 约定:+1 表示 a->b,-1 表示 b->a。
 */
export function otherEnd(edge: EdgeDef, from: string): string | null {
  if (edge.a === from) return edge.b;
  if (edge.b === from && edge.bidirectional) return edge.a;
  return null;
}

/** 沿 from -> to 方向通过路段的方向标记。 */
export function dirOf(edge: EdgeDef, from: string): 1 | -1 {
  return edge.a === from ? 1 : -1;
}

/** 找出直接连接两个节点的路段(方向须允许 from -> to)。多条时取第一条。 */
export function edgeBetween(map: YardMap, from: string, to: string): EdgeDef | null {
  for (const e of map.edges) {
    if (otherEnd(e, from) === to) return e;
  }
  return null;
}
