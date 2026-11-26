import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('every static element id referenced by app.js exists in index.html', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const referenced = [...app.matchAll(/\$\('([A-Za-z0-9_]+)'\)/g)].map((match) => match[1]);
  const missing = [...new Set(referenced)].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, []);

  for (const id of ['cropCol0', 'cropRow0', 'cropCol1', 'cropRow1']) {
    assert.ok(htmlIds.has(id), `${id} should exist for dynamic crop bindings`);
  }
});
