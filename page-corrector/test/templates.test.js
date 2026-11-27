import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDefaultTemplate,
  normalizeConfig,
  loadTemplate,
  saveTemplate,
  loadOverrides,
  saveOverride,
  clearOverride,
  resolveConfig,
  configSignature,
  pageKeyOf,
  TEMPLATE_STORAGE_KEY,
  OVERRIDES_STORAGE_KEY,
} from '../src/core/templates.js';

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test('template and overrides use independent storage keys', () => {
  assert.notEqual(TEMPLATE_STORAGE_KEY, OVERRIDES_STORAGE_KEY);
  const storage = memoryStorage();
  const tpl = { ...createDefaultTemplate(), name: '目录模板A' };
  saveTemplate(storage, tpl);
  let overrides = loadOverrides(storage);
  overrides = saveOverride(storage, overrides, 'page-1', { outputWidth: 800 });

  const rawKeys = [...storage._map.keys()];
  assert.ok(rawKeys.includes(TEMPLATE_STORAGE_KEY));
  assert.ok(rawKeys.includes(OVERRIDES_STORAGE_KEY));

  // 清掉覆盖不影响模板
  clearOverride(storage, loadOverrides(storage), 'page-1');
  const reloadedTpl = loadTemplate(storage);
  assert.equal(reloadedTpl.name, '目录模板A');
  assert.equal(Object.keys(loadOverrides(storage)).length, 0);
});

test('resolveConfig falls back to template and prefers override', () => {
  const tpl = createDefaultTemplate();
  tpl.outputWidth = 2000;
  const overrides = { k1: normalizeConfig({ outputWidth: 900 }) };

  const a = resolveConfig(tpl, overrides, 'missing');
  assert.equal(a.source, 'template');
  assert.equal(a.config.outputWidth, 2000);

  const b = resolveConfig(tpl, overrides, 'k1');
  assert.equal(b.source, 'override');
  assert.equal(b.config.outputWidth, 900);
});

test('normalizeConfig repairs malformed JSON', () => {
  const cfg = normalizeConfig({
    outputWidth: 'not-a-number',
    maskColor: 'red',
    cornersNormalized: 'nope',
    regions: [
      { type: 'mask', x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
      { type: 'bad', x: 0, y: 0, w: 0, h: 0 },
    ],
  });
  assert.equal(cfg.outputWidth, 1654);
  assert.equal(cfg.maskColor, '#ffffff');
  assert.equal(cfg.cornersNormalized.length, 4);
  assert.equal(cfg.regions.length, 1);
  assert.equal(cfg.regions[0].type, 'mask');
});

test('configSignature changes only when effective settings change', () => {
  const a = createDefaultTemplate();
  const b = createDefaultTemplate();
  assert.equal(configSignature(a), configSignature(b));

  const c = createDefaultTemplate();
  c.outputWidth = 999;
  assert.notEqual(configSignature(a), configSignature(c));

  const d = createDefaultTemplate();
  d.cornersNormalized[0].x += 1e-9; // 低于签名精度，不应失效
  assert.equal(configSignature(a), configSignature(d));
});

test('pageKeyOf is stable for file metadata', () => {
  assert.equal(pageKeyOf({ name: 'a.jpg', size: 10, lastModified: 123 }), 'a.jpg#10#123');
  assert.equal(pageKeyOf({ key: 'fixed' }), 'fixed');
});
