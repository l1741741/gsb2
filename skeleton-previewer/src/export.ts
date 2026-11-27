import type { FrameResult } from './types.js';
import { evaluateFrame, type Scene } from './evaluate.js';
import { normDeg } from './math.js';

const round = (v: number): number => Math.round(v * 1e6) / 1e6;
const roundVec = (p: { x: number; y: number }) => ({ x: round(p.x), y: round(p.y) });
const roundRot = (deg: number): number => round(normDeg(deg));

export interface ExportedFrame {
  time: number;
  segmentIndex: number;
  segmentType: string;
  blend: number | null;
  bones: Record<string, { x: number; y: number; rot: number }>;
  attachments: Record<string, { x: number; y: number }>;
  pins: {
    attachment: string;
    target: { x: number; y: number };
    achieved: { x: number; y: number };
    deviation: number;
    reachable: boolean;
  }[];
}

export function exportFrame(frame: FrameResult): ExportedFrame {
  const bones: ExportedFrame['bones'] = {};
  for (const b of frame.bones) {
    bones[b.id] = { x: round(b.world.x), y: round(b.world.y), rot: roundRot(b.world.rot) };
  }
  const attachments: ExportedFrame['attachments'] = {};
  for (const [id, p] of Object.entries(frame.attachments)) {
    attachments[id] = roundVec(p);
  }
  return {
    time: round(frame.time),
    segmentIndex: frame.segmentIndex,
    segmentType: frame.segmentType,
    blend: frame.blend === null ? null : round(frame.blend),
    bones,
    attachments,
    pins: frame.pins.map((p) => ({
      attachment: p.attachment,
      target: roundVec(p.target),
      achieved: roundVec(p.achieved),
      deviation: round(p.deviation),
      reachable: p.reachable,
    })),
  };
}

/** 导出场景在全部关键时间点的数值（骨骼世界变换、挂点坐标、IK 偏差）。 */
export function exportScenario(scene: Scene) {
  return {
    scenario: scene.scenario.id,
    description: scene.scenario.description,
    totalDuration: scene.totalDuration,
    frames: scene.scenario.exportTimes.map((t) => exportFrame(evaluateFrame(scene, t))),
  };
}
