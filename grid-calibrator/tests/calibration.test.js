import test from 'node:test';
import assert from 'node:assert/strict';

import { recomputeFit } from '../src/calibration.js';
import { DEFAULT_WARP, SAMPLE_OUTPUT, createSyntheticPoints, measureWarp } from '../src/distortion.js';
import { checkpointKeys, createDocument } from '../src/state.js';
import { largestValidRectangle, renderCorrection } from '../src/warp.js';

function syntheticDocument() {
  const keys = checkpointKeys(DEFAULT_WARP.columns, DEFAULT_WARP.rows);
  const points = createSyntheticPoints(DEFAULT_WARP, (col, row) => (
    keys.has(`${col}:${row}`) ? 'check' : 'fit'
  ));
  return createDocument({
    image: { width: DEFAULT_WARP.width, height: DEFAULT_WARP.height },
    columns: DEFAULT_WARP.columns,
    rows: DEFAULT_WARP.rows,
    points,
  });
}

test('built-in warp has measurable center versus edge/corner motion', () => {
  const measurement = measureWarp(DEFAULT_WARP);
  assert.ok(measurement.edgeMeanDisplacement > 8);
  assert.ok(measurement.cornerMaxDisplacement > measurement.edgeMeanDisplacement);
  assert.ok(measurement.edgeMeanDisplacement > measurement.centerDisplacement + 5);
});

test('synthetic bent grid fits and held-out center/edge checkpoints have small residuals', () => {
  const result = recomputeFit(syntheticDocument());
  assert.equal(result.ok, true, result.doc.fitReport?.message);
  assert.ok(result.doc.activeModel);
  assert.equal(result.doc.fitReport.checkCount >= 5, true);
  assert.ok(result.doc.fitReport.checkRms < 3, `check RMS ${result.doc.fitReport.checkRms}`);
  assert.ok(result.doc.fitReport.regionStats.edge.max < 4);
  assert.ok(result.doc.fitReport.regionStats.center.rms < 2);
});

test('shipped sample output crop exhibits out-of-bounds borders and valid rectangle', () => {
  const fitted = recomputeFit(syntheticDocument());
  assert.equal(fitted.ok, true);
  const source = {
    width: DEFAULT_WARP.width,
    height: DEFAULT_WARP.height,
    data: new Uint8ClampedArray(DEFAULT_WARP.width * DEFAULT_WARP.height * 4).fill(255),
  };
  const frame = renderCorrection(source, fitted.doc.activeModel, SAMPLE_OUTPUT);
  assert.ok(frame.stats.outOfBoundsPixels > 100);
  const rect = largestValidRectangle(frame.valid, frame.width, frame.height);
  assert.ok(rect.width < frame.width || rect.height < frame.height);
  assert.ok(rect.area > frame.width * frame.height * 0.9);
});

test('too few markers do not replace an existing usable model', () => {
  const good = recomputeFit(syntheticDocument());
  assert.equal(good.ok, true);
  const preservedModel = good.doc.activeModel;

  const tooFew = {
    ...good.doc,
    points: good.doc.points.slice(0, 3),
  };
  const result = recomputeFit(tooFew);
  assert.equal(result.ok, false);
  assert.match(result.doc.fitReport.message, /太少/);
  assert.equal(result.doc.activeModel, preservedModel);
  assert.equal(result.doc.fitReport.retained, true);
});

test('clustered corner markers prompt for spread and retain last result', () => {
  const good = recomputeFit(syntheticDocument());
  const preservedModel = good.doc.activeModel;
  const clusteredPoints = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (row === 2 && col === 2) continue;
      clusteredPoints.push({
        id: `cluster_${row}_${col}`,
        row,
        col,
        x: 42 + col * 22,
        y: 48 + row * 24,
        role: 'fit',
      });
    }
  }

  const result = recomputeFit({ ...good.doc, points: clusteredPoints });
  assert.equal(result.ok, false);
  assert.equal(result.assessment.code, 'clustered');
  assert.match(result.doc.fitReport.message, /集中|分布/);
  assert.equal(result.doc.activeModel, preservedModel);
});
