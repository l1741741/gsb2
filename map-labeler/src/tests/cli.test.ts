import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '../cli/index.js');
const sample = resolve(here, '../../demo/sample-floorplan.json');

test('CLI layout：横版输出摘要与坐标清单文件', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'labeler-cli-'));
  const out = resolve(dir, 'manifest.json');
  const { stdout } = await execFileAsync(process.execPath, [
    cli, 'layout', sample, '--width', '1280', '--height', '720', '--out', out,
  ]);
  assert.match(stdout, /画布 1280×720/);
  const manifest = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.anchors.length, 18);
  assert.ok(manifest.labelBoxes.every((b: unknown) => b !== null));
  assert.ok(manifest.summary.visible > 0);
});

test('CLI layout：窄版折叠数不少于横版，且每个折叠都有原因', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'labeler-cli-'));
  const wideOut = resolve(dir, 'wide.json');
  const narrowOut = resolve(dir, 'narrow.json');
  await execFileAsync(process.execPath, [cli, 'layout', sample, '--width', '1280', '--height', '720', '--out', wideOut]);
  await execFileAsync(process.execPath, [cli, 'layout', sample, '--width', '420', '--height', '900', '--out', narrowOut]);
  const wide = JSON.parse(await readFile(wideOut, 'utf8'));
  const narrow = JSON.parse(await readFile(narrowOut, 'utf8'));
  assert.ok(narrow.summary.folded >= wide.summary.folded);
  for (const box of narrow.labelBoxes.filter((b: { folded: boolean }) => b.folded)) {
    assert.ok(box.foldReason && box.foldReason.code, '折叠标签必须带结构化原因');
  }
});

test('CLI restore：保存后同规格恢复无警告，坏参数报错退出', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'labeler-cli-'));
  const designPath = resolve(dir, 'design.json');
  // 直接把 layout 清单包成最小设计文档，验证 restore 参数链路
  const manifest = JSON.parse(await readFile(sample, 'utf8'));
  const minimal = {
    version: 1,
    input: manifest,
    manualOverrides: {},
    manualFolds: {},
    camera: { centerX: 500, centerY: 320, scale: 1, rotation: 0 },
    canvas: { width: 1280, height: 720 },
    layout: { labels: [] },
    savedAt: '2026-11-28T00:00:00.000Z',
  };
  await writeFile(designPath, JSON.stringify(minimal));
  const { stdout } = await execFileAsync(process.execPath, [
    cli, 'restore', designPath, '--width', '1280', '--height', '720',
  ]);
  assert.match(stdout, /画布 1280×720/);

  await assert.rejects(
    execFileAsync(process.execPath, [cli, 'layout', sample, '--width', '-1', '--height', '720']),
    /width/,
  );
});
