import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateQuad,
  rejectionHint,
  findHomography,
  invertMatrix3,
  mapPoint,
  sourcePixelsToPaperNorm,
  paperNormToSourcePixels,
  warpImage,
  outputPixelsToSourceHomography,
  defaultMinDistance,
  normalizedCornersToPixels,
} from '../src/core/geometry.js';

const rect = [
  { x: 10, y: 10 },
  { x: 110, y: 12 },
  { x: 108, y: 110 },
  { x: 12, y: 108 },
];

test('validateQuad accepts a normal convex quad', () => {
  const issues = validateQuad(rect, { minDistance: 5 });
  assert.deepEqual(issues, []);
});

test('validateQuad rejects nearly coincident corners and names the pair', () => {
  const corners = rect.map((p) => ({ ...p }));
  corners[1] = { x: 12, y: 11 }; // 靠近左上角
  const issues = validateQuad(corners, { minDistance: 20 });
  const coincident = issues.filter((i) => i.code === 'coincident');
  assert.ok(coincident.length >= 1);
  assert.deepEqual(coincident[0].corners, [0, 1]);

  const hint = rejectionHint(issues, 1);
  assert.match(hint.message, /右上角/);
  assert.match(hint.message, /左上角/);
  assert.ok(hint.badCorners.includes(0));
  assert.ok(hint.badCorners.includes(1));
});

test('validateQuad rejects crossed opposite edges (bowtie)', () => {
  // 把右下角拖到左上区域，使顶边/底边或左右边交叉
  const corners = [
    { x: 20, y: 20 },
    { x: 180, y: 20 },
    { x: 30, y: 170 }, // BR 跑到 BL 左边 -> 交叉
    { x: 170, y: 180 },
  ];
  const issues = validateQuad(corners, { minDistance: 5 });
  assert.ok(issues.some((i) => i.code === 'crossed'));
  const hint = rejectionHint(issues, 2);
  assert.match(hint.message, /交叉/);
  assert.match(hint.message, /右下角/);
});

test('validateQuad flags a concave corner', () => {
  const corners = [
    { x: 20, y: 20 },
    { x: 180, y: 20 },
    { x: 90, y: 90 }, // 凹进去的右下角
    { x: 20, y: 180 },
  ];
  const issues = validateQuad(corners, { minDistance: 5 });
  assert.ok(issues.some((i) => i.code === 'concave' && i.corners[0] === 2));
  const hint = rejectionHint(issues, 2);
  assert.match(hint.message, /右下角/);
  assert.match(hint.message, /内凹/);
});

test('defaultMinDistance scales with image diagonal', () => {
  assert.equal(defaultMinDistance(1000, 1000), 0.02 * Math.hypot(1000, 1000));
});

test('findHomography maps an axis-aligned rectangle exactly (scale + translate)', () => {
  const src = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  const dst = [
    { x: 10, y: 20 },
    { x: 110, y: 20 },
    { x: 110, y: 220 },
    { x: 10, y: 220 },
  ];
  const H = findHomography(src, dst);
  for (const [s, d] of [
    [src[0], dst[0]],
    [src[1], dst[1]],
    [src[2], dst[2]],
    [src[3], dst[3]],
    [{ x: 0.5, y: 0.5 }, { x: 60, y: 120 }],
  ]) {
    const got = mapPoint(H, s.x, s.y);
    assert.ok(Math.abs(got.x - d.x) < 1e-7, `x ${got.x} != ${d.x}`);
    assert.ok(Math.abs(got.y - d.y) < 1e-7, `y ${got.y} != ${d.y}`);
  }
});

test('homography inverse and paper/source maps round-trip', () => {
  const H = sourcePixelsToPaperNorm(rect);
  const Hinv = paperNormToSourcePixels(rect);
  const product = H.map((_, i) => {
    const r = Math.floor(i / 3);
    const c = i % 3;
    let sum = 0;
    for (let k = 0; k < 3; k += 1) sum += H[r * 3 + k] * Hinv[k * 3 + c];
    return sum;
  });
  for (let i = 0; i < 9; i += 1) {
    const expected = i % 4 === 0 ? 1 : 0; // 对角位置 0,4,8
    assert.ok(Math.abs(product[i] - expected) < 1e-7, `product[${i}]=${product[i]}`);
  }

  for (const p of [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]) {
    const source = mapPoint(Hinv, p.x, p.y);
    const back = mapPoint(H, source.x, source.y);
    assert.ok(Math.abs(back.x - p.x) < 1e-9);
    assert.ok(Math.abs(back.y - p.y) < 1e-9);
  }
});

test('invertMatrix3 inverts a known matrix', () => {
  const m = [2, 0, 0, 0, 3, 0, 0, 0, 1];
  const inv = invertMatrix3(m);
  assert.ok(Math.abs(inv[0] - 0.5) < 1e-12);
  assert.ok(Math.abs(inv[4] - 1 / 3) < 1e-12);
  assert.ok(Math.abs(inv[8] - 1) < 1e-12);
});

test('normalizedCornersToPixels scales by width/height', () => {
  const px = normalizedCornersToPixels([{ x: 0.5, y: 0.25 }], 200, 400);
  assert.deepEqual(px, [{ x: 100, y: 100 }]);
});

function makeImage(width, height, painter) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a = 255] = painter(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  }
  return { width, height, data };
}

test('warpImage identity 1:1 preserves texel colors at pixel centers', async () => {
  // 2x2 四色图，输出也是 2x2，角点即整图边界 -> 恒等映射
  const src = makeImage(2, 2, (x, y) => {
    if (x === 0 && y === 0) return [255, 0, 0];
    if (x === 1 && y === 0) return [0, 255, 0];
    if (x === 0 && y === 1) return [0, 0, 255];
    return [255, 255, 0];
  });
  const corners = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ];
  const H = outputPixelsToSourceHomography(corners, 2, 2);
  const out = await warpImage(src, H, 2, 2, { yieldRows: 1 });
  const px = (x, y) => {
    const i = (y * 2 + x) * 4;
    return [out.data[i], out.data[i + 1], out.data[i + 2]];
  };
  assert.deepEqual(px(0, 0), [255, 0, 0]);
  assert.deepEqual(px(1, 0), [0, 255, 0]);
  assert.deepEqual(px(0, 1), [0, 0, 255]);
  assert.deepEqual(px(1, 1), [255, 255, 0]);
});

test('warpImage with transparent edge sets outside pixels alpha 0', async () => {
  const src = makeImage(2, 2, () => [255, 255, 255, 255]);
  // 目标四角映射到源图中央 1x1 区域，目标 4x4 的外圈必然在源图 [0,1] 范围之外
  const H = findHomography(
    [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 4 },
      { x: 0, y: 4 },
    ],
    [
      { x: 0.5, y: 0.5 },
      { x: 1.5, y: 0.5 },
      { x: 1.5, y: 1.5 },
      { x: 0.5, y: 1.5 },
    ],
  );
  const out = await warpImage(src, H, 4, 4, { edge: 'transparent', yieldRows: 1 });
  // 角落输出像素中心 (0.5,0.5) 经映射后落在源图 0.5 处，恰在边界内；
  // 取明确的外角区域验证：构造一个把整张目标映射到源图负坐标的矩阵更直接。
  const Houtside = findHomography(
    [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ],
    [
      { x: -5, y: -5 },
      { x: -4, y: -5 },
      { x: -4, y: -4 },
      { x: -5, y: -4 },
    ],
  );
  const out2 = await warpImage(src, Houtside, 2, 2, { edge: 'transparent', yieldRows: 1 });
  assert.equal(out2.data[3], 0);
  assert.equal(out2.data[(1 * 2 + 1) * 4 + 3], 0);
  assert.ok(out);
});

test('warpImage honours cancellation token', async () => {
  const src = makeImage(8, 8, () => [10, 20, 30]);
  const corners = [
    { x: 0, y: 0 },
    { x: 8, y: 0 },
    { x: 8, y: 8 },
    { x: 0, y: 8 },
  ];
  const H = outputPixelsToSourceHomography(corners, 8, 8);
  const signal = { cancelled: true };
  await assert.rejects(
    () => warpImage(src, H, 8, 8, { signal, yieldRows: 1 }),
    /取消/,
  );
});
