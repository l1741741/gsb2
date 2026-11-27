#!/usr/bin/env node
// 命令行检查点复核：node scripts/verify-plan.mjs <方案.json>
// 与浏览器探针、检查点面板使用同一套 src/ 计算代码，
// 因此导出的方案 JSON 在任何环境下复核结果一致。

import { readFile } from 'node:fs/promises';
import { loadScene, sceneSegments } from '../src/scene.js';
import { buildLightPolygons, probePoint } from '../src/lighting.js';

const path = process.argv[2];
if (!path) {
  console.error('用法: node scripts/verify-plan.mjs <方案.json>');
  process.exit(2);
}

const data = JSON.parse(await readFile(path, 'utf8'));
const scene = loadScene(data);
const segments = sceneSegments(scene);
const polygons = buildLightPolygons(scene, segments);

console.log(`方案: ${scene.name} | 门限: ${scene.settings.threshold} | 灯具: ${scene.lights.length}`);
let failures = 0;
for (const checkpoint of scene.checkpoints) {
  const probe = probePoint(scene, segments, checkpoint, polygons);
  const ids = probe.contributions.map((c) => c.lightId);
  let pass = false;
  if (checkpoint.expect === 'dark') pass = ids.length === 0;
  else if (checkpoint.expect === 'partial') pass = ids.length >= 2;
  else pass = ids.length >= 1
    && (!checkpoint.lights || checkpoint.lights.every((id) => ids.includes(id)));
  if (!pass) failures += 1;
  const label = { dark: '应全暗', partial: '部分相交', visible: '直接可见' }[checkpoint.expect];
  console.log(
    `[${pass ? 'PASS' : 'FAIL'}] ${checkpoint.id} (${label}) `
      + `总照度=${probe.total.toFixed(4)} 贡献灯=[${ids.join(', ') || '无'}]`,
  );
}
console.log(failures === 0 ? '全部检查点通过' : `${failures} 个检查点不符`);
process.exit(failures === 0 ? 0 : 1);
