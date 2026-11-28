import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSweep } from '../src/sweep.js';
import { toObj } from '../src/obj.js';

const run = promisify(execFile);
const casePath = (name) => new URL(`../cases/${name}.json`, import.meta.url).pathname;

test('OBJ export contains v/vt/vn, materials and in-range indices', async () => {
  const def = JSON.parse(await readFile(casePath('straight-joint'), 'utf8'));
  const mesh = buildSweep(def);
  const obj = toObj(mesh);
  const lines = obj.split('\n');
  const vCount = lines.filter((l) => l.startsWith('v ')).length;
  const vtCount = lines.filter((l) => l.startsWith('vt ')).length;
  const vnCount = lines.filter((l) => l.startsWith('vn ')).length;
  assert.equal(vCount, mesh.positions.length);
  assert.equal(vtCount, mesh.uvs.length);
  assert.equal(vnCount, mesh.normals.length);
  assert.ok(lines.includes('usemtl strip'));
  assert.ok(lines.includes('usemtl cap'), 'open path must export cap material');
  for (const line of lines.filter((l) => l.startsWith('f '))) {
    for (const ref of line.slice(2).split(' ')) {
      const [vi, ti, ni] = ref.split('/').map(Number);
      assert.ok(vi >= 1 && vi <= vCount, `vertex index ${vi} out of range`);
      assert.ok(ti >= 1 && ti <= vtCount, `uv index ${ti} out of range`);
      assert.ok(ni >= 1 && ni <= vnCount, `normal index ${ni} out of range`);
    }
  }
});

test('closed loop exports no cap material', async () => {
  const def = JSON.parse(await readFile(casePath('closed-loop'), 'utf8'));
  const obj = toObj(buildSweep(def));
  assert.ok(!obj.includes('usemtl cap'));
});

test('CLI exports OBJ plus a JSON report for every shipped case', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'lightstrip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const name of ['spatial-bend', 'closed-loop', 'u-turn', 'straight-joint']) {
    const out = path.join(dir, `${name}.obj`);
    const { stdout } = await run(process.execPath, [
      new URL('../bin/export.js', import.meta.url).pathname,
      casePath(name),
      out,
    ]);
    assert.match(stdout, /wrote/);
    const obj = await readFile(out, 'utf8');
    assert.ok(obj.includes('\nv '), 'OBJ has vertices');
    assert.ok(obj.includes('\nvt '), 'OBJ has texture coordinates');
    assert.ok(obj.includes('\nvn '), 'OBJ has normals');
    const report = JSON.parse(await readFile(out.replace(/\.obj$/, '.report.json'), 'utf8'));
    assert.equal(report.nanVertices, 0);
    if (name === 'u-turn') {
      assert.ok(report.selfIntersections.count > 0, 'u-turn report must flag self-intersection');
      assert.match(stdout, /PROBLEMS/);
    } else {
      assert.equal(report.selfIntersections.count, 0);
    }
  }
});
