import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSweep } from '../src/sweep.js';
import { trianglesIntersect } from '../src/diagnostics.js';

const loadCase = async (name) =>
  JSON.parse(await readFile(new URL(`../cases/${name}.json`, import.meta.url), 'utf8'));

test('U-turn counterexample reports self-intersections and fold risk', async () => {
  const mesh = buildSweep(await loadCase('u-turn'));
  const d = mesh.diagnostics;
  assert.ok(d.selfIntersections.count > 0, 'tight U-turn must self-intersect');
  assert.ok(d.foldRiskCount > 0, 'bend radius smaller than half width must be flagged');
  assert.ok(d.selfIntersections.pairs.length > 0, 'report should name offending face pairs');
});

test('gentle cases report no self-intersection', async () => {
  for (const name of ['spatial-bend', 'closed-loop', 'straight-joint']) {
    const mesh = buildSweep(await loadCase(name));
    assert.equal(mesh.diagnostics.selfIntersections.count, 0, `${name} should be clean`);
    assert.equal(mesh.diagnostics.foldRiskCount, 0, `${name} should have no fold risk`);
  }
});

test('duplicate control points are reported as degenerate, geometry stays finite', () => {
  const mesh = buildSweep({
    points: [
      { position: [0, 0, 0], width: 0.3 },
      { position: [1, 0, 0], width: 0.3 },
      { position: [1, 0, 0], width: 0.3 }, // duplicate
      { position: [2, 0.5, 0.5], width: 0.3 },
    ],
  });
  assert.ok(mesh.diagnostics.degenerateSegments.length > 0, 'degenerate segment not reported');
  assert.equal(mesh.diagnostics.nanVertices, 0);
});

test('triangle intersection predicate agrees on known cases', () => {
  const t1 = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
  const crossing = [[0.2, 0.2, -1], [0.2, 0.2, 1], [0.4, 0.1, 0.5]];
  const beside = [[2, 0, -1], [2, 0, 1], [2, 1, 0]];
  const parallel = [[0, 0, 1], [1, 0, 1], [0, 1, 1]];
  assert.equal(trianglesIntersect(t1, crossing), true);
  assert.equal(trianglesIntersect(t1, beside), false);
  assert.equal(trianglesIntersect(t1, parallel), false);
});
