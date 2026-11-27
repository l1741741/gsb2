import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateMap, heightAt } from '../src/mapio.js';
import { computeViewshed, queryLos } from '../src/los.js';
import { hexRadiusTiles } from '../src/hex.js';
import { solveFrom } from '../src/solve.js';
import { replay } from '../src/engine.js';
import type { MapDef } from '../src/types.js';

function loadMap(file: string): MapDef {
  const url = new URL(`../../maps/${file}`, import.meta.url);
  const raw = JSON.parse(readFileSync(url, 'utf8'));
  const v = validateMap(raw);
  assert.equal(v.ok, true, v.errors.join('; '));
  return v.map!;
}

const open = loadMap('open-plain.json');
const ridge = loadMap('ridgeline.json');

test('两份内置地图都通过校验，且成本/预算明确为正', () => {
  for (const m of [open, ridge]) {
    assert.ok(m.budget > 0);
    assert.ok(m.costs.move >= 0);
    assert.ok(m.costs.observe > 0);
    assert.ok(m.beacons.length >= 3);
    assert.ok(m.stances && m.stances.length >= 1);
  }
  assert.equal(open.id, 'open-plain');
  assert.equal(ridge.id, 'ridgeline');
});

test('开阔关：近处信标起点可见；残墙信标被石墙挡住', () => {
  const near = open.beacons.find((b) => b.id === 'near')!;
  const wallb = open.beacons.find((b) => b.id === 'wallb')!;
  assert.equal(queryLos(open, open.start, 2, near).clear, true);

  const los = queryLos(open, open.start, 2, wallb);
  assert.equal(los.clear, false);
  assert.equal(los.primary?.kind, 'wall');
});

test('开阔关：站立时矮丘挡住丘后信标，观测杆更高视点可越过', () => {
  const dune = open.beacons.find((b) => b.id === 'dune')!;
  const stand = queryLos(open, open.start, 2, dune);
  assert.equal(stand.clear, false);
  assert.equal(stand.primary?.kind, 'terrain');

  const mast = queryLos(open, open.start, 4, dune);
  assert.equal(mast.clear, true, '观测杆 eye=4 应能越过近侧矮丘');
});

test('开阔关在给定预算内存在可完成路线，且求解路线重放必胜', () => {
  const sol = solveFrom(open, open.start, [], open.budget);
  assert.ok(sol, `预算 ${open.budget} 内应当可解`);
  assert.ok(sol!.totalCost <= open.budget);
  const s = replay(open, sol!.actions);
  assert.equal(s.status, 'won');
  assert.equal(s.foundIds.length, open.beacons.length);
});

test('山脊关：起点看不见岭北信标，阻挡来自山脊较高地形', () => {
  const north = ridge.beacons.find((b) => b.id === 'north')!;
  const los = queryLos(ridge, ridge.start, 2, north);
  assert.equal(los.clear, false);
  assert.ok(los.primary);
  assert.equal(los.primary!.kind, 'terrain');
  assert.ok(los.primary!.blockTop >= 3);
});

test('山脊关：南侧低地（r>=1 且 h<=1）没有任何格能看见岭北信标', () => {
  const north = ridge.beacons.find((b) => b.id === 'north')!;
  const spies: string[] = [];
  for (const o of hexRadiusTiles(ridge.shape.radius)) {
    if (o.r < 1) continue;
    const h = heightAt(ridge, o.q, o.r);
    if (h > 1) continue;
    const vs = computeViewshed(ridge, o, 2);
    if (vs.visible.has(`${north.q},${north.r}`)) spies.push(`${o.q},${o.r}`);
  }
  assert.deepEqual(spies, []);
});

test('山脊关：指定的高瞭望岩 (2,2) 能看见岭北信标', () => {
  const north = ridge.beacons.find((b) => b.id === 'north')!;
  assert.equal(heightAt(ridge, 2, 2), 4);
  const los = queryLos(ridge, { q: 2, r: 2 }, 2, north);
  assert.equal(los.clear, true);
});

test('山脊关在给定预算内可完成（提示求解器可作为安全网）', () => {
  const sol = solveFrom(ridge, ridge.start, [], ridge.budget);
  assert.ok(sol, `预算 ${ridge.budget} 内应当可解`);
  assert.ok(sol!.totalCost <= ridge.budget);
  const s = replay(ridge, sol!.actions);
  assert.equal(s.status, 'won');
});
