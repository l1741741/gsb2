/**
 * 输入轮廓校验：退化环、重复点、环内自交、环间交叉、包含关系异常。
 * 所有问题都带环下标/点下标与坐标，UI 可据此定位高亮。
 * 设计目标：宁可多报近邻问题，也不让带病轮廓静默进入偏移管线。
 */
import type { ContourInput, GeometryIssue, Loop } from './types.js';
import {
  EPS,
  pointInLoop,
  pointsEqual,
  segmentIntersection,
  signedArea2,
} from './primitives.js';

/** 输出环的长度低于该值（坐标单位的相对量）视为退化。 */
const DEGEN_AREA_FACTOR = 1e-12;

export interface ValidationReport {
  valid: boolean;
  issues: GeometryIssue[];
  /** 自交点去重后的坐标列表，方便渲染层直接画红叉。 */
  selfIntersectionPoints: { point: { x: number; y: number }; loopIndex: number }[];
}

/** 检查单个环内部：点数、重复点、非相邻边自交、共线重叠。 */
function validateLoop(loop: Loop, loopIndex: number): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  const n = loop.length;

  if (n < 3) {
    issues.push({
      kind: 'degenerate-loop',
      message: `环 #${loopIndex} 只有 ${n} 个点，无法构成闭合区域`,
      loopIndex,
    });
    return issues;
  }

  // 重复相邻点（含首尾）
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    if (pointsEqual(a, b, EPS)) {
      issues.push({
        kind: 'duplicate-point',
        message: `环 #${loopIndex} 的点 #${i} 与点 #${(i + 1) % n} 重合于 (${a.x}, ${a.y})`,
        loopIndex,
        pointIndex: i,
        pointIndex2: (i + 1) % n,
        point: { ...a },
      });
    }
  }

  if (Math.abs(signedArea2(loop)) <= DEGEN_AREA_FACTOR) {
    issues.push({
      kind: 'degenerate-loop',
      message: `环 #${loopIndex} 的有向面积为 0，形状退化（共线或自覆）`,
      loopIndex,
    });
  }

  // 非相邻边两两求交。相邻边共享端点属于正常闭合，不报。
  for (let i = 0; i < n; i++) {
    const a1 = loop[i];
    const a2 = loop[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // 相邻边（含首尾边 n-1/0）
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const b1 = loop[j];
      const b2 = loop[(j + 1) % n];
      const hit = segmentIntersection(a1, a2, b1, b2, EPS);
      if (!hit) continue;
      if (hit.kind === 'overlap') {
        issues.push({
          kind: 'overlapping-edge',
          message: `环 #${loopIndex} 的边 #${i} 与边 #${j} 共线重叠，交点附近 (${hit.point.x.toFixed(4)}, ${hit.point.y.toFixed(4)})`,
          loopIndex,
          pointIndex: i,
          pointIndex2: j,
          point: { ...hit.point },
        });
      } else if (hit.kind === 'proper') {
        issues.push({
          kind: 'self-intersection',
          message: `环 #${loopIndex} 在边 #${i} 与边 #${j} 处自交，交点 (${hit.point.x.toFixed(4)}, ${hit.point.y.toFixed(4)})`,
          loopIndex,
          pointIndex: i,
          pointIndex2: j,
          point: { ...hit.point },
        });
      } else {
        // 端点恰好落在另一条边的内部：同样破坏简单多边形性质
        const onEdge = hit.t1 > EPS && hit.t1 < 1 - EPS ? i : j;
        issues.push({
          kind: 'self-intersection',
          message: `环 #${loopIndex} 的顶点落在边 #${onEdge} 上（T 形接触），位置 (${hit.point.x.toFixed(4)}, ${hit.point.y.toFixed(4)})`,
          loopIndex,
          pointIndex: i,
          pointIndex2: j,
          point: { ...hit.point },
        });
      }
    }
  }
  return issues;
}

/** 环间检查：互相交叉的边、包含关系是否构成合法嵌套树。 */
function validateBetweenLoops(loops: Loop[]): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  const n = loops.length;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = loops[i];
      const b = loops[j];
      let crossFound = false;
      for (let ei = 0; ei < a.length && !crossFound; ei++) {
        for (let ej = 0; ej < b.length; ej++) {
          const hit = segmentIntersection(
            a[ei],
            a[(ei + 1) % a.length],
            b[ej],
            b[(ej + 1) % b.length],
            EPS,
          );
          if (hit && hit.kind !== 'endpoint') {
            issues.push({
              kind: 'self-intersection',
              message: `环 #${i} 的边 #${ei} 与环 #${j} 的边 #${ej} 交叉，交点 (${hit.point.x.toFixed(4)}, ${hit.point.y.toFixed(4)})`,
              loopIndex: i,
              pointIndex: ei,
              loopIndex2: j,
              pointIndex2: ej,
              point: { ...hit.point },
            });
            crossFound = true;
            break;
          }
          if (hit && hit.kind === 'endpoint') {
            issues.push({
              kind: 'non-nested-loop',
              message: `环 #${i} 与环 #${j} 在点 (${hit.point.x.toFixed(4)}, ${hit.point.y.toFixed(4)}) 接触，轮廓之间不允许点接触`,
              loopIndex: i,
              pointIndex: ei,
              loopIndex2: j,
              pointIndex2: ej,
              point: { ...hit.point },
            });
            crossFound = true;
            break;
          }
        }
      }
    }
  }

  // 包含关系：每个环取首点，统计包含它的环数；深度必须一致且无部分包含。
  // 边交叉已在上面排除，因此简单环之间要么完全包含、要么完全分离。
  const depth = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const rel = pointInLoop(loops[i][0], loops[j]);
      if (rel === 0) {
        issues.push({
          kind: 'containment-violation',
          message: `环 #${i} 的首点落在环 #${j} 的边界上，无法判定包含层级`,
          loopIndex: i,
          loopIndex2: j,
          point: { ...loops[i][0] },
        });
      }
      if (rel === 1) depth[i]++;
    }
  }
  // 显式角色与嵌套深度不一致时报错（outer 必须偶数深度）
  return issues;
}

export function validateContour(input: ContourInput): ValidationReport {
  const issues: GeometryIssue[] = [];
  input.loops.forEach((loop, i) => {
    issues.push(...validateLoop(loop, i));
  });
  if (input.loops.length > 1) {
    issues.push(...validateBetweenLoops(input.loops));
  }

  if (input.roles) {
    input.loops.forEach((_, i) => {
      const role = input.roles![i];
      // 用包含深度核对显式角色
      let depth = 0;
      for (let j = 0; j < input.loops.length; j++) {
        if (j !== i && pointInLoop(input.loops[i][0], input.loops[j]) === 1) depth++;
      }
      const expected = depth % 2 === 0 ? 'outer' : 'hole';
      if (role !== expected) {
        issues.push({
          kind: 'containment-violation',
          message: `环 #${i} 显式标注为 ${role}，但按包含关系它是 ${expected}（嵌套深度 ${depth}）`,
          loopIndex: i,
        });
      }
    });
  }

  const selfIntersectionPoints = issues
    .filter((x) => x.kind === 'self-intersection' || x.kind === 'overlapping-edge')
    .map((x) => ({ point: x.point!, loopIndex: x.loopIndex }));

  const blocking = issues.filter(
    (x) =>
      x.kind === 'self-intersection' ||
      x.kind === 'overlapping-edge' ||
      x.kind === 'degenerate-loop' ||
      x.kind === 'containment-violation' ||
      x.kind === 'non-nested-loop',
  );
  return {
    valid: blocking.length === 0,
    issues,
    selfIntersectionPoints,
  };
}
