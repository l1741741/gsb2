/**
 * engine.ts — 纯函数游戏状态机。
 *
 * 唯一的事实源是「地图 + 已提交行动序列」：
 *   state = replay(map, actions)
 * 撤回 = 删掉末尾行动后重新 replay；
 * 存档 = 序列化 map + actions；
 * 重放 = 对 actions 的前缀逐个 replay。
 * 因此固定地图与操作在载入后必然得到一致结果，
 * 撤回也会精确还原预算、记录与已发现信标。
 */

import {
  heightAt,
  isPassable,
  observeCost,
  obstacleAt,
  getStance,
  getStances,
} from './mapio.js';
import { computeViewshed } from './los.js';
import { keyOf, neighbors, sameHex, type Axial } from './hex.js';
import type { Action, MapDef, SaveFile } from './types.js';
import { validateMap } from './mapio.js';

export interface CellRecord {
  step: number;
  q: number;
  r: number;
  /** 产生该记录时的观测视点绝对海拔。 */
  altitude: number;
  height: number;
  obstacleKind?: string;
  /** 该次观测在这一格标定到的信标 id（若有）。 */
  beaconId?: string;
}

export type GameStatus = 'playing' | 'won' | 'stalled';

export interface LogEntry {
  step: number;
  kind: 'move' | 'observe' | 'system';
  text: string;
}

export interface GameState {
  mapId: string;
  player: Axial;
  budgetLeft: number;
  moves: number;
  observes: number;
  step: number;
  records: Record<string, CellRecord>;
  foundIds: string[];
  status: GameStatus;
  log: LogEntry[];
}

export class GameActionError extends Error {
  code: 'won' | 'illegal-tile' | 'obstacle' | 'budget' | 'unknown-stance';
  constructor(code: GameActionError['code'], message: string) {
    super(message);
    this.name = 'GameActionError';
    this.code = code;
  }
}

export function initialState(map: MapDef): GameState {
  return {
    mapId: map.id,
    player: { ...map.start },
    budgetLeft: map.budget,
    moves: 0,
    observes: 0,
    step: 0,
    records: {},
    foundIds: [],
    status: 'playing',
    log: [
      {
        step: 0,
        kind: 'system',
        text: `进入「${map.name}」：预算 ${map.budget}，找出全部 ${map.beacons.length} 座信标。`,
      },
    ],
  };
}

function beaconAt(map: MapDef, q: number, r: number) {
  return map.beacons.find((b) => b.q === q && b.r === r);
}

/** 当前预算下是否还存在任何可提交的行动。 */
export function hasAffordableAction(map: MapDef, s: GameState): boolean {
  if (s.budgetLeft >= map.costs.move) {
    for (const n of neighbors(s.player)) {
      if (isPassable(map, n.q, n.r)) return true;
    }
  }
  for (const stance of getStances(map)) {
    if (s.budgetLeft >= observeCost(map, stance.id)) return true;
  }
  return false;
}

function deriveStatus(map: MapDef, s: GameState): GameStatus {
  if (s.foundIds.length === map.beacons.length) return 'won';
  if (!hasAffordableAction(map, s)) return 'stalled';
  return 'playing';
}

/**
 * 应用一个已提交行动，返回新状态；不合法时抛 GameActionError。
 * 不修改入参。
 */
export function applyAction(prev: GameState, action: Action, map: MapDef): GameState {
  if (prev.status === 'won') {
    throw new GameActionError('won', '勘测已完成，请撤回或重新开始。');
  }

  const s: GameState = {
    ...prev,
    player: { ...prev.player },
    records: { ...prev.records },
    foundIds: [...prev.foundIds],
    log: [...prev.log],
  };

  if (action.type === 'move') {
    const cost = map.costs.move;
    const adjacent = neighbors(prev.player).some((n) => sameHex(n, action.to));
    if (!adjacent) {
      throw new GameActionError('illegal-tile', '只能移动到相邻六边格。');
    }
    if (!isPassable(map, action.to.q, action.to.r)) {
      throw new GameActionError(
        obstacleAt(map, action.to.q, action.to.r) ? 'obstacle' : 'illegal-tile',
        obstacleAt(map, action.to.q, action.to.r)
          ? '那里有石墙/障碍，无法进入。'
          : '那里不在勘测区域内。',
      );
    }
    if (prev.budgetLeft < cost) {
      throw new GameActionError('budget', `预算不足：移动需要 ${cost}。`);
    }
    s.player = { ...action.to };
    s.budgetLeft -= cost;
    s.moves += 1;
    s.step += 1;
    s.log.push({
      step: s.step,
      kind: 'move',
      text: `移动到 (${action.to.q}, ${action.to.r})，消耗 ${cost}，预算余 ${s.budgetLeft}。`,
    });
  } else {
    const stance = getStance(map, action.stanceId);
    if (!stance) {
      throw new GameActionError('unknown-stance', `未知观测姿态 ${action.stanceId}`);
    }
    const cost = observeCost(map, stance.id);
    if (prev.budgetLeft < cost) {
      throw new GameActionError('budget', `预算不足：${stance.label}需要 ${cost}。`);
    }

    const viewshed = computeViewshed(map, prev.player, stance.eye);
    const altitude = heightAt(map, prev.player.q, prev.player.r) + stance.eye;
    let newBeacons = 0;

    for (const k of viewshed.visible) {
      const [qs, rs] = k.split(',');
      const q = Number(qs);
      const r = Number(rs);
      const b = beaconAt(map, q, r);
      const o = obstacleAt(map, q, r);
      s.records[k] = {
        step: prev.step + 1,
        q,
        r,
        altitude,
        height: heightAt(map, q, r),
        ...(o ? { obstacleKind: o.kind } : {}),
        ...(b ? { beaconId: b.id } : {}),
      };
      if (b && !s.foundIds.includes(b.id)) {
        s.foundIds.push(b.id);
        newBeacons += 1;
      }
    }

    s.foundIds.sort();
    s.budgetLeft -= cost;
    s.observes += 1;
    s.step += 1;
    s.log.push({
      step: s.step,
      kind: 'observe',
      text:
        `${stance.label}（海拔 ${altitude}）观测：覆盖 ${viewshed.visible.size} 格，` +
        `新标定 ${newBeacons} 座信标，消耗 ${cost}，预算余 ${s.budgetLeft}。`,
    });
  }

  s.status = deriveStatus(map, s);
  if (s.status === 'won') {
    s.log.push({ step: s.step, kind: 'system', text: '全部信标标定完成，勘测成功！' });
  } else if (s.status === 'stalled') {
    s.log.push({
      step: s.step,
      kind: 'system',
      text: '剩余预算已无法执行任何移动或观测，可撤回几步或重新规划。',
    });
  }
  return s;
}

/** 从初始局面依次执行行动序列。遇到非法行动直接抛错（存档校验用）。 */
export function replay(map: MapDef, actions: readonly Action[]): GameState {
  let s = initialState(map);
  for (const a of actions) s = applyAction(s, a, map);
  return s;
}

/** 重放前 k 个行动（重放拖动条用）。 */
export function stateAtPrefix(
  map: MapDef,
  actions: readonly Action[],
  k: number,
): GameState {
  return replay(map, actions.slice(0, k));
}

export interface MoveOption {
  to: Axial;
  cost: number;
  adjacent: true;
  inMap: boolean;
  blockedBy?: string;
  affordable: boolean;
  legal: boolean;
  reason?: string;
}

/** 当前位置六个相邻方向的合法行动信息（供地图高亮与点击裁定）。 */
export function getMoveOptions(map: MapDef, s: GameState): MoveOption[] {
  const cost = map.costs.move;
  return neighbors(s.player).map((to) => {
    const inMap =
      Math.abs(to.q) <= map.shape.radius &&
      Math.abs(to.r) <= map.shape.radius &&
      Math.abs(to.q + to.r) <= map.shape.radius;
    const o = inMap ? obstacleAt(map, to.q, to.r) : undefined;
    const affordable = s.budgetLeft >= cost;
    let blockedBy: string | undefined;
    let reason: string | undefined;
    if (!inMap) {
      blockedBy = 'outside';
      reason = '不在勘测区域内';
    } else if (o) {
      blockedBy = o.kind;
      reason = o.kind === 'wall' ? '石墙阻挡，无法进入' : '障碍无法进入';
    } else if (!affordable) {
      reason = `预算不足（移动需 ${cost}）`;
    }
    const legal = inMap && !o && affordable && s.status !== 'won';
    if (!legal && !reason && s.status === 'won') reason = '勘测已完成';
    return { to, cost, adjacent: true as const, inMap, ...(blockedBy ? { blockedBy } : {}), affordable, legal, ...(reason ? { reason } : {}) };
  });
}

export function canObserve(map: MapDef, s: GameState, stanceId: string): boolean {
  return s.status !== 'won' && s.budgetLeft >= observeCost(map, stanceId);
}

/* ---------------- 存档 ---------------- */

export function createSave(map: MapDef, actions: readonly Action[]): SaveFile {
  return {
    app: 'hex-survey',
    format: 1,
    savedAt: new Date().toISOString(),
    map,
    actions: actions.map((a) => structuredClone(a)),
  };
}

export function serializeSave(save: SaveFile): string {
  return JSON.stringify(save, null, 2);
}

export interface ParsedSave {
  ok: boolean;
  save?: SaveFile;
  errors: string[];
}

/** 解析并完整重放校验存档，保证载入即可得到一致局面。 */
export function parseSave(text: string): ParsedSave {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`不是合法 JSON：${(e as Error).message}`] };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['存档顶层必须是对象'] };
  }
  const obj = raw as Record<string, unknown>;
  if (obj.app !== 'hex-survey' || obj.format !== 1) {
    return { ok: false, errors: ['无法识别的存档格式（app/format 不符）'] };
  }
  const mv = validateMap(obj.map);
  if (!mv.ok || !mv.map) return { ok: false, errors: mv.errors.map((e) => `地图：${e}`) };
  if (!Array.isArray(obj.actions)) return { ok: false, errors: ['actions 必须是数组'] };

  const actions: Action[] = [];
  for (const [i, a] of obj.actions.entries()) {
    if (typeof a !== 'object' || a === null) {
      return { ok: false, errors: [`actions[${i}] 不是对象`] };
    }
    const act = a as Record<string, unknown>;
    if (act.type === 'move') {
      const to = act.to as Axial | undefined;
      if (!to || typeof to.q !== 'number' || typeof to.r !== 'number') {
        return { ok: false, errors: [`actions[${i}].to 非法`] };
      }
      actions.push({ type: 'move', to: { q: to.q, r: to.r } });
    } else if (act.type === 'observe') {
      if (typeof act.stanceId !== 'string') {
        return { ok: false, errors: [`actions[${i}].stanceId 必须是字符串`] };
      }
      actions.push({ type: 'observe', stanceId: act.stanceId });
    } else {
      return { ok: false, errors: [`actions[${i}] 类型未知`] };
    }
  }

  try {
    replay(mv.map, actions);
  } catch (e) {
    return { ok: false, errors: [`行动序列无法在本地图上重放：${(e as Error).message}`] };
  }

  return {
    ok: true,
    save: {
      app: 'hex-survey',
      format: 1,
      // 载入校验不依赖 savedAt；保留原值（若有）。
      savedAt: typeof obj.savedAt === 'string' ? obj.savedAt : 'unknown',
      map: mv.map,
      actions,
    },
    errors: [],
  };
}

/** 供调试 / 测试：某格是否在当前可视域。 */
export function isCurrentlyVisible(
  map: MapDef,
  s: GameState,
  stanceId: string,
  q: number,
  r: number,
): boolean {
  const stance = getStance(map, stanceId);
  const vs = computeViewshed(map, s.player, stance.eye);
  return vs.visible.has(keyOf({ q, r }));
}
