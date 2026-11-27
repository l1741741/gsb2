import {
  bearingToVector,
  normalizeBearing,
  orientedRectangle,
  pointInPolygon,
  segmentIntersection,
  segmentPolygonContact,
  segmentSegmentDistance,
} from './math.ts';
import { changesUpTo, resolveWind } from './wind.ts';
import { stepKinematics, angleBetween } from './physics.ts';
import { commandAt } from './command.ts';
import { sortCommands } from './level.ts';
import { contentHash } from './hash.ts';
import {
  DEFAULT_PHYSICS,
  type BoatKinematics,
  type BuoyGate,
  type CoursePlan,
  type GateCrossing,
  type Issue,
  type Level,
  type Obstacle,
  type PhysicsParams,
  type RunFrame,
  type RunRecord,
  type RunSummary,
  type Vec2,
  type WindSample,
} from './types.ts';
import type { TimedChange } from './wind.ts';

export interface SimOptions {
  /** 性能上限；达到后按超时结束。 */
  maxSteps?: number;
  /** 帧采样间隔（秒）；只影响记录密度，不影响物理。 */
  sampleEvery?: number;
}

const MAX_STEPS_DEFAULT = 300_000;

/**
 * 确定性仿真。状态只由 (关卡、航线、固定步长计数) 决定：
 * 不读墙钟、不用随机数、不依赖渲染帧。因此任意刷新率或倍速下，
 * 相同输入与关卡都会得到相同的过标顺序与事件时刻。
 *
 * 每步判定顺序（同一步内）：
 *   障碍 → 浮标 → 岸线 → 靠泊。
 * 泊位位于水域内部、贴着岸线，所以先判靠泊再判岸线不会互相遮蔽。
 */
export function simulate(level: Level, plan: CoursePlan, options: SimOptions = {}): RunRecord {
  const physics: PhysicsParams = { ...DEFAULT_PHYSICS, ...(level.physics ?? {}) };
  const step = physics.fixedStep;
  if (!(step > 0) || !Number.isFinite(step)) throw new RangeError('fixedStep 必须为正的有限数');
  const sampleEvery = Math.max(1, Math.round((options.sampleEvery ?? step) / step));
  const maxSteps = options.maxSteps ?? MAX_STEPS_DEFAULT;

  const commands = sortCommands(plan.commands);
  // 预排序全部风速变化；每个固定步取截至该时刻的前缀，与步内时间一致。
  const allChanges: TimedChange[] = changesUpTo(level, level.duration + step);
  const changesAt = (at: number): TimedChange[] => {
    let lo = 0;
    let hi = allChanges.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((allChanges[mid] as TimedChange).time <= at + 1e-9) lo = mid + 1;
      else hi = mid;
    }
    return allChanges.slice(0, lo);
  };

  const boat: BoatKinematics & { track: number } = {
    position: { ...level.start.position },
    heading: normalizeBearing(level.start.heading),
    sheet: clamp01(level.start.sheet),
    speed: Math.max(0, level.start.speed),
    track: normalizeBearing(level.start.heading),
  };

  const frames: RunFrame[] = [];
  const crossings: GateCrossing[] = [];
  const issues: Issue[] = [];
  let outcome: RunSummary['outcome'] | null = null;
  let finishTime = 0;
  let dockSpeed: number | null = null;
  let routeIndex = 0;
  let stepIndex = 0;
  let time = 0;
  let wind: WindSample = resolveWind(level, boat.position, 0, changesAt(0));

  const recordFrame = (): void => {
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

  const fail = (issue: Issue): void => {
    if (outcome) return;
    issues.push(issue);
    outcome = 'failed';
    finishTime = issue.time;
  };

  recordFrame();

  while (time < level.duration && !outcome) {
    if (stepIndex >= maxSteps) {
      fail({ kind: 'timeout', time, position: { ...boat.position }, message: '仿真步数达到上限，按超时结束' });
      break;
    }

    const intent = commandAt(level, { version: 1, levelId: level.id, commands }, time);
    wind = resolveWind(level, boat.position, time, changesAt(time));

    const from: Vec2 = { ...boat.position };
    const next = stepKinematics(boat, { heading: intent.heading, sheet: intent.sheet }, wind, physics, step);
    const to = next.position;

    // 1) 障碍：扫掠检测，避免高速在两步之间穿透。
    for (const obstacle of level.obstacles) {
      const contact = obstacleContact(obstacle, from, to, physics.hullRadius + physics.obstacleClearance);
      if (contact) {
        boat.position = contact;
        fail({
          kind: 'obstacle-contact',
          time: timeAtPoint(from, to, contact, time, step),
          position: contact,
          message: `擦碰${obstacle.kind === 'circle' ? '岛屿' : '岩礁'}：${obstacle.name}`,
          subjectId: obstacle.id,
        });
        break;
      }
    }
    if (outcome) break;

    // 2) 浮标：扫掠线段与标线求交，一帧内跨越也不会漏判。
    for (const gate of level.buoys) {
      const hit = segmentIntersection(from, to, gate.a, gate.b);
      if (!hit) continue;
      const expectedId = level.route[routeIndex];
      const isExpected = expectedId === gate.id;
      const gateRouteIndex = level.route.indexOf(gate.id);
      // 回穿已经按次序通过的浮标不算逆序：真实航行中绕行、抢风都会碰到旧标线。
      const isRepeat = gateRouteIndex !== -1 && gateRouteIndex < routeIndex;
      crossings.push({
        gateId: gate.id,
        time: time + hit.t * step,
        position: hit.point,
        speed: boat.speed,
        order: isExpected ? routeIndex + 1 : 0,
        ...(isRepeat ? { repeat: true } : {}),
      });
      if (isExpected) {
        routeIndex += 1;
      } else if (!isRepeat) {
        boat.position = hit.point;
        fail({
          kind: 'wrong-order',
          time: time + hit.t * step,
          position: hit.point,
          message: expectedId
            ? `逆序通过 ${gate.name}：应先通过第 ${routeIndex + 1} 个浮标 ${gateName(level, expectedId)}`
            : `通过未在航线内的 ${gate.name}：全部浮标已按次序通过`,
          subjectId: gate.id,
        });
        break;
      }
    }
    if (outcome) break;

    // 3) 岸线：水域边界内安全，只有驶出边界才算触岸。
    const boundsContact = crossingIntoBoundary(from, to, level.bounds);
    if (boundsContact) {
      boat.position = boundsContact;
      fail({
        kind: 'outside-bounds',
        time: timeAtPoint(from, to, boundsContact, time, step),
        position: boundsContact,
        message: '驶出航行水域（触岸）',
      });
      break;
    }

    // 4) 靠泊：扫掠进入泊位矩形后检查完成情况、限速与航向。
    const dockHit = segmentPolygonContact(from, to, dockRectangle(level), 0);
    if (dockHit.hit) {
      boat.position = dockHit.point;
      const at = timeAtPoint(from, to, dockHit.point, time, step);
      const missing = level.route[routeIndex];
      if (missing) {
        fail({
          kind: 'dock-missed',
          time: at,
          position: dockHit.point,
          message: `尚未按次序通过全部浮标（缺少 ${gateName(level, missing)}），不能靠泊`,
          subjectId: level.dock.id,
        });
        break;
      }
      if (boat.speed > level.dock.speedLimit + physics.dockSpeedMargin) {
        fail({
          kind: 'over-speed-dock',
          time: at,
          position: dockHit.point,
          message: `速度过高进港：${boat.speed.toFixed(2)} m/s，限速 ${level.dock.speedLimit.toFixed(2)} m/s`,
          subjectId: level.dock.id,
        });
        break;
      }
      const headingError = angleBetween(boat.heading, level.dock.heading);
      if (headingError > physics.dockAlignTolerance) {
        fail({
          kind: 'dock-missed',
          time: at,
          position: dockHit.point,
          message: `进港航向偏差 ${headingError.toFixed(0)}°，未对准泊位（限差 ${physics.dockAlignTolerance}°）`,
          subjectId: level.dock.id,
        });
        break;
      }
      outcome = 'docked';
      finishTime = at;
      dockSpeed = boat.speed;
      break;
    }

    boat.position = to;
    boat.heading = next.heading;
    boat.speed = next.speed;
    boat.sheet = next.sheet;
    boat.track = trackToward(boat.track, next.heading, physics.maxTurnRate * 2 * step);
    time += step;
    stepIndex += 1;
    if (stepIndex % sampleEvery === 0) recordFrame();
  }

  if (!outcome) {
    fail({ kind: 'timeout', time: level.duration, position: { ...boat.position }, message: '关卡时间耗尽，未靠泊' });
  }

  if (outcome !== 'docked' && routeIndex < level.route.length) {
    const missing = level.route[routeIndex];
    if (missing) {
      issues.push({
        kind: 'dock-missed',
        time: finishTime > 0 ? finishTime : Math.min(time, level.duration),
        position: { ...boat.position },
        message: `本次航次未通过全部浮标（缺少 ${gateName(level, missing)}）`,
        subjectId: missing,
      });
    }
  }

  recordFrame();

  const summary: RunSummary = {
    outcome: outcome ?? 'timed-out',
    finishTime,
    crossings: [...crossings].sort((a, b) => a.time - b.time),
    routeProgress: routeIndex,
    issues: [...issues].sort((a, b) => a.time - b.time),
    finalPosition: { ...boat.position },
    dockSpeed,
  };

  return {
    levelId: level.id,
    levelName: level.name,
    levelHash: contentHash(levelContentForHash(level)),
    commandHash: contentHash(commands),
    planHash: contentHash({ levelId: level.id, commands }),
    plan: { version: 1, levelId: level.id, commands },
    physics,
    sampleStep: step * sampleEvery,
    frames,
    summary,
    steps: stepIndex,
  };
}

/* ------------------------------ 工具 ------------------------------ */

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function gateName(level: Level, id: string): string {
  return level.buoys.find((buoy) => buoy.id === id)?.name ?? id;
}

function obstacleContact(obstacle: Obstacle, from: Vec2, to: Vec2, clearance: number): Vec2 | null {
  if (obstacle.kind === 'circle') {
    const result = segmentSegmentDistance(from, to, obstacle.center, obstacle.center);
    return result.distance <= obstacle.radius + clearance ? result.point : null;
  }
  const hit = segmentPolygonContact(from, to, obstacle.vertices, clearance);
  return hit.hit ? hit.point : null;
}

/** 把扫掠接触点换算为更精确的时间。 */
export function timeAtPoint(from: Vec2, to: Vec2, point: Vec2, time: number, step: number): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return time;
  const t = clamp01(((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSq);
  return time + t * step;
}

/** 泊位矩形：入口向 heading 方向延伸 length，宽 width。 */
export function dockRectangle(level: Level): Vec2[] {
  const dock = level.dock;
  const forward = bearingToVector(dock.heading);
  const center = {
    x: dock.mouth.x + forward.x * (dock.length / 2),
    y: dock.mouth.y + forward.y * (dock.length / 2),
  };
  return orientedRectangle(center, dock.heading, dock.length, dock.width);
}

/** 不含配色与提示的关卡内容，用于判定“关卡是否变了”。 */
export function levelContentForHash(level: Level): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(level)) {
    if (key === 'palette' || key === 'briefing') continue;
    copy[key] = value;
  }
  return copy;
}

export function insideDock(level: Level, point: Vec2): boolean {
  return pointInPolygon(point, dockRectangle(level));
}

/**
 * 线段 from->to 是否驶出多边形水域。返回越界点；仍在界内返回 null。
 * 起点在界外时（理论上不会发生）返回起点，便于报告。
 */
export function crossingIntoBoundary(from: Vec2, to: Vec2, boundary: readonly Vec2[]): Vec2 | null {
  const startsInside = pointInPolygon(from, boundary);
  const endsInside = pointInPolygon(to, boundary);
  if (!startsInside) return from;
  if (endsInside) return null;
  let closest: { t: number; point: Vec2 } | null = null;
  for (let i = 0; i < boundary.length; i++) {
    const a = boundary[i] as Vec2;
    const b = boundary[(i + 1) % boundary.length] as Vec2;
    const hit = segmentIntersection(from, to, a, b);
    if (hit && (closest === null || hit.t < closest.t)) closest = hit;
  }
  return closest?.point ?? to;
}

/** 航迹向船首向缓慢靠拢；仅影响显示与回放。 */
function trackToward(track: number, heading: number, maxDelta: number): number {
  const error = ((heading - track + 540) % 360) - 180;
  const delta = Math.max(-maxDelta, Math.min(maxDelta, error * 0.6));
  return normalizeBearing(track + delta);
}

/** 两个罗盘方向的夹角，0..180 度。 */
export function angleDeg(a: number, b: number): number {
  return angleBetween(a, b);
}

/** 当前应通过的下一个浮标。 */
export function nextGate(level: Level, progress: number): BuoyGate | null {
  const id = level.route[progress];
  if (!id) return null;
  return level.buoys.find((gate) => gate.id === id) ?? null;
}
