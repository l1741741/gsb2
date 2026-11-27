/**
 * solve.ts — 小规模 Dijkstra 求解器。
 *
 * 状态 = (位置, 已发现信标掩码)，边 = 合法移动 / 某姿态观测。
 * 用途：
 *  - 测试中证明每一关在给定预算内确实可解；
 *  - 游戏内“提示”给出从当前局面出发的最省预算下一步。
 */

import { keyOf, neighbors } from './hex.js';
import { computeViewshed } from './los.js';
import { isPassable, observeCost, getStances } from './mapio.js';
import type { Action, MapDef } from './types.js';

export interface Solution {
  totalCost: number;
  actions: Action[];
}

interface Node {
  posKey: string;
  mask: number;
}

/**
 * 注意：只有「观测」能标定信标。移动到信标所在格本身不会发现它，
 * 因此移动边不改变信标掩码。
 */

/** 某位置某姿态观测能覆盖到的信标掩码。 */
export function observeMask(map: MapDef, q: number, r: number, eyeExtra: number): number {
  const vs = computeViewshed(map, { q, r }, eyeExtra);
  let m = 0;
  map.beacons.forEach((b, i) => {
    if (vs.visible.has(keyOf(b))) m |= 1 << i;
  });
  return m;
}

/**
 * 求从指定位置 / 已发现掩码出发，找全全部信标的最小消耗行动序列。
 * budgetLimit 给出后会剪掉超过它的路径；无解返回 null。
 */
export function solveFrom(
  map: MapDef,
  start: { q: number; r: number },
  foundIds: readonly string[] = [],
  budgetLimit = Infinity,
): Solution | null {
  const nBeacons = map.beacons.length;
  const fullMask = (1 << nBeacons) - 1;
  let initialMask = 0;
  map.beacons.forEach((b, i) => {
    if (foundIds.includes(b.id)) initialMask |= 1 << i;
  });

  const startKey = keyOf(start);
  const startNode: Node = { posKey: startKey, mask: initialMask };
  const nodeKey = (n: Node) => `${n.posKey}|${n.mask}`;

  const dist = new Map<string, number>();
  const prev = new Map<string, { from: string; action: Action }>();
  dist.set(nodeKey(startNode), 0);

  // 地图很小（<= ~170 格 × <=16 掩码），用线性扫描取最小距离即可。
  const settled = new Set<string>();
  const allNodes = new Map<string, Node>();
  allNodes.set(nodeKey(startNode), startNode);

  function maybeAddNode(n: Node): string {
    const k = nodeKey(n);
    if (!allNodes.has(k)) allNodes.set(k, n);
    return k;
  }

  while (true) {
    let curKey: string | null = null;
    let curDist = Infinity;
    for (const [k, d] of dist) {
      if (!settled.has(k) && d < curDist) {
        curDist = d;
        curKey = k;
      }
    }
    if (curKey === null) break;
    settled.add(curKey);

    const [pk, maskStr] = curKey.split('|');
    const mask = Number(maskStr);
    if (mask === fullMask) {
      // 回溯行动序列。
      const actions: Action[] = [];
      let k: string | undefined = curKey;
      while (k && prev.has(k)) {
        const p: { from: string; action: Action } = prev.get(k)!;
        actions.push(p.action);
        k = p.from;
      }
      actions.reverse();
      return { totalCost: curDist, actions };
    }
    if (curDist >= budgetLimit) continue;

    const [qs, rs] = pk.split(',');
    const q = Number(qs);
    const r = Number(rs);

    const relax = (next: Node, cost: number, action: Action) => {
      const nk = maybeAddNode(next);
      if (settled.has(nk)) return;
      const nd = curDist + cost;
      if (nd > budgetLimit) return;
      if (nd < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, nd);
        prev.set(nk, { from: curKey!, action });
      }
    };

    // 移动边（不改变信标掩码：踩到信标格不等于标定）
    for (const to of neighbors({ q, r })) {
      if (!isPassable(map, to.q, to.r)) continue;
      relax(
        { posKey: keyOf(to), mask },
        map.costs.move,
        { type: 'move', to: { q: to.q, r: to.r } },
      );
    }

    // 观测边（每种姿态；无新增信标的观测不改善掩码，跳过）
    for (const stance of getStances(map)) {
      const gain = observeMask(map, q, r, stance.eye) & ~mask;
      if (gain === 0) continue;
      const cost = observeCost(map, stance.id);
      relax(
        { posKey: pk, mask: mask | gain },
        cost,
        { type: 'observe', stanceId: stance.id },
      );
    }
  }

  return null;
}
