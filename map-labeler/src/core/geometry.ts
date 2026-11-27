/**
 * 基础几何类型与纯函数。所有坐标均为平面图自身坐标系（地图单位），
 * 屏幕坐标系之间的换算集中在 view/camera.ts，核心排版逻辑不依赖 DOM。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function rectFromCorners(minX: number, minY: number, maxX: number, maxY: number): Rect {
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rectRight(r: Rect): number {
  return r.x + r.width;
}

export function rectBottom(r: Rect): number {
  return r.y + r.height;
}

export function rectCenter(r: Rect): Point {
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < rectRight(b) &&
    rectRight(a) > b.x &&
    a.y < rectBottom(b) &&
    rectBottom(a) > b.y
  );
}

export function rectContainsPoint(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= rectRight(r) && p.y >= r.y && p.y <= rectBottom(r);
}

export function inflateRect(r: Rect, amount: number): Rect {
  return {
    x: r.x - amount,
    y: r.y - amount,
    width: r.width + amount * 2,
    height: r.height + amount * 2,
  };
}

/** 重叠面积；不相交时返回 0。用于量化“压了多少”。 */
export function intersectionArea(a: Rect, b: Rect): number {
  const overlapW = Math.min(rectRight(a), rectRight(b)) - Math.max(a.x, b.x);
  const overlapH = Math.min(rectBottom(a), rectBottom(b)) - Math.max(a.y, b.y);
  return overlapW > 0 && overlapH > 0 ? overlapW * overlapH : 0;
}

export function rectArea(r: Rect): number {
  return r.width * r.height;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 线段与轴对齐矩形是否相交。
 * 连线从锚点连到标签边缘，压到禁放区时需要显式检测。
 * 使用 slab 法（Liang–Kuo 裁剪思路），线段端点在矩形内也算相交。
 */
export function segmentIntersectsRect(p1: Point, p2: Point, r: Rect): boolean {
  if (rectContainsPoint(r, p1) || rectContainsPoint(r, p2)) return true;
  let tMin = 0;
  let tMax = 1;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const slabs: Array<[number, number, number, number]> = [
    [p1.x, dx, r.x, rectRight(r)],
    [p1.y, dy, r.y, rectBottom(r)],
  ];
  for (const [origin, delta, min, max] of slabs) {
    if (Math.abs(delta) < 1e-12) {
      if (origin < min || origin > max) return false;
      continue;
    }
    let t1 = (min - origin) / delta;
    let t2 = (max - origin) / delta;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }
  return true;
}

/** 两线段是否相交（含共线重叠与端点接触）。用于连线互相交叉的检测。 */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-12) {
    // 平行：退化为共线时检查投影重叠
    if (!pointOnSegment(p1, p3, p4) && !pointOnSegment(p2, p3, p4) &&
        !pointOnSegment(p3, p1, p2) && !pointOnSegment(p4, p1, p2)) {
      return false;
    }
    return true;
  }
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

export function pointOnSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
  if (Math.abs(cross) > 1e-9) return false;
  return (
    p.x >= Math.min(a.x, b.x) - 1e-9 &&
    p.x <= Math.max(a.x, b.x) + 1e-9 &&
    p.y >= Math.min(a.y, b.y) - 1e-9 &&
    p.y <= Math.max(a.y, b.y) + 1e-9
  );
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 把矩形整体平移到边界框内（保持尺寸），用于越界标签回拉。 */
export function clampRectToBounds(r: Rect, bounds: Rect): Rect {
  return {
    x: clamp(r.x, bounds.x, Math.max(bounds.x, rectRight(bounds) - r.width)),
    y: clamp(r.y, bounds.y, Math.max(bounds.y, rectBottom(bounds) - r.height)),
    width: r.width,
    height: r.height,
  };
}
