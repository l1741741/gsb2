/**
 * types.ts — 地图文件、关卡规则与存档的纯数据结构。
 * 地图文件（maps/*.json）必须能定义：地块高度、障碍、信标、起点，
 * 以及每次移动 / 观测的消耗。
 */

import type { Axial } from './hex.js';

export type ObstacleKind = 'wall' | 'spire' | 'rock';

export interface ObstacleDef extends Axial {
  kind: ObstacleKind;
  /**
   * 高出本地块地面的高度（海拔级数）。
   * 石墙缺省取 MapDef.wallHeight，其它障碍缺省取 1。
   */
  extra?: number;
}

export interface BeaconDef extends Axial {
  id: string;
  name?: string;
}

export interface StanceDef {
  id: string;
  label: string;
  /** 视点高出地块地面的高度（级数）。观测海拔 = 地块 height + eye。 */
  eye: number;
  /** 本次观测的预算消耗；缺省用 costs.observe。 */
  cost?: number;
  desc?: string;
}

export interface LevelCosts {
  /** 每移动一格的预算消耗。 */
  move: number;
  /** 每次观测的缺省预算消耗（姿态可覆盖）。 */
  observe: number;
}

export interface MapDef {
  format: 'hex-survey-map@1';
  id: string;
  name: string;
  /** 关卡说明 / 勘测简报。 */
  brief: string;
  /** 裁定规则的补充提示，会显示在关卡面板。 */
  rulingNote?: string;
  shape: { kind: 'hex'; radius: number };
  start: Axial;
  /** 总行动预算。移动与观测都从这里扣除。 */
  budget: number;
  costs: LevelCosts;
  /** 缺省视点高度（高出所站地块）。 */
  eyeHeight: number;
  /** 石墙高出地块地面的缺省级数。 */
  wallHeight: number;
  /** 最大视距（六边格距离，可选；不设则全图）。 */
  visionRange?: number;
  /** 观测姿态（不同观察高度 / 消耗）；不设则只有标准姿态。 */
  stances?: StanceDef[];
  /**
   * 地块高度表，键为 "q,r"，值为海拔整数级。
   * 未列出的地块高度为 0。
   */
  heights?: Record<string, number>;
  obstacles?: ObstacleDef[];
  beacons: BeaconDef[];
  /** 参考预算：不超过它完成可获得“干练勘测员”评价。 */
  parBudget?: number;
  tips?: string[];
}

/** 一次已提交、可序列化、可重放的行动。 */
export type Action =
  | { type: 'move'; to: Axial }
  | { type: 'observe'; stanceId: string };

export interface SaveFile {
  app: 'hex-survey';
  format: 1;
  savedAt: string;
  map: MapDef;
  actions: Action[];
}
