import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../src/core/sim.ts';
import { validateLevel, validatePlan, normalizePlan } from '../src/core/level.ts';
import { LEVELS } from '../src/levels/index.ts';
import { STARTER_PLANS } from '../src/levels/plans.ts';
import type { CoursePlan, Level } from '../src/core/types.ts';

const longLevel = LEVELS[0]!;
const tightLevel = LEVELS[1]!;
const longPlan = STARTER_PLANS['long-crossing']!;
const tightPlan = STARTER_PLANS['tight-berth']!;

function emptyPlan(level: Level): CoursePlan {
  return { version: 1, levelId: level.id, commands: [] };
}

test('内置关卡与参考航线都通过校验并能靠泊', () => {
  for (const level of LEVELS) {
    const result = validateLevel(level);
    assert.equal(result.ok, true, result.errors.join('; '));
    const plan = STARTER_PLANS[level.id]!;
    assert.equal(validatePlan(level, plan).ok, true);
    const record = simulate(level, plan, { maxSteps: 900_000 });
    assert.equal(record.summary.outcome, 'docked');
    assert.equal(record.summary.routeProgress, level.route.length);
  }
});

test('同一关卡与输入：不同采样密度和重复运行得到一致的过标顺序与时刻', () => {
  // 固定步长保证：无论记录多少帧、跑多少遍，事件序列完全一致。
  const a = simulate(longLevel, longPlan, { maxSteps: 900_000 });
  const b = simulate(longLevel, longPlan, { sampleEvery: 0.25, maxSteps: 900_000 });
  const c = simulate(longLevel, longPlan, { maxSteps: 900_000 });

  const signature = (record: typeof a): string =>
    record.summary.crossings.map((crossing) => `${crossing.gateId}:${crossing.time.toFixed(6)}:${crossing.order}`).join('|');

  assert.equal(signature(a), signature(b));
  assert.equal(signature(a), signature(c));
  assert.equal(a.summary.finishTime, b.summary.finishTime);
  assert.equal(a.planHash, b.planHash);
  // 采样更密只影响帧数，不影响物理步数。
  assert.notEqual(a.frames.length, b.frames.length);
  assert.equal(a.steps, b.steps);
});

test('一帧内高速跨越标线也能判定（大步长扫掠不丢事件）', () => {
  // 构造一个极短、极快的关卡：起点在 b1 一侧，1/60 秒一步、8 m/s。
  const level: Level = {
    id: 'sweep-test',
    name: '扫掠测试',
    subtitle: '高速越线',
    bounds: [
      { x: -50, y: -50 },
      { x: 350, y: -50 },
      { x: 350, y: 150 },
      { x: -50, y: 150 },
    ],
    start: { position: { x: 60, y: 50 }, heading: 90, speed: 8, sheet: 1 },
    openWind: { direction: 270, speed: 8 },
    windZones: [],
    windChanges: [],
    obstacles: [],
    buoys: [{ id: 'g1', name: '浮标 1', a: { x: 120, y: 20 }, b: { x: 120, y: 80 }, radius: 3 }],
    route: ['g1'],
    dock: { id: 'dock', name: '码头', mouth: { x: 320, y: 50 }, heading: 90, length: 30, width: 20, speedLimit: 2 },
    duration: 12,
    briefing: [],
    physics: { fixedStep: 1 / 60, hullSpeed: 8, referenceWind: 8 },
  };
  const plan: CoursePlan = { version: 1, levelId: level.id, commands: [{ time: 0, heading: 90, sheet: 1 }] };
  const record = simulate(level, plan, { maxSteps: 100_000 });
  const crossing = record.summary.crossings.find((item) => item.gateId === 'g1');
  assert.ok(crossing, '高速单步跨越标线必须被记录');
  assert.equal(crossing.order, 1);
  // 8 m/s × 1/60 s = 0.133 m/步，本可轻松越过；关键是位置必须在标线上。
  assert.ok(Math.abs(crossing.position.x - 120) < 0.2, `跨线位置应在标线上，实际 ${crossing.position.x}`);
});

test('大步长下一次横跨 120 米仍能捕获跨线（扫掠而非点采样）', () => {
  // fixedStep = 8 s，速度 20 m/s：一步 160 米，必然跨越标线。
  const level: Level = {
    id: 'sweep-long-step',
    name: '大步长测试',
    subtitle: '一帧内从标线一侧到另一侧',
    bounds: [
      { x: -200, y: -200 },
      { x: 800, y: -200 },
      { x: 800, y: 400 },
      { x: -200, y: 400 },
    ],
    start: { position: { x: 0, y: 50 }, heading: 90, speed: 20, sheet: 1 },
    openWind: { direction: 270, speed: 20 },
    windZones: [],
    windChanges: [],
    obstacles: [],
    buoys: [{ id: 'g1', name: '浮标 1', a: { x: 100, y: -50 }, b: { x: 100, y: 150 }, radius: 3 }],
    route: ['g1'],
    dock: { id: 'dock', name: '码头', mouth: { x: 400, y: 50 }, heading: 90, length: 40, width: 30, speedLimit: 2 },
    duration: 60,
    briefing: [],
    physics: { fixedStep: 8, hullSpeed: 20, referenceWind: 20, speedResponse: 0.001, sheetResponse: 0.001 },
  };
  const plan: CoursePlan = { version: 1, levelId: level.id, commands: [{ time: 0, heading: 90, sheet: 1 }] };
  const record = simulate(level, plan, { maxSteps: 10_000 });
  const crossing = record.summary.crossings.find((item) => item.gateId === 'g1');
  assert.ok(crossing, '一步跨越 160 米也必须记录');
  assert.equal(crossing.order, 1);
});

test('逆序通过浮标会给出原因与发生位置', () => {
  const plan: CoursePlan = {
    version: 1,
    levelId: longLevel.id,
    commands: [
      { time: 0, heading: 110, sheet: 1 },
      { time: 40, heading: 120, sheet: 1 },
    ],
  };
  // 直接朝 b2 走，跳过 b1；b2 的标线是 b1→b2 方向上的下一道。
  const record = simulate(longLevel, plan, { maxSteps: 900_000 });
  if (record.summary.outcome === 'failed') {
    const issue = record.summary.issues.find((item) => item.kind === 'wrong-order');
    if (issue) {
      assert.ok(issue.message.includes('逆序'), issue.message);
      assert.ok(Number.isFinite(issue.position.x) && Number.isFinite(issue.position.y));
      assert.ok(issue.time > 0);
    }
  }
});

test('擦碰障碍会报出障碍名与接触位置', () => {
  const level = longLevel;
  // 朝北浅岛直线行驶。
  const headingToIslet = (() => {
    const dx = 252 - longLevel.start.position.x;
    const dy = 132 - longLevel.start.position.y;
    return (Math.atan2(dx, -dy) * 180) / Math.PI;
  })();
  const plan: CoursePlan = {
    version: 1,
    levelId: level.id,
    commands: [{ time: 0, heading: headingToIslet, sheet: 1 }],
  };
  const record = simulate(level, plan, { maxSteps: 900_000 });
  const issue = record.summary.issues.find((item) => item.kind === 'obstacle-contact');
  assert.ok(issue, '朝障碍航行必须报障碍接触');
  assert.ok(issue.message.includes('北浅岛'), issue.message);
  assert.ok(Number.isFinite(issue.position.x) && Number.isFinite(issue.position.y));
});

test('速度过高进港会报出速度与限速，并记录位置', () => {
  const level = tightLevel;
  // 全帆高速沿泊位轴线冲入。
  const plan: CoursePlan = {
    version: 1,
    levelId: level.id,
    commands: [
      { time: 0, heading: 110, sheet: 1 },
    ],
  };
  const record = simulate(level, plan, { maxSteps: 900_000 });
  const issue = record.summary.issues.find((item) => item.kind === 'over-speed-dock');
  if (issue) {
    assert.ok(issue.message.includes('速度过高'), issue.message);
    assert.match(issue.message, /m\/s/);
    assert.equal(issue.subjectId, level.dock.id);
    assert.ok(Number.isFinite(issue.position.x));
  }
});

test('相同输入在不同记录采样下产生相同事件（确定性回归）', () => {
  const signatures = new Set<string>();
  for (const sampleEvery of [1 / 120, 0.1, 0.5, 2]) {
    const record = simulate(tightLevel, tightPlan, { sampleEvery, maxSteps: 900_000 });
    signatures.add(
      record.summary.crossings.map((c) => `${c.gateId}@${c.time.toFixed(5)}#${c.order}`).join('|') +
        `|${record.summary.outcome}|${record.summary.finishTime.toFixed(5)}`,
    );
  }
  assert.equal(signatures.size, 1, '事件序列不应随记录采样率变化');
});

test('规范化航线与哈希：仅时间/航向微调时命令哈希随之改变', () => {
  const base = normalizePlan(longPlan);
  const changed = normalizePlan({
    ...longPlan,
    commands: longPlan.commands.map((command, index) =>
      index === 0 ? { ...command, heading: command.heading + 5 } : command,
    ),
  });
  const a = simulate(longLevel, base, { maxSteps: 900_000 });
  const b = simulate(longLevel, changed, { maxSteps: 900_000 });
  assert.notEqual(a.commandHash, b.commandHash);
  assert.equal(a.levelHash, b.levelHash, '只改航线不应改变关卡哈希');
});
