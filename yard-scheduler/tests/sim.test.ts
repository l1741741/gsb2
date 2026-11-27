import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from '../src/sim.js';
import { BASIC, ALLEY } from '../src/scenarios.js';
import {
  Edit, applyEdit, validateEdit, replay, serialize, parseSave, deepCopyPlan,
} from '../src/persistence.js';
import { Plan } from '../src/model.js';

function runBasic() {
  const sim = new Sim(BASIC.map, deepCopyPlan(BASIC.initialPlan));
  sim.runToEnd();
  return sim;
}

/** JSON 归一化(去掉 undefined 字段),用于跨快照比较。 */
const norm = (x: unknown) => JSON.parse(JSON.stringify(x));

test('基础场景:默认计划全部按时送达', () => {
  const sim = runBasic();
  assert.equal(sim.status, 'success');
  assert.equal(sim.conflicts.length, 0);
  const delivered = Object.fromEntries(
    sim.events.filter((e) => e.kind === 'delivered').map((e) => [e.vehicle, e.tick]),
  );
  // 三个交付时隙由结算规则唯一确定,钉住以防回归
  assert.deepEqual(delivered, { V1: 13, V2: 24, V3: 19 });
  for (const t of Object.values(delivered)) assert.ok(t <= BASIC.map.deadline);
});

test('边界一致:占用区间半开,月台车位首尾相接不冲突', () => {
  const sim = runBasic();
  const dock1 = sim.dockOcc['dock1']!;
  assert.equal(dock1.length, 2);
  const [a, b] = dock1;
  // V1 [7,13),V3 从 13 开始 —— 结束即起点,不算冲突
  assert.deepEqual([a!.start, a!.end], [7, 13]);
  assert.equal(b!.start, 13);
  // 任意两条月台占用不重叠
  for (const x of dock1) for (const y of dock1) {
    if (x !== y) assert.ok(x.end <= y.start || y.end <= x.start, '月台占用重叠');
  }
});

test('窄路段从不出现重叠占用(含对向)', () => {
  for (const sc of [BASIC, ALLEY]) {
    const plan = deepCopyPlan(sc.initialPlan);
    if (sc.id === 'alley') plan['V2']!.depart = 12; // 用可通过的计划
    const sim = new Sim(sc.map, plan);
    sim.runToEnd();
    for (const e of sc.map.edges.filter((e) => e.narrow)) {
      const occ = sim.edgeOcc[e.id]!;
      for (const x of occ) for (const y of occ) {
        if (x === y) continue;
        const xe = x.exit ?? Infinity;
        const ye = y.exit ?? Infinity;
        assert.ok(xe <= y.enter || ye <= x.enter, `${e.id} 上 ${x.vehicle} 与 ${y.vehicle} 占用重叠`);
      }
    }
  }
});

test('窄巷场景:默认计划在 t=8 死锁,冲突定位到车辆与路段', () => {
  const sim = new Sim(ALLEY.map, deepCopyPlan(ALLEY.initialPlan));
  sim.runToEnd();
  assert.equal(sim.status, 'deadlock');
  assert.equal(sim.conflicts.length, 1);
  const c = sim.conflicts[0]!;
  assert.equal(c.kind, 'deadlock');
  assert.equal(c.tick, 8);
  assert.deepEqual([...c.vehicles].sort(), ['V1', 'V2']);
  assert.deepEqual([...c.location].sort(), ['e1', 'e2']);
  // 死锁时两车分别滞留在两段窄巷上
  assert.equal(sim.states['V1']!.edge, 'e1');
  assert.equal(sim.states['V2']!.edge, 'e2');
});

test('窄巷场景:错开起步时隙后可通过', () => {
  const plan = deepCopyPlan(ALLEY.initialPlan);
  plan['V2']!.depart = 12;
  const sim = new Sim(ALLEY.map, plan);
  sim.runToEnd();
  assert.equal(sim.status, 'success');
  const delivered = sim.events.filter((e) => e.kind === 'delivered');
  assert.equal(delivered.length, 2);
  for (const e of delivered) assert.ok(e.tick <= ALLEY.map.deadline);
});

test('确定性:同一计划重复模拟,事件序列完全一致', () => {
  const a = runBasic();
  const b = runBasic();
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.edgeOcc, b.edgeOcc);
  assert.deepEqual(a.dockOcc, b.dockOcc);
});

test('快照/恢复与连续运行结果一致(显示速度无关性的核心)', () => {
  // 连续跑到结束
  const whole = runBasic();
  // 先跑 10 个时隙,快照,恢复,再跑到结束
  const part = new Sim(BASIC.map, deepCopyPlan(BASIC.initialPlan));
  part.run(10);
  const restored = Sim.restore(BASIC.map, part.plan, part.snapshot());
  restored.runToEnd();
  assert.deepEqual(norm(restored.events), norm(whole.events));
  assert.deepEqual(norm(restored.edgeOcc), norm(whole.edgeOcc));
  assert.deepEqual(norm(restored.dockOcc), norm(whole.dockOcc));
  assert.equal(restored.status, whole.status);
});

test('编辑规则:已起步不能改起步时隙,已走过的路段不能改写', () => {
  const plan = deepCopyPlan(BASIC.initialPlan);
  const sim = new Sim(BASIC.map, plan);
  // t=0:未起步车辆的起步时隙必须大于当前时隙
  assert.match(validateEdit(sim, 'V2', { tick: 0, vehicle: 'V2', depart: 0 })!, /大于当前时隙/);
  assert.equal(validateEdit(sim, 'V2', { tick: 0, vehicle: 'V2', depart: 5 }), null);
  sim.run(6); // V1 已起步,正在 eJ1D1 上(已走过 eAB)
  assert.equal(sim.states['V1']!.phase, 'onEdge');
  // 改起步时隙:拒绝
  assert.match(validateEdit(sim, 'V1', { tick: 6, vehicle: 'V1', depart: 20 })!, /已起步/);
  // 改写已走过的前缀:拒绝(防瞬移)
  assert.match(
    validateEdit(sim, 'V1', { tick: 6, vehicle: 'V1', route: ['eJ1J2', 'eJ2D2'] })!,
    /不能改写/,
  );
});

test('编辑规则:已送达车辆完全冻结(防货物重复送达)', () => {
  const plan = deepCopyPlan(BASIC.initialPlan);
  const sim = new Sim(BASIC.map, plan);
  sim.run(14); // V1 已于 t=13 送达
  assert.equal(sim.states['V1']!.phase, 'delivered');
  assert.match(validateEdit(sim, 'V1', { tick: 14, vehicle: 'V1', route: ['eAB', 'eJ1D1'] })!, /已送达/);
  assert.match(validateEdit(sim, 'V1', { tick: 14, vehicle: 'V1', depart: 30 })!, /已送达/);
});

test('重放:存档载入后重现同一过程', () => {
  // 现场:在 t=0 把 V3 起步推迟到 8,再跑到结束
  const plan = deepCopyPlan(BASIC.initialPlan);
  const sim = new Sim(BASIC.map, plan);
  const edits: Edit[] = [];
  const edit: Edit = { tick: 0, vehicle: 'V3', depart: 8 };
  assert.equal(validateEdit(sim, 'V3', edit), null);
  edits.push(edit);
  applyEdit(plan, edit);
  sim.runToEnd();
  assert.equal(sim.status, 'success');

  // 存档 → 重放
  const save = parseSave(serialize(BASIC.map, BASIC.initialPlan, edits, sim.tick));
  const { sim: replayed } = replay(save.map, save.initialPlan, save.edits, save.tick);
  assert.deepEqual(norm(replayed.events), norm(sim.events));
  assert.equal(replayed.status, sim.status);
});

test('回退后修改再跑:窄巷死锁 → 回退 → 推迟 V2 → 成功', () => {
  const plan = deepCopyPlan(ALLEY.initialPlan);
  const edits: Edit[] = [];
  const sim = new Sim(ALLEY.map, plan);
  sim.runToEnd();
  assert.equal(sim.status, 'deadlock');
  const conflictTick = sim.conflicts[0]!.tick; // 8

  // 回退到冲突发生前(t=0),推迟 V2 起步
  const { sim: rewound, plan: plan2 } = replay(ALLEY.map, ALLEY.initialPlan, edits, 0);
  assert.equal(rewound.tick, 0);
  const edit: Edit = { tick: 0, vehicle: 'V2', depart: 12 };
  assert.equal(validateEdit(rewound, 'V2', edit), null);
  edits.push(edit);
  applyEdit(plan2, edit);
  rewound.runToEnd();
  assert.equal(rewound.status, 'success');
  assert.ok(conflictTick > 0);
});

test('超时:安排不当会在截止时隙报告超时并定位车辆', () => {
  const plan: Plan = deepCopyPlan(ALLEY.initialPlan);
  plan['V2']!.depart = 100; // 太晚,必定超过 deadline=40
  const sim = new Sim(ALLEY.map, plan);
  sim.runToEnd();
  assert.equal(sim.status, 'deadline');
  const c = sim.conflicts.find((c) => c.kind === 'deadline')!;
  assert.deepEqual(c.vehicles, ['V2']);
  assert.ok(c.location.length === 1);
});

test('月台争抢:两车同目的地,后到者等待,车位不重叠', () => {
  // V1、V3 都去 dock1(车位 1)
  const sim = runBasic();
  const dock1 = sim.dockOcc['dock1']!;
  assert.equal(dock1.length, 2);
  assert.deepEqual(dock1.map((o) => o.vehicle), ['V1', 'V3']);
  // V3 有过等待记录,且等待发生在 V1 卸货期间
  const waits = sim.events.filter((e) => e.kind === 'wait-start' && e.vehicle === 'V3');
  assert.ok(waits.length > 0);
});
