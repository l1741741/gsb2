/**
 * mapio.ts — 地图读取、校验与查询辅助。
 * 内置地图与玩家选择的本地 JSON 都经过同一个 validateMap。
 */

import { hexRadiusTiles, keyOf, sameHex } from './hex.js';
import type { MapDef, ObstacleDef, StanceDef } from './types.js';

export interface ValidationResult {
  ok: boolean;
  map?: MapDef;
  errors: string[];
}

export function tileKeys(map: MapDef): Set<string> {
  return new Set(hexRadiusTiles(map.shape.radius).map(keyOf));
}

export function hasTile(map: MapDef, q: number, r: number): boolean {
  const { radius } = map.shape;
  return (
    Math.abs(q) <= radius &&
    Math.abs(r) <= radius &&
    Math.abs(q + r) <= radius
  );
}

export function heightAt(map: MapDef, q: number, r: number): number {
  const h = map.heights?.[`${q},${r}`];
  return typeof h === 'number' && Number.isFinite(h) ? h : 0;
}

const OBSTACLE_INDEX_CACHE = new WeakMap<MapDef, Map<string, ObstacleDef>>();

export function obstacleAt(
  map: MapDef,
  q: number,
  r: number,
): ObstacleDef | undefined {
  let idx = OBSTACLE_INDEX_CACHE.get(map);
  if (!idx) {
    idx = new Map<string, ObstacleDef>();
    for (const o of map.obstacles ?? []) idx.set(keyOf(o), o);
    OBSTACLE_INDEX_CACHE.set(map, idx);
  }
  return idx.get(`${q},${r}`);
}

export function isPassable(map: MapDef, q: number, r: number): boolean {
  return hasTile(map, q, r) && !obstacleAt(map, q, r);
}

/** 障碍顶部的绝对海拔 = 地块高度 + 障碍高出地面的级数。 */
export function blockTopAt(map: MapDef, q: number, r: number): number | null {
  const o = obstacleAt(map, q, r);
  if (!o) return null;
  const extra =
    o.extra ?? (o.kind === 'wall' ? map.wallHeight : o.kind === 'spire' ? 3 : 1);
  return heightAt(map, q, r) + extra;
}

export function getStances(map: MapDef): StanceDef[] {
  if (map.stances && map.stances.length > 0) return map.stances;
  return [
    {
      id: 'standard',
      label: '标准视点',
      eye: map.eyeHeight,
      cost: map.costs.observe,
    },
  ];
}

export function getStance(map: MapDef, id: string): StanceDef {
  const all = getStances(map);
  return all.find((s) => s.id === id) ?? all[0];
}

export function observeCost(map: MapDef, stanceId: string): number {
  const s = getStance(map, stanceId);
  return s.cost ?? map.costs.observe;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asCoord(
  v: unknown,
  path: string,
  errors: string[],
): { q: number; r: number } | null {
  if (!isObject(v)) {
    errors.push(`${path} 必须是 {q,r} 对象`);
    return null;
  }
  if (typeof v.q !== 'number' || typeof v.r !== 'number') {
    errors.push(`${path}.q / ${path}.r 必须是数字`);
    return null;
  }
  if (!Number.isInteger(v.q) || !Number.isInteger(v.r)) {
    errors.push(`${path} 的 q,r 必须是整数`);
    return null;
  }
  return { q: v.q, r: v.r };
}

/** 校验并归一化一份未知 JSON；不做网络请求。 */
export function validateMap(raw: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObject(raw)) return { ok: false, errors: ['地图文件顶层必须是对象'] };

  if (raw.format !== 'hex-survey-map@1') {
    errors.push('format 必须是 "hex-survey-map@1"');
  }
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    errors.push('id 必须是非空字符串');
  }
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    errors.push('name 必须是非空字符串');
  }
  if (!isObject(raw.shape) || raw.shape.kind !== 'hex' ||
      typeof raw.shape.radius !== 'number' ||
      !Number.isInteger(raw.shape.radius) || raw.shape.radius < 1) {
    errors.push('shape 必须是 { kind:"hex", radius:正整数 }');
  }
  const start = asCoord(raw.start, 'start', errors);

  if (typeof raw.budget !== 'number' || raw.budget <= 0) {
    errors.push('budget 必须是正数');
  }
  if (!isObject(raw.costs) ||
      typeof raw.costs.move !== 'number' || raw.costs.move < 0 ||
      typeof raw.costs.observe !== 'number' || raw.costs.observe < 0) {
    errors.push('costs.move / costs.observe 必须是非负数字');
  }
  if (typeof raw.eyeHeight !== 'number' || raw.eyeHeight < 0) {
    errors.push('eyeHeight 必须是非负数字');
  }
  if (typeof raw.wallHeight !== 'number' || raw.wallHeight < 1) {
    errors.push('wallHeight 必须是 >=1 的数字');
  }
  if (!Array.isArray(raw.beacons) || raw.beacons.length === 0) {
    errors.push('beacons 至少包含一个信标');
  }

  if (errors.length > 0) return { ok: false, errors };

  // 到这里基础字段形态正确，构造强类型地图再做坐标域校验。
  const map = raw as unknown as MapDef;
  const radius = map.shape.radius;
  const inBounds = (q: number, r: number) =>
    Math.abs(q) <= radius && Math.abs(r) <= radius && Math.abs(q + r) <= radius;

  if (start && !inBounds(start.q, start.r)) {
    errors.push(`start (${start.q},${start.r}) 超出半径 ${radius} 的六边形地图`);
  }

  if (map.heights !== undefined) {
    if (!isObject(map.heights)) {
      errors.push('heights 必须是 { "q,r": 高度 } 对象');
    } else {
      for (const [k, h] of Object.entries(map.heights)) {
        const [qs, rs] = k.split(',');
        const q = Number(qs);
        const r = Number(rs);
        if (!Number.isInteger(q) || !Number.isInteger(r) || !inBounds(q, r)) {
          errors.push(`heights 键 "${k}" 不是界内整数坐标`);
        }
        if (typeof h !== 'number' || !Number.isFinite(h) || h < 0) {
          errors.push(`heights["${k}"] 必须是非负有限数字`);
        }
      }
    }
  }

  const obstacleKeys = new Set<string>();
  for (const [i, o] of (map.obstacles ?? []).entries()) {
    const c = asCoord(o, `obstacles[${i}]`, errors);
    if (!c) continue;
    if (!inBounds(c.q, c.r)) {
      errors.push(`obstacles[${i}] (${c.q},${c.r}) 越界`);
    }
    const k = keyOf(c);
    if (obstacleKeys.has(k)) errors.push(`障碍 ${k} 重复定义`);
    obstacleKeys.add(k);
    if (!['wall', 'spire', 'rock'].includes(o.kind)) {
      errors.push(`obstacles[${i}].kind 必须是 wall/spire/rock`);
    }
  }

  const beaconIds = new Set<string>();
  const beaconKeys = new Set<string>();
  for (const [i, b] of map.beacons.entries()) {
    const c = asCoord(b, `beacons[${i}]`, errors);
    if (!c) continue;
    if (typeof b.id !== 'string' || b.id.length === 0) {
      errors.push(`beacons[${i}].id 必须是非空字符串`);
    } else if (beaconIds.has(b.id)) {
      errors.push(`信标 id "${b.id}" 重复`);
    } else {
      beaconIds.add(b.id);
    }
    if (!inBounds(c.q, c.r)) errors.push(`信标 ${b.id ?? i} 坐标越界`);
    const k = keyOf(c);
    if (beaconKeys.has(k)) errors.push(`信标 ${k} 重复布置在同一格`);
    beaconKeys.add(k);
    if (obstacleKeys.has(k)) errors.push(`信标 ${k} 不能与障碍同格`);
    if (start && sameHex(c, start)) errors.push(`信标 ${b.id} 不能放在起点`);
  }

  if (map.stances !== undefined) {
    const ids = new Set<string>();
    for (const [i, s] of map.stances.entries()) {
      if (!isObject(s) || typeof s.id !== 'string' || typeof s.label !== 'string' ||
          typeof s.eye !== 'number' || s.eye < 0) {
        errors.push(`stances[${i}] 必须含字符串 id/label 与非负 eye`);
        continue;
      }
      if (ids.has(s.id)) errors.push(`姿态 id "${s.id}" 重复`);
      ids.add(s.id);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, map, errors: [] };
}
