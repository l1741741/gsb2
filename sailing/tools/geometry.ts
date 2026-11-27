import type { Vec2 } from '../src/core/types.ts';

/** 罗盘航向 -> 屏幕向量。 */
export function bearingVector(deg: number): Vec2 {
  const rad = (deg * Math.PI) / 180;
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

/** 由中心、航线方向、半宽生成垂直于航线的标线端点。 */
export function gateLine(center: Vec2, routeHeading: number, halfWidth: number): { a: Vec2; b: Vec2 } {
  const along = bearingVector(routeHeading + 90);
  return {
    a: { x: center.x - along.x * halfWidth, y: center.y - along.y * halfWidth },
    b: { x: center.x + along.x * halfWidth, y: center.y + along.y * halfWidth },
  };
}

/** 点到线段的距离。 */
export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq)) : 0;
  return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
}

/** 航线方向（罗盘度）由相邻点得出。 */
export function headingBetween(from: Vec2, to: Vec2): number {
  return (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI;
}
