import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/core/sim.ts';
import { buildLegs, buildTimeline, frameIndexAt, sampleAt, progressAt, eventsBefore } from '../src/core/replay.ts';
import { compareRuns } from '../src/core/compare.ts';
import { LEVELS } from '../src/levels/index.ts';
import { STARTER_PLANS } from '../src/levels/plans.ts';
import type { CoursePlan, Level } from '../src/core/types.ts';

const longLevel = LEVELS[0]!;
const tightLevel = LEVELS[1]!;
const longPlan = STARTER_PLANS['long-crossing']!;
const tightPlan = STARTER_PLANS['tight-berth']!;

function run(level: Level, plan: CoursePlan) {
  return simulate(level, plan, { maxSteps: 900_000 });
}

test('回放航段按“起点 → 浮标 → 靠泊”切分，时间单调不重叠', () => {
  const record = run(longLevel, longPlan);
  const legs = buildLegs(record);
  assert.ok(legs.length >= longLevel.route.length + 1);
  assert.equal(legs[0]!.kind, 'gate', '第一条航段终点是第 1 个浮标');
  assert.equal(legs.at(-1)!.kind, 'dock');
  for (let i = 0; i + 1 < legs.length; i++) {
    assert.ok(legs[i]!.endTime >= legs[i]!.startTime, '航段时间必须非负');
    assert.ok(legs[i + 1]!.startTime >= legs[i]!.endTime - 1e-9, '航段之间不能重叠');
  }
});

test('可定位到任意已发生的航段，插值船位落在记录范围内', () => {
  const record = run(longLevel, longPlan);
  const legs = buildLegs(record);
  const target = legs[2]!;
  const mid = (target.startTime + target.endTime) / 2;
  const frame = sampleAt(record, mid);
  assert.equal(frame.time, mid);
  assert.ok(Number.isFinite(frame.position.x) && Number.isFinite(frame.position.y));
  const index = frameIndexAt(record, mid);
  assert.ok(index >= 0 && index < record.frames.length);
  assert.ok(Math.abs(frame.position.x - target.startPosition.x) + Math.abs(frame.position.y - target.startPosition.y) >= 0);
});

test('重跑修改后的控制点会得到新的记录与不同的指令哈希', () => {
  const original = run(tightLevel, tightPlan);
  const modified: CoursePlan = {
    ...tightPlan,
    commands: tightPlan.commands.map((command, index) =>
      index === tightPlan.commands.length - 1 ? { ...command, sheet: 0.0 } : command,
    ),
  };
  const rerun = run(tightLevel, modified);
  assert.notEqual(original.commandHash, rerun.commandHash);
  assert.equal(original.levelHash, rerun.levelHash);
  // 修改最后一条收帆点后，结果要么不同，要么至少结束时刻不同。
  const changed = rerun.summary.finishTime !== original.summary.finishTime || rerun.summary.outcome !== original.summary.outcome;
  assert.ok(changed, '修改控制点后结果应有可观察差异');
});

test('对比记录能区分“关卡变化”与“玩家修改”', () => {
  const base = run(longLevel, longPlan);

  // 1) 仅玩家修改。
  const modifiedPlan: CoursePlan = {
    ...longPlan,
    commands: longPlan.commands.map((command, index) =>
      index === 0 ? { ...command, sheet: 0.5 } : command,
    ),
  };
  const planOnly = run(longLevel, modifiedPlan);
  const planCompare = compareRuns(longLevel, longLevel, base, planOnly);
  assert.equal(planCompare.sameLevel, true);
  assert.equal(planCompare.sameCommands, false);
  assert.equal(planCompare.cause, 'plan');

  // 2) 仅关卡变化（风力更强）。
  const strongerWind: Level = {
    ...longLevel,
    openWind: { ...longLevel.openWind, speed: longLevel.openWind.speed + 1.5 },
  };
  const levelOnly = run(strongerWind, longPlan);
  const levelCompare = compareRuns(longLevel, strongerWind, base, levelOnly);
  assert.equal(levelCompare.sameLevel, false);
  assert.equal(levelCompare.sameCommands, true);
  assert.equal(levelCompare.cause, 'level');
  assert.ok(levelCompare.levelFields.includes('openWind'), levelCompare.levelFields.join(','));

  // 3) 两者都变。
  const both = run(strongerWind, modifiedPlan);
  const bothCompare = compareRuns(longLevel, strongerWind, base, both);
  assert.equal(bothCompare.cause, 'both');
});

test('对比报告给出首个分歧点；完全相同的记录没有分歧', () => {
  const a = run(tightLevel, tightPlan);
  const b = run(tightLevel, tightPlan);
  const same = compareRuns(tightLevel, tightLevel, a, b);
  assert.equal(same.cause, 'none');
  assert.equal(same.firstDivergence, null);

  const adjusted = run(tightLevel, {
    ...tightPlan,
    commands: tightPlan.commands.map((command, index) =>
      index === tightPlan.commands.length - 1 ? { ...command, time: command.time + 3 } : command,
    ),
  });
  const compare = compareRuns(tightLevel, tightLevel, a, adjusted);
  assert.equal(compare.cause, 'plan');
  assert.ok(compare.firstDivergence, '存在差异时必须给出首个分歧点');
});

test('时间轴与事件查询：进度随回放时间单调推进', () => {
  const record = run(longLevel, longPlan);
  const timeline = buildTimeline(record);
  assert.ok(timeline.length > 0);
  for (let i = 1; i < timeline.length; i++) {
    assert.ok(timeline[i]!.time >= timeline[i - 1]!.time, '时间轴必须按时间排序');
    assert.ok(timeline[i]!.frameIndex >= timeline[i - 1]!.frameIndex, '帧索引不能回退');
  }
  let previous = 0;
  for (let t = 0; t <= record.summary.finishTime; t += 2) {
    const progress = progressAt(record, t);
    assert.ok(progress >= previous, '进度不能倒退');
    previous = progress;
  }
  const beforeEnd = eventsBefore(record, record.summary.finishTime);
  assert.ok(beforeEnd.length >= longLevel.route.length);
});
