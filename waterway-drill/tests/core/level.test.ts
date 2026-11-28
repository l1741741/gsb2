import test from 'node:test';
import assert from 'node:assert/strict';
import { compileLevel, canonicalize, fingerprintOf } from '../../src/level.ts';
import type { LevelSpec } from '../../src/types.ts';
import { miniLevel } from '../fixtures/levels.ts';

test('level: 校验失败抛出逐条问题，而不是静默容错', () => {
  const bad: LevelSpec = miniLevel({
    edges: [{ id: 'e1', from: 'high', to: 'missing', capacity: 2 }],
  });
  assert.throws(() => compileLevel(bad), (error: unknown) => {
    const issues = (error as { issues?: string[] }).issues;
    assert.ok(Array.isArray(issues) && issues.length > 0);
    return true;
  });
});

test('level: 拒绝逆高程的支路（水流只能自高向低）', () => {
  const bad = miniLevel({
    edges: [{ id: 'e1', from: 'low', to: 'high', capacity: 2, gate: 'G' }],
  });
  assert.throws(() => compileLevel(bad), /高处流向低处/);
});

test('level: 目标超过容量或溢流指向更高池都被拒绝', () => {
  const goalTooHigh = miniLevel({ goal: { pool: 'low', atLeast: 7 } });
  assert.throws(() => compileLevel(goalTooHigh), /超过.*容量/);

  const badOverflow: LevelSpec = miniLevel({
    pools: [
      { id: 'high', label: '高池', elevation: 10, capacity: 4, initial: 3,
        overflowTo: 'low', layout: { x: 0, y: 0, width: 40, height: 20 } },
      { id: 'low', label: '低池', elevation: 0, capacity: 6, initial: 0,
        layout: { x: 100, y: 0, width: 40, height: 20 } },
      { id: 'mid', label: '中池', elevation: 5, capacity: 2, initial: 0,
        overflowTo: 'high', layout: { x: 50, y: 0, width: 40, height: 20 } },
    ],
  });
  assert.throws(() => compileLevel(badOverflow), /溢流只能倒向更低的池子/);
});

test('level: 指纹只取决于结算相关内容，绘制坐标变化不影响记录校验', () => {
  const base = compileLevel(miniLevel());
  const moved = miniLevel();
  const movedPools = moved.pools.map((pool) => ({
    ...pool,
    layout: { ...pool.layout, x: pool.layout.x + 40, y: pool.layout.y + 40 },
  }));
  const movedLevel = compileLevel({ ...moved, pools: movedPools });
  assert.equal(base.fingerprint, movedLevel.fingerprint);
});

test('level: 结算相关的改动会改变指纹', () => {
  const base = compileLevel(miniLevel());
  const changed = compileLevel(miniLevel({
    edges: [{ id: 'e1', from: 'high', to: 'low', capacity: 3, gate: 'G' }],
  }));
  assert.notEqual(base.fingerprint, changed.fingerprint);
});

test('level: 规范化字符串与键顺序无关', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
  assert.equal(fingerprintOf({ x: [1, 2] }), fingerprintOf({ x: [1, 2] }));
  assert.notEqual(fingerprintOf({ x: [1, 2] }), fingerprintOf({ x: [2, 1] }));
});
