import type { BoneDef, CharacterDef, Transform, Vec2 } from './types.js';
import { compose, applyToPoint } from './math.js';

/** 每根骨骼的局部姿势（位置 + 旋转，度）。纯数据，可自由拷贝。 */
export type LocalPose = Record<string, { x: number; y: number; rot: number }>;

export interface Skeleton {
  def: CharacterDef;
  /** 拓扑排序后的骨骼（父先于子），保证世界变换单趟合成 */
  order: BoneDef[];
  byId: Map<string, BoneDef>;
  restPose: LocalPose;
}

export function buildSkeleton(def: CharacterDef): Skeleton {
  const byId = new Map<string, BoneDef>();
  for (const b of def.bones) {
    if (byId.has(b.id)) throw new Error(`duplicate bone id: ${b.id}`);
    byId.set(b.id, b);
  }
  const order: BoneDef[] = [];
  const placed = new Set<string>();
  let remaining = [...def.bones];
  while (remaining.length > 0) {
    const next = remaining.filter(
      (b) => b.parent === null || placed.has(b.parent),
    );
    if (next.length === 0) {
      throw new Error(
        `bone hierarchy has a cycle or missing parent: ${remaining
          .map((b) => b.id)
          .join(', ')}`,
      );
    }
    for (const b of next) {
      if (b.parent !== null && !byId.has(b.parent)) {
        throw new Error(`bone ${b.id} references unknown parent ${b.parent}`);
      }
      order.push(b);
      placed.add(b.id);
    }
    remaining = remaining.filter((b) => !placed.has(b.id));
  }
  const restPose: LocalPose = {};
  for (const b of def.bones) {
    restPose[b.id] = { x: b.x, y: b.y, rot: b.rotation };
  }
  return { def, order, byId, restPose };
}

/**
 * 自顶向下合成世界变换。子骨骼的世界变换永远 = 父世界变换 ∘ 子局部姿势，
 * 因此无论局部姿势来自采样、混合还是 IK，父子坐标关系都保持一致。
 */
export function computeWorld(sk: Skeleton, pose: LocalPose): Map<string, Transform> {
  const worlds = new Map<string, Transform>();
  for (const b of sk.order) {
    const local = pose[b.id];
    if (!local) throw new Error(`pose missing bone ${b.id}`);
    const parentWorld =
      b.parent === null
        ? { x: 0, y: 0, rot: 0 }
        : worlds.get(b.parent)!;
    worlds.set(b.id, compose(parentWorld, local));
  }
  return worlds;
}

export function boneTip(sk: Skeleton, world: Transform, boneId: string): Vec2 {
  const b = sk.byId.get(boneId)!;
  return applyToPoint(world, { x: b.length, y: 0 });
}

export function attachmentWorld(
  sk: Skeleton,
  worlds: Map<string, Transform>,
  attachmentId: string,
): Vec2 {
  const att = sk.def.attachments.find((a) => a.id === attachmentId);
  if (!att) throw new Error(`unknown attachment: ${attachmentId}`);
  const w = worlds.get(att.bone);
  if (!w) throw new Error(`attachment ${attachmentId} on unknown bone ${att.bone}`);
  return applyToPoint(w, { x: att.x, y: att.y });
}
