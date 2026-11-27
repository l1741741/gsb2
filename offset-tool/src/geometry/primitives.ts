/**
 * 基础二维几何工具：数值容差、线段相交、环方向、点包含、坐标缩放。
 * 所有浮点比较统一走 EPS，避免不同调用点各自发明容差。
 */
import type { Loop, Point } from './types.js';

/** 默认浮点容差（输入坐标单位）。 */
export const EPS = 1e-9;

export function pointsEqual(a: Point, b: Point, eps = EPS): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 有向面积的两倍；>0 表示逆时针（屏幕坐标 y 向下时视觉为顺时针，数学约定不变）。 */
export function signedArea2(loop: Loop): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s;
}

export function signedArea(loop: Loop): number {
  return signedArea2(loop) / 2;
}

export function loopLength(loop: Loop): number {
  let len = 0;
  for (let i = 0; i < loop.length; i++) {
    len += distance(loop[i], loop[(i + 1) % loop.length]);
  }
  return len;
}

export function reverseLoop(loop: Loop): Loop {
  return [...loop].reverse();
}

/** 强制环为指定方向：ccw=true 返回逆时针环。 */
export function ensureOrientation(loop: Loop, ccw: boolean): Loop {
  const isCcw = signedArea2(loop) > 0;
  return isCcw === ccw ? loop.map((p) => ({ ...p })) : reverseLoop(loop).map((p) => ({ ...p }));
}

export interface SegmentIntersection {
  /** 交点（端点接触时为该端点）。 */
  point: Point;
  /** 在第一条线段上的参数 t∈[0,1]。 */
  t1: number;
  /** 在第二条线段上的参数 t2∈[0,1]。 */
  t2: number;
  /** 相交类型：proper=内部交叉，endpoint=端点落在另一线段上，overlap=共线重叠。 */
  kind: 'proper' | 'endpoint' | 'overlap';
}

/**
 * 计算两条线段 a1-a2 与 b1-b2 的交点；不相交返回 null。
 * 共线重叠返回 overlap（交点取重叠段中点附近的第一个端点）。
 */
export function segmentIntersection(
  a1: Point,
  a2: Point,
  b1: Point,
  b2: Point,
  eps = EPS,
): SegmentIntersection | null {
  const rx = a2.x - a1.x;
  const ry = a2.y - a1.y;
  const sx = b2.x - b1.x;
  const sy = b2.y - b1.y;
  const rxs = rx * sy - ry * sx;
  const qpx = b1.x - a1.x;
  const qpy = b1.y - a1.y;

  if (Math.abs(rxs) > eps) {
    const t = (qpx * sy - qpy * sx) / rxs;
    const u = (qpx * ry - qpy * rx) / rxs;
    if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
    const tc = Math.min(1, Math.max(0, t));
    const uc = Math.min(1, Math.max(0, u));
    const point = { x: a1.x + tc * rx, y: a1.y + tc * ry };
    const endpoint =
      tc <= eps || tc >= 1 - eps || uc <= eps || uc >= 1 - eps;
    return {
      point,
      t1: tc,
      t2: uc,
      kind: endpoint ? 'endpoint' : 'proper',
    };
  }

  // 平行：检查共线重叠
  const qpxr = qpx * ry - qpy * rx;
  if (Math.abs(qpxr) > eps) return null;
  // 共线。把 b 的两端投影到 a 的方向上
  const r2 = rx * rx + ry * ry;
  if (r2 <= eps) {
    // a 退化为点
    if (pointsEqual(a1, b1, eps) || pointsEqual(a1, b2, eps)) {
      return { point: { ...a1 }, t1: 0, t2: 0, kind: 'endpoint' };
    }
    return null;
  }
  const tB1 = (qpx * rx + qpy * ry) / r2;
  const tB2 = ((b2.x - a1.x) * rx + (b2.y - a1.y) * ry) / r2;
  const lo = Math.max(0, Math.min(tB1, tB2));
  const hi = Math.min(1, Math.max(tB1, tB2));
  if (hi + eps < lo) return null;
  return {
    point: { x: a1.x + lo * rx, y: a1.y + lo * ry },
    t1: lo,
    t2: Math.min(tB1, tB2) <= Math.max(tB1, tB2) ? lo : lo,
    kind: lo <= eps || hi >= 1 - eps ? 'endpoint' : 'overlap',
  };
}

/** 射线法点在环内判定：1=内部，0=边界，-1=外部。 */
export function pointInLoop(p: Point, loop: Loop, eps = EPS): 1 | 0 | -1 {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[j];
    const b = loop[i];
    // 边界判定：点在线段包围盒内且叉积≈0
    if (
      Math.min(a.x, b.x) - eps <= p.x &&
      p.x <= Math.max(a.x, b.x) + eps &&
      Math.min(a.y, b.y) - eps <= p.y &&
      p.y <= Math.max(a.y, b.y) + eps
    ) {
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (Math.abs(cross) <= eps * Math.max(1, Math.hypot(b.x - a.x, b.y - a.y))) {
        return 0;
      }
    }
    if (a.y > p.y !== b.y > p.y) {
      const xIntersect = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (xIntersect > p.x) inside = !inside;
    }
  }
  return inside ? 1 : -1;
}

/** 环 b 的顶点是否落在环 a 内（不含边界）。 */
export function loopInside(inner: Loop, outer: Loop): boolean {
  return pointInLoop(inner[0], outer) === 1;
}

/** 包围盒。 */
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boundsOfLoops(loops: Loop[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const loop of loops) {
    for (const p of loop) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, minY, maxX, maxY };
}

export function boundsOfPoints(points: Point[]): Bounds {
  return boundsOfLoops([points]);
}
