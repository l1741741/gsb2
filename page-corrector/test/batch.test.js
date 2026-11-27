import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runBatch,
  CancelToken,
  BatchCancelled,
  MemoryResultCache,
  summarizeRecords,
} from '../src/core/batch.js';

const pages = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }];

test('runBatch processes pages sequentially and keeps successful results', async () => {
  const processed = [];
  const records = await runBatch(pages, {
    processPage: async (page) => {
      processed.push(page.id);
      return { ok: page.id };
    },
  });
  assert.deepEqual(processed, ['p1', 'p2', 'p3', 'p4']);
  assert.equal(records.length, 4);
  assert.ok(records.every((r) => r.status === 'success'));
  assert.equal(records[2].result.ok, 'p3');
});

test('cancelling before start marks all remaining pages cancelled but keeps earlier successes', async () => {
  const token = new CancelToken();
  const processed = [];
  const updates = [];
  const promise = runBatch(
    pages,
    {
      onUpdate: (r) => updates.push(r.status),
      processPage: async (page) => {
        processed.push(page.id);
        if (page.id === 'p2') token.cancel('user'); // p2 处理完后取消
        return { ok: page.id };
      },
    },
    token,
  );
  const records = await promise;
  assert.deepEqual(processed, ['p1', 'p2']);
  assert.deepEqual(records.map((r) => r.status), [
    'success',
    'success',
    'cancelled',
    'cancelled',
  ]);
  const summary = summarizeRecords(records);
  assert.equal(summary.success, 2);
  assert.equal(summary.cancelled, 2);
  assert.equal(summary.adoptable, 2);
  // 已成功页结果仍在记录里，可直接采用
  assert.equal(records[0].result.ok, 'p1');
});

test('mid-page BatchCancelled marks current page cancelled and stops subsequent pages', async () => {
  const token = new CancelToken();
  const processed = [];
  const records = await runBatch(pages, {
    processPage: async (page, t) => {
      processed.push(page.id);
      if (page.id === 'p2') {
        t.cancel();
        throw new BatchCancelled();
      }
      return { ok: true };
    },
  }, token);
  assert.deepEqual(processed, ['p1', 'p2']);
  assert.deepEqual(records.map((r) => r.status), [
    'success',
    'cancelled',
    'cancelled',
    'cancelled',
  ]);
});

test('ordinary page errors are recorded and later pages continue', async () => {
  const records = await runBatch(pages, {
    processPage: async (page) => {
      if (page.id === 'p2') throw new Error('解码失败');
      return { id: page.id };
    },
  });
  assert.deepEqual(records.map((r) => r.status), ['success', 'error', 'success', 'success']);
  assert.match(records[1].error, /解码失败/);
});

test('fresh cache hits are reported as cached/adoptable and skip processing', async () => {
  const cache = new MemoryResultCache();
  await cache.set('p1:sig', { png: 'BLOB1' });
  const processed = [];
  const records = await runBatch(
    [{ id: 'p1' }, { id: 'p2' }],
    {
      getCached: async (page) =>
        page.id === 'p1' ? { cacheKey: 'p1:sig', result: await cache.get('p1:sig') } : null,
      processPage: async (page) => {
        processed.push(page.id);
        return { fresh: page.id };
      },
    },
  );
  assert.deepEqual(records.map((r) => r.status), ['cached', 'success']);
  assert.equal(records[0].result.png, 'BLOB1');
  assert.deepEqual(processed, ['p2']);
});
