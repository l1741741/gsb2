import test from 'node:test';
import assert from 'node:assert/strict';

import { fitPolynomial } from '../src/math.js';
import {
  largestValidRectangle,
  renderCorrection,
} from '../src/warp.js';

function affineGridModel() {
  const points = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 5; col += 1) {
      points.push({
        id: `${row}-${col}`,
        col,
        row,
        x: 80 + col * 40,
        y: 80 + row * 40,
      });
    }
  }
  return fitPolynomial(points, { degree: 2 });
}

function opaqueSource(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = 180;
    data[i * 4 + 1] = 120;
    data[i * 4 + 2] = 60;
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

test('correction leaves out-of-source pixels transparent and finds valid rectangle', () => {
  const model = affineGridModel();
  const source = opaqueSource(400, 400);
  const output = {
    cellPx: 40,
    crop: { col0: -4, row0: -4, col1: 8, row1: 8 },
  };

  const frame = renderCorrection(source, model, output);
  assert.equal(frame.width, 480);
  assert.equal(frame.height, 480);
  assert.ok(frame.stats.outOfBoundsPixels > 0);

  const cornerAlpha = frame.data[3];
  assert.equal(cornerAlpha, 0);

  const centerIndex = (240 * frame.width + 240) * 4;
  assert.equal(frame.data[centerIndex + 3], 255);
  assert.equal(frame.data[centerIndex], 180);

  const rect = largestValidRectangle(frame.valid, frame.width, frame.height);
  assert.deepEqual(rect, { x: 80, y: 80, width: 399, height: 399, area: 399 * 399 });
  assert.ok(rect.width < frame.width);
});

test('largestValidRectangle handles an all-valid and empty mask', () => {
  const allValid = new Uint8Array(4 * 3).fill(1);
  assert.deepEqual(
    largestValidRectangle(allValid, 4, 3),
    { x: 0, y: 0, width: 4, height: 3, area: 12 },
  );

  const none = new Uint8Array(16);
  assert.equal(largestValidRectangle(none, 4, 4).area, 0);
});
