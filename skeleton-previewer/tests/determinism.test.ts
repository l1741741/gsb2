import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CharacterDef, ClipDef, ScenarioDef } from '../src/types.js';
import { buildScene, evaluateFrame } from '../src/evaluate.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'data');
const character = JSON.parse(
  readFileSync(join(dataDir, 'character.json'), 'utf8'),
) as CharacterDef;
const { clips } = JSON.parse(readFileSync(join(dataDir, 'clips.json'), 'utf8')) as {
  clips: ClipDef[];
};
const { scenarios } = JSON.parse(
  readFileSync(join(dataDir, 'scenarios.json'), 'utf8'),
) as { scenarios: ScenarioDef[] };

test('确定性：同一时间点与求值历史、方向、速度无关（逐位相等）', () => {
  for (const scenario of scenarios) {
    const scene = buildScene(character, clips, scenario);
    const T = scene.totalDuration;
    const probe = [0, T * 0.25, T * 0.5, T * 0.77, T - 1e-6];

    // 正向与反向逐帧（模拟 60fps 连续播放与倒放），
    // 使用规范化后的同一批探测时间点，避免累加器浮点噪声干扰“同一时刻”的定义。
    const steps = Math.floor(T * 60);
    const canonTime = (i: number) => Number((i / 60).toFixed(9));
    const forward = new Map<number, string>();
    for (let i = 0; i < steps; i++) {
      const t = canonTime(i);
      forward.set(t, JSON.stringify(evaluateFrame(scene, t)));
    }
    const backward = new Map<number, string>();
    for (let i = steps - 1; i >= 0; i--) {
      const t = canonTime(i);
      backward.set(t, JSON.stringify(evaluateFrame(scene, t)));
    }
    for (const t of probe) {
      const direct = JSON.stringify(evaluateFrame(scene, t));
      // 直接求值 == 重复求值（纯函数）
      assert.equal(JSON.stringify(evaluateFrame(scene, t)), direct, `${scenario.id} @${t}`);
      // 跳变式访问（模拟拖动时间轴、变速）后结果不变
      evaluateFrame(scene, t + 3.3);
      evaluateFrame(scene, 0.01);
      assert.equal(JSON.stringify(evaluateFrame(scene, t)), direct, `${scenario.id} @${t} after scrub`);
    }
    // 正向与反向逐帧在相同时间点上完全一致
    for (const [t, json] of forward) {
      const back = backward.get(t);
      if (back !== undefined) {
        assert.equal(back, json, `${scenario.id} @${t} forward != backward`);
      }
    }
  }
});

test('循环：t 与 t + N×总时长 的画面一致（1e-6 精度）', () => {
  const scene = buildScene(character, clips, scenarios[0]);
  const T = scene.totalDuration;
  // 数值归一化到 1e-6：取模运算的浮点尾差不属于“姿势不同”
  const canon = (t: number) =>
    JSON.stringify(evaluateFrame(scene, t), (_k, v) =>
      typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v,
    );
  for (const t of [0.3, 1.4, 2.9]) {
    assert.equal(canon(t), canon(t + 3 * T));
  }
});
