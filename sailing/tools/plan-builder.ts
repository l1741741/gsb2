import { simulate, type SimOptions } from '../src/core/sim.ts';
import { resolveWind, changesUpTo } from '../src/core/wind.ts';
import { angleBetween, sheetDrive, windDrive } from '../src/core/physics.ts';
import { clamp, normalizeBearing, vectorToBearing, bearingToVector } from '../src/core/math.ts';
import { DEFAULT_PHYSICS, type CourseCommand, type CoursePlan, type Level, type Vec2 } from '../src/core/types.ts';

export interface RouteSpec {
  /** 手绘折线，最后一点为泊位入口外侧。 */
  path: Vec2[];
  /** 巡航速度。 */
  cruise: number;
  /** 最后多少米开始按泊位限速收帆。 */
  slowDistance: number;
  /** 入口外侧对准点距入口的距离（米）。 */
  approachDistance: number;
  /** 允许的横向偏差（米），超过则先回到轴线。 */
  alignWidth: number;
}

export interface BuildOptions {
  /** 决策间隔，秒。 */
  interval?: number;
  /** 前视距离，米。 */
  lookAhead?: number;
}

const SIM: SimOptions = { maxSteps: 900_000 };

/**
 * 离线航线生成器（纯追踪 + 简化）。生成的指令会先被正式仿真复核，
 * 再按“航向/帆位变化足够大才保留”的原则简化，最后再次复核。
 */
export function buildReferencePlan(level: Level, route: RouteSpec, options: BuildOptions = {}): CoursePlan {
  const interval = options.interval ?? 0.75;
  const lookAhead = options.lookAhead ?? 20;
  const physics = { ...DEFAULT_PHYSICS, ...(level.physics ?? {}) };
  const dense: CourseCommand[] = [];
  let time = 0;
  let fromSegment = 0;

  const plan = (): CoursePlan => ({ version: 1, levelId: level.id, commands: [...dense] });
  let record = simulate(level, plan(), SIM);

  while (time < level.duration && dense.length < 600) {
    if (record.summary.outcome === 'docked') break;
    if (record.summary.outcome === 'failed' && record.summary.finishTime <= time + 1e-9) break;

    const frame = frameAt(record, time);
    const wind = resolveWind(level, frame.position, time, changesUpTo(level, time + 1e-9));
    const mouthDistance = Math.hypot(level.dock.mouth.x - frame.position.x, level.dock.mouth.y - frame.position.y);

    // 入港分两段：先到入口外侧的轴线点，再沿泊位轴线进入。
    // 轴线判定用“沿轴线方向的投影”，避免仅凭距离就把斜向驶来的船当成已对准。
    const dockForward = bearingToVector(level.dock.heading);
    const toBoat = { x: frame.position.x - level.dock.mouth.x, y: frame.position.y - level.dock.mouth.y };
    const axisOffset = Math.abs(toBoat.x * dockForward.y - toBoat.y * dockForward.x); // 到轴线的横向偏差
    const alongAxis = toBoat.x * dockForward.x + toBoat.y * dockForward.y; // 负值 = 在入口外侧
    // 船在入口外侧一定范围内、且横向偏差不大时，直接沿轴线进入；
    // 否则先驶向入口外侧对准点。alongAxis 为负表示在入口外侧。
    const linedUp = axisOffset <= route.alignWidth && alongAxis >= -route.approachDistance && alongAxis <= 0;

    let heading: number;
    let speed: number;
    if (linedUp) {
      heading = normalizeBearing(level.dock.heading);
      speed = Math.max(0.85, level.dock.speedLimit * 0.95);
    } else if (mouthDistance <= route.slowDistance) {
      // 先驶向入口外侧的轴线点。
      const approach = {
        x: level.dock.mouth.x - dockForward.x * route.approachDistance,
        y: level.dock.mouth.y - dockForward.y * route.approachDistance,
      };
      heading = vectorToBearing({ x: approach.x - frame.position.x, y: approach.y - frame.position.y });
      speed = Math.min(route.cruise, Math.max(1.4, level.dock.speedLimit * 2.2));
    } else {
      const pursued = pursuePoint(route.path, frame.position, lookAhead, fromSegment);
      fromSegment = pursued.segment;
      heading = vectorToBearing({ x: pursued.point.x - frame.position.x, y: pursued.point.y - frame.position.y });
      speed = route.cruise;
    }

    const sheet = sheetFor(physics, heading, wind, speed);

    dense.push({ time: round(time, 3), heading: round(normalizeBearing(heading), 0.1), sheet: round(sheet, 3) });
    record = simulate(level, plan(), SIM);
    time = round(time + interval, 3);
  }

  return simplifyPlan(level, dense, physics);
}

/**
 * 路径上的纯追踪点：先找“只向前”的最近点（不允许回退到已走过的线段），
 * 再沿路径前进 lookAhead 米。这样多段折线与障碍绕行不会被反向追踪点带偏。
 */
export function pursuePoint(
  path: readonly Vec2[],
  position: Vec2,
  lookAhead: number,
  fromSegment = 0,
): { point: Vec2; segment: number } {
  let bestSegment = fromSegment;
  let bestT = 0;
  let bestDistance = Infinity;
  for (let i = fromSegment; i + 1 < path.length; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 1e-9 ? clamp(((position.x - a.x) * dx + (position.y - a.y) * dy) / lengthSq, 0, 1) : 0;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    // 已在该段终点的后方时，t 会被夹住，距离自然偏大，不会回退。
    const distance = Math.hypot(px - position.x, py - position.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSegment = i;
      bestT = t;
    }
  }

  let remaining = lookAhead;
  let x = path[bestSegment]!.x + (path[bestSegment + 1]!.x - path[bestSegment]!.x) * bestT;
  let y = path[bestSegment]!.y + (path[bestSegment + 1]!.y - path[bestSegment]!.y) * bestT;
  for (let i = bestSegment; i + 1 < path.length; i++) {
    const next = path[i + 1]!;
    const segmentLength = Math.hypot(next.x - x, next.y - y);
    if (segmentLength >= remaining || i + 2 >= path.length) {
      const t = segmentLength > 1e-9 ? Math.min(1, remaining / segmentLength) : 1;
      return { point: { x: x + (next.x - x) * t, y: y + (next.y - y) * t }, segment: i };
    }
    remaining -= segmentLength;
    x = next.x;
    y = next.y;
  }
  return { point: path[path.length - 1]!, segment: path.length - 2 };
}

/** 保留变化超过阈值的指令，保证简化后仍能复现原轨迹的主要意图。 */
export function simplifyPlan(level: Level, commands: readonly CourseCommand[], physics: { hullSpeed: number }): CoursePlan {
  void physics;
  const kept: CourseCommand[] = [];
  for (const command of commands) {
    const last = kept[kept.length - 1];
    if (
      !last ||
      angleBetween(command.heading, last.heading) > 4 ||
      Math.abs(command.sheet - last.sheet) > 0.06
    ) {
      kept.push(command);
    }
  }
  // 校验简化后仍能靠泊；不行就退化为保留后半段更密的版本。
  const simplified: CoursePlan = { version: 1, levelId: level.id, commands: kept };
  const record = simulate(level, simplified, SIM);
  if (record.summary.outcome === 'docked') return simplified;
  // 尝试逐步回补：每隔一条恢复成密集版本。
  let candidate: CourseCommand[] = [];
  for (let i = 0; i < commands.length; i++) {
    const last = candidate[candidate.length - 1];
    const command = commands[i]!;
    if (
      !last ||
      angleBetween(command.heading, last.heading) > 3 ||
      Math.abs(command.sheet - last.sheet) > 0.05 ||
      i % 3 === 0
    ) {
      candidate.push(command);
    }
  }
  const denser: CoursePlan = { version: 1, levelId: level.id, commands: candidate };
  const denserRecord = simulate(level, denser, SIM);
  if (denserRecord.summary.outcome === 'docked') return denser;
  void record;
  return { version: 1, levelId: level.id, commands: [...commands] };
}

function sheetFor(
  physics: { hullSpeed: number; referenceWind: number },
  heading: number,
  wind: { direction: number; speed: number },
  targetSpeed: number,
): number {
  const windRatio = clamp(wind.speed / physics.referenceWind, 0, 1.1);
  const drive = windDrive(angleBetween(heading, wind.direction));
  const crank = physics.hullSpeed * drive * windRatio;
  if (crank < 0.15) return 0.1;
  let best = 0.02;
  let bestError = Infinity;
  for (let i = 0; i <= 100; i++) {
    const sheet = i / 100;
    const error = Math.abs(crank * sheetDrive(sheet) - targetSpeed);
    if (error < bestError) {
      bestError = error;
      best = sheet;
    }
  }
  return Math.max(0.02, best);
}

function frameAt(record: ReturnType<typeof simulate>, time: number) {
  const frames = record.frames;
  if (frames.length === 0) throw new RangeError('record has no frames');
  let index = 0;
  for (let i = 0; i < frames.length; i++) {
    if ((frames[i] as { time: number }).time <= time + 1e-9) index = i;
    else break;
  }
  return frames[index]!;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
