import { contentHash } from './hash.ts';
import { pointInPolygon, projectPointOnSegment } from './math.ts';
import type { CourseCommand, CoursePlan, Level } from './types.ts';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * 关卡校验关注“判定可解释、可复现”：
 * - 风区多边形有效，风速变化指向存在的风区；
 * - 航线中的每个 id 都对应唯一浮标，且不重复；
 * - 浮标标线两端在航行水域内；
 * - 第一个浮标不能压在靠泊口上，否则过标与靠泊判定会互相干扰。
 */
export function validateLevel(level: Level): ValidationResult {
  const errors: string[] = [];

  if (!level.id) errors.push('关卡缺少 id');
  if (!Number.isFinite(level.duration) || level.duration <= 0) errors.push('关卡时长必须大于 0');
  if (level.bounds.length < 3) errors.push('航行水域边界至少需要 3 个顶点');
  if (!(level.dock.length > 0) || !(level.dock.width > 0)) errors.push('泊位尺寸必须为正');
  if (!(level.dock.speedLimit > 0)) errors.push('泊位限速必须为正');

  const zoneIds = new Set<string>();
  for (const zone of level.windZones) {
    if (zoneIds.has(zone.id)) errors.push(`风区 id 重复：${zone.id}`);
    zoneIds.add(zone.id);
    if (zone.vertices.length < 3) errors.push(`风区 ${zone.id} 至少需要 3 个顶点`);
    if (zone.vertices.some((v) => !Number.isFinite(v.x) || !Number.isFinite(v.y))) {
      errors.push(`风区 ${zone.id} 含非法坐标`);
    }
    if (!(zone.wind.speed >= 0)) errors.push(`风区 ${zone.id} 风速非法`);
  }

  for (const change of level.windChanges) {
    if (!(change.time >= 0)) errors.push('风速变化时间必须非负');
    if (change.zoneId !== null && change.zoneId !== 'open' && !zoneIds.has(change.zoneId)) {
      errors.push(`风速变化指向不存在的风区：${change.zoneId}`);
    }
    if (!(change.speed >= 0)) errors.push(`风速变化（${change.time}s）风速非法`);
  }

  const obstacleIds = new Set<string>();
  for (const obstacle of level.obstacles) {
    if (obstacleIds.has(obstacle.id)) errors.push(`障碍 id 重复：${obstacle.id}`);
    obstacleIds.add(obstacle.id);
    if (obstacle.kind === 'circle' && !(obstacle.radius > 0)) {
      errors.push(`圆形障碍 ${obstacle.id} 半径非法`);
    }
    if (obstacle.kind === 'rock' && obstacle.vertices.length < 3) {
      errors.push(`岩礁 ${obstacle.id} 至少需要 3 个顶点`);
    }
  }

  const buoyIds = new Set<string>();
  for (const buoy of level.buoys) {
    if (buoyIds.has(buoy.id)) errors.push(`浮标 id 重复：${buoy.id}`);
    buoyIds.add(buoy.id);
    if (!pointInPolygon(buoy.a, level.bounds) || !pointInPolygon(buoy.b, level.bounds)) {
      errors.push(`浮标 ${buoy.id} 的标线超出航行水域`);
    }
    if (Math.hypot(buoy.b.x - buoy.a.x, buoy.b.y - buoy.a.y) < 1e-3) {
      errors.push(`浮标 ${buoy.id} 的标线长度为零`);
    }
  }

  for (const gateId of level.route) {
    if (!buoyIds.has(gateId)) errors.push(`航线引用了不存在的浮标：${gateId}`);
  }
  if (new Set(level.route).size !== level.route.length) errors.push('航线中出现重复浮标');

  if (level.route.length > 0) {
    const first = level.buoys.find((buoy) => buoy.id === level.route[0]);
    if (first) {
      const closest = projectPointOnSegment(first.a, first.b, level.dock.mouth);
      if (closest.distance < level.dock.width / 2 + 2) {
        errors.push('第一个浮标与靠泊口过近，靠泊判定会与过标判定混淆');
      }
    }
  }

  if (!pointInPolygon(level.start.position, level.bounds)) errors.push('起点必须在航行水域内');
  return { ok: errors.length === 0, errors };
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

export function levelHash(level: Level): string {
  return contentHash(levelContentForHash(level));
}

/** 指令按关卡时间排序；同时间指令保留声明顺序（排序稳定）。 */
export function sortCommands<T extends CourseCommand>(commands: readonly T[]): T[] {
  return commands
    .map((command, index) => ({ command, index }))
    .sort((a, b) => a.command.time - b.command.time || a.index - b.index)
    .map((entry) => entry.command);
}

export function normalizeHeading(heading: number): number {
  return Number.isFinite(heading) ? ((heading % 360) + 360) % 360 : 0;
}

export function clampSheet(value: number): number {
  return !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value));
}

/** 规范化航线：排序、取整到稳定精度、夹取范围。 */
export function normalizePlan(plan: CoursePlan): CoursePlan {
  return {
    version: 1,
    levelId: plan.levelId,
    commands: sortCommands(plan.commands).map((command) => ({
      time: roundTo(command.time, 4),
      heading: roundTo(normalizeHeading(command.heading), 3),
      sheet: roundTo(clampSheet(command.sheet), 4),
    })),
  };
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface PlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePlan(level: Level, plan: CoursePlan): PlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (plan.version !== 1) errors.push('航线版本必须为 1');
  if (plan.levelId !== level.id) {
    errors.push(`航线属于关卡 ${plan.levelId}，与当前关卡 ${level.id} 不匹配`);
  }
  if (plan.commands.length === 0) warnings.push('航线为空：小艇会保持初始航向与帆位');
  let previous = -Infinity;
  for (const command of plan.commands) {
    if (!Number.isFinite(command.time) || command.time < 0) {
      errors.push('指令时间必须非负');
      continue;
    }
    if (command.time < previous) errors.push('指令必须按时间非降序排列');
    previous = command.time;
    if (!Number.isFinite(command.heading)) errors.push(`指令（${command.time}s）航向非法`);
    if (!Number.isFinite(command.sheet) || command.sheet < 0 || command.sheet > 1) {
      errors.push(`指令（${command.time}s）收帆点必须在 0..1`);
    }
    if (command.time > level.duration) {
      warnings.push(`指令（${command.time}s）在关卡结束之后，不会生效`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}
