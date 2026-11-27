import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeViewshed,
  hexInterval,
  queryLos,
  ratCmp,
  ratToNumber,
} from '../src/los.js';
import { toUV } from '../src/hex.js';
import type { MapDef } from '../src/types.js';

function testMap(over: Partial<MapDef> = {}): MapDef {
  return {
    format: 'hex-survey-map@1',
    id: 'unit',
    name: '单测图',
    brief: '',
    shape: { kind: 'hex', radius: 5 },
    start: { q: 0, r: 0 },
    budget: 10,
    costs: { move: 1, observe: 2 },
    eyeHeight: 2,
    wallHeight: 3,
    beacons: [{ id: 'b', q: 2, r: 0 }],
    ...over,
  };
}

test('平坦开阔地图上，到多数格的视线畅通', () => {
  const map = testMap();
  const r = queryLos(map, { q: 0, r: 0 }, 2, { q: 3, r: -2 });
  assert.equal(r.clear, true);
  assert.equal(r.primary, null);
  assert.ok(r.traversed.length > 0);
});

test('石墙挡住视线，查询给出阻挡格与原因', () => {
  const map = testMap({
    obstacles: [{ q: 1, r: 0, kind: 'wall' }], // top = 0+3 = 3
  });
  const r = queryLos(map, { q: 0, r: 0 }, 2, { q: 3, r: 0 });
  assert.equal(r.clear, false);
  assert.ok(r.primary);
  assert.equal(r.primary!.q, 1);
  assert.equal(r.primary!.r, 0);
  assert.equal(r.primary!.kind, 'wall');
  assert.equal(r.primary!.blockTop, 3);
  // 阻挡信息必须带可解释的参数与高度。
  assert.ok(r.primary!.hitT.n > 0n);
  assert.ok(ratToNumber(r.primary!.hitT) > 0);
});

test('较高中间地形阻挡；抬高视点后越过', () => {
  // O(0,0) -> T(3,-3) 沿 (1,-1) 直线，(1,-1) 是途经格。
  const blocked = testMap({ heights: { '1,-1': 3 } });
  const r1 = queryLos(blocked, { q: 0, r: 0 }, 2, { q: 3, r: -3 });
  assert.equal(r1.clear, false);
  assert.equal(r1.primary?.q, 1);
  assert.equal(r1.primary?.r, -1);
  assert.equal(r1.primary?.kind, 'terrain');

  // 同样的山，观测杆 eye=6 -> eyeZ=6，足以越过。
  const r2 = queryLos(blocked, { q: 0, r: 0 }, 6, { q: 3, r: -3 });
  assert.equal(r2.clear, true);
});

test('精确：视线沿两格公共边走过时，两格都纳入同一区间裁定', () => {
  // O=(0,0), T=(1,1)，UV 线段 U=V，t∈[1/3,2/3] 与
  // (1,0)、(0,1) 两格的公共边完全重合。
  const O = toUV({ q: 0, r: 0 });
  const T = toUV({ q: 1, r: 1 });
  const H1 = toUV({ q: 1, r: 0 });
  const H2 = toUV({ q: 0, r: 1 });
  const iv1 = hexInterval(H1.u, H1.v, O.u, O.v, T.u - O.u, T.v - O.v)!;
  const iv2 = hexInterval(H2.u, H2.v, O.u, O.v, T.u - O.u, T.v - O.v)!;
  assert.ok(iv1 && iv2);
  assert.equal(ratToNumber(iv1.lo), 1 / 3);
  assert.equal(ratToNumber(iv1.hi), 2 / 3);
  assert.equal(ratCmp(iv1.lo, iv2.lo), 0);
  assert.equal(ratCmp(iv1.hi, iv2.hi), 0);

  const base = testMap();
  const los0 = queryLos(base, { q: 0, r: 0 }, 3, { q: 1, r: 1 });
  // 两个沿边格都必须出现在 traversed 中（闭区间，不忽略擦边）。
  const keys = los0.traversed.map((h) => `${h.q},${h.r}`);
  assert.ok(keys.includes('1,0'));
  assert.ok(keys.includes('0,1'));

  // eyeZ=3,targetZ=0；区间远端 t=2/3 处视线高恰好为 1。
  // 阻挡顶高 =1：严格小于才遮挡 ⇒ 齐平放行。
  const tie = testMap({ heights: { '1,0': 1 } });
  const losTie = queryLos(tie, { q: 0, r: 0 }, 3, { q: 1, r: 1 });
  assert.equal(losTie.clear, true, '视线与遮挡顶齐平时应放行');

  // 阻挡顶高 =2：区间内视线严格低于 2 ⇒ 挡住，且首要阻挡就是该格。
  const over = testMap({ heights: { '1,0': 2 } });
  const losOver = queryLos(over, { q: 0, r: 0 }, 3, { q: 1, r: 1 });
  assert.equal(losOver.clear, false);
  assert.deepEqual(
    { q: losOver.primary!.q, r: losOver.primary!.r },
    { q: 1, r: 0 },
  );

  // 石墙 extra=1 使顶高恰为 1，同样齐平放行；extra=2 则挡住。
  const wallTie = testMap({
    obstacles: [{ q: 1, r: 0, kind: 'wall', extra: 1 }],
  });
  assert.equal(
    queryLos(wallTie, { q: 0, r: 0 }, 3, { q: 1, r: 1 }).clear,
    true,
  );
  const wallBlock = testMap({
    obstacles: [{ q: 1, r: 0, kind: 'wall', extra: 2 }],
  });
  const wl = queryLos(wallBlock, { q: 0, r: 0 }, 3, { q: 1, r: 1 });
  assert.equal(wl.clear, false);
  assert.equal(wl.primary?.kind, 'wall');
});

test('精确：视线只在一个顶点擦过某格时的一致裁定', () => {
  // O=(0,0) -> T=(-4,-1)；(-1,-1) 仅在 t=1/3 的顶点被擦到（区间退化为点）。
  const O = toUV({ q: 0, r: 0 });
  const T = toUV({ q: -4, r: -1 });
  const H = toUV({ q: -1, r: -1 });
  const iv = hexInterval(H.u, H.v, O.u, O.v, T.u - O.u, T.v - O.v)!;
  assert.ok(iv);
  assert.equal(ratCmp(iv.lo, iv.hi), 0, '应当是零长度区间（仅擦顶点）');
  assert.equal(ratToNumber(iv.lo), 1 / 3);

  // eyeZ=3,targetZ=0 ⇒ t=1/3 处视线高恰为 2。
  const tie = testMap({ heights: { '-1,-1': 2 } });
  assert.equal(
    queryLos(tie, { q: 0, r: 0 }, 3, { q: -4, r: -1 }).clear,
    true,
    '擦到顶点但与顶高齐平：放行',
  );
  const block = testMap({ heights: { '-1,-1': 3 } });
  const los = queryLos(block, { q: 0, r: 0 }, 3, { q: -4, r: -1 });
  assert.equal(los.clear, false);
  assert.deepEqual(
    { q: los.primary!.q, r: los.primary!.r },
    { q: -1, r: -1 },
  );
});

test('同一查询重复执行结果稳定（首要阻挡格不漂移）', () => {
  const map = testMap({
    heights: { '1,0': 4, '0,1': 4 },
    obstacles: [{ q: -1, r: 0, kind: 'wall' }],
  });
  const a = queryLos(map, { q: 2, r: -2 }, 2, { q: -2, r: 2 });
  const b = queryLos(map, { q: 2, r: -2 }, 2, { q: -2, r: 2 });
  assert.deepEqual(
    a.blockers.map((x) => [x.q, x.r, x.hitT.n.toString(), x.hitT.d.toString()]),
    b.blockers.map((x) => [x.q, x.r, x.hitT.n.toString(), x.hitT.d.toString()]),
  );
});

test('computeViewshed 包含观测格，且每格结论与 queryLos 一致；视距外不可见', () => {
  const map = testMap({ visionRange: 2, obstacles: [{ q: 1, r: 0, kind: 'wall' }] });
  const vs = computeViewshed(map, { q: 0, r: 0 }, 2);
  assert.ok(vs.visible.has('0,0'));
  for (const [k, los] of vs.results) {
    assert.equal(vs.visible.has(k), los.clear);
  }
  // 距离 4 的格不在 results 中。
  assert.equal(vs.results.has('4,0'), false);
  // 邻居墙本身：视线到墙格不被“自己”挡（目标格排除），因此墙格可见。
  assert.ok(vs.visible.has('1,0'));
  // 墙后距离 2 的 (2,0) 应被墙挡住。
  assert.equal(vs.visible.has('2,0'), false);
});
