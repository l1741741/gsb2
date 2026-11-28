import type {
  EdgeSpec,
  GateSpec,
  GateState,
  GoalSpec,
  LevelSpec,
  PoolSpec,
} from './types.ts';

/** 关卡校验失败时抛出的错误，携带逐条问题，便于定位本地关卡数据。 */
export class LevelError extends Error {
  readonly code = 'invalid-level';
  readonly issues: readonly string[];

  constructor(levelId: string, issues: readonly string[]) {
    super(`关卡 ${levelId} 无效：${issues.join('；')}`);
    this.name = 'LevelError';
    this.issues = issues;
  }
}

/** 校验后的池子：补齐默认值，容量溢流线就是 capacity。 */
export interface CompiledPool {
  readonly id: string;
  readonly spec: PoolSpec;
  readonly inflow: number;
  readonly drain: number;
  readonly maintenance: boolean;
  readonly safeLevel: number;
  readonly overflowTo: string | null;
}

/**
 * 校验、补默认值并按结算需要的顺序整理过的关卡。
 * 结算只读取这里的结构，不再触碰原始数组顺序。
 */
export interface CompiledLevel {
  readonly spec: LevelSpec;
  readonly fingerprint: string;
  readonly pools: ReadonlyMap<string, CompiledPool>;
  readonly gates: ReadonlyMap<string, GateSpec>;
  /** 池子的结算顺序：高程从高到低，高程相同按 id 升序。 */
  readonly poolOrder: readonly string[];
  /** 每池的出边，按 id 升序。 */
  readonly outgoing: ReadonlyMap<string, readonly EdgeSpec[]>;
  /** 每条闸门实际控制的支路 id（按 id 升序）。 */
  readonly gateControls: ReadonlyMap<string, readonly string[]>;
  readonly goal: GoalSpec;
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 稳定地把对象转成字符串：对象键按字典序排列、数组保持给定顺序。
 * 用于计算关卡指纹，保证同一内容总是得到同一字符串。
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareIds);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

/** FNV-1a 64 位，输出 16 位十六进制。只依赖 BigInt，浏览器和 Node 都可用。 */
export function fingerprintOf(value: unknown): string {
  const text = canonicalize(value);
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of bytes) {
    hash = (hash ^ BigInt(byte)) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/** 指纹只覆盖影响结算与判定的内容，绘制坐标变化不会导致记录被拒。 */
function fingerprintPayload(level: LevelSpec): unknown {
  const pools = [...level.pools].sort((a, b) => compareIds(a.id, b.id)).map((pool) => ({
    id: pool.id,
    elevation: pool.elevation,
    capacity: pool.capacity,
    initial: pool.initial,
    inflow: pool.inflow ?? 0,
    drain: pool.drain ?? 0,
    maintenance: pool.maintenance ?? false,
    safeLevel: pool.safeLevel ?? pool.capacity,
    overflowTo: pool.overflowTo ?? null,
  }));
  const gates = [...level.gates].sort((a, b) => compareIds(a.id, b.id)).map((gate) => ({
    id: gate.id,
    initial: gate.initial,
  }));
  const edges = [...level.edges].sort((a, b) => compareIds(a.id, b.id)).map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    capacity: edge.capacity,
    gate: edge.gate ?? null,
  }));
  return {
    id: level.id,
    turns: level.turns,
    goal: { pool: level.goal.pool, atLeast: level.goal.atLeast },
    pools,
    gates,
    edges,
  };
}

/**
 * 校验一个本地关卡并生成结算结构。
 * 任何会影响结果的数据不合法都会抛 LevelError，而不是静默容错。
 */
export function compileLevel(level: LevelSpec): CompiledLevel {
  const issues: string[] = [];
  const levelId = level.id;

  if (typeof levelId !== 'string' || levelId.length === 0) issues.push('id 必须是非空字符串');
  if (typeof level.name !== 'string' || level.name.length === 0) issues.push('name 必须是非空字符串');
  if (!isInteger(level.turns) || level.turns < 1) issues.push('turns 必须是正整数');

  const pools = new Map<string, PoolSpec>();
  for (const pool of level.pools ?? []) {
    const prefix = `pool ${pool.id}`;
    if (typeof pool.id !== 'string' || pool.id.length === 0) {
      issues.push('池子 id 必须是非空字符串');
      continue;
    }
    if (pools.has(pool.id)) issues.push(`${prefix}: id 重复`);
    if (!Number.isFinite(pool.elevation)) issues.push(`${prefix}: elevation 必须是有限数`);
    if (!isInteger(pool.capacity) || pool.capacity < 1) issues.push(`${prefix}: capacity 必须是正整数`);
    if (!isInteger(pool.initial) || pool.initial < 0 || pool.initial > pool.capacity) {
      issues.push(`${prefix}: initial 必须是 0..capacity 的整数`);
    }
    if (pool.inflow !== undefined && (!isInteger(pool.inflow) || pool.inflow < 0)) {
      issues.push(`${prefix}: inflow 必须是非负整数`);
    }
    if (pool.drain !== undefined && (!isInteger(pool.drain) || pool.drain < 0)) {
      issues.push(`${prefix}: drain 必须是非负整数`);
    }
    if (pool.safeLevel !== undefined
      && (!isInteger(pool.safeLevel) || pool.safeLevel < 0 || pool.safeLevel > pool.capacity)) {
      issues.push(`${prefix}: safeLevel 必须在 0..capacity 之间`);
    }
    if (pool.overflowTo !== undefined && pool.overflowTo !== null
      && (typeof pool.overflowTo !== 'string' || pool.overflowTo.length === 0)) {
      issues.push(`${prefix}: overflowTo 必须是池子 id 或 null`);
    }
    const layout = pool.layout;
    if (!layout || ![layout.x, layout.y, layout.width, layout.height].every(Number.isFinite)) {
      issues.push(`${prefix}: layout 的 x/y/width/height 必须是有限数`);
    } else if (layout.width <= 0 || layout.height <= 0) {
      issues.push(`${prefix}: layout 的 width/height 必须为正`);
    }
    pools.set(pool.id, pool);
  }

  const gates = new Map<string, GateSpec>();
  for (const gate of level.gates ?? []) {
    const prefix = `gate ${gate.id}`;
    if (typeof gate.id !== 'string' || gate.id.length === 0) {
      issues.push('闸门 id 必须是非空字符串');
      continue;
    }
    if (gates.has(gate.id)) issues.push(`${prefix}: id 重复`);
    if (gate.initial !== 'open' && gate.initial !== 'closed') {
      issues.push(`${prefix}: initial 必须是 open 或 closed`);
    }
    if (gate.layout && (![gate.layout.x, gate.layout.y].every(Number.isFinite))) {
      issues.push(`${prefix}: layout 的 x/y 必须是有限数`);
    }
    gates.set(gate.id, gate);
  }

  const edgeIds = new Set<string>();
  const endpointPairs = new Set<string>();
  const outgoing = new Map<string, EdgeSpec[]>();
  for (const pool of pools.keys()) outgoing.set(pool, []);

  for (const edge of level.edges ?? []) {
    const prefix = `edge ${edge.id}`;
    if (typeof edge.id !== 'string' || edge.id.length === 0) {
      issues.push('支路 id 必须是非空字符串');
      continue;
    }
    if (edgeIds.has(edge.id)) issues.push(`${prefix}: id 重复`);
    edgeIds.add(edge.id);
    const from = pools.get(edge.from);
    const to = pools.get(edge.to);
    if (!from) issues.push(`${prefix}: 起点 ${edge.from} 不存在`);
    if (!to) issues.push(`${prefix}: 终点 ${edge.to} 不存在`);
    if (from && to) {
      if (edge.from === edge.to) issues.push(`${prefix}: 起点与终点不能相同`);
      else if (!(from.elevation > to.elevation)) {
        issues.push(`${prefix}: 水只能从高处流向低处（${edge.from} 高程必须大于 ${edge.to}）`);
      }
      const pair = `${edge.from}->${edge.to}`;
      if (endpointPairs.has(pair)) issues.push(`${prefix}: 与另一条支路重复连接 ${pair}`);
      endpointPairs.add(pair);
    }
    if (!isInteger(edge.capacity) || edge.capacity < 1) {
      issues.push(`${prefix}: capacity 必须是正整数`);
    }
    const gateId = edge.gate ?? null;
    if (gateId !== null && !gates.has(gateId)) issues.push(`${prefix}: 闸门 ${gateId} 不存在`);
    if (edge.layout) {
      for (const point of edge.layout.points) {
        if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
          issues.push(`${prefix}: layout.points 必须都是 [x, y] 数值对`);
          break;
        }
      }
    }
    if (from && to) outgoing.get(edge.from)!.push(edge);
  }

  for (const pool of pools.values()) {
    if (pool.overflowTo === undefined || pool.overflowTo === null) continue;
    const target = pools.get(pool.overflowTo);
    if (!target) {
      issues.push(`pool ${pool.id}: overflowTo 指向不存在的池子 ${pool.overflowTo}`);
    } else if (target.id === pool.id) {
      issues.push(`pool ${pool.id}: overflowTo 不能指向自己`);
    } else if (!(target.elevation < pool.elevation)) {
      issues.push(`pool ${pool.id}: 溢流只能倒向更低的池子`);
    }
  }

  const goal = level.goal;
  if (!goal || typeof goal.pool !== 'string') {
    issues.push('goal 缺失');
  } else {
    const goalPool = pools.get(goal.pool);
    if (!goalPool) issues.push(`goal: 池子 ${goal.pool} 不存在`);
    if (!isInteger(goal.atLeast) || goal.atLeast < 0) issues.push('goal.atLeast 必须是非负整数');
    else if (goalPool && goal.atLeast > goalPool.capacity) {
      issues.push(`goal: atLeast ${goal.atLeast} 超过池子 ${goal.pool} 的容量 ${goalPool.capacity}，无法达成`);
    }
  }

  if (issues.length > 0) throw new LevelError(levelId, issues);

  const compiledPools = new Map<string, CompiledPool>();
  for (const pool of pools.values()) {
    compiledPools.set(pool.id, {
      id: pool.id,
      spec: pool,
      inflow: pool.inflow ?? 0,
      drain: pool.drain ?? 0,
      maintenance: pool.maintenance ?? false,
      safeLevel: pool.safeLevel ?? pool.capacity,
      overflowTo: pool.overflowTo ?? null,
    });
  }

  const poolOrder = [...pools.keys()].sort((a, b) => {
    const byElevation = pools.get(b)!.elevation - pools.get(a)!.elevation;
    return byElevation !== 0 ? byElevation : compareIds(a, b);
  });

  for (const [poolId, edges] of outgoing) {
    outgoing.set(poolId, [...edges].sort((a, b) => compareIds(a.id, b.id)));
  }

  const gateControls = new Map<string, string[]>();
  for (const gateId of gates.keys()) gateControls.set(gateId, []);
  for (const edge of level.edges) {
    const gateId = edge.gate ?? null;
    if (gateId !== null) gateControls.get(gateId)!.push(edge.id);
  }
  for (const [gateId, list] of gateControls) gateControls.set(gateId, [...list].sort(compareIds));

  return {
    spec: level,
    fingerprint: fingerprintOf(fingerprintPayload(level)),
    pools: compiledPools,
    gates,
    poolOrder,
    outgoing,
    gateControls,
    goal,
  };
}

/** 确定性比较工具，供测试和界面复用。 */
export { compareIds };

/** 关卡里每条闸门的初始状态，转为结算用的 Map。 */
export function initialGateStates(level: CompiledLevel): Map<string, GateState> {
  const states = new Map<string, GateState>();
  for (const gate of level.gates.values()) states.set(gate.id, gate.initial);
  return states;
}

/** 关卡里每个池子的初始水量，转为结算用的 Map。 */
export function initialLevels(level: CompiledLevel): Map<string, number> {
  const levels = new Map<string, number>();
  for (const pool of level.pools.values()) levels.set(pool.id, pool.spec.initial);
  return levels;
}
