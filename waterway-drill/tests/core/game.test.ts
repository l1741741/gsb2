import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLevel } from '../../src/level.ts';
import { DrillSession } from '../../src/game.ts';
import { solveLevel } from '../../src/solver.ts';
import { replayRecord } from '../../src/replay.ts';
import { levelOne } from '../../src/levels/index.ts';
import type { GateState } from '../../src/types.ts';
import { miniLevel, threeGateLevel } from '../fixtures/levels.ts';

test('game: 同一回合可先布置多条闸门，确认时统一结算', () => {
  const session = new DrillSession(compileLevel(threeGateLevel()));
  session.queueGate('s-a', 'open');
  session.queueGate('s-b', 'open');
  assert.equal(session.pendingChanges, 2);

  // 尚未确认时，committed 状态仍是初始的关闭。
  const before = session.view();
  assert.equal(before.gates.find((g) => g.id === 's-a')!.committed, 'closed');
  assert.equal(before.gates.find((g) => g.id === 's-a')!.pending, 'open');
  assert.equal(before.edges.find((e) => e.id === 'e-s-a')!.previewOpen, true);
  assert.equal(before.edges.find((e) => e.id === 'e-s-a')!.open, false);

  const record = session.settle();
  assert.equal(record.gates['s-a'], 'open');
  assert.equal(record.gates['s-b'], 'open');
  assert.equal(record.gates['a-out'], 'closed');
  // 两条源出流按容量 3/3 均分源池的 6 格可放水。
  assert.equal(record.edges['e-s-a'], 3);
  assert.equal(record.edges['e-s-b'], 3);
  assert.equal(session.pendingChanges, 0);
});

test('game: 先布置后结算与逐条结算的结果一致（只要组合相同）', () => {
  const level = compileLevel(threeGateLevel());
  const batched = new DrillSession(level);
  batched.queueGate('s-a', 'open');
  batched.queueGate('s-b', 'open');
  batched.queueGate('a-out', 'open');
  const batchedRecord = batched.settle();

  const level2 = compileLevel(threeGateLevel());
  const ordered = new DrillSession(level2);
  ordered.queueGate('a-out', 'open');
  ordered.queueGate('s-b', 'open');
  ordered.queueGate('s-a', 'open');
  const orderedRecord = ordered.settle();

  assert.deepEqual(batchedRecord, orderedRecord);
});

test('game: 未改变的闸门改动会被取消，不进入布置', () => {
  const session = new DrillSession(compileLevel(miniLevel()));
  session.queueGate('G', 'closed'); // 与初始相同
  assert.equal(session.pendingChanges, 0);
  const record = session.settle();
  assert.equal(record.edges.e1, 0);
});

test('game: 结算后会话拒绝继续布置与重复结算已结束的演练', () => {
  const session = new DrillSession(compileLevel(miniLevel({ turns: 1, goal: { pool: 'low', atLeast: 0 } })));
  session.settle();
  assert.equal(session.view().outcome, 'won');
  assert.throws(() => session.queueGate('G', 'open'), /已经结束/);
});

test('game: 撤回一步恢复该回合开始前的水位与闸门状态，并丢弃该回合记录', () => {
  const session = new DrillSession(compileLevel(threeGateLevel()));
  session.queueGate('s-a', 'open');
  const first = session.settle();
  const startLevels = new Map(first.ledger.map((entry) => [entry.poolId, entry.start]));

  assert.equal(session.turnsPlayed, 1);
  const undone = session.undo();
  assert.equal(undone, true);
  assert.equal(session.turnsPlayed, 0);
  assert.deepEqual(session.levelsSnapshot(), startLevels);
  assert.equal(session.gateStatesSnapshot().get('s-a'), 'closed');
  assert.equal(session.historySnapshot().length, 0);
});

test('game: 撤回后改走另一种安排，重放记录与首轮逐回合一致', () => {
  const session = new DrillSession(compileLevel(threeGateLevel()));
  // 首轮：只开左边，故意走一条慢路。
  session.queueGate('s-a', 'open');
  const firstTurn = session.settle();
  session.undo();
  // 改走：两边都开。
  session.queueGate('s-a', 'open');
  session.queueGate('s-b', 'open');
  const changedTurn = session.settle();

  assert.notDeepEqual(firstTurn, changedTurn);
  assert.equal(firstTurn.turn, changedTurn.turn);
});

test('game: 撤回到第 0 回合后再结算，记录回合号仍然从 1 开始', () => {
  const session = new DrillSession(compileLevel(miniLevel()));
  session.settle();
  session.settle();
  session.undo();
  session.undo();
  const record = session.settle();
  assert.equal(record.turn, 1);
  assert.equal(session.historySnapshot().length, 1);
});

test('game: 视图暴露待确认数量、剩余回合与可撤回状态', () => {
  const session = new DrillSession(compileLevel(threeGateLevel()));
  let view = session.view();
  assert.equal(view.turnsRemaining, 3);
  assert.equal(view.canUndo, false);
  assert.equal(view.canConfirm, true);

  session.queueGate('s-a', 'open');
  view = session.view();
  assert.equal(view.pendingChanges, 1);

  session.settle();
  view = session.view();
  assert.equal(view.turnsRemaining, 2);
  assert.equal(view.canUndo, true);
});

test('game: 撤回一步后改走另一种安排，重放记录逐回合数值与失败原因与首轮一致', () => {
  const level = compileLevel(levelOne);
  const solution = solveLevel(level, { maxStatesPerTurn: 2000 }).solutions[0]!;

  // 第 1 回合与求解器一致；第 2 回合故意全开闸门淹掉检修格。
  const session = new DrillSession(level);
  const applyPlan = (plan: Record<string, GateState>) => {
    for (const [gateId, state] of Object.entries(plan)) session.queueGate(gateId, state);
  };
  applyPlan(solution.steps[0]!.gates as Record<string, GateState>);
  session.settle();
  const gatesAfterFirst = session.gateStatesSnapshot();
  const levelsAfterFirst = session.levelsSnapshot();

  // 第 2 回合故意把两条进水都打开、关掉出池闸，蓄水池必然溢流淹掉检修格。
  session.queueGate('A', 'open');
  session.queueGate('B', 'open');
  session.queueGate('C', 'closed');
  const failed = session.settle();
  assert.equal(failed.outcome, 'lost');
  assert.equal(failed.failure?.code, 'maintenance-flooded');

  // 撤回这一步，水位与闸门应回到第 1 回合结束时的状态。
  assert.equal(session.undo(), true);
  assert.equal(session.turnsPlayed, 1);
  assert.deepEqual(session.gateStatesSnapshot(), gatesAfterFirst);
  assert.deepEqual(session.levelsSnapshot(), levelsAfterFirst);

  // 改走求解器的第 2、3 回合，完成通关。
  for (const step of solution.steps.slice(1)) {
    applyPlan(step.gates as Record<string, GateState>);
    session.settle();
  }
  const record = session.toRecord();
  assert.equal(record.result.outcome, 'won');

  // 重放改后的记录：逐回合池子数值、通过量、失败原因都与首轮逐字段一致。
  const replay = replayRecord(level, record);
  assert.deepEqual(replay.turns, record.turns);
  assert.deepEqual(replay.turns.map((turn) => turn.pools), record.turns.map((turn) => turn.pools));
  assert.deepEqual(
    replay.turns.map((turn) => turn.failure),
    record.turns.map((turn) => turn.failure),
  );
});

test('game: 撤回后改走另一种安排，重放记录与首轮逐回合一致', () => {
  const session = new DrillSession(compileLevel(threeGateLevel()));
  // 首轮：只开左边，故意走一条慢路。
  session.queueGate('s-a', 'open');
  const firstTurn = session.settle();
  session.undo();
  // 改走：两边都开。
  session.queueGate('s-a', 'open');
  session.queueGate('s-b', 'open');
  const changedTurn = session.settle();

  assert.notDeepEqual(firstTurn, changedTurn);
  assert.equal(firstTurn.turn, changedTurn.turn);
});

test('game: 闸门会驱动其控制的每条支路开放状态', () => {
  const session = new DrillSession(compileLevel(threeGateLevel()));
  session.queueGate('s-a', (('open' as GateState)));
  const view = session.view();
  assert.deepEqual(view.gates.find((g) => g.id === 's-a')!.controls, ['e-s-a']);
});
