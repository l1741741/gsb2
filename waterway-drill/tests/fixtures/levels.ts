import type { LevelSpec } from '../../src/types.ts';

/** 一个只用于单测的最小关卡：两个池子、一条闸门。 */
export function miniLevel(overrides: Partial<LevelSpec> = {}): LevelSpec {
  return {
    id: 'mini',
    name: '单测迷你关',
    summary: '单测用',
    turns: 3,
    pools: [
      {
        id: 'high',
        label: '高池',
        elevation: 10,
        capacity: 4,
        initial: 3,
        inflow: 1,
        layout: { x: 0, y: 0, width: 40, height: 20 },
      },
      {
        id: 'low',
        label: '低池',
        elevation: 0,
        capacity: 6,
        initial: 0,
        layout: { x: 100, y: 0, width: 40, height: 20 },
      },
    ],
    gates: [{ id: 'G', label: '闸 G', initial: 'closed' }],
    edges: [{ id: 'e1', from: 'high', to: 'low', capacity: 2, gate: 'G' }],
    goal: { pool: 'low', atLeast: 2 },
    ...overrides,
  };
}

/** 四闸三池的小关卡，用于验证“同回合多闸门统一结算”。 */
export function threeGateLevel(): LevelSpec {
  return {
    id: 'three-gates',
    name: '三闸',
    summary: '',
    turns: 3,
    pools: [
      { id: 'src', label: '源', elevation: 20, capacity: 10, initial: 6,
        layout: { x: 0, y: 0, width: 10, height: 10 } },
      { id: 'a', label: 'A', elevation: 10, capacity: 8, initial: 0,
        layout: { x: 10, y: 0, width: 10, height: 10 } },
      { id: 'b', label: 'B', elevation: 10, capacity: 8, initial: 0,
        layout: { x: 20, y: 0, width: 10, height: 10 } },
      { id: 'out', label: '出口', elevation: 0, capacity: 12, initial: 0,
        layout: { x: 30, y: 0, width: 10, height: 10 } },
    ],
    gates: [
      { id: 's-a', label: 's-a', initial: 'closed' },
      { id: 's-b', label: 's-b', initial: 'closed' },
      { id: 'a-out', label: 'a-out', initial: 'closed' },
      { id: 'b-out', label: 'b-out', initial: 'closed' },
    ],
    edges: [
      { id: 'e-s-a', from: 'src', to: 'a', capacity: 3, gate: 's-a' },
      { id: 'e-s-b', from: 'src', to: 'b', capacity: 3, gate: 's-b' },
      { id: 'e-a-out', from: 'a', to: 'out', capacity: 3, gate: 'a-out' },
      { id: 'e-b-out', from: 'b', to: 'out', capacity: 3, gate: 'b-out' },
    ],
    goal: { pool: 'out', atLeast: 2 },
  };
}
