// 二维几何原语：所有计算都在世界坐标中进行，与相机缩放/平移无关。
// 点统一使用 { x, y }，线段统一使用 { a: {x,y}, b: {x,y} }。

export const EPS = 1e-9;
// 端点扰动角（弧度）。可见多边形沿每个端点的真实角度 ±ANGLE_EPS 各投一条射线，
// 把浮点误差限制在这个极窄的楔形内，避免墙边、共享顶点附近出现成片漏光。
export const ANGLE_EPS = 1e-5;

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

// 将角度规范到 (-PI, PI]。
export function wrapAngle(angle) {
  const TAU = Math.PI * 2;
  let a = angle % TAU;
  if (a <= -Math.PI) a += TAU;
  if (a > Math.PI) a -= TAU;
  return a;
}

// 从 current 转到 target 的有向角差，结果在 (-PI, PI]。
export function angleDelta(target, current) {
  return wrapAngle(target - current);
}

// 射线 O + t*d（t >= 0）与线段的相交参数 t；不相交返回 null。
export function raySegment(origin, angle, segment) {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const ex = segment.b.x - segment.a.x;
  const ey = segment.b.y - segment.a.y;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < EPS) return null;
  const fx = segment.a.x - origin.x;
  const fy = segment.a.y - origin.y;
  const t = (fx * ey - fy * ex) / denom;
  const u = (fx * dy - fy * dx) / denom;
  if (t < -EPS || u < -EPS || u > 1 + EPS) return null;
  return Math.max(0, t);
}

// 两条线段是否“真正相交”（严格跨立）。端点接触、共线重叠不算遮挡，
// 这样门缝边缘、共享顶点处不会把擦边光线误判为被挡。
export function properCrossing(o, q, segment) {
  const { a, b } = segment;
  const sx = b.x - a.x;
  const sy = b.y - a.y;
  const v1 = cross(sx, sy, o.x - a.x, o.y - a.y);
  const v2 = cross(sx, sy, q.x - a.x, q.y - a.y);
  const tx = q.x - o.x;
  const ty = q.y - o.y;
  const v3 = cross(tx, ty, a.x - o.x, a.y - o.y);
  const v4 = cross(tx, ty, b.x - o.x, b.y - o.y);
  const straddle = (p, q2) => (p > EPS && q2 < -EPS) || (p < -EPS && q2 > EPS);
  return straddle(v1, v2) && straddle(v3, v4);
}

export function distanceToSegment(point, segment) {
  const { a, b } = segment;
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared === 0) return distance(point, a);
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * vx + (point.y - a.y) * vy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * vx), point.y - (a.y + t * vy));
}

// 标准射线法点在多边形内判定，边界上的点也算在内。
export function pointInPolygon(point, polygon) {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j];
    const b = polygon[i];
    const intersects = (b.y > point.y) !== (a.y > point.y)
      && point.x < ((a.x - b.x) * (point.y - b.y)) / (a.y - b.y) + b.x;
    if (intersects) inside = !inside;
  }
  if (inside) return true;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (distanceToSegment(point, { a, b }) <= 1e-7) return true;
  }
  return false;
}
