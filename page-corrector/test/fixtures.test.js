import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXTURE_KINDS,
  getFixtureTruth,
  allFixtureCheckpointTables,
} from '../src/core/fixtures.js';
import { validateQuad, mapPoint, paperNormToSourcePixels } from '../src/core/geometry.js';

test('every fixture has a valid convex truth quad and several checkpoints', () => {
  assert.deepEqual([...FIXTURE_KINDS].sort(), ['grid-oblique', 'hard-edge', 'inverted'].sort());
  for (const kind of FIXTURE_KINDS) {
    const truth = getFixtureTruth(kind);
    assert.ok(truth.checkpoints.length >= 4, `${kind} 应给出至少 4 个核对点`);
    const issues = validateQuad(truth.cornersPixels, { minDistance: 40 });
    assert.deepEqual(issues, [], `${kind} 真值四角必须合法`);

    // 核对点给出的源坐标必须确实能由纸面坐标经单应投影得到
    for (const cp of truth.checkpoints) {
      const expected = mapPoint(
        paperNormToSourcePixels(truth.cornersPixels),
        cp.paper.x,
        cp.paper.y,
      );
      assert.ok(Math.abs(cp.source.x - expected.x) < 1e-6);
      assert.ok(Math.abs(cp.source.y - expected.y) < 1e-6);
      // 源坐标必须落在画布范围内
      assert.ok(cp.source.x >= 0 && cp.source.x <= truth.sourceWidth);
      assert.ok(cp.source.y >= 0 && cp.source.y <= truth.sourceHeight);
    }

    // 归一化角点与像素角点一致
    truth.cornersNormalized.forEach((p, i) => {
      assert.ok(Math.abs(p.x * truth.sourceWidth - truth.cornersPixels[i].x) < 1e-9);
    });
  }
});

test('checkpoint tables are available for README/UI', () => {
  const tables = allFixtureCheckpointTables();
  assert.equal(tables.length, 3);
  for (const t of tables) {
    assert.ok(t.checkpoints.every((c) => Number.isFinite(c.paperMm.x)));
  }
});
