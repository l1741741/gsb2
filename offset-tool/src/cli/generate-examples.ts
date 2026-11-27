/**
 * 批处理：对内置示例（或 --file 指定的轮廓 JSON）按一组距离生成
 * PNG 预览 + 稳定 JSON 坐标，写入 examples/generated/<名称>/。
 *
 * 用法：
 *   node dist/cli/generate-examples.js
 *   node dist/cli/generate-examples.js --file input.json --distances 0,-4,-8 --join round
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join as pathJoin, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import {
  EXAMPLES,
  buildBatchExport,
  describeInputs,
  drawScene,
  HeadlessCanvas,
  offsetContours,
  stableStringify,
  validateContour,
  DEFAULT_PARAMS,
  DEFAULT_SCENE_OPTIONS,
} from '../index.js';
import type { ContourInput, JoinKind, OffsetParams } from '../geometry/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_ROOT = resolve(HERE, '../../examples/generated');
const PNG_SIZE = 640;
const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

interface CliArgs {
  file?: string;
  distances?: number[];
  joinKind?: JoinKind;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--file') args.file = argv[++i];
    else if (token === '--distances') {
      args.distances = argv[++i].split(',').map((s) => Number(s.trim()));
    } else if (token === '--join') args.joinKind = argv[++i] as JoinKind;
  }
  return args;
}

function makeParams(distance: number, joinKind: JoinKind): OffsetParams {
  return { ...DEFAULT_PARAMS, distance, join: joinKind };
}

function renderPng(
  input: ContourInput,
  result: ReturnType<typeof offsetContours> | null,
  validation: ReturnType<typeof validateContour>,
  fileName: string,
): void {
  const canvas = new HeadlessCanvas(PNG_SIZE, PNG_SIZE);
  drawScene(
    canvas,
    { inputLoops: input.loops, result, validation },
    DEFAULT_SCENE_OPTIONS,
  );
  writeFileSync(fileName, canvas.toPng());
}

function processOne(
  input: ContourInput,
  distances: number[],
  joinKind: JoinKind,
): { blocked: boolean } {
  const dir = pathJoin(OUT_ROOT, input.name);
  mkdirSync(dir, { recursive: true });
  const validation = validateContour(input);
  const info = describeInputs(input.loops);

  if (!validation.valid) {
    // 自交等阻断性问题：只画带红叉的原图，导出诊断 JSON
    renderPng(input, null, validation, pathJoin(dir, 'issues.png'));
    const payload = buildBatchExport(input, info, validation, [], FIXED_TIMESTAMP);
    writeFileSync(pathJoin(dir, 'results.json'), stableStringify(payload));
    const report = validation.issues.map((i) => `- [${i.kind}] ${i.message}`).join('\n');
    writeFileSync(pathJoin(dir, 'issues.txt'), `${input.name}\n${report}\n`);
    console.log(
      `[blocked] ${input.name}: ${validation.issues.length} 个问题，见 issues.png/issues.txt`,
    );
    return { blocked: true };
  }

  const runs = distances.map((distance) => {
    const params = makeParams(distance, joinKind);
    const result = offsetContours(input.loops, params);
    const sign = distance >= 0 ? 'plus' : 'minus';
    renderPng(
      input,
      result,
      validation,
      pathJoin(dir, `offset-${sign}${Math.abs(distance)}.png`),
    );
    console.log(
      `[ok] ${input.name} d=${distance}: 组件 ${result.components.length}，` +
        `外环 ${result.stats.outerCount}，孔 ${result.stats.holeCount}，` +
        `细片 ${result.stats.sliverCount}`,
    );
    return { params, result };
  });

  const payload = buildBatchExport(input, info, validation, runs, FIXED_TIMESTAMP);
  writeFileSync(pathJoin(dir, 'results.json'), stableStringify(payload));
  return { blocked: false };
}

function main(): void {
  const args = parseArgs(process.argv);
  mkdirSync(OUT_ROOT, { recursive: true });

  if (args.file) {
    const raw = JSON.parse(readFileSync(resolve(args.file), 'utf8')) as ContourInput;
    const distances = args.distances ?? [0, -4, -8];
    processOne(raw, distances, args.joinKind ?? 'miter');
    return;
  }

  let blocked = 0;
  for (const ex of EXAMPLES) {
    const r = processOne(ex.input, ex.distances, 'miter');
    if (r.blocked) blocked++;
  }
  console.log(`\n输出目录：${OUT_ROOT}`);
  console.log(`示例 ${EXAMPLES.length} 个，其中被校验拦截 ${blocked} 个`);
}

main();
