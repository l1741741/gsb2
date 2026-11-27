// 命令行导出：node dist/src/node-export.js [scenarioId]
// 读取本地 JSON 数据，打印关键时间点的数值（可重定向到文件）。
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { CharacterDef, ClipDef, ScenarioDef } from './types.js';
import { buildScene } from './evaluate.js';
import { exportScenario } from './export.js';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', '..', 'data');

async function loadJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(join(dataDir, name), 'utf8')) as T;
}

const character = await loadJson<CharacterDef>('character.json');
const { clips } = await loadJson<{ clips: ClipDef[] }>('clips.json');
const { scenarios } = await loadJson<{ scenarios: ScenarioDef[] }>('scenarios.json');

const wanted = process.argv[2];
const selected = wanted ? scenarios.filter((s) => s.id === wanted) : scenarios;
if (selected.length === 0) {
  console.error(`unknown scenario: ${wanted}`);
  console.error(`available: ${scenarios.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

const output = selected.map((s) => exportScenario(buildScene(character, clips, s)));
console.log(JSON.stringify(output.length === 1 ? output[0] : output, null, 2));
