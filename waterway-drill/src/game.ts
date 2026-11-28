import type { CompiledLevel } from './level.ts';
import { initialGateStates, initialLevels } from './level.ts';
import type {
  DrillRecord,
  Failure,
  GateState,
  GameView,
  TurnOutcome,
  TurnRecord,
} from './types.ts';
import { settleTurn } from './settle.ts';
import { buildView } from './view.ts';

/**
 * 一场演练的状态机。
 *
 * - 玩家先把若干条闸门改成“待确认布置”，一次性 settle() 结算整回合；
 * - 每条支路在本回合拿到多少水，只取决于回合开始的池子水位与确认后的闸门状态，
 *   与布置的先后顺序、关卡文件里支路的排列无关。
 * - undo() 撤回最近一次结算，回到那一回合开始前的水位与闸门状态，
 *   让玩家改走另一种安排；已结算的历史记录被整体丢弃。
 */
export class DrillSession {
  readonly level: CompiledLevel;
  readonly turnLimit: number;

  #gateStates: Map<string, GateState>;
  #pending = new Map<string, GateState>();
  #levels: Map<string, number>;
  #history: TurnRecord[] = [];
  #outcome: TurnOutcome = 'playing';
  #failure: Failure | null = null;

  constructor(level: CompiledLevel) {
    this.level = level;
    this.turnLimit = level.spec.turns;
    this.#gateStates = initialGateStates(level);
    this.#levels = initialLevels(level);
  }

  get turnsPlayed(): number {
    return this.#history.length;
  }

  get turnsRemaining(): number {
    return Math.max(0, this.turnLimit - this.#history.length);
  }

  get outcome(): TurnOutcome {
    return this.#outcome;
  }

  /** 修改一条闸门的待确认布置。已结束或已超时的演练拒绝继续布置。 */
  queueGate(gateId: string, state: GateState): void {
    if (!this.level.gates.has(gateId)) throw new RangeError(`未知闸门：${gateId}`);
    if (state !== 'open' && state !== 'closed') throw new TypeError(`非法闸门状态：${String(state)}`);
    this.#assertPlayable();
    if (this.#gateStates.get(gateId) === state) {
      this.#pending.delete(gateId);
    } else {
      this.#pending.set(gateId, state);
    }
  }

  /** 撤销某条闸门尚未确认的改动。 */
  clearPending(gateId: string): void {
    this.#pending.delete(gateId);
  }

  /** 放弃所有待确认布置，保留已确认的闸门状态。 */
  clearAllPending(): void {
    this.#pending.clear();
  }

  get pendingChanges(): number {
    return this.#pending.size;
  }

  /**
   * 撤回最近一次已结算回合：水位恢复到该回合开始前，闸门恢复到该回合结算前的
   * 已确认状态（上一回合的布置；首回合则回到初始状态），并丢弃这回合的记录与布置。
   * 撤回后玩家可以改走另一种安排再结算。
   */
  undo(): boolean {
    if (this.#history.length === 0) return false;
    const last = this.#history.pop()!;

    const starts = new Map<string, number>();
    for (const entry of last.ledger) starts.set(entry.poolId, entry.start);
    this.#levels = starts;

    // 撤回到该回合结算前的闸门状态：上一回合确认的布置，首回合回到初始状态。
    const previous = this.#history.at(-1);
    const restoredGates = previous
      ? new Map<string, GateState>(
          Object.entries(previous.gates).map(([gateId, state]) => [gateId, state]),
        )
      : initialGateStates(this.level);
    this.#gateStates = restoredGates;

    this.#pending.clear();
    this.#outcome = 'playing';
    this.#failure = null;
    return true;
  }

  /** 按本轮全部待确认布置统一结算。没有改动时也允许直接结算（保持原状过一回合）。 */
  settle(): TurnRecord {
    this.#assertPlayable();
    if (this.#history.length >= this.turnLimit) {
      throw new RangeError('回合数已用完，无法继续结算');
    }

    for (const [gateId, state] of this.#pending) this.#gateStates.set(gateId, state);
    this.#pending.clear();

    const { record } = settleTurn(this.level, {
      turn: this.#history.length + 1,
      turnLimit: this.turnLimit,
      startLevels: this.#levels,
      gates: this.#gateStates,
    });

    this.#history.push(record);
    this.#levels = new Map(Object.entries(record.pools));
    this.#outcome = record.outcome;
    this.#failure = record.failure;
    return record;
  }

  /** 当前水位（已结算回合之后），供界面或测试读取。 */
  levelsSnapshot(): Map<string, number> {
    return new Map(this.#levels);
  }

  gateStatesSnapshot(): Map<string, GateState> {
    return new Map(this.#gateStates);
  }

  historySnapshot(): readonly TurnRecord[] {
    return this.#history;
  }

  /** 导出可重放的记录。记录只包含影响复核的数据，不含界面状态。 */
  toRecord(): DrillRecord {
    return {
      schema: 'waterway-drill/record@1',
      levelId: this.level.spec.id,
      levelFingerprint: this.level.fingerprint,
      turns: this.#history,
      result: { outcome: this.#outcome, failure: this.#failure },
    };
  }

  /** 给界面的只读快照。与会话共享构建逻辑，保证与回放视图一致。 */
  view(): GameView {
    return buildView(this.level, {
      levels: this.#levels,
      gates: this.#gateStates,
      pending: this.#pending,
      history: this.#history,
      outcome: this.#outcome,
      failure: this.#failure,
    });
  }

  #assertPlayable(): void {
    if (this.#outcome !== 'playing') {
      throw new RangeError('演练已经结束，无法继续操作');
    }
    if (this.#history.length >= this.turnLimit) {
      throw new RangeError('回合数已用完，无法继续操作');
    }
  }
}
