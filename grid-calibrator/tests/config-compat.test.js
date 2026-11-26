import test from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig, serializeConfig } from '../src/config.js';
import { recomputeFit } from '../src/calibration.js';
import { DEFAULT_WARP, createSyntheticPoints } from '../src/distortion.js';
import { checkImageDimensions, checkpointKeys, createDocument } from '../src/state.js';
import { hashFrame, renderCorrection } from '../src/warp.js';

function fittedDocument() {
  const keys = checkpointKeys(DEFAULT_WARP.columns, DEFAULT_WARP.rows);
  const points = createSyntheticPoints(DEFAULT_WARP, (col, row) => (
    keys.has(`${col}:${row}`) ? 'check' : 'fit'
  ));
  const doc = createDocument({
    image: {
      name: 'grid.png',
      width: DEFAULT_WARP.width,
      height: DEFAULT_WARP.height,
      dataUrl: 'data:image/png;base64,placeholder',
    },
    columns: DEFAULT_WARP.columns,
    rows: DEFAULT_WARP.rows,
    points,
    cellPx: 24,
  });
  const result = recomputeFit(doc);
  assert.equal(result.ok, true);
  return result.doc;
}

function patternedSource(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = x % 256;
      data[i + 1] = y % 256;
      data[i + 2] = (x + y) % 256;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

test('saved and restored calibration produces identical corrected pixels', () => {
  const doc = fittedDocument();
  const config = serializeConfig(doc);
  const restored = parseConfig(JSON.stringify(config));

  assert.deepEqual(restored.activeModel, doc.activeModel);
  assert.deepEqual(restored.output, doc.output);
  assert.equal(restored.points.length, doc.points.length);

  const source = patternedSource(DEFAULT_WARP.width, DEFAULT_WARP.height);
  const before = renderCorrection(source, doc.activeModel, doc.output);
  const after = renderCorrection(source, restored.activeModel, restored.output);

  assert.equal(after.width, before.width);
  assert.equal(after.height, before.height);
  assert.equal(hashFrame(after), hashFrame(before));
  assert.deepEqual(after.data, before.data);
});

test('configuration parser rejects foreign or unsupported files', () => {
  assert.throws(() => parseConfig({ app: 'something-else' }), /不是本工具/);
  assert.throws(
    () => parseConfig({ app: 'grid-calibrator', configVersion: 99, grid: {}, points: [] }),
    /版本/,
  );
});

test('different image dimensions are reported as an explicit mismatch', () => {
  const doc = fittedDocument();
  const ok = checkImageDimensions({ width: 960, height: 720 }, doc.image);
  const bad = checkImageDimensions({ width: 1200, height: 900 }, doc.image);
  assert.equal(ok.compatible, true);
  assert.equal(bad.compatible, false);
  assert.equal(bad.code, 'dimension_mismatch');
  assert.match(bad.message, /尺寸不匹配/);
});
