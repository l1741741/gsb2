import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEX_DIRECTIONS,
  addHex,
  axialRound,
  axialToPixel,
  fromUV,
  hexDistance,
  hexRadiusTiles,
  neighbors,
  pixelToAxialFloat,
  pixelToHex,
  toUV,
  uvToPixel,
} from '../src/hex.js';

test('UV 整数坐标与轴坐标可逆', () => {
  for (const q of [-6, -1, 0, 2, 6]) {
    for (const r of [-6, 0, 3, 6]) {
      const uv = toUV({ q, r });
      assert.equal(uv.u, 2 * q + r);
      assert.equal(uv.v, 3 * r);
      const back = fromUV(uv);
      assert.deepEqual(back, { q, r });
    }
  }
  // 非格心 UV 应被识别为非法。
  assert.equal(fromUV({ u: 1, v: 1 }), null); // v 不是 3 的倍数
  assert.equal(fromUV({ u: 2, v: 3 }), null); // u-r 奇偶不符
});

test('六个邻居都距离 1 且互异，往返一致', () => {
  const o = { q: 2, r: -3 };
  const ns = neighbors(o);
  assert.equal(ns.length, 6);
  const keys = new Set(ns.map((n) => `${n.q},${n.r}`));
  assert.equal(keys.size, 6);
  for (const n of ns) assert.equal(hexDistance(o, n), 1);
  // 每个方向的反方向也在方向表中。
  for (const d of HEX_DIRECTIONS) {
    const back = addHex(addHex(o, d), { q: -d.q, r: -d.r });
    assert.deepEqual(back, o);
  }
});

test('hexDistance 满足对称与已知值', () => {
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: 3, r: -3 }), 3);
  assert.equal(hexDistance({ q: 0, r: 0 }, { q: -2, r: 4 }), 4);
  const a = { q: 1, r: 2 };
  const b = { q: -3, r: 1 };
  assert.equal(hexDistance(a, b), hexDistance(b, a));
});

test('半径 N 的六边形包含 1+3N(N+1) 格', () => {
  for (const R of [1, 2, 5]) {
    assert.equal(hexRadiusTiles(R).length, 1 + 3 * R * (R + 1));
  }
});

test('像素 <-> 轴坐标往返（含 UV 像素映射）', () => {
  const size = 28;
  for (const h of hexRadiusTiles(4)) {
    const p = axialToPixel(h, size);
    const back = pixelToHex(p, size);
    assert.deepEqual(back, h);
    // UV->像素 与 axial->像素 必须一致。
    const p2 = uvToPixel(toUV(h), size);
    assert.ok(Math.abs(p.x - p2.x) < 1e-9);
    assert.ok(Math.abs(p.y - p2.y) < 1e-9);
  }
  // 浮点逆变换后舍入应回到原格。
  const f = pixelToAxialFloat(axialToPixel({ q: 2, r: -1 }, size), size);
  assert.deepEqual(axialRound(f), { q: 2, r: -1 });
});
