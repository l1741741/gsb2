import { DEFAULT_PALETTE, DEFAULT_PHYSICS, type Level } from '../core/types.ts';

/**
 * 关卡一：跨风区长线（世界 0..440 × 0..280）。
 *
 * 航线：起点(62,214) → b1(136,160) → b2(218,92) → b3(320,98) → b4(368,158) → 栈桥(388,204)。
 * 两个风区：西风区（292°/8.4 m/s）覆盖西半，东风区（84°/7.4 m/s）覆盖东半；
 * 开阔水域（330°/7.6 m/s）夹在中间。40s 全局转北风，57s 东风区东偏增强。
 */
export const LONG_CROSSING: Level = {
  id: 'long-crossing',
  name: '东风转场',
  subtitle: '跨两个风区的长线：先借西风，再穿开阔水域，最后逆风进南栈桥',
  bounds: [
    { x: 22, y: 44 },
    { x: 418, y: 38 },
    { x: 428, y: 252 },
    { x: 26, y: 258 },
  ],
  start: { position: { x: 62, y: 214 }, heading: 50, speed: 2.6, sheet: 0.75 },
  openWind: { direction: 330, speed: 7.6 },
  windZones: [
    {
      id: 'west-sound',
      name: '西风区',
      vertices: [
        { x: 22, y: 44 },
        { x: 190, y: 40 },
        { x: 196, y: 256 },
        { x: 26, y: 258 },
      ],
      wind: { direction: 292, speed: 8.4 },
    },
    {
      id: 'east-reach',
      name: '东风区',
      vertices: [
        { x: 292, y: 40 },
        { x: 418, y: 38 },
        { x: 428, y: 252 },
        { x: 302, y: 254 },
      ],
      wind: { direction: 84, speed: 7.4 },
    },
  ],
  windChanges: [
    { time: 22, zoneId: 'west-sound', direction: 314, speed: 9.0, note: '西风区增强并北偏' },
    { time: 40, zoneId: null, direction: 18, speed: 7.6, note: '全局转北风' },
    { time: 57, zoneId: 'east-reach', direction: 58, speed: 8.6, note: '东风区东偏增强' },
  ],
  obstacles: [
    { kind: 'circle', id: 'north-islet', name: '北浅岛', center: { x: 252, y: 132 }, radius: 18 },
    { kind: 'rock', id: 'mid-reef', name: '中礁', vertices: [
      { x: 288, y: 228 },
      { x: 314, y: 222 },
      { x: 320, y: 244 },
      { x: 294, y: 250 },
    ] },
  ],
  buoys: [
    { id: 'b1', name: '浮标 1', a: { x: 128.9, y: 150.3 }, b: { x: 143.1, y: 169.7 }, radius: 4 },
    { id: 'b2', name: '浮标 2', a: { x: 210.3, y: 82.8 }, b: { x: 225.7, y: 101.2 }, radius: 4 },
    { id: 'b3', name: '浮标 3', a: { x: 320.7, y: 86.0 }, b: { x: 319.3, y: 110.0 }, radius: 4 },
    { id: 'b4', name: '浮标 4', a: { x: 377.4, y: 150.5 }, b: { x: 358.6, y: 165.5 }, radius: 4 },
  ],
  route: ['b1', 'b2', 'b3', 'b4'],
  dock: {
    id: 'dock-south',
    name: '南栈桥',
    mouth: { x: 388, y: 204 },
    heading: 157,
    length: 40,
    width: 16,
    speedLimit: 1.6,
  },
  duration: 108,
  briefing: [
    '起点在西南，西风区吹 292° 8.4 m/s；先向东北通过浮标 1。',
    '22s 西风区增强到 9 m/s，40s 全局转北风，57s 东风区东偏增强。',
    '浮标 2 在开阔水域边缘、浮标 3–4 在东风区，换风后需要重排帆位。',
    '最后靠 157° 南栈桥：进港前收帆，速度须低于 1.6 m/s。',
  ],
  physics: { ...DEFAULT_PHYSICS, hullSpeed: 6.2 },
  palette: {
    ...DEFAULT_PALETTE,
    water: '#0a2433',
    zone: 'rgba(118, 196, 214, 0.13)',
    predicted: 'rgba(140, 225, 245, 0.8)',
  },
};

/**
 * 关卡二：窄泊位低速贴靠（世界 0..340 × 0..240）。
 *
 * 航线：起点(54,180) → b1(117,136) → b2(216,140) → 窄泊位(268,90,航向 110°)。
 * 泊位宽 12 米、限速 1.2 m/s；26s 全局转南风 4.6 m/s，38s 降到 3.2 m/s。
 */
export const TIGHT_BERTH: Level = {
  id: 'tight-berth',
  name: '窄泊位贴靠',
  subtitle: '短航程窄入口：提前收帆，贴住 1.2 m/s 限速的 12 米泊位',
  bounds: [
    { x: 20, y: 44 },
    { x: 310, y: 40 },
    { x: 316, y: 214 },
    { x: 24, y: 222 },
  ],
  start: { position: { x: 54, y: 180 }, heading: 46, speed: 2.2, sheet: 0.75 },
  openWind: { direction: 24, speed: 7.8 },
  windZones: [
    {
      id: 'harbor-approach',
      name: '港口入口风区',
      vertices: [
        { x: 218, y: 36 },
        { x: 322, y: 36 },
        { x: 328, y: 222 },
        { x: 226, y: 226 },
      ],
      wind: { direction: 352, speed: 5.2 },
    },
  ],
  windChanges: [
    { time: 8, zoneId: 'harbor-approach', direction: 338, speed: 6.2, note: '入口略转西北并减弱' },
    { time: 30, zoneId: null, direction: 192, speed: 6.0, note: '全局转南风，船速下降' },
    { time: 44, zoneId: null, direction: 176, speed: 5.8, note: '风进一步减弱，进入滑行' },
  ],
  obstacles: [
    { kind: 'circle', id: 'inner-island', name: '内港小岛', center: { x: 156, y: 192 }, radius: 14 },
    { kind: 'rock', id: 'breakwater', name: '防波堤端', vertices: [
      { x: 208, y: 58 },
      { x: 234, y: 52 },
      { x: 238, y: 68 },
      { x: 212, y: 74 },
    ] },
    { kind: 'circle', id: 'mooring-rock', name: '系泊礁石', center: { x: 246, y: 190 }, radius: 9 },
  ],
  buoys: [
    { id: 'b1', name: '浮标 1', a: { x: 108.6, y: 128.0 }, b: { x: 125.4, y: 144.0 }, radius: 3.5 },
    { id: 'b2', name: '浮标 2', a: { x: 216.0, y: 128.6 }, b: { x: 216.0, y: 151.4 }, radius: 3.5 },
  ],
  route: ['b1', 'b2'],
  dock: {
    id: 'dock-narrow',
    name: '窄泊位',
    mouth: { x: 268, y: 90 },
    heading: 110,
    length: 38,
    width: 12,
    speedLimit: 1.2,
  },
  duration: 84,
  briefing: [
    '短航程窄泊位：泊位宽 12 米，限速 1.2 m/s。',
    '8s 入口风转 338°，26s 全局转南风，38s 进一步减弱并滑行。',
    '浮标 2 之后需要转向 110° 泊位入口，收帆要提前。',
    '进港超速、航向偏差超 34°、擦碰障碍都会给出原因与位置。',
  ],
  physics: { ...DEFAULT_PHYSICS, hullSpeed: 5.6, dockAlignTolerance: 34 },
  palette: {
    ...DEFAULT_PALETTE,
    water: '#102b38',
    shallow: '#174654',
  },
};

export const LEVELS: Level[] = [LONG_CROSSING, TIGHT_BERTH];

export function levelById(id: string): Level | undefined {
  return LEVELS.find((level) => level.id === id);
}
