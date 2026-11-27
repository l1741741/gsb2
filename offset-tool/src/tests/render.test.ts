/**
 * 离屏渲染与 PNG 管线测试。
 * 不做像素快照比对（脆弱），只验证：输出是合法 PNG、尺寸正确、
 * 同输入两次渲染字节一致（确定性）、不同距离产出不同图像。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HeadlessCanvas,
  drawScene,
  DEFAULT_SCENE_OPTIONS,
  DEFAULT_PARAMS,
  slitPlate,
  offsetContours,
  validateContour,
  selfIntersectingBowtie,
} from '../index.js';

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function render(input: ReturnType<typeof slitPlate>, distance: number): Buffer {
  const validation = validateContour(input);
  const result = validation.valid
    ? offsetContours(input.loops, { ...DEFAULT_PARAMS, distance })
    : null;
  const canvas = new HeadlessCanvas(320, 320);
  drawScene(canvas, { inputLoops: input.loops, result, validation }, DEFAULT_SCENE_OPTIONS);
  return canvas.toPng();
}

test('PNG 输出带正确签名与 IHDR 尺寸', () => {
  const png = render(slitPlate(), -3);
  assert.ok(png.subarray(0, 8).equals(PNG_SIG));
  // IHDR：宽高各 4 字节，位于偏移 16..24
  assert.equal(png.readUInt32BE(16), 320);
  assert.equal(png.readUInt32BE(20), 320);
  assert.ok(png.length > 1000);
  // 末尾 12 字节为 IEND 块：4 字节长度(0) + 'IEND' + 4 字节 CRC
  assert.ok(png.subarray(png.length - 8, png.length - 4).equals(Buffer.from('IEND', 'ascii')));
  assert.equal(png.readUInt32BE(png.length - 12), 0);
});

test('同输入两次 PNG 渲染字节一致', () => {
  const a = render(slitPlate(), -3);
  const b = render(slitPlate(), -3);
  assert.ok(b.equals(a));
});

test('不同距离产生不同图像', () => {
  const a = render(slitPlate(), 0);
  const b = render(slitPlate(), -6);
  assert.ok(!b.equals(a));
});

test('自交轮廓仍可渲染问题标记图（不调用偏移）', () => {
  const input = selfIntersectingBowtie();
  const validation = validateContour(input);
  assert.equal(validation.valid, false);
  const canvas = new HeadlessCanvas(320, 320);
  drawScene(
    canvas,
    { inputLoops: input.loops, result: null, validation },
    DEFAULT_SCENE_OPTIONS,
  );
  const png = canvas.toPng();
  assert.ok(png.subarray(0, 8).equals(PNG_SIG));
});
