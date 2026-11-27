import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeuristicTextMeasurer, wrapText } from '../core/text-measurer.js';
import { resolveStyle } from '../core/model.js';

test('启发式测量：全角中文比西文宽，尺寸含内边距', () => {
  const measurer = new HeuristicTextMeasurer();
  const style = resolveStyle({ fontSize: 10, paddingX: 8, paddingY: 4, maxTextWidth: 200 });
  const zh = measurer.measure('中文标签', style);
  const en = measurer.measure('abcd', style);
  assert.ok(zh.width > en.width);
  assert.equal(zh.lines.length, 1);
  assert.ok(zh.width >= 4 * 10 + 16);
});

test('长文本在 maxTextWidth 处换行，显式换行符强制断行', () => {
  const style = resolveStyle({ fontSize: 10, maxTextWidth: 22 });
  const measurer = new HeuristicTextMeasurer();
  const m = measurer.measure('一二三四五六七八九十\n短', style);
  assert.ok(m.lines.length >= 3);
  assert.deepEqual(m.lines.at(-1), '短');
});

test('wrapText 不拆开连续英文单词', () => {
  const style = resolveStyle({ fontSize: 10, maxTextWidth: 100 });
  const lines = wrapText('hello world exhibition', style, (s) => s.length * 5);
  assert.ok(lines.every((line) => !line.includes('  ')));
  assert.ok(lines.join(' ').includes('exhibition'));
});
