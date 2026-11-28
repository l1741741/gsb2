// 面与面的关系检测：邻接（共享折缝，始终接合，不参与检测）、
// 互穿（几何上真正穿过对方内部）、贴合（仅边界/顶点接触，没有面积交叠）。

import { classifyTriangleSets } from './geometry.js';
import { add, clamp, distance, dot, scale, sub } from './math3d.js';
import { solveAt } from './solver.js';

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

// 共享折缝的面对集合：这些是正常邻接，运动学保证接合，检测时跳过。
export function adjacentPairs(model) {
  const pairs = new Set();
  for (const crease of model.creases.values()) {
    pairs.add(pairKey(crease.faces[0], crease.faces[1]));
  }
  return pairs;
}

// 点到三角形距离（内部点取平面距离，外部点取到三条边的最短距离）。
function pointTriangleDistance(p, tri) {
  const [a, b, c] = tri;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const normal = (() => {
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    return scale(n, 1 / len);
  })();
  const planeDist = Math.abs(dot(sub(p, a), normal));
  // 重心坐标判定投影是否落在三角形内。
  const u = dot(sub(p, a), ab) / (dot(ab, ab) || 1);
  const v = dot(sub(p, a), ac) / (dot(ac, ac) || 1);
  if (u >= 0 && v >= 0 && u + v <= 1) return planeDist;
  return Math.min(
    pointSegmentDistance(p, a, b),
    pointSegmentDistance(p, b, c),
    pointSegmentDistance(p, c, a),
  );
}

function pointSegmentDistance(p, a, b) {
  const ab = sub(b, a);
  const t = clamp(dot(sub(p, a), ab) / (dot(ab, ab) || 1), 0, 1);
  return distance(p, add(a, scale(ab, t)));
}

// 三维线段最短距离。
function segmentSegmentDistance(p1, p2, q1, q2) {
  const d1 = sub(p2, p1);
  const d2 = sub(q2, q1);
  const r = sub(p1, q1);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  const denom = a * e - dot(d1, d2) ** 2;
  let s;
  let t;
  if (Math.abs(denom) < 1e-18) {
    s = 0;
    t = f / (e || 1);
  } else {
    s = clamp((dot(d1, d2) * f - e * dot(d1, r)) / denom, 0, 1);
    t = (dot(d1, d2) * s + f) / (e || 1);
    if (t < 0) { t = 0; s = clamp(-dot(d1, r) / (a || 1), 0, 1); }
    else if (t > 1) { t = 1; s = clamp((dot(d1, d2) - dot(d1, r)) / (a || 1), 0, 1); }
  }
  const c1 = add(p1, scale(d1, s));
  const c2 = add(q1, scale(d2, t));
  return distance(c1, c2);
}

function triangleSetDistance(trisA, trisB) {
  let best = Infinity;
  for (const ta of trisA) {
    for (const tb of trisB) {
      for (const p of ta) best = Math.min(best, pointTriangleDistance(p, tb));
      for (const p of tb) best = Math.min(best, pointTriangleDistance(p, ta));
      for (let i = 0; i < 3; i += 1) {
        for (let j = 0; j < 3; j += 1) {
          best = Math.min(best, segmentSegmentDistance(ta[i], ta[(i + 1) % 3], tb[j], tb[(j + 1) % 3]));
        }
      }
    }
  }
  return best;
}

// 在给定姿态下分析全部非邻接面对。
// 返回 { contacts: [...], crossingPairs: Set, touchingPairs: Set }。
// contact: { faces, kind: 'cross'|'touch', minDistance, points }
export function analyzeContacts(model, poses) {
  const adjacent = adjacentPairs(model);
  const ids = model.faceOrder;
  const contacts = [];
  const crossingPairs = new Set();
  const touchingPairs = new Set();

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i];
      const b = ids[j];
      if (adjacent.has(pairKey(a, b))) continue;
      const kind = classifyTriangleSets(poses.get(a).triangles, poses.get(b).triangles, model.eps);
      if (kind === 'none') continue;
      const minDistance = kind === 'touch'
        ? triangleSetDistance(poses.get(a).triangles, poses.get(b).triangles)
        : 0;
      const record = { faces: [a, b], kind, minDistance };
      contacts.push(record);
      if (kind === 'cross') crossingPairs.add(pairKey(a, b));
      else touchingPairs.add(pairKey(a, b));
    }
  }
  return { contacts, crossingPairs, touchingPairs };
}

// 沿进度做一次粗扫，用于回答“哪两片先穿过去”。
// 返回每个采样点的检测结果，以及首个出现互穿的进度（在两个采样点之间二分细化）。
export function scanProgress(model, steps = 120) {
  const samples = [];
  let firstCross = null;
  for (let i = 0; i <= steps; i += 1) {
    const progress = i / steps;
    const poses = solveAt(model, progress);
    const result = analyzeContacts(model, poses);
    samples.push({ progress, crossing: [...result.crossingPairs], touching: [...result.touchingPairs] });
    if (firstCross === null && result.crossingPairs.size > 0) {
      firstCross = { progress, pairs: [...result.crossingPairs] };
    }
  }

  if (firstCross) {
    const index = samples.findIndex((s) => s.crossing.length > 0);
    const lo = index === 0 ? 0 : samples[index - 1].progress;
    const hi = samples[index].progress;
    // 二分：互穿是闭区间事件，找最早使任一面对互穿的进度。
    let left = lo;
    let right = hi;
    for (let k = 0; k < 40; k += 1) {
      const mid = (left + right) / 2;
      const result = analyzeContacts(model, solveAt(model, mid));
      if (result.crossingPairs.size > 0) right = mid;
      else left = mid;
    }
    firstCross = { progress: right, pairs: firstCross.pairs };
  }
  return { samples, firstCross };
}
