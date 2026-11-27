import { pointInPolygon } from './math.ts';
import type { Level, Vec2, WindSample, WindState } from './types.ts';

export interface ResolvedWind extends WindSample {
  /** 生效风的完整对象（direction/speed），便于 UI 直接使用。 */
  wind: WindState;
}

export interface TimedChange {
  time: number;
  zoneId: string | null;
  direction: number;
  speed: number;
  order: number;
}

/**
 * 解析某点某刻的风。规则：
 * - 点落在风区内 → 该风区（数组靠后的风区优先覆盖靠前的）；
 * - 点不在任何风区内 → 开阔水域风；
 * - zoneId === null 的变化覆盖全部区域；"open" 只覆盖开阔水域。
 *
 * 所有变化按 (time, 声明顺序) 排序，查询是纯函数，与刷新率 / 倍速无关。
 */
export function resolveWind(
  level: Level,
  position: Vec2,
  time: number,
  changes: readonly TimedChange[] = changesUpTo(level, time),
): ResolvedWind {
  let zoneId: string | null = null;
  let zoneName = '开阔水域';
  let base = level.openWind;

  for (const zone of level.windZones) {
    if (!pointInPolygon(position, zone.vertices)) continue;
    zoneId = zone.id;
    zoneName = zone.name;
    base = zone.wind;
  }

  let wind: WindState = { direction: base.direction, speed: base.speed };
  for (const change of changes) {
    const applies =
      change.zoneId === null || (change.zoneId === 'open' ? zoneId === null : change.zoneId === zoneId);
    if (applies) wind = { direction: change.direction, speed: change.speed };
  }
  return {
    wind,
    direction: wind.direction,
    speed: wind.speed,
    zoneId,
    zoneName,
  };
}

/** 预计算截至 time 的风速变化（按 time、声明顺序排序）。 */
export function changesUpTo(level: Level, time: number): TimedChange[] {
  const list: TimedChange[] = [];
  for (let index = 0; index < level.windChanges.length; index++) {
    const change = level.windChanges[index];
    if (!change || change.time > time + 1e-9) continue;
    list.push({
      time: change.time,
      zoneId: change.zoneId,
      direction: change.direction,
      speed: change.speed,
      order: index,
    });
  }
  list.sort((a, b) => a.time - b.time || a.order - b.order);
  return list;
}

export interface ZoneWindView {
  zoneId: string;
  zoneName: string;
  wind: WindState;
}

/** 每个风区在某刻的生效风，用于绘制风区标签。 */
export function zoneWinds(level: Level, time: number, changes = changesUpTo(level, time)): ZoneWindView[] {
  const views: ZoneWindView[] = [];
  for (const zone of level.windZones) {
    let wind: WindState = { direction: zone.wind.direction, speed: zone.wind.speed };
    for (const change of changes) {
      if (change.zoneId === null || change.zoneId === zone.id) {
        wind = { direction: change.direction, speed: change.speed };
      }
    }
    views.push({ zoneId: zone.id, zoneName: zone.name, wind });
  }
  return views;
}

export function openWaterWind(level: Level, time: number, changes = changesUpTo(level, time)): WindState {
  let wind: WindState = { direction: level.openWind.direction, speed: level.openWind.speed };
  for (const change of changes) {
    if (change.zoneId === null || change.zoneId === 'open') {
      wind = { direction: change.direction, speed: change.speed };
    }
  }
  return wind;
}

export interface UpcomingChange {
  time: number;
  zoneId: string | null;
  zoneLabel: string;
  direction: number;
  speed: number;
  note?: string;
}

/** 关卡时间 time 之后的风速变化，供时间轴显示。 */
export function upcomingChanges(level: Level, time: number): UpcomingChange[] {
  const labels = new Map(level.windZones.map((zone) => [zone.id, zone.name] as const));
  return level.windChanges
    .filter((change) => change.time > time)
    .map((change) => ({
      time: change.time,
      zoneId: change.zoneId,
      zoneLabel:
        change.zoneId === null
          ? '全部水域'
          : change.zoneId === 'open'
            ? '开阔水域'
            : labels.get(change.zoneId) ?? change.zoneId,
      direction: change.direction,
      speed: change.speed,
      ...(change.note === undefined ? {} : { note: change.note }),
    }))
    .sort((a, b) => a.time - b.time);
}
