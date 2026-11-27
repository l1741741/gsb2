import type {
  CharacterDef,
  ClipDef,
  FrameResult,
  PinDef,
  PinResult,
  ScenarioDef,
  Transform,
} from './types.js';
import { clamp, euclideanMod } from './math.js';
import {
  attachmentWorld,
  boneTip,
  buildSkeleton,
  computeWorld,
  type Skeleton,
} from './skeleton.js';
import { blendPoses, sampleClip } from './clip.js';
import { solveTwoBone } from './ik.js';
import { locateSegment, programDuration } from './timeline.js';

export interface Scene {
  sk: Skeleton;
  clips: Map<string, ClipDef>;
  scenario: ScenarioDef;
  totalDuration: number;
}

export function buildScene(
  character: CharacterDef,
  clips: ClipDef[],
  scenario: ScenarioDef,
): Scene {
  const sk = buildSkeleton(character);
  const clipMap = new Map(clips.map((c) => [c.id, c]));
  for (const seg of scenario.program) {
    for (const id of seg.type === 'clip' ? [seg.clip] : [seg.from, seg.to]) {
      if (!clipMap.has(id)) throw new Error(`scenario ${scenario.id} references unknown clip ${id}`);
    }
  }
  for (const pin of scenario.pins) {
    if (!character.chains.some((c) => c.id === pin.chain)) {
      throw new Error(`pin references unknown chain ${pin.chain}`);
    }
    if (!character.attachments.some((a) => a.id === pin.attachment)) {
      throw new Error(`pin references unknown attachment ${pin.attachment}`);
    }
  }
  return {
    sk,
    clips: clipMap,
    scenario,
    totalDuration: programDuration(scenario.program),
  };
}

function pinActive(pin: PinDef, t: number): boolean {
  if (pin.from !== undefined && t < pin.from) return false;
  if (pin.to !== undefined && t > pin.to) return false;
  return true;
}

/**
 * 求某一时刻的完整画面。这是整个工具的核心纯函数：
 * 输出只取决于 (scene, time)，不读取也不维护任何跨帧状态，
 * 因此拖动时间轴、倒放、变速播放得到的同一时刻画面完全一致。
 */
export function evaluateFrame(scene: Scene, time: number): FrameResult {
  const { sk, clips, scenario, totalDuration } = scene;
  const t = scenario.loop
    ? euclideanMod(time, totalDuration)
    : clamp(time, 0, totalDuration);

  const located = locateSegment(scenario.program, t);
  const seg = located.def;

  let pose;
  let blend: number | null = null;
  if (seg.type === 'clip') {
    pose = sampleClip(sk, clips.get(seg.clip)!, (seg.startAt ?? 0) + located.elapsed);
  } else {
    const a = sampleClip(sk, clips.get(seg.from)!, (seg.fromStartAt ?? 0) + located.elapsed);
    const b = sampleClip(sk, clips.get(seg.to)!, (seg.toStartAt ?? 0) + located.elapsed);
    blend = clamp(located.elapsed / seg.duration, 0, 1);
    pose = blendPoses(sk, a, b, blend);
  }

  // 固定挂点（IK）：按链条在层级中的深度排序，先解靠近根部的链，
  // 每条链求解时基于当前姿势重新合成世界变换，结果确定。
  const chainDepth = (chainId: string): number => {
    const chain = sk.def.chains.find((c) => c.id === chainId)!;
    let depth = 0;
    let cur = sk.byId.get(chain.bones[0])!;
    while (cur.parent !== null) {
      depth++;
      cur = sk.byId.get(cur.parent)!;
    }
    return depth;
  };
  const activePins = scenario.pins
    .filter((p) => pinActive(p, t))
    .sort((p, q) => chainDepth(p.chain) - chainDepth(q.chain));

  const pins: PinResult[] = [];
  for (const pin of activePins) {
    const chain = sk.def.chains.find((c) => c.id === pin.chain)!;
    const worlds = computeWorld(sk, pose);
    const b1 = sk.byId.get(chain.bones[0])!;
    const b2 = sk.byId.get(chain.bones[1])!;
    const parentWorld: Transform =
      b1.parent === null ? { x: 0, y: 0, rot: 0 } : worlds.get(b1.parent)!;
    const rootWorld = worlds.get(b1.id)!;
    const sol = solveTwoBone(
      { x: rootWorld.x, y: rootWorld.y },
      parentWorld.rot,
      b1.length,
      b2.length,
      { x: pin.x, y: pin.y },
      chain.bend,
    );
    pose[chain.bones[0]].rot = sol.rot1;
    pose[chain.bones[1]].rot = sol.rot2;
    pins.push({
      attachment: pin.attachment,
      chain: pin.chain,
      target: { x: pin.x, y: pin.y },
      achieved: sol.end,
      deviation: sol.deviation,
      reachable: sol.reachable,
    });
  }

  const worlds = computeWorld(sk, pose);
  const bones = sk.order.map((b) => ({
    id: b.id,
    world: worlds.get(b.id)!,
    tip: boneTip(sk, worlds.get(b.id)!, b.id),
  }));
  const attachments: Record<string, { x: number; y: number }> = {};
  for (const att of sk.def.attachments) {
    attachments[att.id] = attachmentWorld(sk, worlds, att.id);
  }
  const props: Record<string, Transform> = {};
  for (const prop of sk.def.props) {
    const att = sk.def.attachments.find((a) => a.id === prop.attachment)!;
    const boneWorld = worlds.get(att.bone)!;
    props[prop.id] = {
      x: attachments[prop.attachment].x,
      y: attachments[prop.attachment].y,
      rot: boneWorld.rot + prop.rotation,
    };
  }

  return {
    time: t,
    segmentIndex: located.index,
    segmentType: seg.type,
    blend,
    bones,
    attachments,
    props,
    pins,
  };
}
