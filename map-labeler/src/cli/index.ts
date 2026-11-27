/**
 * 命令行入口（无第三方运行时依赖）：
 *   layout  <input.json> [--width 1280] [--height 720] [--out manifest.json]
 *   restore <design.json> [--width 1280] [--height 720] [--out manifest.json]
 *
 * PNG 导出依赖浏览器 Canvas，在 demo 页面完成；CLI 输出可核对的坐标清单。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  assertDesignDocument,
  buildExportManifest,
  Camera,
  HeuristicTextMeasurer,
  layoutLabels,
  resolveStyle,
  restoreLayout,
  validateFloorplanInput,
} from '../index.js';
import type { ExportManifest } from '../index.js';

interface CliArgs {
  command: string;
  file: string;
  width: number;
  height: number;
  out?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const [command, file, ...rest] = argv;
  if (!command || !file || (command !== 'layout' && command !== 'restore')) {
    throw new Error('用法: map-labeler <layout|restore> <json 文件> [--width N] [--height N] [--out 文件]');
  }
  let width = 1280;
  let height = 720;
  let out: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--width') width = Number(rest[++i]);
    else if (rest[i] === '--height') height = Number(rest[++i]);
    else if (rest[i] === '--out') out = rest[++i];
    else throw new Error(`未知参数: ${rest[i]}`);
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('--width/--height 必须是正整数');
  }
  return { command, file, width, height, out };
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(resolve(path), 'utf8');
  return JSON.parse(text) as unknown;
}

function makeCamera(width: number, height: number, bounds: { x: number; y: number; width: number; height: number }): Camera {
  const camera = new Camera(width, height);
  camera.fitToMapBounds(bounds);
  return camera;
}

function printSummary(manifest: ExportManifest, warnings: string[]): void {
  const { summary } = manifest;
  console.log(
    `画布 ${manifest.canvas.width}×${manifest.canvas.height}｜标签 ${summary.total} 张：显示 ${summary.visible}，折叠 ${summary.folded}，冲突 ${summary.conflicts} 处`,
  );
  if (warnings.length > 0) {
    console.log('恢复核对警告：');
    for (const warning of warnings) console.log(`  - ${warning}`);
  }
  for (const box of manifest.labelBoxes) {
    const where = box.map
      ? `map=(${box.map.x.toFixed(1)}, ${box.map.y.toFixed(1)}, ${box.map.width.toFixed(1)}×${box.map.height.toFixed(1)})`
      : '未放置';
    const state = box.folded ? `折叠[${box.foldReason?.code ?? '?'}]` : box.pinned ? '固定' : '自动';
    console.log(`  [${state}] ${box.anchorId} 「${box.text}」 ${where}${box.conflicts.length ? ` 冲突×${box.conflicts.length}` : ''}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const measurer = new HeuristicTextMeasurer();
  const now = new Date().toISOString();
  let manifest: ExportManifest;
  const warnings: string[] = [];

  if (args.command === 'layout') {
    const input = validateFloorplanInput(await readJson(args.file));
    const style = resolveStyle(input.style);
    const camera = makeCamera(args.width, args.height, input.map.bounds);
    const result = layoutLabels({
      canvasWidth: args.width,
      canvasHeight: args.height,
      scale: camera.scale,
      viewBounds: camera.viewBoundsInMap(),
      mapBounds: input.map.bounds,
      forbidden: input.forbidden ?? [],
      anchors: input.anchors,
      style,
      measurer,
    });
    manifest = buildExportManifest(input, result.labels, camera, now);
  } else {
    const doc = assertDesignDocument(await readJson(args.file));
    const style = resolveStyle(doc.input.style);
    const camera = makeCamera(args.width, args.height, doc.input.map.bounds);
    const { layout, warnings: restoreWarnings } = restoreLayout(
      doc,
      measurer,
      style,
      args.width,
      args.height,
      camera.scale,
      camera.viewBoundsInMap(),
    );
    warnings.push(...restoreWarnings);
    manifest = buildExportManifest(doc.input, layout.labels, camera, now);
  }

  const json = JSON.stringify(manifest, null, 2);
  if (args.out) {
    await writeFile(resolve(args.out), json, 'utf8');
    console.log(`已写入 ${args.out}`);
  }
  printSummary(manifest, warnings);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
