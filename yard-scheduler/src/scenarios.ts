/**
 * 内置场景。
 * basic:可解的基础场景(默认计划即可成功,含月台争抢的让行)。
 * alley:窄巷场景,默认计划会在 t=8 死锁,需要回退后错开起步时隙。
 */

import { YardMap, Plan } from './model.js';

export interface Scenario {
  id: string;
  title: string;
  description: string;
  map: YardMap;
  initialPlan: Plan;
}

export const BASIC: Scenario = {
  id: 'basic',
  title: '基础场景:三台车两座月台',
  description:
    'V1、V2 从西货场出发,V3 从东货场出发。J1—J2 是窄路段,dock1 只有一个车位,' +
    '岔口 J1 只有一个等待车位。默认计划可全部按时送达:注意观察 V2、V3 在窄路段和' +
    '月台前的相互让行,以及 V3 在 J1 无等待车位时滞留在路段上的情况。',
  map: {
    name: 'basic',
    deadline: 30,
    nodes: [
      { id: 'yardA', name: '西货场', x: 70, y: 140, kind: 'yard' },
      { id: 'J1', name: '岔口J1', x: 270, y: 140, kind: 'junction', waitCapacity: 1 },
      { id: 'dock1', name: '月台1', x: 500, y: 80, kind: 'dock', dockSlots: 1 },
      { id: 'J2', name: '岔口J2', x: 270, y: 330, kind: 'junction', waitCapacity: 1 },
      { id: 'yardB', name: '东货场', x: 70, y: 330, kind: 'yard' },
      { id: 'dock2', name: '月台2', x: 500, y: 330, kind: 'dock', dockSlots: 1 },
    ],
    edges: [
      { id: 'eAB', a: 'yardA', b: 'J1', ticks: 4, bidirectional: true, narrow: false },
      { id: 'eJ1D1', a: 'J1', b: 'dock1', ticks: 3, bidirectional: true, narrow: true },
      { id: 'eJ1J2', a: 'J1', b: 'J2', ticks: 5, bidirectional: true, narrow: true },
      { id: 'eB2', a: 'yardB', b: 'J2', ticks: 4, bidirectional: true, narrow: false },
      { id: 'eJ2D2', a: 'J2', b: 'dock2', ticks: 3, bidirectional: true, narrow: false },
    ],
    vehicles: [
      { id: 'V1', name: 'V1', color: '#e6194b', start: 'yardA', destDock: 'dock1', unloadTicks: 6 },
      { id: 'V2', name: 'V2', color: '#3cb44b', start: 'yardA', destDock: 'dock2', unloadTicks: 6 },
      { id: 'V3', name: 'V3', color: '#4363d8', start: 'yardB', destDock: 'dock1', unloadTicks: 6 },
    ],
  },
  initialPlan: {
    V1: { depart: 0, route: ['eAB', 'eJ1D1'] },
    V2: { depart: 1, route: ['eAB', 'eJ1J2', 'eJ2D2'] },
    V3: { depart: 0, route: ['eB2', 'eJ1J2', 'eJ1D1'] },
  },
};

export const ALLEY: Scenario = {
  id: 'alley',
  title: '窄巷场景:默认计划会死锁',
  description:
    '岔口 X 不能停车(等待车位 0),两段窄巷 e1、e2 串联。V1 自西向东、V2 自东向西,' +
    '默认计划下 V1 在 t=6 被 e2 挡住滞留在 e1 上,V2 在 t=8 被 e1 挡住滞留在 e2 上,' +
    '互相等待形成死锁。从冲突处回退到 V2 起步之前,把 V2 的起步时隙推迟到 12 之后即可通过。',
  map: {
    name: 'alley',
    deadline: 40,
    nodes: [
      { id: 'dockW', name: '西月台', x: 60, y: 90, kind: 'dock', dockSlots: 1 },
      { id: 'W', name: '西货场', x: 200, y: 210, kind: 'yard' },
      { id: 'X', name: '巷口X', x: 380, y: 210, kind: 'junction', waitCapacity: 0 },
      { id: 'E', name: '东货场', x: 560, y: 210, kind: 'yard' },
      { id: 'dockE', name: '东月台', x: 700, y: 90, kind: 'dock', dockSlots: 1 },
    ],
    edges: [
      { id: 'w1', a: 'dockW', b: 'W', ticks: 2, bidirectional: true, narrow: false },
      { id: 'e1', a: 'W', b: 'X', ticks: 6, bidirectional: true, narrow: true },
      { id: 'e2', a: 'X', b: 'E', ticks: 6, bidirectional: true, narrow: true },
      { id: 'e3', a: 'E', b: 'dockE', ticks: 2, bidirectional: true, narrow: false },
    ],
    vehicles: [
      { id: 'V1', name: 'V1', color: '#e6194b', start: 'W', destDock: 'dockE', unloadTicks: 6 },
      { id: 'V2', name: 'V2', color: '#3cb44b', start: 'E', destDock: 'dockW', unloadTicks: 6 },
    ],
  },
  initialPlan: {
    V1: { depart: 0, route: ['e1', 'e2', 'e3'] },
    V2: { depart: 2, route: ['e2', 'e1', 'w1'] },
  },
};

export const SCENARIOS: Scenario[] = [BASIC, ALLEY];

export function scenarioById(id: string): Scenario {
  const s = SCENARIOS.find((s) => s.id === id);
  if (!s) throw new Error(`未知场景: ${id}`);
  return s;
}
