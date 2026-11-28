import type { LevelSpec } from '../types.ts';

/**
 * 关卡一：争水的蓄水池。
 *
 * 中游蓄水池 basin（容量 12，初始 0）同时接受两路进水：
 * - 泉眼 spring 经闸 A，每回合可送 6；
 * - 上游湖 lake 经闸 B，可送 8。
 * 两路同时开太猛，蓄水池就会越过 12 的溢流线，多出来的水倒进低处检修格 maintM；
 * maintM 安全线只有 3，一旦被淹立刻失败。
 *
 * 目标池 target 每回合最多收 8，3 个回合内要达到 18。
 * 只靠泉眼来不及；必须动用湖，但湖的流量要在最后一回合之前关掉，
 * 否则蓄水池溢流会淹没检修格。
 */
export const levelOne: LevelSpec = {
  id: 'level-01-contention',
  name: '一 · 争水的蓄水池',
  summary: '泉眼和上游湖争用同一座蓄水池。蓄水池溢流会倒进低处检修格，淹了检修格就算输。',
  turns: 3,
  pools: [
    {
      id: 'spring',
      label: '泉眼',
      elevation: 45,
      capacity: 60,
      initial: 6,
      inflow: 6,
      layout: { x: 28, y: 96, width: 132, height: 62 },
    },
    {
      id: 'lake',
      label: '上游湖',
      elevation: 40,
      capacity: 20,
      initial: 14,
      layout: { x: 28, y: 236, width: 132, height: 62 },
    },
    {
      id: 'basin',
      label: '蓄水池',
      elevation: 20,
      capacity: 12,
      initial: 0,
      overflowTo: 'maintM',
      layout: { x: 318, y: 150, width: 152, height: 78 },
    },
    {
      id: 'target',
      label: '目标池',
      elevation: 0,
      capacity: 20,
      initial: 2,
      layout: { x: 632, y: 216, width: 152, height: 78 },
    },
    {
      id: 'maintM',
      label: '检修格 M',
      elevation: -12,
      capacity: 12,
      initial: 0,
      safeLevel: 3,
      maintenance: true,
      layout: { x: 318, y: 344, width: 152, height: 58 },
    },
  ],
  gates: [
    { id: 'A', label: '闸 A · 泉眼', initial: 'closed', layout: { x: 206, y: 132 } },
    { id: 'B', label: '闸 B · 上游湖', initial: 'closed', layout: { x: 206, y: 272 } },
    { id: 'C', label: '闸 C · 出池', initial: 'closed', layout: { x: 508, y: 196 } },
  ],
  edges: [
    { id: 'spring-basin', from: 'spring', to: 'basin', capacity: 6, gate: 'A',
      layout: { points: [[160, 127], [206, 132], [270, 145], [318, 175]] } },
    { id: 'lake-basin', from: 'lake', to: 'basin', capacity: 8, gate: 'B',
      layout: { points: [[160, 267], [206, 272], [270, 244], [318, 206]] } },
    { id: 'basin-target', from: 'basin', to: 'target', capacity: 8, gate: 'C',
      layout: { points: [[470, 196], [508, 196], [568, 224], [632, 252]] } },
  ],
  goal: { pool: 'target', atLeast: 18 },
};

/**
 * 关卡二：刚好到溢流线。
 *
 * 目标池 target 的容量是 10，通关要求也是 10；它一旦溢流就倒进低处检修格 N，
 * 而 N 的安全线是 0——哪怕只溢 1 格也判负。因此唯一通关方式，是让 target
 * 在某一回合结算后**恰好停在 10**，既不能多也不能少。
 *
 * 水从泉眼到 target 要经过三跳：泉眼 → 分叉井 → 慢/快支 → 目标池，
 * 每跳都要一回合，所以只有第 3 回合起才可能有水抵达。
 * 分叉井只有上限：慢支 cap 2、快支 cap 3；可用水量不够时按容量比例分配。
 * 全开闸门会让目标池在第 5 回合冲到 12 并溢流，正好淹没检修格；
 * 玩家必须在目标池水位到 10 的那一回合之前逐步收闸。
 */
export const levelTwo: LevelSpec = {
  id: 'level-02-brim',
  name: '二 · 刚好到溢流线',
  summary: '目标池必须恰好停在容量 10：多一格就溢进检修格（安全线 0）判负，少一格也达不到目标。',
  turns: 6,
  pools: [
    {
      id: 'spring',
      label: '泉眼',
      elevation: 60,
      capacity: 30,
      initial: 0,
      inflow: 4,
      layout: { x: 30, y: 150, width: 128, height: 62 },
    },
    {
      id: 'hub',
      label: '分叉井',
      elevation: 30,
      capacity: 8,
      initial: 0,
      layout: { x: 282, y: 150, width: 140, height: 70 },
    },
    {
      id: 'slow',
      label: '慢支',
      elevation: 10,
      capacity: 5,
      initial: 0,
      layout: { x: 512, y: 66, width: 124, height: 56 },
    },
    {
      id: 'fast',
      label: '快支',
      elevation: 10,
      capacity: 5,
      initial: 0,
      layout: { x: 512, y: 210, width: 124, height: 56 },
    },
    {
      id: 'target',
      label: '目标池',
      elevation: 0,
      capacity: 10,
      initial: 0,
      overflowTo: 'maintN',
      layout: { x: 744, y: 152, width: 140, height: 68 },
    },
    {
      id: 'maintN',
      label: '检修格 N',
      elevation: -14,
      capacity: 12,
      initial: 0,
      safeLevel: 0,
      maintenance: true,
      layout: { x: 744, y: 356, width: 140, height: 52 },
    },
  ],
  gates: [
    { id: 'F', label: '闸 F · 泉眼', initial: 'closed', layout: { x: 205, y: 181 } },
    { id: 'S', label: '闸 S · 慢支', initial: 'closed', layout: { x: 468, y: 94 } },
    { id: 'Q', label: '闸 Q · 快支', initial: 'closed', layout: { x: 468, y: 238 } },
  ],
  edges: [
    { id: 'spring-hub', from: 'spring', to: 'hub', capacity: 4, gate: 'F',
      layout: { points: [[158, 181], [205, 181], [282, 185]] } },
    { id: 'hub-slow', from: 'hub', to: 'slow', capacity: 2, gate: 'S',
      layout: { points: [[422, 185], [468, 94], [512, 94]] } },
    { id: 'hub-fast', from: 'hub', to: 'fast', capacity: 3, gate: 'Q',
      layout: { points: [[422, 185], [468, 238], [512, 238]] } },
    { id: 'slow-target', from: 'slow', to: 'target', capacity: 2,
      layout: { points: [[636, 94], [690, 128], [744, 182]] } },
    { id: 'fast-target', from: 'fast', to: 'target', capacity: 3,
      layout: { points: [[636, 238], [696, 246], [744, 210]] } },
  ],
  goal: { pool: 'target', atLeast: 10 },
};

export const sampleLevels: readonly LevelSpec[] = [levelOne, levelTwo];
