// dom-smoke.mjs — 临时 DOM 装配/交互冒烟（不纳入 npm test）。
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fitCamera } from '../dist/render.js';
import { axialToPixel } from '../dist/hex.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost:4177/',
  pretendToBeVisual: true,
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
window.requestAnimationFrame = globalThis.requestAnimationFrame;

// Canvas 2D mock（Proxy 兜底所有方法）
const grad = { addColorStop() {} };
const ctxTarget = {
  measureText: (t) => ({ width: String(t).length * 7 }),
  createLinearGradient: () => grad,
  createRadialGradient: () => grad,
  getContext: undefined,
};
const ctx = new Proxy(ctxTarget, {
  get(t, p) {
    if (p in t) return t[p];
    return () => {};
  },
  set(t, p, v) {
    t[p] = v;
    return true;
  },
});
window.HTMLCanvasElement.prototype.getContext = () => ctx;
window.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
  left: 0, top: 0, x: 0, y: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON() {},
});

class RO { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = RO;
window.ResizeObserver = RO;

// 让画布容器有布局尺寸
const wrap = document.getElementById('canvasWrap');
Object.defineProperty(wrap, 'clientWidth', { value: 1400, configurable: true });
Object.defineProperty(wrap, 'clientHeight', { value: 900, configurable: true });

// fetch 读本地地图
globalThis.fetch = async (url) => {
  const file = String(url).includes('ridgeline') ? 'ridgeline.json' : 'open-plain.json';
  const json = JSON.parse(readFileSync(new URL(`../maps/${file}`, import.meta.url), 'utf8'));
  return { ok: true, status: 200, json: async () => json };
};
window.alert = (m) => { console.log('[alert]', m); };
window.HTMLAnchorElement.prototype.click = () => {};
if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:mock';
window.URL.revokeObjectURL = () => {};

await import('../dist/main.js');
await new Promise((r) => setTimeout(r, 300));

const $ = (id) => document.getElementById(id);
const click = (id) => $(id).dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

assert.match($('levelName').textContent, /风语/);
assert.equal($('beaconList').children.length, 3);
assert.equal($('budgetLeft').textContent, '10');
assert.equal($('observeBtn').disabled, false);
console.log('✔ 启动渲染 HUD：', $('levelName').textContent, $('budgetLeft').textContent);

// 观测：起点只能发现 near
click('observeBtn');
await tick();
assert.equal($('budgetLeft').textContent, '8');
assert.equal($('beaconProgress').textContent, '1/3');
console.log('✔ 观测后预算 8，进度 1/3');

// 撤回：预算与发现还原
click('btnUndo');
await tick();
assert.equal($('budgetLeft').textContent, '10');
assert.equal($('beaconProgress').textContent, '0/3');
console.log('✔ 撤回还原预算与发现');

// 走到合法邻居 (1,2)
const map = JSON.parse(readFileSync(new URL('../maps/open-plain.json', import.meta.url), 'utf8'));
const cam = fitCamera(map, 1400, 900);
const center = axialToPixel({ q: 1, r: 2 }, cam.size);
const cx = center.x + cam.ox;
const cy = center.y + cam.oy;
$('game').dispatchEvent(new window.MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
await tick();
assert.equal($('statMoves').textContent, '1', '点击合法格应移动一步');
assert.equal($('budgetLeft').textContent, '9');
console.log('✔ 画布点击合法格移动，预算 9');

// 点一个非相邻格 -> 检视面板出裁定与动态按钮
const hx = axialToPixel({ q: 3, r: -3 }, cam.size);
$('game').dispatchEvent(new window.MouseEvent('click', {
  clientX: hx.x + cam.ox, clientY: hx.y + cam.oy, bubbles: true,
}));
await tick();
assert.match($('inspector').textContent, /坐标/);
assert.ok(document.getElementById('insQueryB'), '应生成“查勘测员→此格”按钮');
document.getElementById('insQueryB').click();
await tick();
assert.match($('queryResult').textContent, /视线|阻挡|畅通/);
console.log('✔ 检视面板与“查勘测员→此格”裁定可用');

// 查询模式：A=勘测员，再点 dune，应给出高度裁定
click('modeQuery');
click('queryUsePlayer');
const dune = map.beacons.find((b) => b.id === 'dune');
const dp = axialToPixel(dune, cam.size);
$('game').dispatchEvent(new window.MouseEvent('click', {
  clientX: dp.x + cam.ox, clientY: dp.y + cam.oy, bubbles: true,
}));
await tick();
assert.match($('queryResult').textContent, /阻挡|畅通/);
console.log('✔ 任意视线查询出结果');

// 提示
click('btnHint');
await tick();
assert.ok($('message').textContent.length > 0);
console.log('✔ 提示：', $('message').textContent.slice(0, 40));

// 保存（锚点点击已打桩）
click('btnSave');
await tick();
assert.match($('message').textContent, /存档/);
console.log('✔ 保存存档流程触发');

// 回放
click('btnReplay');
await tick();
assert.equal($('replayBar').hidden, false);
const max = Number($('replayRange').max);
assert.ok(max >= 1);
$('replayNext').click();
await tick();
assert.match($('replayLabel').textContent, /^1 \//);
assert.equal(Number($('replayRange').value), 1);
click('replayClose');
await tick();
assert.equal($('replayBar').hidden, true);
console.log('✔ 回放条步进与关闭正常（行动数', max, '）');

// 切到山脊关
const tabs = [...document.querySelectorAll('.level-tab')];
const ridgeTab = tabs.find((t) => /断脊/.test(t.textContent));
assert.ok(ridgeTab, '应有山脊关标签');
ridgeTab.click();
await tick();
assert.match($('levelName').textContent, /断脊/);
assert.equal($('budgetLeft').textContent, '15');
assert.equal($('beaconProgress').textContent, '0/3');
console.log('✔ 切换山脊关，预算 15');

console.log('\nDOM 冒烟全部通过 ✅');
process.exit(0);

function tick() {
  return new Promise((r) => setTimeout(r, 40));
}
