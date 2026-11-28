import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLevel, initialGateStates, initialLevels } from '../../src/level.ts';
import { settleTurn, allocateFairShare, auditLedgers } from '../../src/settle.ts';
import type { GateState, LevelSpec, TurnRecord } from '../../src/types.ts';

function run(levelSpec: LevelSpec, plans: Readonly<Record<string, GateState>>[]): TurnRecord[] {
  const level = compileLevel(levelSpec);
  let levels = initialLevels(level);
  const records: TurnRecord[] = [];
  for (const [index, plan] of plans.entries()) {
    const { record } = settleTurn(level, {
      turn: index + 1,
      turnLimit: levelSpec.turns,
      startLevels: levels,
      gates: new Map(Object.entries(plan)),
    });
    records.push(record);
    levels = new Map(Object.entries(record.pools));
    if (record.outcome !== 'playing') break;
  }
  return records;
}

/** 三池争用：上游 high 同时给 mid 和 low，mid 也给 low；检查顺序无关性。 */
function contentionLevel(): LevelSpec {
  return {
    id: 'contention',
    name: '争用',
    summary: '',
    turns: 2,
    pools: [
      { id: 'high', label: '高', elevation: 30, capacity: 12, initial: 10,
        layout: { x: 0, y: 0, width: 10, height: 10 } },
      { id: 'mid', label: '中', elevation: 20, capacity: 8, initial: 2,
        layout: { x: 20, y: 0, width: 10, height: 10 } },
      { id: 'low', label: '低', elevation: 0, capacity: 20, initial: 0,
        layout: { x: 40, y: 0, width: 10, height: 10 } },
    ],
    gates: [
      { id: 'ab', label: 'ab', initial: 'open' },
      { id: 'bc', label: 'bc', initial: 'open' },
      { id: 'ac', label: 'ac', initial: 'closed' },
    ],
    edges: [
      { id: 'high-mid', from: 'high', to: 'mid', capacity: 5, gate: 'ab' },
      { id: 'mid-low', from: 'mid', to: 'low', capacity: 4, gate: 'bc' },
      { id: 'high-low', from: 'high', to: 'low', capacity: 3, gate: 'ac' },
    ],
    goal: { pool: 'low', atLeast: 5 },
  };
}

test('settle: 同一布置下，关卡文件中支路顺序改变不改变任何数值', () => {
  const level = contentionLevel();
  const permuted: LevelSpec = {
    ...level,
    pools: [...level.pools].reverse(),
    gates: [...level.gates].reverse(),
    edges: [...level.edges].reverse(),
  };
  const plan = { ab: 'open', bc: 'open', ac: 'open' } as const;
  const a = run(level, [plan, plan]);
  const b = run(permuted, [plan, plan]);
  assert.deepEqual(a, b);
});

test('settle: 结果与输入 Map 的迭代顺序无关', () => {
  const level = compileLevel(contentionLevel());
  const forward = new Map<string, GateState>([['ab', 'open'], ['bc', 'open'], ['ac', 'open']]);
  const backward = new Map<string, GateState>([['ac', 'open'], ['bc', 'open'], ['ab', 'open']]);
  const start = initialLevels(level);
  const a = settleTurn(level, { turn: 1, turnLimit: 2, startLevels: start, gates: forward }).record;
  const b = settleTurn(level, { turn: 1, turnLimit: 2, startLevels: start, gates: backward }).record;
  assert.deepEqual(a, b);
});

test('settle: 台账恒等式对每个池子成立，进出/溢流/留池对得上', () => {
  const records = run(contentionLevel(), [
    { ab: 'open', bc: 'open', ac: 'open' },
    { ab: 'closed', bc: 'open', ac: 'open' },
  ]);
  for (const record of records) {
    assert.deepEqual(auditLedgers(record), []);
  }
});

test('settle: 每条支路的通过量之和等于上游实际出流，受容量限制', () => {
  const level = compileLevel(contentionLevel());
  const { record } = settleTurn(level, {
    turn: 1,
    turnLimit: 2,
    startLevels: initialLevels(level),
    gates: new Map([['ab', 'open'], ['bc', 'open'], ['ac', 'open']]),
  });
  const highOut = (record.edges['high-mid'] ?? 0) + (record.edges['high-low'] ?? 0);
  // high 起始 10，本回合可放出 10；两条边合计容量 8，因此放满 8。
  assert.equal(highOut, 8);
  assert.ok(record.edges['high-mid'] <= 5);
  assert.ok(record.edges['high-low'] <= 3);
});

test('settle: 水经过有容量的分叉时按容量公平分配，余数按 id 补齐', () => {
  const edges = [
    { id: 'b-edge', from: 'x', to: 'a', capacity: 2, gate: null },
    { id: 'a-edge', from: 'x', to: 'b', capacity: 4, gate: null },
  ];
  const allocation = allocateFairShare(edges, 5);
  // 5 * 2/6 = 1 余 4；5 * 4/6 = 3 余 2。整数部分合计 4，补 1 给余数更大的 b-edge。
  assert.equal(allocation.get('b-edge'), 2);
  assert.equal(allocation.get('a-edge'), 3);
  assert.equal(allocation.get('a-edge')! + allocation.get('b-edge')!, 5);
});

test('settle: 可用水量不足容量总和时，总通过量恰好等于可用水量', () => {
  const level = compileLevel(contentionLevel());
  const { record } = settleTurn(level, {
    turn: 1,
    turnLimit: 2,
    startLevels: new Map([['high', 2], ['mid', 0], ['low', 0]]),
    gates: new Map([['ab', 'open'], ['bc', 'closed'], ['ac', 'open']]),
  });
  const total = record.edges['high-mid']! + record.edges['high-low']!;
  assert.equal(total, 2);
});

test('settle: 溢流越过容量时按容量截断，多出的水记入 spill', () => {
  const level = compileLevel({
    id: 'overflow',
    name: '溢流',
    summary: '',
    turns: 1,
    pools: [
      { id: 'src', label: '源', elevation: 10, capacity: 3, initial: 3,
        inflow: 4, layout: { x: 0, y: 0, width: 10, height: 10 } },
      { id: 'dst', label: '汇', elevation: 0, capacity: 10, initial: 0,
        layout: { x: 20, y: 0, width: 10, height: 10 } },
    ],
    gates: [],
    edges: [],
    goal: { pool: 'dst', atLeast: 1 },
  });
  const { record } = settleTurn(level, {
    turn: 1, turnLimit: 1, startLevels: initialLevels(level), gates: new Map(),
  });
  assert.equal(record.pools.src, 3);
  assert.equal(record.spill.src, 4);
  assert.equal(record.ledger.find((entry) => entry.poolId === 'src')!.start, 3);
});

test('settle: 溢流倒进更低池子时，接收池的 spillIn 与溢出量一致', () => {
  const level = compileLevel({
    id: 'overflow-chain',
    name: '溢流链',
    summary: '',
    turns: 1,
    pools: [
      { id: 'a', label: 'A', elevation: 20, capacity: 2, initial: 2,
        inflow: 3, overflowTo: 'b', layout: { x: 0, y: 0, width: 10, height: 10 } },
      { id: 'b', label: 'B', elevation: 10, capacity: 5, initial: 0,
        layout: { x: 10, y: 10, width: 10, height: 10 } },
    ],
    gates: [],
    edges: [],
    goal: { pool: 'b', atLeast: 1 },
  });
  const { record } = settleTurn(level, {
    turn: 1, turnLimit: 1, startLevels: initialLevels(level), gates: new Map(),
  });
  assert.equal(record.spill.a, 3);
  assert.equal(record.ledger.find((entry) => entry.poolId === 'b')!.spillIn, 3);
  assert.equal(record.pools.b, 3);
  assert.deepEqual(auditLedgers(record), []);
});

test('settle: 检修格被淹立刻判负，并记录水位与安全线', () => {
  const level = compileLevel({
    id: 'flood',
    name: '检修',
    summary: '',
    turns: 2,
    pools: [
      { id: 's', label: 'S', elevation: 10, capacity: 5, initial: 5,
        overflowTo: 'm', layout: { x: 0, y: 0, width: 10, height: 10 } },
      { id: 'm', label: '检修', elevation: 0, capacity: 10, initial: 0,
        safeLevel: 1, maintenance: true, layout: { x: 10, y: 10, width: 10, height: 10 } },
    ],
    gates: [],
    edges: [],
    goal: { pool: 'm', atLeast: 1 },
  });
  const { record } = settleTurn(level, {
    turn: 1, turnLimit: 2, startLevels: new Map([['s', 8], ['m', 0]]), gates: new Map(),
  });
  // s 起始 8、容量 5，溢出 3 格倒进 m；m 水位 3 超过安全线 1，判负。
  assert.equal(record.outcome, 'lost');
  assert.deepEqual(record.failure, {
    code: 'maintenance-flooded', poolId: 'm', level: 3, safeLevel: 1,
  });
});

test('settle: 恰好到达溢流线不算失败，超过安全线才算', () => {
  const level = compileLevel({
    id: 'brim',
    name: '刚好到线',
    summary: '',
    turns: 2,
    pools: [
      { id: 's', label: 'S', elevation: 10, capacity: 5, initial: 5,
        overflowTo: 'm', layout: { x: 0, y: 0, width: 10, height: 10 } },
      { id: 'm', label: '检修', elevation: 0, capacity: 10, initial: 0,
        safeLevel: 2, maintenance: true, layout: { x: 10, y: 10, width: 10, height: 10 } },
    ],
    gates: [],
    edges: [],
    goal: { pool: 'm', atLeast: 3 },
  });
  const atBrim = settleTurn(level, {
    turn: 1, turnLimit: 2, startLevels: new Map([['s', 7], ['m', 0]]), gates: new Map(),
  }).record;
  assert.equal(atBrim.pools.s, 5, '池子停在容量 5');
  assert.equal(atBrim.spill.s, 2);
  assert.equal(atBrim.pools.m, 2);
  assert.equal(atBrim.outcome, 'playing');

  // 溢流再多 1 格就超过安全线 2。
  const flooded = settleTurn(level, {
    turn: 1, turnLimit: 2, startLevels: new Map([['s', 8], ['m', 0]]), gates: new Map(),
  }).record;
  assert.equal(flooded.pools.m, 3);
  assert.equal(flooded.outcome, 'lost');
});

test('settle: 回合用尽而目标未达成时记为 turn-limit 失败', () => {
  const records = run(contentionLevel(), [{ ab: 'closed', bc: 'closed', ac: 'closed' },
    { ab: 'closed', bc: 'closed', ac: 'closed' }]);
  const last = records.at(-1)!;
  assert.equal(last.outcome, 'lost');
  assert.deepEqual(last.failure, {
    code: 'turn-limit', goalPoolId: 'low', achieved: 0, required: 5,
  });
});

test('settle: 目标达成即获胜，后续回合不再推进', () => {
  const records = run(contentionLevel(), [{ ab: 'open', bc: 'open', ac: 'open' }]);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.outcome, 'won');
  assert.equal(records[0]!.failure, null);
});
