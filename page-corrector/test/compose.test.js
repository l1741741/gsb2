import test from 'node:test';
import assert from 'node:assert/strict';

import { composePage, hexToRgb, fillRectRGBA } from '../src/core/compose.js';
import { createDefaultTemplate } from '../src/core/templates.js';

function makeImage(width, height, painter) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = painter(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

test('hexToRgb parses 3/6 digit hex and falls back to white', () => {
  assert.deepEqual(hexToRgb('#ff0000'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hexToRgb('#0f0'), { r: 0, g: 255, b: 0 });
  assert.deepEqual(hexToRgb('nope'), { r: 255, g: 255, b: 255 });
});

test('fillRectRGBA fills only requested pixels', () => {
  const img = makeImage(4, 4, () => [0, 0, 0]);
  fillRectRGBA(img, 1, 1, 2, 1, '#ffffff');
  const at = (x, y) => img.data[(y * 4 + x) * 4];
  assert.equal(at(0, 0), 0);
  assert.equal(at(1, 1), 255);
  assert.equal(at(2, 1), 255);
  assert.equal(at(3, 1), 0);
  assert.equal(at(1, 2), 0);
});

test('composePage warps full-frame quad and bakes mask regions', async () => {
  // 8x10 源图，四角即全图；输出宽度 8 -> 高度按 A4 比例约 11
  const source = makeImage(8, 10, (x) => (x < 4 ? [200, 30, 30] : [30, 30, 200]));
  const config = createDefaultTemplate();
  config.cornersNormalized = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  config.outputWidth = 8;
  config.ratio = { id: 'custom', w: 4, h: 5 }; // ratio 0.8 -> outH = 10
  config.maskColor = '#00ff00';
  config.regions = [
    { id: 'm1', type: 'mask', x: 0, y: 0, w: 0.5, h: 0.5, enabled: true },
    { id: 'keep1', type: 'keep', x: 0.6, y: 0.6, w: 0.2, h: 0.2, enabled: true },
  ];

  const { image, width, height } = await composePage(source, config, { yieldRows: 1 });
  assert.equal(width, 8);
  assert.equal(height, 10);

  // 左上 2x2 区域应被绿色遮挡覆盖
  const px = (x, y) => {
    const i = (y * width + x) * 4;
    return [image.data[i], image.data[i + 1], image.data[i + 2]];
  };
  assert.deepEqual(px(1, 1), [0, 255, 0]);
  // 右下未遮挡区应保留蓝/红内容而非绿色
  const lower = px(6, 8);
  assert.notDeepEqual(lower, [0, 255, 0]);
});
