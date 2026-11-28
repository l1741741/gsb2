import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPlan } from '../src/model.js';
import { buildFloorLayout, STYLE } from '../src/layout.js';

const demoPath = fileURLToPath(new URL('../demo/data/demo.json', import.meta.url));

function demoPlan() {
  return loadPlan(JSON.parse(readFileSync(demoPath, 'utf8'))).plan;
}

test('共用边 B1-C1：三条车道（R1、R2 同向 + R3 反向），偏移对称且不重叠', () => {
  const plan = demoPlan();
  const layout = buildFloorLayout(plan, 'F1', 1);
  const edge = layout.edges.get('B1|C1');
  assert.ok(edge, 'B1-C1 应被引用');
  assert.equal(edge.sortedLanes.length, 3);

  // 可复现的排布顺序：按 (路线id, 方向) 排序
  assert.deepEqual(
    edge.sortedLanes.map((l) => `${l.routeId}:${l.dir}`),
    ['R1:1', 'R2:1', 'R3:-1'],
  );
  // 车道间距恒定、以走廊为中心对称
  const offsets = edge.sortedLanes.map((l) => l.offset);
  assert.deepEqual(offsets, [-STYLE.lane, 0, STYLE.lane]);
});

test('车道分配与 JSON 中路线顺序无关（可复现）', () => {
  const data1 = JSON.parse(readFileSync(demoPath, 'utf8'));
  const data2 = JSON.parse(readFileSync(demoPath, 'utf8'));
  data2.routes.reverse();
  const l1 = buildFloorLayout(loadPlan(data1).plan, 'F1', 1);
  const l2 = buildFloorLayout(loadPlan(data2).plan, 'F1', 1);
  const lanes1 = l1.edges.get('B1|C1').sortedLanes.map((l) => `${l.routeId}|${l.dir}|${l.offset}`);
  const lanes2 = l2.edges.get('B1|C1').sortedLanes.map((l) => `${l.routeId}|${l.dir}|${l.offset}`);
  assert.deepEqual(lanes1, lanes2);
});

test('反向共用：R1 与 R3 在 B1-C1 上箭头方向相反', () => {
  const plan = demoPlan();
  const layout = buildFloorLayout(plan, 'F1', 1);
  const arrowOf = (routeId) => layout.routePaths
    .find((p) => p.routeId === routeId)
    .arrows.find((a) => a.edge && a.edge.split('|').sort().join('|') === 'B1|C1');
  const a1 = arrowOf('R1');
  const a3 = arrowOf('R3');
  assert.ok(a1 && a3);
  const diff = Math.abs(a1.angle - a3.angle);
  assert.ok(Math.abs(diff - Math.PI) < 1e-9, `反向箭头夹角应为 π，实际 ${diff}`);
});

test('断开的路线：含缺失节点的段不绘制，其余段仍绘制', () => {
  const plan = demoPlan();
  const f2 = buildFloorLayout(plan, 'F2', 1);
  assert.ok(!f2.routePaths.some((p) => p.routeId === 'R4'), 'R4 的 F2 段引用了 N-404，不应绘制');
  const f1 = buildFloorLayout(plan, 'F1', 1);
  assert.ok(f1.routePaths.some((p) => p.routeId === 'R4'), 'R4 的 F1 段完好，应照常绘制');
});

test('楼梯符号：编号与方向对应原数据 level', () => {
  const plan = demoPlan();
  const f1 = buildFloorLayout(plan, 'F1', 1);
  const st1 = f1.stairs.find((s) => s.stair.id === 'ST1');
  assert.equal(st1.stair.flight, '1#');
  assert.equal(st1.transition.direction, 'up');
  assert.equal(st1.transition.to.id, 'F2');
  const f2 = buildFloorLayout(plan, 'F2', 1);
  const st1b = f2.stairs.find((s) => s.stair.id === 'ST1');
  assert.equal(st1b.transition.direction, 'down');
  assert.equal(st1b.transition.to.id, 'F1');
});

test('跨层延续标记：F1 标"续 → 二层"，F2 标"← 接 一层"', () => {
  const plan = demoPlan();
  const f1 = buildFloorLayout(plan, 'F1', 1);
  const f2 = buildFloorLayout(plan, 'F2', 1);
  const cont1 = f1.continuations.filter((c) => c.routeId === 'R1');
  assert.equal(cont1.length, 1);
  assert.equal(cont1[0].kind, 'to');
  assert.match(cont1[0].text, /续 → 二层/);
  const cont2 = f2.continuations.filter((c) => c.routeId === 'R1');
  assert.equal(cont2.length, 1);
  assert.equal(cont2[0].kind, 'from');
  assert.match(cont2[0].text, /← 接 一层/);
});

test('缩放只改变装饰尺寸的世界换算，车道屏幕间距恒定', () => {
  const plan = demoPlan();
  const l1 = buildFloorLayout(plan, 'F1', 1);
  const l2 = buildFloorLayout(plan, 'F1', 2);
  const o1 = l1.edges.get('B1|C1').sortedLanes.map((l) => l.offset);
  const o2 = l2.edges.get('B1|C1').sortedLanes.map((l) => l.offset);
  // 世界单位偏移随 1/scale 缩小，乘回 scale 后屏幕间距不变
  assert.deepEqual(o2.map((o) => o * 2), o1);
});
