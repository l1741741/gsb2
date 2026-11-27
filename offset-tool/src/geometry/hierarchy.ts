/**
 * 环的包含层级判定与规范化：
 * - 简单环之间无交叉（校验阶段已保证），用点包含计数求嵌套深度；
 * - 偶数深度=实体外轮廓，奇数深度=孔洞；
 * - 规范化为 Clipper 要求的方向：outer 逆时针、hole 顺时针；
 * - 浮点坐标放大为 Clipper 整数坐标，结果再缩回。
 */
import type { IntPath, IntPaths, IntPoint } from 'clipper-lib';
import type { InputLoopInfo, Loop, LoopRole, Point } from './types.js';
import { ensureOrientation, pointInLoop, pointsEqual, signedArea2 } from './primitives.js';

/** 浮点→整数的放大倍数。Clipper1 JS 整数空间约 ±4.5e15，1e6 对木工毫米坐标足够。 */
export const DEFAULT_SCALE = 1_000_000;

export interface ClassifiedLoop {
  index: number;
  role: LoopRole;
  depth: number;
  loop: Loop;
  signedArea: number;
}

/** 按包含关系给每个环定深度与角色。 */
export function classifyLoops(loops: Loop[]): ClassifiedLoop[] {
  return loops.map((loop, index) => {
    let depth = 0;
    for (let j = 0; j < loops.length; j++) {
      if (j === index) continue;
      if (pointInLoop(loop[0], loops[j]) === 1) depth++;
    }
    const role: LoopRole = depth % 2 === 0 ? 'outer' : 'hole';
    return {
      index,
      role,
      depth,
      loop,
      signedArea: signedArea2(loop) / 2,
    };
  });
}

export function describeInputs(loops: Loop[]): InputLoopInfo[] {
  return classifyLoops(loops).map((c) => ({
    index: c.index,
    role: c.role,
    signedArea: c.signedArea,
    pointCount: c.loop.length,
  }));
}

/**
 * 规范化输入环：
 * 1. 去掉首尾重复点与连续重复点；
 * 2. outer 强制 CCW，hole 强制 CW（ClipperOffset 依赖显式方向识别孔洞）；
 * 3. 不改变点的顺序以外的几何形状。
 */
export function normalizeLoops(loops: Loop[]): { loops: Loop[]; info: InputLoopInfo[] } {
  const classified = classifyLoops(loops);
  const normalized: Loop[] = [];
  const info: InputLoopInfo[] = [];
  for (const c of classified) {
    const deduped: Loop = [];
    for (const p of c.loop) {
      if (deduped.length === 0 || !pointsEqual(deduped[deduped.length - 1], p)) {
        deduped.push({ ...p });
      }
    }
    if (deduped.length > 1 && pointsEqual(deduped[0], deduped[deduped.length - 1])) {
      deduped.pop();
    }
    const oriented = ensureOrientation(deduped, c.role === 'outer');
    normalized.push(oriented);
    info.push({
      index: c.index,
      role: c.role,
      signedArea: c.signedArea,
      pointCount: oriented.length,
    });
  }
  return { loops: normalized, info };
}

export function toIntPoint(p: Point, scale: number): IntPoint {
  return { X: Math.round(p.x * scale), Y: Math.round(p.y * scale) };
}

export function toIntPaths(loops: Loop[], scale: number): IntPaths {
  return loops.map((loop) => loop.map((p) => toIntPoint(p, scale)));
}

export function fromIntPath(path: IntPath, scale: number): Loop {
  return path.map((p) => ({ x: p.X / scale, y: p.Y / scale }));
}

/** 去掉缩放+清洗后产生的连续重复点。 */
export function cleanFloatLoop(loop: Loop, eps = 1e-9): Loop {
  const out: Loop = [];
  for (const p of loop) {
    if (out.length === 0 || !pointsEqual(out[out.length - 1], p, eps)) out.push(p);
  }
  if (out.length > 1 && pointsEqual(out[0], out[out.length - 1], eps)) out.pop();
  return out;
}
