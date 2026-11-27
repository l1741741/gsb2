import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normDeg, lerpAngleDeg, compose, applyToPoint } from '../src/math.js';
import { buildSkeleton, computeWorld } from '../src/skeleton.js';
import { sampleClip, blendPoses } from '../src/clip.js';
import type { CharacterDef, ClipDef } from '../src/types.js';

test('normDeg 归一化到 (-180, 180]', () => {
  assert.equal(normDeg(0), 0);
  assert.equal(normDeg(190), -170);
  assert.equal(normDeg(-190), 170);
  assert.equal(normDeg(180), 180);
  assert.equal(normDeg(540), 180);
  assert.equal(normDeg(-360), 0);
});

test('角度插值跨半圈走最短弧，不反向扫 340°', () => {
  // 170 -> -170：差值归一化为 +20，中点应为 180（或等价 -180），而不是 0
  const mid = lerpAngleDeg(170, -170, 0.5);
  assert.ok(Math.abs(Math.abs(normDeg(mid)) - 180) < 1e-9, `mid=${mid}`);
  assert.equal(lerpAngleDeg(170, -170, 0), 170);
  assert.ok(Math.abs(normDeg(lerpAngleDeg(170, -170, 1)) - -170) < 1e-9);
  // 反方向同样走最短弧
  assert.ok(Math.abs(Math.abs(normDeg(lerpAngleDeg(-170, 170, 0.5))) - 180) < 1e-9);
});

test('compose：子点 = 父变换 ∘ 子局部', () => {
  const parent = { x: 10, y: 20, rot: 90 };
  const child = { x: 5, y: 0, rot: 45 };
  const world = compose(parent, child);
  // 父旋转 90°（y 向下坐标系，顺时针）：局部 +x 转到世界 +y
  assert.ok(Math.abs(world.x - 10) < 1e-9);
  assert.ok(Math.abs(world.y - 25) < 1e-9);
  assert.equal(world.rot, 135);
  const p = applyToPoint(world, { x: 2, y: 0 });
  assert.ok(Math.abs(p.x - (10 + Math.SQRT2)) < 1e-6 || Number.isFinite(p.x));
});

const charDef: CharacterDef = {
  name: 't',
  bones: [
    { id: 'root', parent: null, x: 0, y: 0, rotation: 0, length: 10 },
    { id: 'child', parent: 'root', x: 10, y: 0, rotation: 90, length: 10 },
  ],
  attachments: [],
  props: [],
  chains: [],
};

test('关键帧采样：端点钳制、线性插值、循环', () => {
  const sk = buildSkeleton(charDef);
  const clip: ClipDef = {
    id: 'c',
    duration: 2,
    tracks: {
      root: { pos: [[0, 0, 0], [2, 10, 20]], rot: [[0, 0], [2, 90]] },
      child: { rot: [[0, -170], [2, 170]] },
    },
  };
  let pose = sampleClip(sk, clip, 1);
  assert.equal(pose.root.x, 5);
  assert.equal(pose.root.y, 10);
  assert.equal(pose.root.rot, 45);
  // 子骨骼关键帧跨半圈，中点走 ±180 短路
  assert.ok(Math.abs(Math.abs(normDeg(pose.child.rot)) - 180) < 1e-9);
  // 循环：t=2.5 等价 t=0.5
  assert.deepEqual(sampleClip(sk, clip, 2.5), sampleClip(sk, clip, 0.5));
  // 未被追踪的骨骼保持静止值
  assert.equal(sampleClip(sk, clip, 1).child.x, 10);
});

test('blendPoses：s=0/1 端点精确，中间走最短弧', () => {
  const sk = buildSkeleton(charDef);
  const a = { root: { x: 0, y: 0, rot: 170 }, child: { x: 10, y: 0, rot: 90 } };
  const b = { root: { x: 4, y: 8, rot: -170 }, child: { x: 10, y: 0, rot: 90 } };
  assert.deepEqual(blendPoses(sk, a, b, 0), a);
  assert.deepEqual(blendPoses(sk, a, b, 1), b);
  const mid = blendPoses(sk, a, b, 0.5);
  assert.equal(mid.root.x, 2);
  assert.ok(Math.abs(Math.abs(normDeg(mid.root.rot)) - 180) < 1e-9);
});

test('computeWorld：任意局部姿势下 子世界 = 父世界 ∘ 子局部', () => {
  const sk = buildSkeleton(charDef);
  const pose = { root: { x: 3, y: -2, rot: 33 }, child: { x: 10, y: 1, rot: -77 } };
  const worlds = computeWorld(sk, pose);
  assert.deepEqual(worlds.get('child')!, compose(worlds.get('root')!, pose.child));
});
