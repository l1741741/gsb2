import type { CompiledLevel } from './level.ts';
import { initialGateStates, initialLevels } from './level.ts';
import { settleTurn } from './settle.ts';
import type { GateState, TurnRecord } from './types.ts';

/**
 * 穷举式求解器（开发/测试工具，不参与运行时的胜负判定）。
 *
 * 每回合枚举全部闸门开合组合，按“闸门 + 水位”去重后逐回合推进。
 * 两个样例关卡的组合数很小（3~6 条闸门），因此可以完整搜索，
 * 用来证明关卡不依赖随机生成、确有确定解，也用于生成 README 中的示例走法。
 */
export interface SolvedPath {
  readonly gates: ReadonlyMap<string, GateState>;
  readonly steps: readonly TurnRecord[];
}

interface Branch {
  readonly gates: ReadonlyMap<string, GateState>;
  readonly levels: ReadonlyMap<string, number>;
  readonly steps: readonly TurnRecord[];
}

export interface SolveOptions {
  /** 安全上限，防止关卡设计失控导致组合爆炸。 */
  readonly maxStatesPerTurn?: number;
  /** 搜索全部通关路径（可能很多）；默认只返回第一条。 */
  readonly collectAll?: boolean;
}

/** 见 SolveOptions.collectAll；只返回结果，不暴露内部结构。 */
export interface SolveResult {
  readonly solutions: readonly SolvedPath[];
  readonly exploredTurns: readonly number[];
}

function combinationGateStates(level: CompiledLevel): Map<string, GateState>[] {
  const gateIds = [...level.gates.keys()];
  const combinations: Map<string, GateState>[] = [];
  for (let mask = 0; mask < 2 ** gateIds.length; mask += 1) {
    const states = new Map<string, GateState>();
    gateIds.forEach((gateId, index) => {
      states.set(gateId, (mask & (1 << index)) !== 0 ? 'open' : 'closed');
    });
    combinations.push(states);
  }
  return combinations;
}

function branchKey(branch: Branch): string {
  const gates = [...branch.gates.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const levels = [...branch.levels.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([gates, levels]);
}

/** 广度优先穷举。返回的 paths 顺序稳定：回合越少越先，其次按枚举顺序。 */
export function solveLevel(level: CompiledLevel, options: SolveOptions = {}): SolveResult {
  const maxStatesPerTurn = options.maxStatesPerTurn ?? 100_000;
  const collectAll = options.collectAll ?? false;
  const combinations = combinationGateStates(level);
  const exploredTurns: number[] = [];

  let frontier: Branch[] = [{
    gates: initialGateStates(level),
    levels: initialLevels(level),
    steps: [],
  }];
  const solutions: SolvedPath[] = [];

  for (let turn = 1; turn <= level.spec.turns; turn += 1) {
    const next: Branch[] = [];
    const seen = new Set<string>();
    for (const branch of frontier) {
      for (const gates of combinations) {
        const { record } = settleTurn(level, {
          turn,
          turnLimit: level.spec.turns,
          startLevels: branch.levels,
          gates,
        });
        if (record.outcome === 'won') {
          solutions.push({ gates, steps: [...branch.steps, record] });
          if (!collectAll) return { solutions, exploredTurns };
          continue;
        }
        if (record.outcome === 'lost') continue;
        const candidate: Branch = {
          gates,
          levels: new Map(Object.entries(record.pools)),
          steps: [...branch.steps, record],
        };
        const key = branchKey(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(candidate);
      }
    }
    exploredTurns.push(next.length);
    if (next.length === 0) break;
    if (next.length > maxStatesPerTurn) {
      throw new RangeError(`状态数超过 ${maxStatesPerTurn}，关卡设计可能失控`);
    }
    frontier = next;
  }

  return { solutions, exploredTurns };
}

/** 便捷封装：只判断是否可解。 */
export function isSolvable(level: CompiledLevel): boolean {
  return solveLevel(level, { maxStatesPerTurn: 50_000 }).solutions.length > 0;
}
