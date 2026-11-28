import { compileLevel, initialGateStates, initialLevels } from './level.ts';
import type { CompiledLevel } from './level.ts';
import { settleTurn } from './settle.ts';
import type {
  DrillRecord,
  Failure,
  GateState,
  TurnOutcome,
  TurnRecord,
} from './types.ts';

/** 记录无法用当前关卡复核时抛出的错误；消息说明是哪一处对不上。 */
export class RecordRejectedError extends Error {
  readonly code: 'record-rejected';

  constructor(message: string) {
    super(message);
    this.name = 'RecordRejectedError';
    this.code = 'record-rejected';
  }
}

/** 重放的逐回合结果：数值、通过量、溢流、胜负与失败原因都与记录逐字段比对。 */
export interface ReplayResult {
  readonly record: DrillRecord;
  readonly turns: readonly TurnRecord[];
  readonly outcome: TurnOutcome;
  readonly failure: Failure | null;
}

/**
 * 用当前关卡复核一份记录。
 *
 * 拒绝条件（一律抛 RecordRejectedError，不做静默降级）：
 * - schema 不是本工具支持的版本；
 * - levelId 与当前关卡不同；
 * - levelFingerprint 与当前关卡不同（同名但被改过，或根本是另一关卡的记录）；
 * - 回合数超过关卡允许的回合上限，或回合号不连续。
 *
 * 复核过程不读取记录里的“结果”做任何提示，而是完全重新结算，
 * 再与记录逐字段对比；任何差异都视为记录被篡改或与关卡不符。
 */
export function replayRecord(level: CompiledLevel, record: DrillRecord): ReplayResult {
  if (!record || typeof record !== 'object') throw new RecordRejectedError('记录为空或不是对象');
  if (record.schema !== 'waterway-drill/record@1') {
    throw new RecordRejectedError(`不支持的记录版本：${String(record.schema)}`);
  }
  if (record.levelId !== level.spec.id) {
    throw new RecordRejectedError(
      `记录属于关卡 ${record.levelId}，当前关卡是 ${level.spec.id}，拒绝加载`,
    );
  }
  if (record.levelFingerprint !== level.fingerprint) {
    throw new RecordRejectedError(
      `关卡 ${level.spec.id} 的内容与记录时的指纹不符（记录 ${record.levelFingerprint}，当前 ${level.fingerprint}），拒绝加载`,
    );
  }
  if (!Array.isArray(record.turns)) throw new RecordRejectedError('记录缺少 turns');
  if (record.turns.length > level.spec.turns) {
    throw new RecordRejectedError(
      `记录有 ${record.turns.length} 个回合，超过关卡上限 ${level.spec.turns}`,
    );
  }
  // 回合号必须从 1 连续递增；先做这项结构检查，避免逐回合结算时误报“数值不符”。
  for (const [index, turn] of record.turns.entries()) {
    if (!turn || typeof turn !== 'object' || turn.turn !== index + 1) {
      throw new RecordRejectedError(
        `记录第 ${index + 1} 条的回合号应为 ${index + 1}，实际为 ${String(turn?.turn)}`,
      );
    }
  }

  let levels = initialLevels(level);
  let gates = initialGateStates(level);
  const replayTurns: TurnRecord[] = [];

  for (const [index, expected] of record.turns.entries()) {
    const turn = index + 1;
    validateGateRecord(level, expected.gates ?? {});
    const nextGates = new Map<string, GateState>();
    for (const gate of level.gates.values()) {
      const state = (expected.gates as Readonly<Record<string, GateState>>)[gate.id];
      if (state !== 'open' && state !== 'closed') {
        throw new RecordRejectedError(`第 ${turn} 回合闸门 ${gate.id} 状态缺失或非法`);
      }
      nextGates.set(gate.id, state);
    }

    const { record: actual } = settleTurn(level, {
      turn,
      turnLimit: level.spec.turns,
      startLevels: levels,
      gates: nextGates,
    });

    compareTurnRecords(turn, expected, actual);
    replayTurns.push(actual);
    levels = new Map(Object.entries(actual.pools));
    gates = nextGates;
  }

  const outcome = replayTurns.at(-1)?.outcome ?? 'playing';
  const failure = replayTurns.at(-1)?.failure ?? null;
  const claimed = record.result;
  if (!claimed || claimed.outcome !== outcome || !sameFailure(claimed.failure, failure)) {
    throw new RecordRejectedError(
      `记录的最终结果（${String(claimed?.outcome)}）与复核结果（${outcome}）不一致`,
    );
  }

  return { record, turns: replayTurns, outcome, failure };
}

/** 只做形状校验，数值对账交给重新结算。 */
function validateGateRecord(level: CompiledLevel, gates: Readonly<Record<string, unknown>>): void {
  for (const gateId of Object.keys(gates)) {
    if (!level.gates.has(gateId)) throw new RecordRejectedError(`记录里有当前关卡不存在的闸门 ${gateId}`);
  }
}

/** 逐字段对比记录与实际结算；任一差异都拒绝。 */
function compareTurnRecords(turn: number, expected: TurnRecord, actual: TurnRecord): void {
  compareMap(turn, 'pools', expected.pools, actual.pools);
  compareMap(turn, 'edges', expected.edges, actual.edges);
  compareMap(turn, 'spill', expected.spill, actual.spill);
  compareMap(turn, 'gates', expected.gates, actual.gates);
  if (expected.outcome !== actual.outcome) {
    throw new RecordRejectedError(
      `第 ${turn} 回合结果应为 ${actual.outcome}，记录写的是 ${String(expected.outcome)}`,
    );
  }
  if (!sameFailure(expected.failure, actual.failure)) {
    throw new RecordRejectedError(
      `第 ${turn} 回合失败原因与复核不一致（记录 ${JSON.stringify(expected.failure)}，复核 ${JSON.stringify(actual.failure)}）`,
    );
  }
  if (expected.ledger.length !== actual.ledger.length) {
    throw new RecordRejectedError(`第 ${turn} 回合台账条数与复核不一致`);
  }
  const actualLedger = new Map(actual.ledger.map((entry) => [entry.poolId, entry]));
  for (const entry of expected.ledger) {
    const reference = actualLedger.get(entry.poolId);
    if (!reference) throw new RecordRejectedError(`第 ${turn} 回合台账缺少池子 ${entry.poolId}`);
    for (const key of ['start', 'inflow', 'spillIn', 'inEdges', 'outEdges', 'drain', 'spill', 'end'] as const) {
      if (entry[key] !== reference[key]) {
        throw new RecordRejectedError(
          `第 ${turn} 回合池子 ${entry.poolId} 的 ${key} 记录为 ${entry[key]}，复核为 ${reference[key]}`,
        );
      }
    }
  }
}

function compareMap(
  turn: number,
  field: 'pools' | 'edges' | 'spill' | 'gates',
  expected: Readonly<Record<string, unknown>>,
  actual: Readonly<Record<string, unknown>>,
): void {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  if (expectedKeys.length !== actualKeys.length
    || expectedKeys.some((key, index) => key !== actualKeys[index])) {
    throw new RecordRejectedError(`第 ${turn} 回合 ${field} 的键集合与复核不一致`);
  }
  for (const key of actualKeys) {
    if (expected[key] !== actual[key]) {
      throw new RecordRejectedError(
        `第 ${turn} 回合 ${field}.${key} 记录为 ${String(expected[key])}，复核为 ${String(actual[key])}`,
      );
    }
  }
}

function sameFailure(a: Failure | null | undefined, b: Failure | null | undefined): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 从 JSON 文本解析记录。除了结构校验，还会检查必需字段的类型；
 * 具体是否属于当前关卡由 replayRecord 判定。
 */
export function parseRecord(text: string): DrillRecord {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new RecordRejectedError(`记录不是合法 JSON：${(error as Error).message}`);
  }
  if (!value || typeof value !== 'object') throw new RecordRejectedError('记录根节点必须是对象');
  const candidate = value as Partial<DrillRecord>;
  if (candidate.schema !== 'waterway-drill/record@1') {
    throw new RecordRejectedError('记录缺少受支持的 schema');
  }
  if (typeof candidate.levelId !== 'string') throw new RecordRejectedError('记录缺少 levelId');
  if (typeof candidate.levelFingerprint !== 'string') {
    throw new RecordRejectedError('记录缺少 levelFingerprint');
  }
  if (!Array.isArray(candidate.turns)) throw new RecordRejectedError('记录缺少 turns 数组');
  if (!candidate.result || typeof candidate.result !== 'object') {
    throw new RecordRejectedError('记录缺少 result');
  }
  return candidate as DrillRecord;
}

/** 导入记录前的便捷检查：先解析，再用关卡复核。 */
export function loadRecord(levelSpec: Parameters<typeof compileLevel>[0], text: string): ReplayResult {
  return replayRecord(compileLevel(levelSpec), parseRecord(text));
}
