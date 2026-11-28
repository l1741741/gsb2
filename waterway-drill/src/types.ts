/**
 * 水道演练的关卡与运行时类型。
 *
 * 水量一律用整数“格”为单位，结算全程只做整数加减，
 * 因此“进出 / 溢流 / 留池”可以逐格对账，重放也不会出现浮点漂移。
 */

/** 闸门状态只有开、关两种。 */
export type GateState = 'open' | 'closed';

/** 池子的绘制位置（像素，由界面按画布坐标使用）。 */
export interface PoolLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 闸门的绘制位置（像素）。 */
export interface GateLayout {
  readonly x: number;
  readonly y: number;
}

/** 支路的绘制折线；缺省时由界面自动从两端池子中心连线。 */
export interface EdgeLayout {
  readonly points: readonly (readonly [number, number])[];
}

/**
 * 池子。容量同时就是池壁上的“溢流线”：水面超过容量的部分进入溢流，
 * 默认泄走；若填写 overflowTo，则溢流会倒进另一个池子（常用于低处检修格）。
 *
 * elevation 是设计者指定的高程，越高越靠上游。水只能沿高程严格下降的支路流动，
 * 这样结算顺序只由高程和 id 决定，与关卡文件里的数组排列无关。
 */
export interface PoolSpec {
  readonly id: string;
  readonly label: string;
  /** 高程；水只从高往低走，同一高程的池子之间不交换水。 */
  readonly elevation: number;
  /** 容量（溢流线），正整数。 */
  readonly capacity: number;
  /** 初始水量，0..capacity 的整数。 */
  readonly initial: number;
  /** 每回合外部来水（泉眼等），非负整数。 */
  readonly inflow?: number;
  /** 每回合最多向外泄走的水量（外排口），非负整数。 */
  readonly drain?: number;
  /** 是否为低处检修格；回合结束时水位超过 safeLevel 即演练失败。 */
  readonly maintenance?: boolean;
  /** 检修格的安全水位；缺省为容量。 */
  readonly safeLevel?: number;
  /** 溢流倒向哪个池子；缺省表示泄走（不进入任何池子）。 */
  readonly overflowTo?: string | null;
  readonly layout: PoolLayout;
}

/** 闸门。一条闸门可以被多条支路引用。 */
export interface GateSpec {
  readonly id: string;
  readonly label: string;
  readonly initial: GateState;
  readonly layout?: GateLayout;
}

/**
 * 有向支路 / 分叉。容量是每回合允许通过的最大水量。
 * gate 为空表示常开；否则只有对应闸门打开时水才能通过。
 * 支路必须从高水位池流向低水位池（elevation[from] > elevation[to]）。
 */
export interface EdgeSpec {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly capacity: number;
  readonly gate?: string | null;
  readonly layout?: EdgeLayout;
}

/** 演练目标：回合结束时 goal.pool 的水量不少于 atLeast。 */
export interface GoalSpec {
  readonly pool: string;
  readonly atLeast: number;
}

/** 一个本地关卡。 */
export interface LevelSpec {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  /** 允许确认的回合总数。 */
  readonly turns: number;
  readonly pools: readonly PoolSpec[];
  readonly gates: readonly GateSpec[];
  readonly edges: readonly EdgeSpec[];
  readonly goal: GoalSpec;
}

/** 单个池子在一回合内的水量台账。恒等式：
 *  start + inflow + spillIn + inEdges - outEdges - drain - spill = end
 */
export interface PoolLedger {
  readonly poolId: string;
  readonly start: number;
  readonly inflow: number;
  readonly spillIn: number;
  readonly inEdges: number;
  readonly outEdges: number;
  readonly drain: number;
  readonly spill: number;
  readonly end: number;
}

/**
 * 失败原因。code 是稳定标识，附带数值用于界面展示；
 * 同一份记录重放时会逐字段比对，包括这些数值和原因。
 */
export type Failure =
  | {
      readonly code: 'maintenance-flooded';
      readonly poolId: string;
      readonly level: number;
      readonly safeLevel: number;
    }
  | {
      readonly code: 'turn-limit';
      readonly goalPoolId: string;
      readonly achieved: number;
      readonly required: number;
    };

export type TurnOutcome = 'playing' | 'won' | 'lost';

/** 一个回合结算后的完整结果，也是记录中的一条。 */
export interface TurnRecord {
  /** 1 起始的回合号。 */
  readonly turn: number;
  /** 本回合确认的全部闸门状态。 */
  readonly gates: Readonly<Record<string, GateState>>;
  /** 回合结束时各池子的水量。 */
  readonly pools: Readonly<Record<string, number>>;
  /** 本回合各支路实际通过的水量。 */
  readonly edges: Readonly<Record<string, number>>;
  /** 本回合各池子溢出的水量。 */
  readonly spill: Readonly<Record<string, number>>;
  /** 逐池水量台账，用于对账与展示。 */
  readonly ledger: readonly PoolLedger[];
  readonly outcome: TurnOutcome;
  readonly failure: Failure | null;
}

/** 可导出、可重放的一份演练记录。 */
export interface DrillRecord {
  readonly schema: 'waterway-drill/record@1';
  readonly levelId: string;
  /** 关卡中影响结算的内容指纹；用于拒绝“同名异物”或别的关卡记录。 */
  readonly levelFingerprint: string;
  readonly turns: readonly TurnRecord[];
  readonly result: {
    readonly outcome: TurnOutcome;
    readonly failure: Failure | null;
  };
}

/** 界面读取的单回合布置。 */
export interface GateView {
  readonly id: string;
  readonly label: string;
  /** 已确认的开合状态。 */
  readonly committed: GateState;
  /** 尚未确认的布置；没有改动时为 null。 */
  readonly pending: GateState | null;
  /** 受这条闸门控制的支路 id。 */
  readonly controls: readonly string[];
  readonly layout: GateLayout | null;
}

export interface PoolView {
  readonly id: string;
  readonly label: string;
  readonly elevation: number;
  readonly capacity: number;
  readonly level: number;
  readonly initial: number;
  readonly inflow: number;
  readonly drain: number;
  readonly maintenance: boolean;
  readonly safeLevel: number;
  readonly overflowTo: string | null;
  /** 上一回合该池子的溢流量；尚无结算时为 0。 */
  readonly spillLastTurn: number;
  readonly layout: PoolLayout;
}

export interface EdgeView {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly capacity: number;
  readonly gate: string | null;
  /** 按已确认的闸门状态计算出的开放状态。 */
  readonly open: boolean;
  /** 若存在未确认布置，按布置预览的开放状态。 */
  readonly previewOpen: boolean;
  /** 上一回合实际通过量；尚无结算时为 0。 */
  readonly throughputLastTurn: number;
  readonly layout: EdgeLayout | null;
}

/** 引擎对界面的只读快照。 */
export interface GameView {
  readonly levelId: string;
  readonly levelName: string;
  readonly levelSummary: string;
  readonly turnLimit: number;
  readonly turnsPlayed: number;
  readonly turnsRemaining: number;
  readonly goal: GoalSpec;
  readonly outcome: TurnOutcome;
  readonly failure: Failure | null;
  readonly pools: readonly PoolView[];
  readonly gates: readonly GateView[];
  readonly edges: readonly EdgeView[];
  readonly lastTurn: TurnRecord | null;
  readonly pendingChanges: number;
  readonly canConfirm: boolean;
  readonly canUndo: boolean;
  readonly history: readonly TurnRecord[];
}
