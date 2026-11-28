import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLevel } from '../src/level.ts';
import { DrillSession } from '../src/game.ts';
import { parseRecord, replayRecord, RecordRejectedError } from '../src/replay.ts';
import { sampleLevels, levelOne, levelTwo } from '../src/levels/index.ts';
import { solveLevel } from '../src/solver.ts';
import type { DrillRecord, GateState, TurnRecord } from '../src/types.ts';

/** 用求解器的通关走法造一份记录，作为“首轮”。 */
function solvedRecord(specIndex: number): DrillRecord {
  const level = compileLevel(sampleLevels[specIndex]!);
  const solution = solveLevel(level).solutions[0]!;
  const session = new DrillSession(level);
  for (const step of solution.steps) {
    for (const gate of level.gates.values()) {
      session.queueGate(gate.id, step.gates[gate.id] as GateState);
    }
    session.settle();
  }
  return session.toRecord();
}

test('replay: 首轮记录重放后逐回合数值、失败原因完全一致', () => {
  for (const index of [0, 1]) {
    const record = solvedRecord(index);
    const level = compileLevel(sampleLevels[index]!);
    const replay = replayRecord(level, record);
    assert.deepEqual(replay.turns, record.turns);
    assert.equal(replay.outcome, record.result.outcome);
    assert.deepEqual(replay.failure, record.result.failure);
  }
});

test('replay: JSON 往返后再解析，记录等价', () => {
  const record = solvedRecord(0);
  const restored = parseRecord(JSON.stringify(record));
  assert.deepEqual(restored, record);
});

test('replay: 加载另一关卡的记录时明确拒绝', () => {
  const recordOfLevelOne = solvedRecord(0);
  const levelTwoCompiled = compileLevel(levelTwo);
  assert.throws(
    () => replayRecord(levelTwoCompiled, recordOfLevelOne),
    (error: unknown) => {
      assert.ok(error instanceof RecordRejectedError);
      assert.match(error.message, /记录属于关卡 level-01-contention/);
      assert.match(error.message, /当前关卡是 level-02-brim/);
      return true;
    },
  );
});

test('replay: 同名但内容被改过的关卡拒绝加载记录', () => {
  const record = solvedRecord(0);
  const tamperedSpec = {
    ...levelOne,
    edges: levelOne.edges.map((edge) =>
      edge.id === 'basin-target' ? { ...edge, capacity: edge.capacity + 1 } : edge),
  };
  assert.throws(() => replayRecord(compileLevel(tamperedSpec), record), /指纹不符/);
});

test('replay: 若只改绘制坐标，关卡仍接受原记录（指纹只看结算内容）', () => {
  const record = solvedRecord(0);
  const movedSpec = {
    ...levelOne,
    pools: levelOne.pools.map((pool) => ({
      ...pool,
      layout: { ...pool.layout, x: pool.layout.x + 10 },
    })),
  };
  const replay = replayRecord(compileLevel(movedSpec), record);
  assert.deepEqual(replay.turns, record.turns);
});

test('replay: 记录里被篡改的水位会被拒绝，并指出回合与池子', () => {
  const record = solvedRecord(0);
  const tampered: DrillRecord = structuredClone(record);
  const first = tampered.turns[0]!;
  const targetKey = Object.keys(first.pools)[0]!;
  (first.pools as Record<string, number>)[targetKey] = ((first.pools[targetKey] as number) + 1);
  assert.throws(
    () => replayRecord(compileLevel(levelOne), tampered),
    /pools\.\w+ 记录为|键集合|不一致/,
  );
});

test('replay: 记录里被篡改的最终结果会被拒绝', () => {
  const record = solvedRecord(0);
  const tampered: DrillRecord = structuredClone(record);
  (tampered as { result: { outcome: string } }).result.outcome = 'lost';
  assert.throws(() => replayRecord(compileLevel(levelOne), tampered), /最终结果/);
});

test('replay: 记录声明的失败原因与复核不一致时拒绝', () => {
  const record = solvedRecord(0);
  const tampered: DrillRecord = structuredClone(record);
  (tampered as { result: { failure: unknown } }).result.failure = {
    code: 'turn-limit', goalPoolId: 'target', achieved: 0, required: 18,
  };
  assert.throws(() => replayRecord(compileLevel(levelOne), tampered), /最终结果/);
});

test('replay: 回合数超过关卡上限、回合号不连续、未知闸门都拒绝', () => {
  // 关卡一上限 3 回合；把记录补到 4 条触发“超过上限”。
  const record = solvedRecord(0);
  const duplicated = structuredClone(record) as DrillRecord;
  const extra = structuredClone(duplicated.turns.at(-1)!) as TurnRecord;
  (extra as { turn: number }).turn = duplicated.turns.length + 1;
  const overLimit: DrillRecord = { ...duplicated, turns: [...duplicated.turns, extra] };
  assert.throws(() => replayRecord(compileLevel(levelOne), overLimit), /超过关卡上限/);

  const outOfOrder: DrillRecord = structuredClone(record);
  (outOfOrder.turns[1] as { turn: number }).turn = 5;
  assert.throws(() => replayRecord(compileLevel(levelOne), outOfOrder), /回合号应为/);

  const unknownGate: DrillRecord = structuredClone(record);
  (unknownGate.turns[0]!.gates as Record<string, GateState>)['ZZ'] = 'open';
  assert.throws(() => replayRecord(compileLevel(levelOne), unknownGate), /不存在的闸门/);
});

test('replay: 非法 JSON、错误 schema、缺字段都被拒绝', () => {
  assert.throws(() => parseRecord('{'), /合法 JSON/);
  assert.throws(() => parseRecord('{"schema":"other"}'), /schema/);
  assert.throws(() => parseRecord('{"schema":"waterway-drill/record@1"}'), /levelId/);
});

test('replay: 失败局的记录也逐回合复现同样的失败原因与数值', () => {
  // 手动构造一个“全开闸门、最终淹掉检修格”的失败首轮。
  const level = compileLevel(levelOne);
  const session = new DrillSession(level);
  for (const gate of level.gates.values()) session.queueGate(gate.id, 'open');
  while (session.view().outcome === 'playing' && session.turnsRemaining > 0) {
    const result = session.settle();
    if (result.outcome !== 'playing') break;
    for (const gate of level.gates.values()) session.queueGate(gate.id, 'open');
  }
  const record = session.toRecord();
  assert.equal(record.result.outcome, 'lost');

  const replay = replayRecord(level, record);
  assert.equal(replay.outcome, 'lost');
  assert.deepEqual(replay.failure, record.result.failure);
  assert.deepEqual(replay.turns, record.turns);
});
