// 平面多边形几何：耳切三角化、线段与三角形求交、共面多边形重叠判定。
// 这里的“平面多边形”指每个面在其局部平面内是简单多边形；折叠过程中面始终为刚体平面片。

import {
  add,
  cross,
  distance,
  dot,
  matApply,
  normalize,
  scale,
  sub,
} from './math3d.js';

// 二维投影后的点只有 [x, y] 两个分量，不能复用三维向量函数（第三个分量会变成 NaN）。
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]];
const dot2 = (a, b) => a[0] * b[0] + a[1] * b[1];
const add2 = (a, b) => [a[0] + b[0], a[1] + b[1]];
const scale2 = (a, s) => [a[0] * s, a[1] * s];
const distance2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// ---------------------------------------------------------------------------
// 2D 耳切三角化（输入为同一平面内的点，先投影到二维再处理）
// ---------------------------------------------------------------------------

function signedArea2(points) {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

// 点是否在三角形内（含边界），用叉积朝向判定，兼容顺/逆时针三角形。
function pointInTriangle2(p, a, b, c) {
  const d1 = orient2(p, a, b);
  const d2 = orient2(p, b, c);
  const d3 = orient2(p, c, a);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function orient2(p, a, b) {
  return (a[0] - p[0]) * (b[1] - p[1]) - (b[0] - p[0]) * (a[1] - p[1]);
}

// 把平面内的三维点序列投影到二维，返回 { points2, to3 }。
function projectTo2D(points3d, normal) {
  const n = normalize(normal);
  const ref = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  // u 必须在垂直于 n 的平面内：cross(n, ref) 天然与 n 正交；
  // 写反成 cross(ref, n) 且 ref 与 n 平行时会退化为零向量。
  const u = normalize(cross(n, ref));
  const v = cross(u, n);
  const origin = points3d[0];
  const points2 = points3d.map((p) => {
    const d = sub(p, origin);
    return [dot(d, u), dot(d, v)];
  });
  return {
    points2,
    to3: (p2) => add(add(origin, scale(u, p2[0])), scale(v, p2[1])),
  };
}

// 耳切法三角化。points3d 必须共面且构成简单多边形（顺序可顺可逆）。
// 返回三角形顶点在原数组中的索引三元组列表。
export function triangulate(points3d) {
  const count = points3d.length;
  if (count < 3) throw new RangeError('polygon needs at least 3 vertices');
  const normal = cross(sub(points3d[1], points3d[0]), sub(points3d[2], points3d[0]));
  const { points2 } = projectTo2D(points3d, normal);

  // 统一为逆时针，耳切的“凸顶点”判断才一致。
  let indices = points2.map((_, i) => i);
  if (signedArea2(points2) < 0) indices.reverse();

  const triangles = [];
  let guard = 0;
  while (indices.length > 3) {
    let earFound = false;
    for (let k = 0; k < indices.length; k += 1) {
      const i0 = indices[(k - 1 + indices.length) % indices.length];
      const i1 = indices[k];
      const i2 = indices[(k + 1) % indices.length];
      const a = points2[i0];
      const b = points2[i1];
      const c = points2[i2];
      const crossZ = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (crossZ <= 0) continue; // 凹顶点或共线，不是耳
      let containsOther = false;
      for (const idx of indices) {
        if (idx === i0 || idx === i1 || idx === i2) continue;
        if (pointInTriangle2(points2[idx], a, b, c)) {
          containsOther = true;
          break;
        }
      }
      if (containsOther) continue;
      triangles.push([i0, i1, i2]);
      indices.splice(k, 1);
      earFound = true;
      break;
    }
    if (!earFound) {
      // 共线顶点等退化情况：放宽为接受任意凸顶点；仍失败则报错而不是静默产出错误三角化。
      guard += 1;
      if (guard > 2) throw new Error('polygon triangulation failed (degenerate or self-intersecting polygon)');
      triangles.push([indices[0], indices[1], indices[2]]);
      indices.splice(1, 1);
    }
  }
  triangles.push([indices[0], indices[1], indices[2]]);
  return triangles;
}

// ---------------------------------------------------------------------------
// 线段 vs 三角形（Möller–Trumbore），区分内部穿越与边界接触
// ---------------------------------------------------------------------------

// 返回 null（不相交）或 { kind: 'cross'|'touch', point, u, v, w }。
// cross = 从三角形内部穿过；touch = 仅在三角形边或顶点处接触。
export function segmentTriangle(p0, p1, tri, eps) {
  const [a, b, c] = tri;
  const edge1 = sub(b, a);
  const edge2 = sub(c, a);
  const direction = sub(p1, p0);
  const pvec = cross(direction, edge2);
  const det = dot(edge1, pvec);
  if (Math.abs(det) < eps) return null; // 线段与三角形平面平行

  const invDet = 1 / det;
  const tvec = sub(p0, a);
  const u = dot(tvec, pvec) * invDet;
  if (u < -eps || u > 1 + eps) return null;
  const qvec = cross(tvec, edge1);
  const v = dot(direction, qvec) * invDet;
  if (v < -eps || u + v > 1 + eps) return null;
  const t = dot(edge2, qvec) * invDet;
  if (t < -eps || t > 1 + eps) return null;

  const uu = Math.max(0, Math.min(1, u));
  const vv = Math.max(0, Math.min(1, v));
  const onBoundary = uu <= eps || vv <= eps || uu + vv >= 1 - eps;
  const point = add(p0, scale(direction, Math.max(0, Math.min(1, t))));
  return { kind: onBoundary ? 'touch' : 'cross', point, u: uu, v: vv, w: 1 - uu - vv };
}

// 共面的两个三角形是否有二维面积重叠（共享边/仅顶点接触不算面积重叠）。
// 用 SAT 分离轴定理：两个凸多边形不重叠，当且仅当存在一条轴使投影区间严格分离。
// 共面三角形只需检查各自三条边的法线（共 6 条候选轴）。
function coplanarTrianglesOverlap(triA, triB, eps) {
  const normal = normalize(cross(sub(triA[1], triA[0]), sub(triA[2], triA[0])));
  const all = [...triA, ...triB];
  const { points2 } = projectTo2D(all, normal);
  const a = points2.slice(0, 3);
  const b = points2.slice(3, 6);
  // SAT 判定的是精确拓扑（边贴合 vs 面积压过），容差只用于吸收浮点误差，
  // 因此按投影坐标跨度相对取，而不直接用按模型尺寸放大的 eps。
  const coords = [...a, ...b].flat();
  const span = Math.max(...coords.map(Math.abs)) || 1;
  const satEps = span * 1e-9;
  const axes = [];
  for (const tri of [a, b]) {
    for (let i = 0; i < 3; i += 1) {
      const e = sub2(tri[(i + 1) % 3], tri[i]);
      axes.push([-e[1], e[0]]); // 边的法线
    }
  }
  for (const axis of axes) {
    const pa = a.map((p) => dot2(p, axis));
    const pb = b.map((p) => dot2(p, axis));
    const minA = Math.min(...pa);
    const maxA = Math.max(...pa);
    const minB = Math.min(...pb);
    const maxB = Math.max(...pb);
    // 区间存在严格间隙 => 找到分离轴 => 完全不相交。
    if (maxA < minB - satEps || maxB < minA - satEps) return false;
  }
  // 没有分离轴。面积重叠要求在“每一条”轴上都真正压过（深度 > 浮点容差）；
  // 只要存在一条轴压合深度≈0，就是沿该轴的边/顶点贴合，只有一维接触而非面积交叠。
  return axes.every((axis) => {
    const pa = a.map((p) => dot2(p, axis));
    const pb = b.map((p) => dot2(p, axis));
    const minA = Math.min(...pa);
    const maxA = Math.max(...pa);
    const minB = Math.min(...pb);
    const maxB = Math.max(...pb);
    return Math.min(maxA, maxB) - Math.max(minA, minB) > satEps;
});
}

// 共面两三角形是否只在边界/顶点处接触（无面积重叠时调用）。
function coplanarTrianglesTouch(triA, triB, eps) {
  const normal = normalize(cross(sub(triA[1], triA[0]), sub(triA[2], triA[0])));
  const { points2 } = projectTo2D([...triA, ...triB], normal);
  const a = points2.slice(0, 3);
  const b = points2.slice(3, 6);
  // 顶点落在另一三角形内或其边上。
  for (const p of b) {
    if (pointInTriangle2(p, ...a)) return true;
    if (onEdge2(p, a, eps)) return true;
  }
  for (const p of a) {
    if (pointInTriangle2(p, ...b)) return true;
    if (onEdge2(p, b, eps)) return true;
  }
  // 边与边相交（含端点相交），或一三角形顶点贴到另一边。
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      if (segmentSegment2(a[i], a[(i + 1) % 3], b[j], b[(j + 1) % 3], eps) !== null) return true;
      if (pointSegmentDistance2(a[i], b[j], b[(j + 1) % 3]) <= eps) return true;
    }
  }
  return false;
}

function onEdge2(p, tri, eps) {
  for (let i = 0; i < 3; i += 1) {
    if (pointSegmentDistance2(p, tri[i], tri[(i + 1) % 3]) <= eps) return true;
  }
  return false;
}

function pointSegmentDistance2(p, a, b) {
  const ab = sub2(b, a);
  const lenSq = dot2(ab, ab);
  if (lenSq <= 1e-24) return distance2(p, a); // 退化边：退化为到端点的距离
  const t = Math.max(0, Math.min(1, dot2(sub2(p, a), ab) / lenSq));
  return distance2(p, add2(a, scale2(ab, t)));
}

// 返回 'interior'（线段内部相交）| 'endpoint'（仅端点处相接）| null。
// eps 为二维坐标容差，由调用方按模型尺寸给出。
function segmentSegment2(p1, p2, q1, q2, eps = 1e-9) {
  const r = sub2(p2, p1);
  const s = sub2(q2, q1);
  const denom = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(denom) < eps * eps) return null;
  const t = ((q1[0] - p1[0]) * s[1] - (q1[1] - p1[1]) * s[0]) / denom;
  const u = ((q1[0] - p1[0]) * r[1] - (q1[1] - p1[1]) * r[0]) / denom;
  const inside = (v) => v >= -eps && v <= 1 + eps;
  if (!inside(t) || !inside(u)) return null;
  const strict = (v) => v > eps && v < 1 - eps;
  return strict(t) && strict(u) ? 'interior' : 'endpoint';
}

// ---------------------------------------------------------------------------
// 两个面（已三角化、已变换到世界坐标）之间的完整关系判定
// ---------------------------------------------------------------------------

// 输入两组世界坐标三角形，返回 'cross' | 'touch' | 'none'。
// cross: 存在边从另一三角形内部穿过，或共面面积重叠。
// touch: 只在边界/顶点处接触（贴合但不互穿）。
function areCoplanar(src, tri, eps) {
  const na = normalize(cross(sub(src[1], src[0]), sub(src[2], src[0])));
  const nb = normalize(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])));
  return Math.abs(dot(na, nb)) > 1 - 1e-8 && Math.abs(dot(sub(tri[0], src[0]), na)) <= eps;
}

export function classifyTriangleSets(trisA, trisB, eps) {
  let touched = false;

  for (const tri of trisB) {
    for (const src of trisA) {
      if (areCoplanar(src, tri, eps)) {
        // 共面时线段-三角形求交失效（方向与平面平行），改走完整二维判定：
        // 面积重叠 => 互穿；仅边/顶点接触 => 贴合；否则无接触。
        if (coplanarTrianglesOverlap(src, tri, eps)) return 'cross';
        if (coplanarTrianglesTouch(src, tri, eps)) touched = true;
        continue;
      }
      for (const edge of [[src[0], src[1]], [src[1], src[2]], [src[2], src[0]]]) {
        const hit = segmentTriangle(edge[0], edge[1], tri, eps);
        if (hit?.kind === 'cross') return 'cross';
        if (hit?.kind === 'touch') touched = true;
      }
      for (const edge of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) {
        const hit = segmentTriangle(edge[0], edge[1], src, eps);
        if (hit?.kind === 'cross') return 'cross';
        if (hit?.kind === 'touch') touched = true;
      }
    }
  }
  return touched ? 'touch' : 'none';
}

// 变换一整组三角形：R 为旋转矩阵，t 为平移向量。
export function transformTriangles(triangles, points, R, t) {
  return triangles.map((tri) => tri.map((idx) => add(matApply(R, points[idx]), t)));
}
