import type { Transform, Vec2 } from './types.js';

export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;

/**
 * 把角度归一化到 (-180, 180]。
 * 这是全工具唯一的角度差规则：任意两个角度之间的插值都沿最短弧进行，
 * 跨过半圈（例如 170° -> -170°）时取经过 ±180° 的 20° 短路，
 * 而不是反向扫过 340°。
 */
export function normDeg(a: number): number {
  let r = ((a % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r;
}

export function lerp(a: number, b: number, s: number): number {
  return a + (b - a) * s;
}

/** 角度插值：先归一化差值再走最短弧，结果同样归一化，保证规则一致。 */
export function lerpAngleDeg(a: number, b: number, s: number): number {
  return normDeg(a + normDeg(b - a) * s);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 欧几里得取模，结果总是落在 [0, m)。 */
export function euclideanMod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

/** 父变换 ∘ 子局部变换（无缩放，旋转单位为度）。 */
export function compose(parent: Transform, local: Transform): Transform {
  const r = deg2rad(parent.rot);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return {
    x: parent.x + local.x * c - local.y * s,
    y: parent.y + local.x * s + local.y * c,
    rot: parent.rot + local.rot,
  };
}

export function applyToPoint(t: Transform, p: Vec2): Vec2 {
  const r = deg2rad(t.rot);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: t.x + p.x * c - p.y * s, y: t.y + p.x * s + p.y * c };
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
