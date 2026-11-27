import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CharacterDef, ClipDef, ScenarioDef } from '../src/types.js';
import { buildScene, evaluateFrame } from '../src/evaluate.js';
import { compose } from '../src/math.js';
import { sampleClip, blendPoses } from '../src/clip.js';
import { buildSkeleton } from '../src/skeleton.js';

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

const byId = (id: string) => scenarios.find((s) => s.id === id)!;

test('过渡全程父子坐标关系保持：子世界 = 父世界 ∘ 子局部', () => {
  const scene = buildScene(character, clips, byId('transition-carry-to-wave'));
  for (let t = 0; t <= scene.totalDuration; t += 0.05) {
    const frame = evaluateFrame(scene, t);
    const worldById = new Map(frame.bones.map((b) => [b.id, b.world]));
    for (const bone of character.bones) {
      if (bone.parent === null) continue;
      // 世界变换由层级合成而来：父的世界位置必然通过子骨骼的局部偏移相连。
      // 用父世界变换 + 子世界反推局部平移，验证它是有界的（层级未断裂）。
      const pw = worldById.get(bone.parent)!;
      const cw = worldById.get(bone.id)!;
      const r = (-pw.rot * Math.PI) / 180;
      const lx = (cw.x - pw.x) * Math.cos(r) - (cw.y - pw.y) * Math.sin(r);
      const ly = (cw.x - pw.x) * Math.sin(r) + (cw.y - pw.y) * Math.cos(r);
      assert.ok(
        Math.hypot(lx, ly) < 60,
        `t=${t} bone=${bone.id} 局部偏移异常 (${lx}, ${ly})`,
      );
      assert.ok(Number.isFinite(cw.rot - pw.rot));
    }
  }
});

test('过渡中旋转跨半圈遵循最短弧：carry(125°) → wave(-160°) 经过 ±180 而非 0', () => {
  const sk = buildSkeleton(character);
  const carry = clips.find((c) => c.id === 'carry')!;
  const wave = clips.find((c) => c.id === 'wave')!;
  const a = sampleClip(sk, carry, 1.0); // upperArmL = 125°
  const b = sampleClip(sk, wave, 0); // upperArmL = -160°
  const mid = blendPoses(sk, a, b, 0.5);
  // 125 -> -160 的差值归一化为 +75，中点 = 162.5；朴素插值会得到 -17.5（关节翻向）
  assert.ok(Math.abs(mid.upperArmL.rot - 162.5) < 1e-9, `mid=${mid.upperArmL.rot}`);
  assert.ok(Math.abs(mid.upperArmL.rot - -17.5) > 90, '不应走朴素插值路径');
});

test('过渡端点与相邻片段衔接：s=0 等于前段末尾，s=1 等于后段开头', () => {
  const scene = buildScene(character, clips, byId('transition-carry-to-wave'));
  const atStart = evaluateFrame(scene, 1.0); // 过渡开始
  const justBefore = evaluateFrame(scene, 0.999);
  const atEnd = evaluateFrame(scene, 1.8); // 过渡结束
  const justAfter = evaluateFrame(scene, 1.801);
  const hand = (f: ReturnType<typeof evaluateFrame>) => f.attachments.handL;
  assert.ok(Math.abs(hand(atStart).x - hand(justBefore).x) < 1);
  assert.ok(Math.abs(hand(atStart).y - hand(justBefore).y) < 1);
  assert.ok(Math.abs(hand(atEnd).x - hand(justAfter).x) < 1);
  assert.ok(Math.abs(hand(atEnd).y - hand(justAfter).y) < 1);
});

test('固定挂点超出可达范围：偏差 > 0 且骨长不变', () => {
  const scene = buildScene(character, clips, byId('pin-hand-out-of-reach'));
  const frame = evaluateFrame(scene, 0.5);
  assert.equal(frame.pins.length, 1);
  const pin = frame.pins[0];
  assert.ok(!pin.reachable);
  assert.ok(pin.deviation > 50, `deviation=${pin.deviation}`);
  // 骨长不变：上臂 30、前臂 28
  const w = new Map(frame.bones.map((b) => [b.id, b]));
  const upper = w.get('upperArmL')!;
  const fore = w.get('foreArmL')!;
  const elbowDist = Math.hypot(
    fore.world.x - upper.world.x,
    fore.world.y - upper.world.y,
  );
  assert.ok(Math.abs(elbowDist - 30) < 1e-6, `upper arm stretched: ${elbowDist}`);
  const handDist = Math.hypot(
    frame.attachments.handL.x - fore.world.x,
    frame.attachments.handL.y - fore.world.y,
  );
  assert.ok(Math.abs(handDist - 28) < 1e-6, `forearm stretched: ${handDist}`);
});

test('固定挂点可达：末端落在目标上，偏差为 0；时间窗外不生效', () => {
  const scene = buildScene(character, clips, byId('pin-foot-planted'));
  const pinned = evaluateFrame(scene, 0.5);
  assert.equal(pinned.pins.length, 1);
  assert.ok(pinned.pins[0].reachable);
  assert.ok(pinned.pins[0].deviation < 1e-6);
  assert.ok(Math.abs(pinned.attachments.footL.x - 5) < 1e-6);
  assert.ok(Math.abs(pinned.attachments.footL.y - 60) < 1e-6);
  // 时间窗外（t=0.1 与 t=0.8）不生效
  assert.equal(evaluateFrame(scene, 0.1).pins.length, 0);
  assert.equal(evaluateFrame(scene, 0.8).pins.length, 0);
});

test('compose 一致性：evaluateFrame 内部世界变换与 compose 定义相同', () => {
  const scene = buildScene(character, clips, byId('transition-carry-to-wave'));
  const frame = evaluateFrame(scene, 1.4);
  const w = new Map(frame.bones.map((b) => [b.id, b.world]));
  // head 是 spine 的子骨骼，局部偏移 (45, 0)
  const headLocal = { x: 45, y: 0, rot: frame.bones.find((b) => b.id === 'head')!.world.rot - w.get('spine')!.rot };
  const recomposed = compose(w.get('spine')!, headLocal);
  assert.ok(Math.abs(recomposed.x - w.get('head')!.x) < 1e-9);
  assert.ok(Math.abs(recomposed.y - w.get('head')!.y) < 1e-9);
});
