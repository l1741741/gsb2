/**
 * 偏移引擎：规范化输入 → ClipperOffset（实体区域，显式方向）→
 * PolyTree 还原包含层级 → 与原区域做布尔差求删除细片。
 *
 * 关键正确性约束：
 * - 自交轮廓在 validate 阶段拦截，不进入本引擎；
 * - ClipperOffset 使用 etClosedPolygon + outer(CCW)/hole(CW) 显式方向，
 *   凹角处由 Clipper 的自交清理保证输出为简单环，自交段不会被当成零件外边；
 * - 孔洞吞并且通道闭合全部体现在 PolyTree 的层级变化上。
 */
import ClipperLib from 'clipper-lib';
import type { IntPaths, PolyNode, PolyTree } from 'clipper-lib';
import type {
  Loop,
  OffsetParams,
  OffsetResult,
  RemovedSliver,
  ResultLoop,
} from './types.js';
import {
  DEFAULT_SCALE,
  cleanFloatLoop,
  fromIntPath,
  normalizeLoops,
  toIntPaths,
} from './hierarchy.js';
import { signedArea } from './primitives.js';

const C = ClipperLib;

export const DEFAULT_PARAMS: OffsetParams = {
  distance: 0,
  join: 'miter',
  miterLimit: 2,
  arcTolerance: 0,
  cleanTolerance: 0,
};

function joinTypeOf(join: OffsetParams['join']): number {
  switch (join) {
    case 'miter':
      return C.JoinType.jtMiter;
    case 'round':
      return C.JoinType.jtRound;
    case 'square':
      return C.JoinType.jtSquare;
  }
}

export interface EngineOptions {
  scale?: number;
}

interface RawNode {
  path: Loop;
  isHole: boolean;
  depth: number;
  children: RawNode[];
}

/** 递归展开 PolyTree，根节点的空 Contour 被跳过。 */
function readPolyTree(tree: PolyTree, scale: number): RawNode[] {
  const out: RawNode[] = [];
  const walk = (node: PolyNode, depth: number, sink: RawNode[]): void => {
    const contour = node.Contour();
    let nextSink = sink;
    let nextDepth = depth;
    if (contour.length > 0) {
      const path = cleanFloatLoop(fromIntPath(contour, scale));
      const raw: RawNode = { path, isHole: node.IsHole(), depth, children: [] };
      sink.push(raw);
      nextSink = raw.children;
      nextDepth = depth + 1;
    }
    for (const child of node.Childs()) {
      walk(child, nextDepth, nextSink);
    }
  };
  walk(tree, 0, out);
  return out;
}

/** 原始区域与结果区域的差异：收缩=被删材料，外扩=新增材料。 */
function diffSlivers(
  original: IntPaths,
  resultPaths: IntPaths,
  scale: number,
  distance: number,
): RemovedSliver[] {
  const toSliver = (p: (typeof original)[number], idx: number, kind: RemovedSliver['kind']): RemovedSliver | null => {
    const points = cleanFloatLoop(fromIntPath(p, scale));
    if (points.length < 3) return null;
    return { id: `sliver-${idx}`, points, area: Math.abs(signedArea(points)), kind };
  };

  const slivers: RemovedSliver[] = [];

  // 收缩或 distance=0：原区域减结果区域 = 被吃掉的材料（细通道、吞掉的孔外材料）
  if (distance <= 0) {
    const clipper = new C.Clipper();
    clipper.AddPaths(original, C.PolyType.ptSubject, true);
    if (resultPaths.length > 0) {
      clipper.AddPaths(resultPaths, C.PolyType.ptClip, true);
    }
    const diff: IntPaths = new C.Paths();
    clipper.Execute(
      C.ClipType.ctDifference,
      diff,
      C.PolyFillType.pftEvenOdd,
      C.PolyFillType.pftEvenOdd,
    );
    diff.forEach((p, i) => {
      const s = toSliver(p, i, 'removed');
      if (s) slivers.push(s);
    });
  } else {
    // 外扩：结果减原区域 = 新增材料
    const clipper = new C.Clipper();
    clipper.AddPaths(resultPaths, C.PolyType.ptSubject, true);
    clipper.AddPaths(original, C.PolyType.ptClip, true);
    const diff: IntPaths = new C.Paths();
    clipper.Execute(
      C.ClipType.ctDifference,
      diff,
      C.PolyFillType.pftEvenOdd,
      C.PolyFillType.pftEvenOdd,
    );
    diff.forEach((p, i) => {
      const s = toSliver(p, i, 'added');
      if (s) slivers.push(s);
    });
  }
  return slivers.map((s, i) => ({ ...s, id: `sliver-${i}` }));
}

/** 用最近点把结果环关联回输入环下标；孔洞合并时等距的多个源都会保留。 */
function traceSources(resultLoop: Loop, originals: Loop[]): number[] {
  const c = resultLoop[0];
  const dists = originals.map((src) => {
    let best = Infinity;
    for (const p of src) {
      const d = (p.x - c.x) ** 2 + (p.y - c.y) ** 2;
      if (d < best) best = d;
    }
    return best;
  });
  const minD = Math.min(...dists);
  return dists
    .map((d, i) => (d <= minD + 1e-9 ? i : -1))
    .filter((i) => i >= 0);
}

/**
 * 对一组已通过校验的简单闭合环执行偏移。
 * 返回包含层级、组件拆分与细片差异的完整结果。
 */
export function offsetContours(
  loops: Loop[],
  params: OffsetParams,
  options: EngineOptions = {},
): OffsetResult {
  const scale = options.scale ?? DEFAULT_SCALE;
  const { loops: normalized } = normalizeLoops(loops);
  const originalInt = toIntPaths(normalized, scale);

  const cleanDist = Math.max(0, params.cleanTolerance) * scale || scale * 0.01;
  const cleaned = C.Clipper.CleanPolygons(originalInt, cleanDist);

  const offsetter = new C.ClipperOffset(
    params.miterLimit,
    params.arcTolerance * scale,
  );
  offsetter.AddPaths(cleaned, joinTypeOf(params.join), C.EndType.etClosedPolygon);
  const tree = new C.PolyTree();
  offsetter.Execute(tree, params.distance * scale);

  const raw = readPolyTree(tree, scale);
  const resultInt = C.Clipper.PolyTreeToPaths(tree);

  const components: ResultLoop[][] = [];
  const allLoops: ResultLoop[] = [];
  let loopCounter = 0;

  const build = (node: RawNode, componentId: string): void => {
    const role = node.isHole ? 'hole' : 'outer';
    const rl: ResultLoop = {
      id: `${componentId}-L${loopCounter++}`,
      role,
      depth: node.depth,
      componentId,
      points: node.path,
      signedArea: signedArea(node.path),
      sourceLoops: traceSources(node.path, normalized),
    };
    const bucket = components[components.length - 1];
    bucket.push(rl);
    allLoops.push(rl);
    for (const ch of node.children) build(ch, componentId);
  };

  let compCounter = 0;
  for (const node of raw) {
    const componentId = `component-${compCounter++}`;
    components.push([]);
    build(node, componentId);
  }

  const slivers = diffSlivers(cleaned, resultInt, scale, params.distance);
  const removedArea = slivers
    .filter((s) => s.kind === 'removed')
    .reduce((a, s) => a + s.area, 0);
  const addedArea = slivers
    .filter((s) => s.kind === 'added')
    .reduce((a, s) => a + s.area, 0);

  return {
    params: { ...params },
    components,
    loops: allLoops,
    removedSlivers: slivers,
    empty: allLoops.length === 0,
    stats: {
      outerCount: allLoops.filter((l) => l.role === 'outer').length,
      holeCount: allLoops.filter((l) => l.role === 'hole').length,
      sliverCount: slivers.length,
      removedArea,
      addedArea,
    },
  };
}
