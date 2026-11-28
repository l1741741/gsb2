import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLevel } from '../src/level.ts';
import { sampleLevels, levelOne, levelTwo } from '../src/levels/index.ts';
import { solveLevel } from '../src/solver.ts';
import { DrillSession } from '../src/game.ts';
import { replayRecord } from '../src/replay.ts';
import type { GateState } from '../src/types.ts';

test('levels: 两个样例关卡都能无随机地确定性求解', () => {
  for (const spec of sampleLevels) {
    const level = compileLevel(spec);
    const result = solveLevel(level);
    assert.ok(result.solutions.length > 0, `${spec.id} 应有通关走法`);
  }
});

test('levels: 求解两次得到完全相同的首条走法（不依赖随机）', () => {
  const level = compileLevel(levelTwo);
  const a = solveLevel(level).solutions[0]!;
  const b = solveLevel(level).solutions[0]!;
  assert.deepEqual(a.steps, b.steps);
});

test('levels: 关卡一存在“争用同一池子”的分叉（basin 有两条入边）', () => {
  const level = compileLevel(levelOne);
  const intoBasin = level.spec.edges.filter((edge) => edge.to === 'basin');
  assert.equal(intoBasin.length, 2);
  const outOfBasin = level.spec.edges.filter((edge) => edge.from === 'basin');
  assert.ok(outOfBasin.length >= 1);
});

test('levels: 关卡二存在“刚好到达溢流线”的关键判定点（目标池容量与目标相等）', () => {
  const level = compileLevel(levelTwo);
  const target = level.pools.get('target')!;
  assert.equal(level.goal.atLeast, target.spec.capacity);
  const maint = level.pools.get('maintN')!;
  assert.equal(maint.safeLevel, 0, '任何溢流都会淹检修格');
  assert.ok(target.overflowTo === 'maintN');
});

test('levels: 关卡一全开闸门会淹没检修格（无脑策略失败）', () => {
  const level = compileLevel(levelOne);
  const session = new DrillSession(level);
  for (const gate of level.gates.values()) session.queueGate(gate.id, 'open');
  while (session.view().outcome === 'playing' && session.turnsRemaining > 0) {
    const record = session.settle();
    if (record.outcome !== 'playing') break;
    for (const gate of level.gates.values()) session.queueGate(gate.id, 'open');
  }
  assert.equal(session.view().outcome, 'lost');
  assert.equal(session.view().failure?.code, 'maintenance-flooded');
});

test('levels: 关卡二全开闸门会越过溢流线判负（需要逐步收闸）', () => {
  const level = compileLevel(levelTwo);
  const session = new DrillSession(level);
  for (const gate of level.gates.values()) session.queueGate(gate.id, 'open');
  while (session.view().outcome === 'playing' && session.turnsRemaining > 0) {
    const record = session.settle();
    if (record.outcome !== 'playing') break;
    for (const gate of level.gates.values()) session.queueGate(gate.id, 'open');
  }
  assert.equal(session.view().outcome, 'lost');
  assert.equal(session.view().failure?.code, 'maintenance-flooded');
});

test('levels: 通关走法生成的记录能被同一关卡完整重放', () => {
  for (const spec of sampleLevels) {
    const level = compileLevel(spec);
    const solution = solveLevel(level).solutions[0]!;
    const session = new DrillSession(level);
    for (const step of solution.steps) {
      for (const gate of level.gates.values()) {
        session.queueGate(gate.id, step.gates[gate.id] as GateState);
      }
      session.settle();
    }
    const record = session.toRecord();
    assert.equal(record.result.outcome, 'won');
    const replay = replayRecord(level, record);
    assert.deepEqual(replay.turns, record.turns);
    assert.equal(replay.outcome, 'won');
  }
});

test('levels: 两关的关卡 id 不同、指纹不同', () => {
  const one = compileLevel(levelOne);
  const two = compileLevel(levelTwo);
  assert.notEqual(one.spec.id, two.spec.id);
  assert.notEqual(one.fingerprint, two.fingerprint);
});
