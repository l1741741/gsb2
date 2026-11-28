import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeWall,
  validateWall,
  wallSpanDeg,
  isFullCircle,
  arcLengthMm,
  normalizeArcMm,
  angleAtArcMm,
  arcAtAngleDeg,
  artworkCoverageAtArc,
  validateArtwork,
  anchorEdgeDistances,
  validateAnchors,
  projectPoint,
} from '../src/geometry.js';

const partialWall = makeWall({ radiusMm: 3000, startAngleDeg: 20, endAngleDeg: 200, heightMm: 2600 });
const fullWall = makeWall({ radiusMm: 2500, startAngleDeg: 0, endAngleDeg: 360, heightMm: 2400 });

test('展开长度 = 半径 × 弧度跨度', () => {
  assert.ok(Math.abs(arcLengthMm(partialWall) - 3000 * Math.PI) < 1e-6);
  assert.ok(Math.abs(arcLengthMm(fullWall) - 2500 * 2 * Math.PI) < 1e-6);
  assert.equal(wallSpanDeg(partialWall), 180);
  assert.ok(isFullCircle(fullWall));
  assert.ok(!isFullCircle(partialWall));
});

test('非法角被逐条指出', () => {
  assert.deepEqual(validateWall({ radiusMm: 3000, startAngleDeg: 200, endAngleDeg: 100, heightMm: 2600 })
    .some((e) => e.includes('结束角必须大于起始角')), true);
  assert.deepEqual(validateWall({ radiusMm: 3000, startAngleDeg: 0, endAngleDeg: 400, heightMm: 2600 })
    .some((e) => e.includes('不能超过 360')), true);
  assert.deepEqual(validateWall({ radiusMm: 0, startAngleDeg: 0, endAngleDeg: 90, heightMm: 2600 })
    .some((e) => e.includes('半径')), true);
  assert.throws(() => makeWall({ radiusMm: -1, startAngleDeg: 0, endAngleDeg: 90, heightMm: 100 }), /半径/);
});

test('满圈时弧长按周长回绕，跨缝接续', () => {
  const length = arcLengthMm(fullWall);
  assert.ok(Math.abs(normalizeArcMm(fullWall, length + 120) - 120) < 1e-9);
  assert.ok(Math.abs(normalizeArcMm(fullWall, -30) - (length - 30)) < 1e-9);
  // 角度同样回绕：370° 落在 10° 处
  assert.ok(Math.abs(arcAtAngleDeg(fullWall, 370) - arcAtAngleDeg(fullWall, 10)) < 1e-9);
});

test('不足一圈时越界返回 null，空白区不重复贴图', () => {
  const length = arcLengthMm(partialWall);
  assert.equal(normalizeArcMm(partialWall, length + 1), null);
  assert.equal(normalizeArcMm(partialWall, -1), null);
  assert.equal(arcAtAngleDeg(partialWall, 10), null); // 起始角 20° 之外
  assert.equal(angleAtArcMm(partialWall, length + 1), null);
});

test('跨起止缝的画面在满圈墙上正常接续', () => {
  const length = arcLengthMm(fullWall);
  const artwork = { offsetMm: length - 500, widthMm: 1000, bottomMm: 0, heightMm: 2400 };
  // 缝前 100mm：u 接近 0.9；缝后 100mm（即弧长 100）：u 接近 0.6 —— 同一条带连续
  const before = artworkCoverageAtArc(fullWall, artwork, length - 100);
  const after = artworkCoverageAtArc(fullWall, artwork, 100);
  assert.ok(Math.abs(before.u - 0.4) < 1e-9);
  assert.ok(Math.abs(after.u - 0.6) < 1e-9);
  // 画面之外的墙面为空白
  assert.equal(artworkCoverageAtArc(fullWall, artwork, 2000), null);
});

test('不足一圈时画面不外溢、不重复', () => {
  const artwork = { offsetMm: 500, widthMm: 1000, bottomMm: 0, heightMm: 2000 };
  assert.equal(artworkCoverageAtArc(partialWall, artwork, 400), null); // 画面左侧空白
  assert.equal(artworkCoverageAtArc(partialWall, artwork, 1600), null); // 画面右侧空白
  assert.equal(artworkCoverageAtArc(partialWall, artwork, arcLengthMm(partialWall) + 700), null); // 墙外
  assert.ok(Math.abs(artworkCoverageAtArc(partialWall, artwork, 1000).u - 0.5) < 1e-9);
  // 不足一圈时画面越界属于非法布置
  const errors = validateArtwork(partialWall, { offsetMm: 9000, widthMm: 1000, bottomMm: 0, heightMm: 2000 });
  assert.ok(errors.some((e) => e.includes('不足一圈')));
});

test('定位点到墙边距离与观察方向无关（翻面不反转测量）', () => {
  const anchor = { id: 'A', arcMm: 1200, heightMm: 300 };
  const d = anchorEdgeDistances(partialWall, anchor);
  assert.ok(Math.abs(d.toStartEdgeMm - 1200) < 1e-9);
  assert.ok(Math.abs(d.toEndEdgeMm - (arcLengthMm(partialWall) - 1200)) < 1e-9);
  assert.ok(Math.abs(d.toBottomMm - 300) < 1e-9);
  assert.ok(Math.abs(d.toTopMm - 2300) < 1e-9);
  // 翻面只镜像屏幕投影，距离读数不变
  const front = projectPoint(partialWall, anchor.arcMm, anchor.heightMm, { side: 'front' });
  const back = projectPoint(partialWall, anchor.arcMm, anchor.heightMm, { side: 'back' });
  assert.ok(Math.abs(front.x + back.x) < 1e-9);
  assert.deepEqual(anchorEdgeDistances(partialWall, anchor), d);
});

test('相互冲突与越界的定位点被明确指出', () => {
  const errors = validateAnchors(partialWall, [
    { id: 'A', arcMm: 1000, heightMm: 500 },
    { id: 'B', arcMm: 1000.4, heightMm: 500.2 }, // 与 A 相距不足 1mm
    { id: 'C', arcMm: 99999, heightMm: 100 }, // 水平越界
    { id: 'D', arcMm: 100, heightMm: 99999 }, // 高度越界
    { id: 'A', arcMm: 2000, heightMm: 800 }, // id 重复
  ]);
  assert.ok(errors.some((e) => e.includes('A 与 B') && e.includes('冲突')));
  assert.ok(errors.some((e) => e.includes('C') && e.includes('水平位置超出')));
  assert.ok(errors.some((e) => e.includes('D') && e.includes('高度超出')));
  assert.ok(errors.some((e) => e.includes('id 重复')));
});

test('角度与弧长互转往返一致', () => {
  for (const arc of [0, 1234.5, arcLengthMm(partialWall)]) {
    const angle = angleAtArcMm(partialWall, arc);
    assert.ok(Math.abs(arcAtAngleDeg(partialWall, angle) - arc) < 1e-6);
  }
});
