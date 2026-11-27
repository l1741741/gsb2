/**
 * los.ts — 六边格视线 / 可视域裁定。
 *
 * 裁定模型（页面“视线裁定”面板与 README 中同样说明）：
 *
 * 1. 每个地块视为顶面海拔 height、覆盖整格闭区域的等高棱柱；
 *    石墙 / 尖柱等障碍把该格的遮挡顶高抬到 height + extra。
 * 2. 视线是从观测格中心（海拔 height(o)+eye）到目标格中心地面
 *    （海拔 height(t)）的三维直线段。
 * 3. 用仿射整数坐标 (U=2q+r, V=3r) 对六边多边形做六个半平面裁剪，
 *    精确求出视线平面投影落在每个格内的参数闭区间 [lo,hi]。
 *    —— 闭区间意味着“刚好擦过顶点 / 边沿”的格也会被纳入裁定，
 *    擦边不再依赖浮点误差或遍历顺序。
 * 4. 高度沿参数 t 线性变化，因此一个格是否遮挡，只需比较区间端点
 *    视线高度的最小值与该格遮挡顶高：
 *      存在 t∈[lo,hi] 使 sightZ(t) < blockTop  ⇒ 挡住
 *    严格小于才遮挡；视线与遮挡顶恰好齐平时放行（“齐平可过”）。
 * 5. 多个格在同一参数点形成遮挡时，按 t、再按 (q,r) 字典序确定首要
 *    阻挡格，保证查询结果稳定一致。
 *
 * 所有区间与高度比较都使用 bigint 分数，边界情形可写死测试。
 */

import { hexRadiusTiles, toUV, type Axial } from './hex.js';
import { blockTopAt, heightAt } from './mapio.js';
import type { MapDef } from './types.js';

export interface Rat {
  n: bigint;
  d: bigint; // 恒为正
}

export const RAT_0: Rat = { n: 0n, d: 1n };
export const RAT_1: Rat = { n: 1n, d: 1n };

export function rat(n: bigint | number, d: bigint | number = 1n): Rat {
  let bn = typeof n === 'number' ? BigInt(n) : n;
  let bd = typeof d === 'number' ? BigInt(d) : d;
  if (bd === 0n) throw new Error('Rat denominator zero');
  if (bd < 0n) {
    bn = -bn;
    bd = -bd;
  }
  const g = gcd(bn < 0n ? -bn : bn, bd);
  return { n: bn / g, d: bd / g };
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a === 0n ? 1n : a;
}

export function ratCmp(a: Rat, b: Rat): -1 | 0 | 1 {
  const x = a.n * b.d;
  const y = b.n * a.d;
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

export function ratLt(a: Rat, b: Rat): boolean {
  return ratCmp(a, b) < 0;
}

export function ratMin(a: Rat, b: Rat): Rat {
  return ratCmp(a, b) <= 0 ? a : b;
}

export function ratMax(a: Rat, b: Rat): Rat {
  return ratCmp(a, b) >= 0 ? a : b;
}

export function ratToNumber(a: Rat): number {
  return Number(a.n) / Number(a.d);
}

/** 把 [0,1] 参数格式化成百分比字符串。 */
export function formatT(a: Rat): string {
  return `${Math.round(ratToNumber(a) * 100)}%`;
}

/** 视线高度可能是分数，展示两位小数。 */
export function formatZ(a: Rat): string {
  const v = ratToNumber(a);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

export interface ParamInterval {
  lo: Rat;
  hi: Rat;
}

/**
 * 把不等式 f0 + fd*t <= c 裁进区间 iv。
 * fd>0 给上界，fd<0 给下界，fd=0 时恒成立或恒不成立。
 */
function clipLe(
  f0: number,
  fd: number,
  c: number,
  iv: ParamInterval,
): ParamInterval | null {
  if (fd === 0) {
    return f0 <= c ? iv : null;
  }
  if (fd > 0) {
    // t <= (c-f0)/fd
    const bound = rat(c - f0, fd);
    return { lo: iv.lo, hi: ratMin(iv.hi, bound) };
  }
  // fd < 0: t >= (c-f0)/fd = (f0-c)/(-fd)
  const bound = rat(f0 - c, -fd);
  return { lo: ratMax(iv.lo, bound), hi: iv.hi };
}

/**
 * 求 UV 整数坐标下，线段 A+tD（t∈[0,1]）与中心 (cu,cv) 的六边格
 * 闭区域相交的参数区间；不相交返回 null。
 *
 * 六条半平面（u=U-cu, v=V-cv）：
 *   u ≤ 1, -u ≤ 1
 *   u+v ≤ 2, -(u+v) ≤ 2
 *   v-u ≤ 2, u-v ≤ 2
 */
export function hexInterval(
  cu: number,
  cv: number,
  au: number,
  av: number,
  du: number,
  dv: number,
): ParamInterval | null {
  let iv: ParamInterval = { lo: RAT_0, hi: RAT_1 };

  // 每一项是 [A,B,K]，表示 A*u + B*v ≤ K；其负值形式给出下界。
  const forms: ReadonlyArray<readonly [number, number, number]> = [
    [1, 0, 1], // u ≤ 1
    [-1, 0, 1], // -u ≤ 1
    [1, 1, 2], // u+v ≤ 2
    [-1, -1, 2], // -(u+v) ≤ 2
    [-1, 1, 2], // v-u ≤ 2
    [1, -1, 2], // u-v ≤ 2
  ];

  const u0 = au - cu;
  const v0 = av - cv;

  for (const [A, B, K] of forms) {
    const f0 = A * u0 + B * v0;
    const fd = A * du + B * dv;
    const next = clipLe(f0, fd, K, iv);
    if (!next) return null;
    iv = next;
    if (ratCmp(iv.lo, iv.hi) > 0) return null;
  }

  // 闭区间：lo == hi 表示只在一个顶点 / 边界点擦过，仍然返回。
  return iv;
}

export interface TraversedHex extends Axial {
  lo: Rat;
  hi: Rat;
}

export interface BlockerInfo extends Axial {
  /** terrain=较高地形本身；wall/obstacle=障碍顶部。 */
  kind: 'terrain' | 'wall' | 'obstacle';
  /** 该格有效的遮挡顶高（绝对海拔）。 */
  blockTop: number;
  /** 视线首次与遮挡顶相交 / 进入遮挡侧面的参数。 */
  hitT: Rat;
  /** 接触点的视线海拔。 */
  hitZ: Rat;
  intervalLo: Rat;
  intervalHi: Rat;
  zAtLo: Rat;
  zAtHi: Rat;
}

export interface LosResult {
  clear: boolean;
  observer: Axial;
  target: Axial;
  /** 观测视点绝对海拔。 */
  eyeZ: number;
  /** 目标地面绝对海拔。 */
  targetZ: number;
  distance: number;
  /** 除观测格、目标格外，视线投影接触到的全部格（含擦边格）。 */
  traversed: TraversedHex[];
  /** 全部遮挡格，按 hitT、再按坐标排序。 */
  blockers: BlockerInfo[];
  primary: BlockerInfo | null;
}

function zAt(eyeZ: number, targetZ: number, t: Rat): Rat {
  // eyeZ + t*(targetZ-eyeZ)，用分数精确表示。
  return {
    n: BigInt(eyeZ) * t.d + t.n * BigInt(targetZ - eyeZ),
    d: t.d,
  };
}

function blockerKind(map: MapDef, q: number, r: number): BlockerInfo['kind'] {
  const o = map.obstacles?.find((x) => x.q === q && x.r === r);
  if (!o) return 'terrain';
  return o.kind === 'wall' ? 'wall' : 'obstacle';
}

/**
 * 裁定从观测格 o（视点高出地面 eyeExtra 级）到目标格 t 地面的视线。
 * o 与 t 越界时抛错，避免 UI 静默误判。
 */
export function queryLos(
  map: MapDef,
  o: Axial,
  eyeExtra: number,
  t: Axial,
): LosResult {
  const oUV = toUV(o);
  const tUV = toUV(t);
  const du = tUV.u - oUV.u;
  const dv = tUV.v - oUV.v;
  const eyeZ = heightAt(map, o.q, o.r) + eyeExtra;
  const targetZ = heightAt(map, t.q, t.r);
  const distance =
    (Math.abs(o.q - t.q) +
      Math.abs(o.q - t.q + o.r - t.r) +
      Math.abs(o.r - t.r)) /
    2;

  const traversed: TraversedHex[] = [];
  const blockers: BlockerInfo[] = [];

  if (du === 0 && dv === 0) {
    return {
      clear: true,
      observer: { ...o },
      target: { ...t },
      eyeZ,
      targetZ,
      distance: 0,
      traversed,
      blockers,
      primary: null,
    };
  }

  for (const c of hexRadiusTiles(map.shape.radius)) {
    if (c.q === o.q && c.r === o.r) continue;
    if (c.q === t.q && c.r === t.r) continue;

    const cUV = toUV(c);
    const iv = hexInterval(cUV.u, cUV.v, oUV.u, oUV.v, du, dv);
    if (!iv) continue;

    traversed.push({ ...c, lo: iv.lo, hi: iv.hi });

    const terrainH = heightAt(map, c.q, c.r);
    const top = blockTopAt(map, c.q, c.r) ?? terrainH;
    const zLo = zAt(eyeZ, targetZ, iv.lo);
    const zHi = zAt(eyeZ, targetZ, iv.hi);

    const belowLo = ratLt(zLo, rat(top));
    const belowHi = ratLt(zHi, rat(top));
    if (!belowLo && !belowHi) continue;

    // 计算首个遮挡参数点。
    let hitT: Rat;
    let hitZ: Rat;
    if (belowLo) {
      // 进入该格闭区域时视线已低于顶高：撞在边界侧面。
      hitT = iv.lo;
      hitZ = zLo;
    } else {
      // zLo >= top 且 zHi < top：线性下降，求 z(t)=top 的交点。
      // eyeZ + t*(targetZ-eyeZ) = top  ⇒  t = (top-eyeZ)/(targetZ-eyeZ)
      hitT = rat(top - eyeZ, targetZ - eyeZ);
      hitZ = rat(top);
    }

    blockers.push({
      ...c,
      kind: blockerKind(map, c.q, c.r),
      blockTop: top,
      hitT,
      hitZ,
      intervalLo: iv.lo,
      intervalHi: iv.hi,
      zAtLo: zLo,
      zAtHi: zHi,
    });
  }

  blockers.sort((a, b) => {
    const c = ratCmp(a.hitT, b.hitT);
    if (c !== 0) return c;
    if (a.q !== b.q) return a.q - b.q;
    return a.r - b.r;
  });

  return {
    clear: blockers.length === 0,
    observer: { ...o },
    target: { ...t },
    eyeZ,
    targetZ,
    distance,
    traversed,
    blockers,
    primary: blockers[0] ?? null,
  };
}

/** 同一 hitT（擦边共点）的其它阻挡格，供查询面板并列展示。 */
export function coBlockers(result: LosResult): BlockerInfo[] {
  const p = result.primary;
  if (!p) return [];
  return result.blockers.filter(
    (b) => b !== p && ratCmp(b.hitT, p.hitT) === 0,
  );
}

export interface Viewshed {
  eyeZ: number;
  results: Map<string, LosResult>;
  visible: Set<string>;
}

/**
 * 从观测格 o 计算全图可视域。visionRange 之外的格不做裁定、不可见。
 */
export function computeViewshed(
  map: MapDef,
  o: Axial,
  eyeExtra: number,
): Viewshed {
  const results = new Map<string, LosResult>();
  const visible = new Set<string>();
  const eyeZ = heightAt(map, o.q, o.r) + eyeExtra;
  const maxRange = map.visionRange ?? Infinity;

  visible.add(`${o.q},${o.r}`);

  for (const t of hexRadiusTiles(map.shape.radius)) {
    const k = `${t.q},${t.r}`;
    if (t.q === o.q && t.r === o.r) {
      results.set(k, queryLos(map, o, eyeExtra, t));
      continue;
    }
    const d =
      (Math.abs(o.q - t.q) +
        Math.abs(o.q - t.q + o.r - t.r) +
        Math.abs(o.r - t.r)) /
      2;
    if (d > maxRange) continue;
    const los = queryLos(map, o, eyeExtra, t);
    results.set(k, los);
    if (los.clear) visible.add(k);
  }

  return { eyeZ, results, visible };
}
