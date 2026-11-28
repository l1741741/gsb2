import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPlan } from '../src/model.js';

const demoPath = fileURLToPath(new URL('../demo/data/demo.json', import.meta.url));

function demoData() {
  return JSON.parse(readFileSync(demoPath, 'utf8'));
}

test('示范数据载入：断开链路的两处错误都指出楼层与节点', () => {
  const { plan, errors } = loadPlan(demoData());
  assert.equal(plan.routes.length, 4);
  assert.equal(errors.length, 2);

  const missing = errors.find((e) => e.node === 'N-404');
  assert.ok(missing, '应报告缺失节点 N-404');
  assert.equal(missing.floor, 'F2');
  assert.equal(missing.route, 'R4');
  assert.match(missing.message, /F2/);
  assert.match(missing.message, /N-404/);

  const broken = errors.find((e) => e.message.includes('链路断开'));
  assert.ok(broken, '应报告断开的链路');
  assert.equal(broken.route, 'R4');
  assert.equal(broken.floor, 'F1');
  assert.equal(broken.node, 'B1');
  assert.match(broken.message, /B1/);
  assert.match(broken.message, /S2-F2/);
});

test('引用不存在的楼层：错误指出路线与楼层', () => {
  const data = demoData();
  data.routes[0].legs[0].floor = 'F9';
  const { errors } = loadPlan(data);
  const e = errors.find((x) => x.floor === 'F9');
  assert.ok(e);
  assert.equal(e.route, 'R1');
  assert.match(e.message, /F9/);
});

test('节点楼层与分段楼层不符：错误同时指出两个楼层与节点', () => {
  const data = demoData();
  data.routes[2].legs[0].path = ['C1', 'B1', 'C2']; // C2 在 F2
  const { errors } = loadPlan(data);
  const e = errors.find((x) => x.node === 'C2');
  assert.ok(e);
  assert.equal(e.route, 'R3');
  assert.equal(e.floor, 'F1');
  assert.match(e.message, /F2/);
});

test('楼梯落脚节点登记楼层与实际不符时报错', () => {
  const data = demoData();
  data.stairs[0].landings[1].floor = 'F1'; // S1-F2 实际在 F2
  const { errors } = loadPlan(data);
  const e = errors.find((x) => x.node === 'S1-F2');
  assert.ok(e);
  assert.match(e.message, /ST1/);
});

test('schema 缺失会报告但不阻断建模', () => {
  const data = demoData();
  delete data.schema;
  const { plan, errors } = loadPlan(data);
  assert.ok(errors.some((e) => e.message.includes('schema')));
  assert.equal(plan.routes.length, 4);
});
