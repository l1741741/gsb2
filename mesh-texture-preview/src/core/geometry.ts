import type { Vec2 } from './types.ts';

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export const sameVec = (a: Vec2, b: Vec2, eps = 1e-9): boolean =>
  Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;

export const finiteVec = (v: Vec2): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y);

/**
 * Signed area of a polygon/triangle. Positive means the corners are in
 * clockwise order for a Y-down coordinate system (screen convention).
 */
export function signedArea(a: Vec2, b: Vec2, c: Vec2): number {
  return ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function emptyBounds(): Bounds {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}

export function expandBounds(b: Bounds, p: Vec2): Bounds {
  if (p.x < b.minX) b.minX = p.x;
  if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x;
  if (p.y > b.maxY) b.maxY = p.y;
  return b;
}

export function boundsOf(points: readonly Vec2[]): Bounds {
  const b = emptyBounds();
  for (const p of points) expandBounds(b, p);
  return b;
}

export function padBounds(b: Bounds, pad: number): Bounds {
  if (!Number.isFinite(b.minX)) return { minX: -pad, minY: -pad, maxX: pad, maxY: pad };
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

/**
 * Distance from p to segment ab and the parameter of the closest point.
 */
export function segmentDistance(p: Vec2, a: Vec2, b: Vec2): { distance: number; t: number; point: Vec2 } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const l2 = abx * abx + aby * aby;
  const t = l2 === 0 ? 0 : clamp((apx * abx + apy * aby) / l2, 0, 1);
  const point = { x: a.x + abx * t, y: a.y + aby * t };
  return { distance: dist(p, point), t, point };
}

/** Point in triangle test (inclusive of edges). */
export function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const d1 = cross(sub(b, a), sub(p, a));
  const d2 = cross(sub(c, b), sub(p, b));
  const d3 = cross(sub(a, c), sub(p, c));
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Barycentric coordinates of p in triangle abc. Returns null for a
 * degenerate (zero-area) triangle.
 */
export function barycentric(p: Vec2, a: Vec2, b: Vec2, c: Vec2): [number, number, number] | null {
  const den = cross(sub(b, a), sub(c, a));
  if (Math.abs(den) < 1e-12) return null;
  const u = cross(sub(p, a), sub(c, a)) / den;
  const v = cross(sub(b, a), sub(p, a)) / den;
  return [1 - u - v, u, v];
}

export function roundTo(value: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function stableNumber(value: number, digits = 6): string {
  if (!Number.isFinite(value)) return String(value);
  const v = roundTo(value, digits);
  return Object.is(v, -0) ? '0' : String(v);
}
