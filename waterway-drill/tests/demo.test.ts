import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { JSDOM } from 'jsdom';
import { compileLevel } from '../src/level.ts';
import { solveLevel } from '../src/solver.ts';
import { sampleLevels, levelOne, levelTwo } from '../src/levels/index.ts';
import type { GateState } from '../src/types.ts';
import { must, mustInput, mustSelect } from './domQuery.ts';

const ROOT = new URL('..', import.meta.url);
const BROWSER_ENTRY = new URL('src/browser.ts', ROOT).href;

/**
 * 用 jsdom 加载真实的 demo/index.html 与 demo/main.js。
 * 只替换两处浏览器设施：Canvas 2D（用 @napi-rs/canvas 真正光栅化）和控制器里
 * `../build/browser.js` 的 import（改写为一个指向 src/browser.ts 的临时模块）。
 *
 * 这不是为了替代浏览器，而是让“页面接线”在无 GUI 的 CI 环境里也能回归：
 * 点击画布、确认、撤回、导出/导入与拒绝加载，都走真实的 DOM 事件与控制器代码。
 */
async function loadDemoPage() {
  const html = readFileSync(new URL('demo/index.html', ROOT), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/demo/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Canvas 2D 用真实光栅器，绘制代码会被真正执行，而不是被空实现吞掉。
  const contexts = new WeakMap();
  window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
    if (type !== '2d') return null;
    if (!contexts.has(this)) {
      const width = Number(this.getAttribute('width')) || 980;
      const height = Number(this.getAttribute('height')) || 470;
      contexts.set(this, createCanvas(width, height).getContext('2d'));
    }
    return contexts.get(this);
  };

  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    setTimeout(() => callback(0), 0);
    return 0;
  };
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};

  // 把 main.js 的 import 指向 src/browser.ts；临时模块放在系统临时目录。
  const tempDir = mkdtempSync(join(tmpdir(), 'waterway-demo-'));
  const controllerSource = readFileSync(new URL('demo/main.js', ROOT), 'utf8')
    .replace("'../build/browser.js'", `'${BROWSER_ENTRY}'`);
  const controllerPath = join(tempDir, 'main.mjs');
  writeFileSync(controllerPath, controllerSource, 'utf8');

  // jSDOM 的 window 与 Node 的全局类型不完全兼容，测试边界内局部放宽即可。
  Object.assign(globalThis, {
    window,
    document: window.document,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    URL: window.URL,
    Blob: window.Blob,
  });

  await import(pathToFileURL(controllerPath).href);
  tempDirs.push(() => rmSync(tempDir, { recursive: true, force: true }));
  return { window, api: window.__waterway };
}

/** 所有用例的临时目录在测试结束时统一清理，避免污染仓库。 */
const tempDirs: (() => void)[] = [];
test.after(() => { for (const fn of tempDirs) fn(); });

test('demo: 页面加载后渲染出关卡、闸门行与回合读数', async () => {
  const { window, api } = await loadDemoPage();
  const view = api.getView();
  assert.ok(view, '控制器应暴露视图');
  assert.equal(view.levelId, sampleLevels[0].id);
  assert.equal(window.document.querySelectorAll('.gate-row').length, view.gates.length);
  assert.equal(must(window, '#turn-readout').textContent, `0 / ${view.turnLimit}`);
  assert.equal(must(window, '#level-name').textContent, view.levelName);
});

test('demo: 悬停画布高亮闸门，点击布置一条闸门再确认结算', async () => {
  const { window, api } = await loadDemoPage();
  const canvas = must(window, '#scene') as HTMLCanvasElement;

  // jsdom 不会真正布局，给画布一个与画布像素一致的矩形，让坐标换算可用。
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 980, height: 470, right: 980, bottom: 470, x: 0, y: 0, toJSON() {},
  });

  // 闸门 A 在关卡布局坐标 (206, 132)。
  const click = (x: number, y: number) => {
    const event = new window.MouseEvent('click', { clientX: x, clientY: y, bubbles: true });
    canvas.dispatchEvent(event);
  };
  click(206, 132);
  const view = api.getView();
  assert.equal(view.gates.find((gate: { id: string }) => gate.id === 'A')!.pending, 'open');
  assert.equal(must(window, '#pending-count').textContent, '1');

  must(window, '#confirm').click();
  const after = api.getView();
  assert.equal(after.turnsPlayed, 1);
  assert.equal(after.pendingChanges, 0);
  assert.equal(window.document.querySelectorAll('.history-card').length, 1);
  assert.equal(window.document.querySelectorAll('.ledger-row').length, after.pools.length + 1);
});

test('demo: 撤回按钮回到上一回合，可改走另一种安排', async () => {
  const { window, api } = await loadDemoPage();
  api.queueGate('A', 'open');
  api.confirm();
  assert.equal(api.getView().turnsPlayed, 1);

  must(window, '#undo').click();
  const after = api.getView();
  assert.equal(after.turnsPlayed, 0);
  assert.equal(after.canUndo, false);
  const a = after.gates.find((gate: { id: string }) => gate.id === 'A')!;
  assert.equal(a.committed, 'closed');
  assert.equal(a.pending, null);
});

test('demo: 导出记录后导入同一关卡，打开回放并显示逐回合读数', async () => {
  const { window, api } = await loadDemoPage();
  // 用求解器的通关走法驱动页面，得到一个有意义的三回合记录。
  const { solveLevel } = await import('../src/solver.ts');
  const level = compileLevel(levelOne);
  const solution = solveLevel(level).solutions[0];
  for (const step of solution.steps) {
    for (const gate of level.gates.values()) api.queueGate(gate.id, step.gates[gate.id] as GateState);
    api.confirm();
  }
  const recordText = api.exportRecord();
  const record = JSON.parse(recordText);
  assert.equal(record.result.outcome, 'won');

  await api.importRecord(recordText);

  assert.equal(api.isReplayOpen(), true);
  assert.match(must(window, '#replay-meta').textContent, /复核结果 won/);
  const cursor = api.replayCursor();
  assert.match(cursor, new RegExp(`${record.turns.length} / ${record.turns.length}`));

  api.setReplayCursor(0);
  assert.match(api.replayCursor(), /0 /);
  api.setReplayCursor(record.turns.length);
  const readout = api.replayReadout();
  assert.match(readout, /通关/);
});

test('demo: 加载不同关卡的记录时明确拒绝', async () => {
  const { window, api } = await loadDemoPage();
  // 先在关卡一上产生一份失败记录，再切到关卡二尝试导入。
  api.queueGate('A', 'open');
  api.queueGate('B', 'open');
  api.confirm();
  const recordText = api.exportRecord();

  mustSelect(window, '#level-select').value = levelTwo.id;
  mustSelect(window, '#level-select').dispatchEvent(new window.Event('change'));
  assert.equal(api.getView().levelId, levelTwo.id);

  await api.importRecord(recordText);
  const status = must(window, '#record-status');
  assert.match(status.textContent, /拒绝加载/);
  assert.equal(api.isReplayOpen(), false);
});

test('demo: 导入被篡改的记录时拒绝，不打开回放', async () => {
  const { window, api } = await loadDemoPage();
  api.queueGate('A', 'open');
  api.confirm();
  const record = JSON.parse(api.exportRecord());
  record.turns[0].pools.target += 1;
  await api.importRecord(JSON.stringify(record));
  const status = must(window, '#record-status');
  assert.match(status.textContent, /拒绝加载/);
  assert.equal(api.isReplayOpen(), false);
});

test('demo: 关卡切换会重置到初始水位', async () => {
  const { window, api } = await loadDemoPage();
  api.confirm();
  assert.equal(api.getView().turnsPlayed, 1);

  mustSelect(window, '#level-select').value = levelTwo.id;
  mustSelect(window, '#level-select').dispatchEvent(new window.Event('change'));
  const view = api.getView();
  assert.equal(view.levelId, levelTwo.id);
  assert.equal(view.turnsPlayed, 0);
  assert.equal(view.turnsRemaining, levelTwo.turns);
});

test('demo: 每个样例关卡的池子布局都落在画布范围内', async () => {
  const { poolsWithinViewport } = await import('../src/ui/scene.ts');
  const { api } = await loadDemoPage();
  for (const spec of sampleLevels) {
    api.selectLevel(spec.id);
    assert.ok(poolsWithinViewport(api.getView()), `${spec.id} 的布局应有越界`);
  }
});
