import type { CompiledLevel } from './level.ts';
import type {
  EdgeSpec,
  Failure,
  GateState,
  PoolLedger,
  TurnOutcome,
  TurnRecord,
} from './types.ts';

/** 一次结算的输出，除 TurnRecord 外还带上玩家可读的失败/成功信息。 */
export interface Settlement {
  readonly record: TurnRecord;
}

/** 结算输入：起始水位、本回合确认的闸门状态、回合号与总回合数。 */
export interface SettleInput {
  readonly turn: number;
  readonly turnLimit: number;
  readonly startLevels: ReadonlyMap<string, number>;
  readonly gates: ReadonlyMap<string, GateState>;
}

/**
 * 结算规则（全部为确定性整数运算）：
 *
 * 1. 出流按“回合开始时的水”规划：某池本回合可放出的水 = start + 外部来水，
 *    与同回合后来才到达的水无关。因此水沿支路流动至少需要一回合，
 *    规划出的通过量也不受结算顺序影响。
 * 2. 同一池的多条出水支路按容量做最大余数法分配：可放水不够时按容量比例分，
 *    余数并列则按支路 id 升序补齐。每条边得到的量就是它本回合的实际通过量。
 * 3. 应用阶段按池子高程从高到低、同高程按 id 升序逐个结算。
 *    每个池子依次：加外部来水 → 加上游经支路抵达的水 → 加高处溢流带来的水
 *    → 减去本池出流 → 外排（最多 drain）→ 超过容量即溢流。
 *    溢流只会倒向严格更低高程的池子，因此在上述顺序下目标池必然在本池之后结算，
 *    溢流链不会因文件里的支路排列而改变。
 *
 * 台账恒等式：start + inflow + spillIn + inEdges - outEdges - drain - spill = end。
 */
export function settleTurn(level: CompiledLevel, input: SettleInput): Settlement {
  const { pools, outgoing, poolOrder, goal } = level;
  const gates = input.gates;

  // ---- 第一阶段：按回合开始时的水规划每条支路的通过量 ----
  const edgeFlow = new Map<string, number>();
  for (const poolId of poolOrder) {
    for (const edge of outgoing.get(poolId) ?? []) edgeFlow.set(edge.id, 0);
  }

  for (const poolId of poolOrder) {
    const pool = pools.get(poolId)!;
    const start = input.startLevels.get(poolId) ?? pool.spec.initial;
    const supply = Math.max(0, start + pool.inflow);
    const openEdges = (outgoing.get(poolId) ?? []).filter((edge) => isEdgeOpen(edge, gates));
    if (openEdges.length === 0) continue;

    const totalCapacity = openEdges.reduce((sum, edge) => sum + edge.capacity, 0);
    const release = Math.min(supply, totalCapacity);
    for (const [edgeId, amount] of allocateFairShare(openEdges, release)) {
      edgeFlow.set(edgeId, amount);
    }
  }

  // 汇总每个池子从支路收到的水（第二阶段使用）。
  const inEdgesByPool = new Map<string, number>();
  for (const poolId of pools.keys()) inEdgesByPool.set(poolId, 0);
  for (const poolId of poolOrder) {
    for (const edge of outgoing.get(poolId) ?? []) {
      const amount = edgeFlow.get(edge.id) ?? 0;
      inEdgesByPool.set(edge.to, (inEdgesByPool.get(edge.to) ?? 0) + amount);
    }
  }

  // ---- 第二阶段：按高程从高到低逐个应用，并传播溢流 ----
  const spillInByPool = new Map<string, number>();
  for (const poolId of pools.keys()) spillInByPool.set(poolId, 0);

  const endLevels = new Map<string, number>();
  const spills = new Map<string, number>();
  const ledgers: PoolLedger[] = [];

  for (const poolId of poolOrder) {
    const pool = pools.get(poolId)!;
    const start = input.startLevels.get(poolId) ?? pool.spec.initial;
    const inflow = pool.inflow;
    const spillIn = spillInByPool.get(poolId) ?? 0;
    const inEdges = inEdgesByPool.get(poolId) ?? 0;

    let outEdges = 0;
    for (const edge of outgoing.get(poolId) ?? []) outEdges += edgeFlow.get(edge.id) ?? 0;

    let level = start + inflow + spillIn + inEdges - outEdges;
    const drain = Math.min(pool.drain, Math.max(0, level));
    level -= drain;

    let spill = 0;
    if (level > pool.spec.capacity) {
      spill = level - pool.spec.capacity;
      level = pool.spec.capacity;
    }
    if (spill > 0 && pool.overflowTo !== null) {
      const target = pools.get(pool.overflowTo)!;
      // 目标池严格更低，必然后结算；这里只累加，稍后它自己再处理。
      spillInByPool.set(target.id, (spillInByPool.get(target.id) ?? 0) + spill);
    }

    endLevels.set(poolId, level);
    spills.set(poolId, spill);
    ledgers.push({
      poolId,
      start,
      inflow,
      spillIn,
      inEdges,
      outEdges,
      drain,
      spill,
      end: level,
    });
  }

  // ---- 判定：先看检修格是否被淹，再看目标，最后看回合上限 ----
  let failure: Failure | null = null;
  let outcome: TurnOutcome = 'playing';

  for (const poolId of poolOrder) {
    const pool = pools.get(poolId)!;
    if (!pool.maintenance) continue;
    const level = endLevels.get(poolId)!;
    if (level > pool.safeLevel) {
      failure = {
        code: 'maintenance-flooded',
        poolId,
        level,
        safeLevel: pool.safeLevel,
      };
      outcome = 'lost';
      break;
    }
  }

  if (outcome === 'playing' && endLevels.get(goal.pool)! >= goal.atLeast) {
    outcome = 'won';
  }

  if (outcome === 'playing' && input.turn >= input.turnLimit) {
    failure = {
      code: 'turn-limit',
      goalPoolId: goal.pool,
      achieved: endLevels.get(goal.pool)!,
      required: goal.atLeast,
    };
    outcome = 'lost';
  }

  const record: TurnRecord = {
    turn: input.turn,
    gates: gateRecord(gates),
    pools: numberRecord(endLevels),
    edges: numberRecord(edgeFlow),
    spill: numberRecord(spills),
    ledger: ledgers,
    outcome,
    failure,
  };
  return { record };
}

function isEdgeOpen(edge: EdgeSpec, gates: ReadonlyMap<string, GateState>): boolean {
  if (edge.gate === undefined || edge.gate === null) return true;
  return gates.get(edge.gate) === 'open';
}

/**
 * 最大余数法：把 release 按容量比例分给各边。
 * 取整用整数运算 (release*cap) / totalCapacity，余数越大越优先补 1，
 * 余数并列时按 id 升序。保证各边分到的量之和恰好等于 release。
 */
export function allocateFairShare(
  edges: readonly EdgeSpec[],
  release: number,
): Map<string, number> {
  const result = new Map<string, number>();
  const totalCapacity = edges.reduce((sum, edge) => sum + edge.capacity, 0);
  if (release <= 0 || totalCapacity === 0) {
    for (const edge of edges) result.set(edge.id, 0);
    return result;
  }

  const remainders: { id: string; remainder: number }[] = [];
  let assigned = 0;
  for (const edge of edges) {
    const product = release * edge.capacity;
    const base = Math.floor(product / totalCapacity);
    result.set(edge.id, base);
    assigned += base;
    remainders.push({ id: edge.id, remainder: product % totalCapacity });
  }

  const extra = release - assigned;
  remainders.sort((a, b) => b.remainder - a.remainder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let index = 0; index < extra; index += 1) {
    const target = remainders[index];
    result.set(target.id, (result.get(target.id) ?? 0) + 1);
  }
  return result;
}

/** 把水位/流量 Map 按 id 写成稳定对象，避免记录里出现 Map 或随机键序。 */
function numberRecord(values: ReadonlyMap<string, number>): Record<string, number> {
  const record: Record<string, number> = {};
  for (const key of [...values.keys()].sort()) record[key] = values.get(key)!;
  return record;
}

/** 闸门状态同样按 id 排序，重放与展示不依赖输入 Map 的迭代顺序。 */
function gateRecord(values: ReadonlyMap<string, GateState>): Record<string, GateState> {
  const record: Record<string, GateState> = {};
  for (const key of [...values.keys()].sort()) record[key] = values.get(key)!;
  return record;
}

/** 对账：检查台账恒等式，返回所有不满足的池子。 */
export function auditLedgers(record: TurnRecord): string[] {
  const problems: string[] = [];
  for (const ledger of record.ledger) {
    const expected = ledger.start + ledger.inflow + ledger.spillIn + ledger.inEdges
      - ledger.outEdges - ledger.drain - ledger.spill;
    if (expected !== ledger.end) {
      problems.push(
        `${ledger.poolId}: ${ledger.start}+${ledger.inflow}+${ledger.spillIn}+${ledger.inEdges}`
        + `-${ledger.outEdges}-${ledger.drain}-${ledger.spill} = ${expected}，记录为 ${ledger.end}`,
      );
    }
    if (record.pools[ledger.poolId] !== ledger.end) {
      problems.push(`${ledger.poolId}: pools[${ledger.poolId}] 与台账 end 不一致`);
    }
    if (record.spill[ledger.poolId] !== ledger.spill) {
      problems.push(`${ledger.poolId}: spill[${ledger.poolId}] 与台账 spill 不一致`);
    }
    if (ledger.end < 0) problems.push(`${ledger.poolId}: 水量为负`);
  }
  return problems;
}
