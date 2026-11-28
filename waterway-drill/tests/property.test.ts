import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLevel } from '../src/level.ts';
import { settleTurn, auditLedgers } from '../src/settle.ts';
import type { GateState, LevelSpec, TurnRecord } from '../src/types.ts';

/** 用确定性伪随机（mulberry32）生成关卡，不依赖 Math.random，跑可复现的性质测试。 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomLevel(rand: () => number): LevelSpec {
  const poolCount = 3 + Math.floor(rand() * 4);
  const pools = [];
  for (let index = 0; index < poolCount; index += 1) {
    const elevation = index * 10;
    const capacity = 2 + Math.floor(rand() * 9);
    pools.push({
      id: `p${index}`,
      label: `池${index}`,
      elevation,
      capacity,
      initial: Math.floor(rand() * (capacity + 1)),
      inflow: Math.floor(rand() * 4),
      layout: { x: index * 60, y: 0, width: 40, height: 30 },
    });
  }
  const edges = [];
  let edgeCounter = 0;
  for (let lower = 0; lower < poolCount; lower += 1) {
    for (let higher = lower + 1; higher < poolCount; higher += 1) {
      if (rand() < 0.55) {
        edges.push({
          id: `e${edgeCounter++}`,
          from: `p${higher}`,
          to: `p${lower}`,
          capacity: 1 + Math.floor(rand() * 5),
          gate: null,
        });
      }
    }
  }
  // 把最低的一个池子设为检修格，安全线随机但低于容量。
  const withMaint = pools.map((pool, index) => index === 0
    ? { ...pool, maintenance: true, safeLevel: Math.floor(rand() * 3) }
    : pool);
  return {
    id: 'random',
    name: '随机性质测试关',
    summary: '',
    turns: 3,
    pools: withMaint,
    gates: [],
    edges,
    goal: { pool: 'p0', atLeast: Math.max(0, withMaint[0]!.capacity - 2) },
  };
}

test('property: 任意随机关卡的每个回合都满足台账恒等式与非负水量', () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const rand = mulberry32(seed);
    const level = compileLevel(randomLevel(rand));
    let levels = new Map([...level.pools.values()].map((pool) => [pool.id, pool.spec.initial]));
    let record: TurnRecord | undefined;
    for (let turn = 1; turn <= level.spec.turns; turn += 1) {
      const result = settleTurn(level, {
        turn,
        turnLimit: level.spec.turns,
        startLevels: levels,
        gates: new Map<string, GateState>(),
      }).record;
      record = result;
      assert.deepEqual(auditLedgers(result), [], `seed ${seed} 回合 ${turn} 台账不平衡`);
      for (const value of Object.values(result.pools)) {
        assert.ok(value >= 0 && Number.isInteger(value), `seed ${seed} 出现非法水量 ${value}`);
      }
      // 每条边的通过量不超过其容量。
      for (const edge of level.spec.edges) {
        const flow = result.edges[edge.id] ?? 0;
        assert.ok(flow <= edge.capacity, `seed ${seed} 支路 ${edge.id} 超过容量`);
      }
      levels = new Map(Object.entries(result.pools));
      if (result.outcome !== 'playing') break;
    }
  }
});

test('property: 打乱输入顺序（池子、支路、闸门）不改变结算结果', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const level = randomLevel(mulberry32(seed));
    const shuffled = {
      ...level,
      pools: [...level.pools].reverse(),
      edges: [...level.edges].reverse(),
    };
    const a = compileLevel(level);
    const b = compileLevel(shuffled);
    let levelsA = new Map([...a.pools.values()].map((pool) => [pool.id, pool.spec.initial]));
    let levelsB = new Map([...b.pools.values()].map((pool) => [pool.id, pool.spec.initial]));
    for (let turn = 1; turn <= level.turns; turn += 1) {
      const ra = settleTurn(a, {
        turn, turnLimit: level.turns, startLevels: levelsA, gates: new Map(),
      }).record;
      const rb = settleTurn(b, {
        turn, turnLimit: level.turns, startLevels: levelsB, gates: new Map(),
      }).record;
      assert.deepEqual(rb, ra, `seed ${seed} 反转顺序后回合 ${turn} 结果不一致`);
      levelsA = new Map(Object.entries(ra.pools));
      levelsB = new Map(Object.entries(rb.pools));
      if (ra.outcome !== 'playing') break;
    }
  }
});
