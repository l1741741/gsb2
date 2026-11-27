import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScene, sceneSegments } from '../src/scene.js';
import { buildLightPolygons, probePoint } from '../src/lighting.js';
import { cornerScene, corridorScene, crossingScene, sampleScenes } from '../src/samples.js';

// 逐个样例核对检查点：dark/partial/visible 的语义与声明的贡献灯。
function evaluate(rawScene) {
  const scene = loadScene(rawScene);
  const segments = sceneSegments(scene);
  const polygons = buildLightPolygons(scene, segments);
  return scene.checkpoints.map((checkpoint) => ({
    checkpoint,
    probe: probePoint(scene, segments, { x: checkpoint.x, y: checkpoint.y }, polygons),
  }));
}

for (const rawScene of sampleScenes.map((s) => s.data)) {
  test(`样例「${rawScene.name}」三类检查点齐全`, () => {
    const kinds = new Set(rawScene.checkpoints.map((cp) => cp.expect));
    assert.ok(kinds.has('dark'), '缺少全暗检查点');
    assert.ok(kinds.has('partial'), '缺少部分相交检查点');
    assert.ok(kinds.has('visible'), '缺少直接可见检查点');
  });
}

test('走廊与门缝：全暗点无贡献，门缝处两灯相交，近端仅左灯直接可见', () => {
  const results = evaluate(corridorScene);
  const byId = Object.fromEntries(results.map((r) => [r.checkpoint.id, r]));
  assert.equal(byId['cp-dark'].probe.contributions.length, 0);
  assert.equal(byId['cp-dark'].probe.total, 0);
  assert.deepEqual(
    byId['cp-door'].probe.contributions.map((c) => c.lightId).sort(),
    ['L1', 'L2'],
  );
  assert.deepEqual(
    byId['cp-near'].probe.contributions.map((c) => c.lightId),
    ['L1'],
  );
});

test('并排墙角：共享顶点两侧各自只被本区灯照亮，无顶点漏光', () => {
  const results = evaluate(cornerScene);
  const byId = Object.fromEntries(results.map((r) => [r.checkpoint.id, r]));
  assert.equal(byId['cp-dark'].probe.contributions.length, 0);
  assert.deepEqual(byId['cp-graze-a'].probe.contributions.map((c) => c.lightId), ['L1']);
  assert.deepEqual(byId['cp-graze-b'].probe.contributions.map((c) => c.lightId), ['L2']);
});

test('相交光束：柱后全暗，柱上两束光相交，开阔处单灯直接可见', () => {
  const results = evaluate(crossingScene);
  const byId = Object.fromEntries(results.map((r) => [r.checkpoint.id, r]));
  assert.equal(byId['cp-shadow'].probe.contributions.length, 0);
  assert.deepEqual(
    byId['cp-cross'].probe.contributions.map((c) => c.lightId).sort(),
    ['L1', 'L2'],
  );
  assert.deepEqual(
    byId['cp-direct'].probe.contributions.map((c) => c.lightId),
    ['L1'],
  );
});

test('检查点复核结果不受计算次数影响（同参数同结果）', () => {
  const first = evaluate(corridorScene).map((r) => r.probe.total);
  const second = evaluate(corridorScene).map((r) => r.probe.total);
  assert.deepEqual(second, first);
});
