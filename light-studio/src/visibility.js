// 可见性计算：从光源出发的可见多边形（visibility polygon）。
//
// 关键策略：
// 1. 对每个遮挡线段的两个端点，沿其真实角度以及 ±ANGLE_EPS 各投一条射线，
//    误差只存在于 1e-5 弧度的楔形内，短边、共享顶点（T 形接头、墙角）附近
//    不会出现成片漏光或黑边；
// 2. 额外按固定角度步长补投扫描射线，保证灯光最大照明距离处的圆弧边界平滑；
// 3. 聚光灯只在 [aim-fov, aim+fov] 角度域内生成射线，域外不可见。
//
// 所有输入输出均为世界坐标，与渲染缩放无关。

import { ANGLE_EPS, angleDelta, distance, pointInPolygon, properCrossing, raySegment, wrapAngle } from './geometry.js';
import { isOmni } from './scene.js';

const TAU = Math.PI * 2;
const SWEEP_STEP = 0.02;

// 判断点是否位于某盏灯的锥角域内（全向灯恒为真）。
export function pointInCone(light, point) {
  if (isOmni(light)) return true;
  const angle = Math.atan2(point.y - light.y, point.x - light.x);
  return Math.abs(angleDelta(angle, light.aim)) <= light.fov + ANGLE_EPS;
}

function inDomain(angle, light) {
  if (isOmni(light)) return true;
  return Math.abs(angleDelta(angle, light.aim)) <= light.fov + ANGLE_EPS * 0.5;
}

// 两点之间是否无遮挡（严格跨立才算遮挡，端点接触允许通过）。
export function isVisible(segments, from, to) {
  for (const segment of segments) {
    if (properCrossing(from, to, segment)) return false;
  }
  return true;
}

function nearestHit(segments, origin, angle, maxRange) {
  let best = maxRange;
  for (const segment of segments) {
    const t = raySegment(origin, angle, segment);
    if (t !== null && t < best) best = t;
  }
  return { x: origin.x + Math.cos(angle) * best, y: origin.y + Math.sin(angle) * best, t: best };
}

// 生成候选角度：端点方向（含 ±扰动）与扫描方向，过滤到锥角域内。
function candidateAngles(segments, light) {
  const origin = { x: light.x, y: light.y };
  const angles = [];
  for (const segment of segments) {
    for (const endpoint of [segment.a, segment.b]) {
      const base = Math.atan2(endpoint.y - origin.y, endpoint.x - origin.x);
      for (const offset of [-ANGLE_EPS, 0, ANGLE_EPS]) {
        const angle = wrapAngle(base + offset);
        if (inDomain(angle, light)) angles.push(angle);
      }
    }
  }
  if (isOmni(light)) {
    for (let a = -Math.PI; a < Math.PI; a += SWEEP_STEP) angles.push(wrapAngle(a));
  } else {
    const left = wrapAngle(light.aim - light.fov);
    const right = wrapAngle(light.aim + light.fov);
    let delta = angleDelta(right, left);
    if (delta < 0) delta += TAU;
    for (let d = 0; d <= delta; d += SWEEP_STEP) {
      angles.push(wrapAngle(left + d));
    }
    angles.push(left, right);
  }
  // 不在角度维度去重：同一方向可能先命中墙端、再在射程边界结束，
  // 这是两个不同的顶点。重复命中同一空间点由 buildVisibilityPolygon 去重。
  angles.sort((a, b) => a - b);
  return angles;
}

// 计算一盏灯的可见多边形。返回以灯为中心、按角度排序的顶点数组。
export function buildVisibilityPolygon(light, segments) {
  const origin = { x: light.x, y: light.y };
  const angles = candidateAngles(segments, light);
  const hits = [];
  for (const angle of angles) {
    const hit = nearestHit(segments, origin, angle, light.range);
    // 空间去重：命中同一点的多条射线（如共享顶点）只保留一个顶点。
    if (!hits.some((p) => distance(p, hit) < 1e-6)) hits.push(hit);
  }
  hits.sort((p, q) => Math.atan2(p.y - origin.y, p.x - origin.x)
    - Math.atan2(q.y - origin.y, q.x - origin.x));
  // 聚光灯需要把灯心加入多边形形成扇形；全向灯的命中点本身已绕灯一周。
  if (isOmni(light)) return hits;
  return [origin, ...hits];
}

// 点是否在可见多边形内（边界也算可见）。
export function pointInVisibility(point, polygon) {
  return pointInPolygon(point, polygon);
}
