import { commandAt } from './command.ts';
import { stepKinematics } from './physics.ts';
import { changesUpTo, resolveWind } from './wind.ts';
import {
  DEFAULT_PHYSICS,
  type BoatKinematics,
  type CoursePlan,
  type Level,
  type RunFrame,
  type Vec2,
} from './types.ts';
import type { TimedChange } from './wind.ts';

export interface PreviewOptions {
  /** 采样间隔（秒），只影响输出帧密度。 */
  sampleEvery?: number;
  /** 推演时长，默认到关卡结束。 */
  horizon?: number;
  /** 从哪个时刻开始推演（用于“从当前编辑点向后看”）。 */
  fromTime?: number;
  fromState?: { position: Vec2; heading: number; speed: number; sheet: number };
  /** 只看前 N 秒也很常用；与 horizon 取小。 */
  stopOnEnd?: boolean;
}

/**
 * 预计航迹：使用与正式仿真完全相同的运动学和风场，但忽略碰撞、浮标与码头。
 * 用于 UI 预览以及离线规划。因为它不读取渲染状态，所以与刷新率无关。
 */
export function previewTrajectory(level: Level, plan: CoursePlan, options: PreviewOptions = {}): RunFrame[] {
  const physics = { ...DEFAULT_PHYSICS, ...(level.physics ?? {}) };
  const step = physics.fixedStep;
  const sampleEvery = Math.max(1, Math.round((options.sampleEvery ?? 0.25) / step));
  const fromTime = options.fromTime ?? 0;
  const start = options.fromState ?? {
    position: level.start.position,
    heading: level.start.heading,
    speed: level.start.speed,
    sheet: level.start.sheet,
  };
  const horizon = options.horizon ?? level.duration - fromTime;
  const changes: TimedChange[] = changesUpTo(level, level.duration + step);

  let boat: BoatKinematics & { track: number } = {
    position: { ...start.position },
    heading: normalizeBearingSafe(start.heading),
    speed: Math.max(0, start.speed),
    sheet: clamp01(start.sheet),
    track: normalizeBearingSafe(start.heading),
  };

  const frames: RunFrame[] = [];
  let time = fromTime;
  let stepIndex = 0;
  let wind = resolveWind(level, boat.position, time, changesAt(changes, time));

  const push = (): void => {
    frames.push({
      time,
      position: { ...boat.position },
      heading: boat.heading,
      track: boat.track,
      speed: boat.speed,
      sheet: boat.sheet,
      windSpeed: wind.speed,
      windDirection: wind.direction,
      zoneId: wind.zoneId,
      zoneName: wind.zoneName,
    });
  };

  push();
  while (time < fromTime + horizon && time < level.duration) {
    const at = time;
    const intent = commandAt(level, plan, at);
    wind = resolveWind(level, boat.position, at, changesAt(changes, at));
    const next = stepKinematics(boat, { heading: intent.heading, sheet: intent.sheet }, wind, physics, step);
    boat = {
      position: next.position,
      heading: next.heading,
      speed: next.speed,
      sheet: next.sheet,
      track: trackToward(boat.track, next.heading, physics.maxTurnRate * 2 * step),
    };
    time = at + step;
    stepIndex += 1;
    if (stepIndex % sampleEvery === 0) push();
  }
  push();
  void options.stopOnEnd;
  return frames;
}

/** 预计航迹的浮标通过序列，用于 UI 提示“预计会按次序通过”。 */
export interface PredictedCrossing {
  gateId: string;
  time: number;
  position: Vec2;
  order: number;
}

export function predictCrossings(level: Level, frames: readonly RunFrame[]): PredictedCrossing[] {
  const crossings: PredictedCrossing[] = [];
  let routeIndex = 0;
  for (let i = 0; i + 1 < frames.length; i++) {
    const a = frames[i]!;
    const b = frames[i + 1]!;
    for (const gate of level.buoys) {
      const hit = segmentHit(a.position, b.position, gate.a, gate.b);
      if (!hit) continue;
      const expected = level.route[routeIndex];
      crossings.push({
        gateId: gate.id,
        time: a.time + (b.time - a.time) * hit,
        position: {
          x: a.position.x + (b.position.x - a.position.x) * hit,
          y: a.position.y + (b.position.y - a.position.y) * hit,
        },
        order: expected === gate.id ? routeIndex + 1 : 0,
      });
      if (expected === gate.id) routeIndex += 1;
    }
  }
  return crossings;
}

export function changesAt(changes: readonly TimedChange[], at: number): TimedChange[] {
  let lo = 0;
  let hi = changes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((changes[mid] as TimedChange).time <= at + 1e-9) lo = mid + 1;
    else hi = mid;
  }
  return changes.slice(0, lo) as TimedChange[];
}

function segmentHit(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number | null {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denominator = r.x * s.y - r.y * s.x;
  if (Math.abs(denominator) < 1e-12) return null;
  const qp = { x: c.x - a.x, y: c.y - a.y };
  const t = (qp.x * s.y - qp.y * s.x) / denominator;
  const u = (qp.x * r.y - qp.y * r.x) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function normalizeBearingSafe(value: number): number {
  return Number.isFinite(value) ? ((value % 360) + 360) % 360 : 0;
}

function trackToward(track: number, heading: number, maxDelta: number): number {
  const error = ((heading - track + 540) % 360) - 180;
  const delta = Math.max(-maxDelta, Math.min(maxDelta, error * 0.6));
  return ((track + delta) % 360 + 360) % 360;
}
