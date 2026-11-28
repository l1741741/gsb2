import type { CompiledLevel } from './level.ts';
import type {
  Failure,
  GateState,
  GameView,
  PoolView,
  EdgeView,
  GateView,
  TurnOutcome,
  TurnRecord,
} from './types.ts';

/**
 * 构建界面快照的共享入口。
 *
 * 会话视图与记录回放视图都从这里生成，保证“首轮”和“重放”在同一份记录下
 * 画出的池子数值、通过量、溢流量和失败原因完全一致。
 */
export interface ViewState {
  /** 当前各池水位；缺省时用关卡初始值。 */
  readonly levels: ReadonlyMap<string, number>;
  /** 已确认的闸门状态；缺省时用关卡初始值。 */
  readonly gates: ReadonlyMap<string, GateState>;
  /** 尚未确认的布置。 */
  readonly pending?: ReadonlyMap<string, GateState>;
  /** 已发生的回合记录（按回合号递增）。 */
  readonly history: readonly TurnRecord[];
  readonly outcome: TurnOutcome;
  readonly failure: Failure | null;
}

export function buildView(level: CompiledLevel, state: ViewState): GameView {
  const pending = state.pending ?? new Map<string, GateState>();
  const last = state.history.at(-1) ?? null;
  const turnsPlayed = state.history.length;

  const pools: PoolView[] = [...level.poolOrder].map((poolId) => {
    const pool = level.pools.get(poolId)!;
    return {
      id: pool.id,
      label: pool.spec.label,
      elevation: pool.spec.elevation,
      capacity: pool.spec.capacity,
      level: state.levels.get(poolId) ?? pool.spec.initial,
      initial: pool.spec.initial,
      inflow: pool.inflow,
      drain: pool.drain,
      maintenance: pool.maintenance,
      safeLevel: pool.safeLevel,
      overflowTo: pool.overflowTo,
      spillLastTurn: last?.spill[poolId] ?? 0,
      layout: pool.spec.layout,
    };
  });

  const gates: GateView[] = [...level.gates.values()].map((gate) => ({
    id: gate.id,
    label: gate.label,
    committed: state.gates.get(gate.id) ?? gate.initial,
    pending: pending.get(gate.id) ?? null,
    controls: level.gateControls.get(gate.id) ?? [],
    layout: gate.layout ?? null,
  }));

  const edges: EdgeView[] = [...level.spec.edges].map((edge) => {
    const gateId = edge.gate ?? null;
    const committed = gateId === null || (state.gates.get(gateId) ?? level.gates.get(gateId)!.initial) === 'open';
    const pendingState = gateId === null ? undefined : pending.get(gateId);
    const preview = pendingState === undefined ? committed : pendingState === 'open';
    return {
      id: edge.id,
      from: edge.from,
      to: edge.to,
      capacity: edge.capacity,
      gate: gateId,
      open: committed,
      previewOpen: preview,
      throughputLastTurn: last?.edges[edge.id] ?? 0,
      layout: edge.layout ?? null,
    };
  });

  return {
    levelId: level.spec.id,
    levelName: level.spec.name,
    levelSummary: level.spec.summary,
    turnLimit: level.spec.turns,
    turnsPlayed,
    turnsRemaining: Math.max(0, level.spec.turns - turnsPlayed),
    goal: level.goal,
    outcome: state.outcome,
    failure: state.failure,
    pools,
    gates,
    edges,
    lastTurn: last,
    pendingChanges: pending.size,
    canConfirm: state.outcome === 'playing' && turnsPlayed < level.spec.turns,
    canUndo: turnsPlayed > 0,
    history: state.history,
  };
}

/**
 * 从记录生成第 cursor 回合结束时的回放视图。
 * cursor 从 1 开始；传 0 表示开始之前（用于展示初始局面）。
 */
export function buildReplayView(
  level: CompiledLevel,
  turns: readonly TurnRecord[],
  cursor: number,
): GameView {
  const clamped = Math.max(0, Math.min(turns.length, cursor));
  const history = turns.slice(0, clamped);
  const last = history.at(-1) ?? null;

  const levels = new Map<string, number>(
    [...level.pools.values()].map((pool) => [pool.id, pool.spec.initial]),
  );
  const gates = new Map<string, GateState>(
    [...level.gates.values()].map((gate) => [gate.id, gate.initial]),
  );
  for (const turn of history) {
    for (const [poolId, value] of Object.entries(turn.pools)) levels.set(poolId, value);
    for (const [gateId, value] of Object.entries(turn.gates)) gates.set(gateId, value);
  }

  return buildView(level, {
    levels,
    gates,
    pending: new Map(),
    history,
    outcome: last?.outcome ?? 'playing',
    failure: last?.failure ?? null,
  });
}
