import type { Vec2 } from './types.js';
import { clamp, normDeg, rad2deg } from './math.js';

export interface IkSolution {
  /** 根骨局部旋转（度） */
  rot1: number;
  /** 末骨局部旋转（度） */
  rot2: number;
  /** 链条末端实际到达点（场景坐标） */
  end: Vec2;
  /** 不可达偏差：目标与实际末端的距离，可达时为 0 */
  deviation: number;
  reachable: boolean;
}

const EPS = 1e-9;

/**
 * 双骨骼 IK 解析解（余弦定理）。
 *
 * - 输入目标在场景坐标系；rootPos 为链条根关节的场景位置，
 *   parentWorldRot 为根骨父级的世界旋转（度）。
 * - 目标距离被钳制到 [|l1-l2|, l1+l2]：超出可达范围时末端停在可达边界上，
 *   骨骼长度永不改变，偏差 = |目标 - 实际末端|。
 * - bend 决定肘/膝朝向（+1 / -1），对同一目标给出确定解。
 * - 纯函数：同样输入永远得到同样输出，与上一帧无关。
 */
export function solveTwoBone(
  rootPos: Vec2,
  parentWorldRot: number,
  l1: number,
  l2: number,
  target: Vec2,
  bend: 1 | -1,
): IkSolution {
  const dx = target.x - rootPos.x;
  const dy = target.y - rootPos.y;
  const rawDist = Math.hypot(dx, dy);
  const minReach = Math.abs(l1 - l2);
  const maxReach = l1 + l2;
  const d = clamp(rawDist, minReach + EPS, maxReach);
  const reachable = rawDist <= maxReach + 1e-6 && rawDist >= minReach - 1e-6;

  // 目标方向；目标与根重合时退化为 0 方向，结果仍然确定
  const dirAng = rawDist > EPS ? Math.atan2(dy, dx) : 0;
  const cosAlpha = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const alpha = Math.acos(cosAlpha);

  const theta1 = dirAng - bend * alpha; // 根骨世界角
  const joint: Vec2 = {
    x: rootPos.x + Math.cos(theta1) * l1,
    y: rootPos.y + Math.sin(theta1) * l1,
  };
  // 钳制后的目标点（可达边界上）
  const clampedTarget: Vec2 = {
    x: rootPos.x + Math.cos(dirAng) * d,
    y: rootPos.y + Math.sin(dirAng) * d,
  };
  const theta2 = Math.atan2(clampedTarget.y - joint.y, clampedTarget.x - joint.x);
  const end: Vec2 = {
    x: joint.x + Math.cos(theta2) * l2,
    y: joint.y + Math.sin(theta2) * l2,
  };

  const theta1Deg = rad2deg(theta1);
  const theta2Deg = rad2deg(theta2);
  return {
    rot1: normDeg(theta1Deg - parentWorldRot),
    rot2: normDeg(theta2Deg - theta1Deg),
    end,
    deviation: Math.hypot(target.x - end.x, target.y - end.y),
    reachable,
  };
}
