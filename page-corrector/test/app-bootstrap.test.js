import test from 'node:test';
import assert from 'node:assert/strict';

import { installFakeDOM } from './helpers/fake-dom.js';

// 必须在导入 app.js 之前装好 window/document 等全局
const env = installFakeDOM();
await import('../src/ui/app.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('app 引导：示例生成、角点拒绝、真值、区域校验、模板/覆盖独立存储与批量导出', async (t) => {
  const api = globalThis.window.__pageCorrector;
  assert.ok(api, 'window.__pageCorrector 应在启动后暴露');

  await t.test('生成三种示例页', async () => {
    for (const kind of ['grid-oblique', 'inverted', 'hard-edge']) {
      const id = await api.addFixture(kind);
      assert.ok(id, `${kind} 应返回页面 id`);
    }
    await sleep(120); // 让防抖预览跑完
    const pages = api.listPages();
    assert.equal(pages.length, 3);
    assert.ok(pages.every((p) => p.width === 1280 && p.height === 960));
  });

  await t.test('拖动非法角点被拒绝并提示角名', () => {
    // 当前选中最后加入的 hard-edge，初始为默认内缩矩形
    const coincident = api.attemptCornerNormalized(2, 0.13, 0.9);
    assert.equal(coincident.accepted, false);
    assert.match(coincident.message, /几乎重合/);
    assert.ok(coincident.badCorners.includes(2));

    const crossed = api.attemptCornerNormalized(2, 0.2, 0.1);
    assert.equal(crossed.accepted, false);
    assert.match(crossed.message, /交叉|退化|内凹/);

    // 合法移动应被接受
    const okMove = api.attemptCornerNormalized(2, 0.86, 0.88);
    assert.equal(okMove.accepted, true);
  });

  await t.test('应用示例真值后角点与真值一致', () => {
    api.applyTruth();
    const draft = api.getDraft();
    // hard-edge 真值左上归一化约 (214/1280,132/960)
    assert.ok(Math.abs(draft.cornersNormalized[0].x - 214 / 1280) < 1e-9);
    assert.ok(Math.abs(draft.cornersNormalized[0].y - 132 / 960) < 1e-9);
    assert.match(api.precisionSummaryText(), /0\.00 mm/);
  });

  await t.test('添加遮挡区并通过坐标往返校验', async () => {
    const count = api.addMaskRegion({ x: 0.62, y: 0.12, w: 0.22, h: 0.18 });
    assert.ok(count >= 1);
    await sleep(120);
    const text = api.verifyRegions();
    assert.match(text, /✓/);
    assert.match(text, /e-\d+|0\.00/);
  });

  await t.test('本页覆盖与全批模板写入彼此独立的 storage 键', () => {
    api.saveCurrentTemplate();
    api.saveCurrentOverride();
    const keys = [...env.localStorage._map.keys()];
    assert.ok(keys.includes('page-corrector:template:v1'));
    assert.ok(keys.includes('page-corrector:overrides:v1'));
    const overrides = JSON.parse(env.localStorage.getItem('page-corrector:overrides:v1'));
    assert.equal(Object.keys(overrides).length, 1); // 只有当前 fixture 一页覆盖
    const template = JSON.parse(env.localStorage.getItem('page-corrector:template:v1'));
    assert.ok(Array.isArray(template.cornersNormalized));
  });

  await t.test('指针事件：源图角点拒绝/接受 + 纸面拖框添加遮挡区', () => {
    const sourceCanvas = env.document.getElementById('sourceCanvas');
    const hint = env.document.getElementById('sourceHint');

    // hard-edge 真值右下角约 (1048,876)；拖到靠近左下角真值 (232,858)
    sourceCanvas.dispatch('pointerdown', { pointerId: 1, clientX: 1048, clientY: 876 });
    sourceCanvas.dispatch('pointermove', { pointerId: 1, clientX: 240, clientY: 860 });
    assert.match(hint.textContent, /几乎重合/);
    assert.ok(hint.className.includes('error'));
    env.window.dispatch('pointerup', { pointerId: 1, clientX: 240, clientY: 860 });

    // 被拒绝后角点未变，再做一次合法拖动
    sourceCanvas.dispatch('pointerdown', { pointerId: 2, clientX: 1048, clientY: 876 });
    sourceCanvas.dispatch('pointermove', { pointerId: 2, clientX: 1000, clientY: 820 });
    assert.match(hint.textContent, /四角关系有效/);
    assert.ok(hint.className.includes('ok'));
    env.window.dispatch('pointerup', { pointerId: 2, clientX: 1000, clientY: 820 });

    // 纸面拖一个 0.1..0.4 的遮挡框（fake rect 430×610）
    const paperCanvas = env.document.getElementById('paperCanvas');
    api.views.paper.setTool('mask');
    const before = api.getDraft().regions.length;
    paperCanvas.dispatch('pointerdown', { pointerId: 3, clientX: 43, clientY: 61 });
    paperCanvas.dispatch('pointermove', { pointerId: 3, clientX: 172, clientY: 244 });
    env.window.dispatch('pointerup', {});
    assert.equal(api.getDraft().regions.length, before + 1);
  });

  await t.test('小尺寸批量处理三页全部成功并产出 info', { timeout: 60000 }, async () => {
    const report = await api.runSmokeBatch();
    assert.equal(report.summary.success, 3);
    assert.equal(report.summary.adoptable, 3);
    assert.equal(report.records.length, 3);
    for (const r of report.records) {
      assert.equal(r.status, 'success');
      assert.equal(r.width, 360);
      assert.equal(r.hasInfo, true);
      assert.ok(r.blobSize > 0);
    }
  });
});
