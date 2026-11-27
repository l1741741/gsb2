import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveTwoBone } from '../src/ik.js';
import { dist } from '../src/math.js';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('可达目标：末端精确落在目标上，偏差为 0', () => {
  const sol = solveTwoBone({ x: 0, y: 0 }, 0, 30, 28, { x: 40, y: 20 }, 1);
  assert.ok(sol.reachable);
  close(sol.deviation, 0);
  close(dist(sol.end, { x: 40, y: 20 }), 0);
});

test('不可达目标：末端停在可达边界，不拉长骨骼，偏差 = 距离 - 臂展', () => {
  const target = { x: 100, y: 0 };
  const sol = solveTwoBone({ x: 0, y: 0 }, 0, 30, 28, target, 1);
  assert.ok(!sol.reachable);
  close(sol.deviation, 100 - 58);
  close(dist(sol.end, { x: 0, y: 0 }), 58); // 末端在臂展边界上
  close(dist(sol.end, target), sol.deviation);
});

test('最小可达半径：目标过近时同样钳制', () => {
  const sol = solveTwoBone({ x: 0, y: 0 }, 0, 30, 10, { x: 5, y: 0 }, 1);
  assert.ok(!sol.reachable);
  close(dist(sol.end, { x: 0, y: 0 }), 20); // |30-10|
  close(sol.deviation, 15);
});

test('骨骼长度不变：任意目标下两节骨长保持 l1、l2', () => {
  for (const target of [
    { x: 10, y: 10 },
    { x: 200, y: -50 },
    { x: -30, y: 40 },
    { x: 0.1, y: 0 },
  ]) {
    const sol = solveTwoBone({ x: 3, y: -2 }, 15, 30, 28, target, -1);
    // 由解出的局部旋转重建世界位置，验证骨长
    const parentRot = (15 * Math.PI) / 180;
    const t1 = parentRot + (sol.rot1 * Math.PI) / 180;
    const joint = {
      x: 3 + Math.cos(t1) * 30,
      y: -2 + Math.sin(t1) * 30,
    };
    const t2 = t1 + (sol.rot2 * Math.PI) / 180;
    const end = { x: joint.x + Math.cos(t2) * 28, y: joint.y + Math.sin(t2) * 28 };
    close(dist(joint, { x: 3, y: -2 }), 30);
    close(dist(end, joint), 28);
    close(dist(end, sol.end), 0, 1e-6);
  }
});

test('bend 方向决定肘部朝向，且对同一目标结果确定', () => {
  const a1 = solveTwoBone({ x: 0, y: 0 }, 0, 30, 28, { x: 40, y: 0 }, 1);
  const a2 = solveTwoBone({ x: 0, y: 0 }, 0, 30, 28, { x: 40, y: 0 }, 1);
  const b = solveTwoBone({ x: 0, y: 0 }, 0, 30, 28, { x: 40, y: 0 }, -1);
  assert.deepEqual(a1, a2); // 纯函数
  assert.notEqual(a1.rot1, b.rot1); // 两种弯曲方向给出不同解
  close(dist(a1.end, b.end), 0); // 但末端都到达目标
});
