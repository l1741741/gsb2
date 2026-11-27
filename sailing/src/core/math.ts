export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export const TAU = Math.PI * 2;
export const EPSILON = 1e-9;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(v: Vec2, factor: number): Vec2 {
  return { x: v.x * factor, y: v.y * factor };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

export function normalize(v: Vec2): Vec2 {
  const len = length(v);
  return len > EPSILON ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
}

/** Wrap an angle into [-PI, PI]. */
export function wrapPi(angle: number): number {
  let value = (angle + Math.PI) % TAU;
  if (value < 0) value += TAU;
  return value - Math.PI;
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Normalize a compass bearing in degrees to [0, 360). */
export function normalizeBearing(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Compass bearing (0 = north / -y, 90 = east / +x) to a screen-space vector.
 * Canvas y grows downward, so north is negative y.
 */
export function bearingToVector(deg: number): Vec2 {
  const rad = degToRad(deg);
  return { x: Math.sin(rad), y: -Math.cos(rad) };
}

/** Vector to compass bearing in degrees, [0, 360). */
export function vectorToBearing(v: Vec2): number {
  return normalizeBearing(radToDeg(Math.atan2(v.x, -v.y)));
}

/** Canvas rotation needed to draw a +x-pointing shape along a compass bearing. */
export function bearingToCanvasAngle(deg: number): number {
  return degToRad(deg) - Math.PI / 2;
}

export function perpendicular(v: Vec2): Vec2 {
  return { x: -v.y, y: v.x };
}

/** Left-hand normal of a bearing vector (always 90 degrees to its left). */
export function bearingNormal(deg: number): Vec2 {
  return perpendicular(bearingToVector(deg));
}

export interface SegmentIntersection {
  readonly t: number; // parameter along segment a -> b
  readonly point: Vec2;
}

/**
 * Intersection of two closed segments, or null. Parallel / collinear segments
 * are reported as non-intersecting: a boat moving exactly along a gate line is
 * not a crossing event.
 */
export function segmentIntersection(
  a: Vec2,
  b: Vec2,
  c: Vec2,
  d: Vec2,
): SegmentIntersection | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denominator = cross(r, s);
  if (Math.abs(denominator) < 1e-12) return null;
  const qp = sub(c, a);
  const t = cross(qp, s) / denominator;
  const u = cross(qp, r) / denominator;
  if (t < -EPSILON || t > 1 + EPSILON || u < -EPSILON || u > 1 + EPSILON) return null;
  const clampedT = clamp(t, 0, 1);
  return { t: clampedT, point: add(a, scale(r, clampedT)) };
}

export interface PointProjection {
  readonly distance: number;
  readonly point: Vec2;
  readonly t: number;
}

/** Closest point on segment a->b to point p. */
export function projectPointOnSegment(a: Vec2, b: Vec2, p: Vec2): PointProjection {
  const ab = sub(b, a);
  const abLengthSq = dot(ab, ab);
  const t = abLengthSq > EPSILON ? clamp(dot(sub(p, a), ab) / abLengthSq, 0, 1) : 0;
  const point = add(a, scale(ab, t));
  return { distance: distance(point, p), point, t };
}

export interface SegmentDistance {
  readonly distance: number;
  readonly a: Vec2;
  readonly b: Vec2;
  readonly point: Vec2;
}

/**
 * Shortest distance between two segments, with the closest pair and their
 * midpoint. Used for swept collision tests so a fast boat cannot tunnel
 * through an obstacle between two simulation steps.
 */
export function segmentSegmentDistance(a: Vec2, b: Vec2, c: Vec2, d: Vec2): SegmentDistance {
  const intersection = segmentIntersection(a, b, c, d);
  if (intersection) {
    return { distance: 0, a: intersection.point, b: intersection.point, point: intersection.point };
  }
  const candidates: SegmentDistance[] = [];
  const p1 = projectPointOnSegment(c, d, a);
  candidates.push({ distance: p1.distance, a, b: p1.point, point: p1.point });
  const p2 = projectPointOnSegment(c, d, b);
  candidates.push({ distance: p2.distance, a: b, b: p2.point, point: p2.point });
  const p3 = projectPointOnSegment(a, b, c);
  candidates.push({ distance: p3.distance, a: p3.point, b: c, point: p3.point });
  const p4 = projectPointOnSegment(a, b, d);
  candidates.push({ distance: p4.distance, a: p4.point, b: d, point: p4.point });
  let best = candidates[0] as SegmentDistance;
  for (const candidate of candidates) {
    if (candidate.distance < best.distance) best = candidate;
  }
  return {
    distance: best.distance,
    a: best.a,
    b: best.b,
    point: { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2 },
  };
}

export interface PolygonHit {
  readonly hit: boolean;
  readonly point: Vec2;
  readonly distance: number;
}

/** Point-in-polygon via ray casting; boundary counts as inside. */
export function pointInPolygon(point: Vec2, polygon: readonly Vec2[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i] as Vec2;
    const pj = polygon[j] as Vec2;
    const straddles = pi.y > point.y !== pj.y > point.y;
    if (straddles) {
      const x = ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

/**
 * Swept test of segment a->b against a closed polygon with a clearance radius.
 * Returns the contact point when the swept hull touches the polygon.
 */
export function segmentPolygonContact(
  a: Vec2,
  b: Vec2,
  polygon: readonly Vec2[],
  clearance = 0,
): PolygonHit {
  if (polygon.length < 3) return { hit: false, point: a, distance: Infinity };
  if (pointInPolygon(a, polygon) || pointInPolygon(b, polygon)) {
    return { hit: true, point: pointInPolygon(a, polygon) ? a : b, distance: 0 };
  }
  let bestDistance = Infinity;
  let bestPoint: Vec2 = a;
  for (let i = 0; i < polygon.length; i++) {
    const c = polygon[i] as Vec2;
    const d = polygon[(i + 1) % polygon.length] as Vec2;
    const result = segmentSegmentDistance(a, b, c, d);
    if (result.distance < bestDistance) {
      bestDistance = result.distance;
      bestPoint = result.point;
    }
  }
  return {
    hit: bestDistance <= clearance + EPSILON,
    point: bestPoint,
    distance: bestDistance,
  };
}

/** Rectangle corners from a center, axis bearing, length and width. */
export function orientedRectangle(
  center: Vec2,
  axisDeg: number,
  lengthAlong: number,
  widthAcross: number,
): Vec2[] {
  const axis = bearingToVector(axisDeg);
  const side = perpendicular(axis);
  const halfLength = lengthAlong / 2;
  const halfWidth = widthAcross / 2;
  return [
    add(add(center, scale(axis, -halfLength)), scale(side, -halfWidth)),
    add(add(center, scale(axis, halfLength)), scale(side, -halfWidth)),
    add(add(center, scale(axis, halfLength)), scale(side, halfWidth)),
    add(add(center, scale(axis, -halfLength)), scale(side, halfWidth)),
  ];
}

/** Bounding box of a polygon. */
export function polygonBounds(polygon: readonly Vec2[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Deterministic formatting helper shared by rendering and reports. */
export function formatOne(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

export function formatPoint(p: Vec2): string {
  return `${Math.round(p.x)}, ${Math.round(p.y)}`;
}
