import type { ClipDef, PosKey, RotKey } from './types.js';
import { euclideanMod, lerp, lerpAngleDeg } from './math.js';
import type { LocalPose, Skeleton } from './skeleton.js';

/** 片段内时间归一化：片段视为循环，始终落在 [0, duration)。 */
export function clipLocalTime(clip: ClipDef, t: number): number {
  if (!(clip.duration > 0)) throw new Error(`clip ${clip.id} has non-positive duration`);
  return euclideanMod(t, clip.duration);
}

function sampleRot(keys: RotKey[], t: number): number {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first[0]) return first[1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const s = (t - a[0]) / (b[0] - a[0]);
      // 关键帧之间同样走最短弧，规则与过渡混合一致
      return lerpAngleDeg(a[1], b[1], s);
    }
  }
  return last[1];
}

function samplePos(keys: PosKey[], t: number): { x: number; y: number } {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first[0]) return { x: first[1], y: first[2] };
  if (t >= last[0]) return { x: last[1], y: last[2] };
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a[0] && t <= b[0]) {
      const s = (t - a[0]) / (b[0] - a[0]);
      return { x: lerp(a[1], b[1], s), y: lerp(a[2], b[2], s) };
    }
  }
  return { x: last[1], y: last[2] };
}

/**
 * 在片段局部时间 t 采样，得到完整局部姿势（未被打孔的骨骼取静止值）。
 * 纯函数：同一 (clip, t) 永远得到同一结果。
 */
export function sampleClip(sk: Skeleton, clip: ClipDef, t: number): LocalPose {
  const lt = clipLocalTime(clip, t);
  const pose: LocalPose = {};
  for (const id of Object.keys(sk.restPose)) {
    pose[id] = { ...sk.restPose[id] };
  }
  for (const [boneId, track] of Object.entries(clip.tracks)) {
    if (!pose[boneId]) throw new Error(`clip ${clip.id} tracks unknown bone ${boneId}`);
    if (track.rot && track.rot.length > 0) pose[boneId].rot = sampleRot(track.rot, lt);
    if (track.pos && track.pos.length > 0) {
      const p = samplePos(track.pos, lt);
      pose[boneId].x = p.x;
      pose[boneId].y = p.y;
    }
  }
  return pose;
}

/**
 * 局部空间混合两段姿势。s=0 完全为 a，s=1 完全为 b。
 * 旋转走最短弧；因为混合发生在局部空间、世界变换之后才合成，
 * 所以过渡期间父子层级关系不会被破坏。
 */
export function blendPoses(sk: Skeleton, a: LocalPose, b: LocalPose, s: number): LocalPose {
  const pose: LocalPose = {};
  for (const id of Object.keys(sk.restPose)) {
    const pa = a[id];
    const pb = b[id];
    pose[id] = {
      x: lerp(pa.x, pb.x, s),
      y: lerp(pa.y, pb.y, s),
      rot: lerpAngleDeg(pa.rot, pb.rot, s),
    };
  }
  return pose;
}
