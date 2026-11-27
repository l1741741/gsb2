// 无头 Chrome 冒烟测试（零依赖，使用 Node 22 内置 WebSocket/fetch）。
// 自动启动静态服务器与 Chrome，通过 CDP 驱动真实页面：
// 生成三种示例 -> 验证非法角点被拒绝 -> 应用真值 -> 区域校验 -> 小尺寸批量导出。
//
// 用法：node scripts/browser-smoke.mjs
// 环境变量：SMOKE_PORT(静态端口, 默认4181)、CDP_PORT(默认9333)、CHROME_BIN、KEEP=1

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const HTTP_PORT = Number(process.env.SMOKE_PORT || 4181);
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}/index.html`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createCDP(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP WebSocket 连接失败')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const cb of listeners.get(msg.method) ?? []) cb(msg.params);
    }
  });
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    },
    on(method, cb) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(cb);
    },
    close() {
      ws.close();
    },
  };
}

async function waitForJSON(url, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error(`等待 ${url} 超时`);
}

async function waitForHttp(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`等待 ${url} 超时`);
}

async function evaluate(cdp, expression) {
  const res = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 120000,
  });
  if (res.exceptionDetails) {
    const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
    throw new Error(`页面异常: ${desc}`);
  }
  return res.result.value;
}

const scenario = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 100 && !window.__pageCorrector; i += 1) await sleep(50);
  const api = window.__pageCorrector;
  if (!api) throw new Error('__pageCorrector API 未就绪');

  for (const k of ['grid-oblique', 'inverted', 'hard-edge']) await api.addFixture(k);
  await sleep(900);

  const pages = api.listPages();

  // 1) 把右下拖到靠近左下 -> 必须以“几乎重合”拒绝
  const rejectCoincident = api.attemptCornerNormalized(2, 0.13, 0.9);
  // 2) 把右下拖到顶边上 -> 必然交叉/退化，必须拒绝
  const rejectCross = api.attemptCornerNormalized(2, 0.2, 0.1);

  // 3) 应用自生成真值，核对偏差应接近 0
  api.applyTruth();
  await sleep(500);
  const precision = api.precisionSummaryText();

  // 4) 增加遮挡区并校验坐标往返
  const regionCount = api.addMaskRegion({ x: 0.62, y: 0.12, w: 0.22, h: 0.18 });
  const verifyText = api.verifyRegions();
  await sleep(700);

  const canvas = api.canvasSignature();

  // 5) 小尺寸批量处理三页
  const batch = await api.runSmokeBatch();

  return {
    pageCount: pages.length,
    pages,
    rejectCoincident,
    rejectCross,
    precision,
    regionCount,
    verifyText,
    canvas,
    batch,
  };
})()`;

async function main() {
  const userData = mkdtempSync(join(ROOT, '.smoke-profile-'));
  const httpServer = spawn('python3', ['-m', 'http.server', String(HTTP_PORT), '--bind', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
  });

  const chromeArgs = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${userData}`,
    'about:blank',
  ];
  const chrome = spawn(CHROME, chromeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString().slice(-4000); });

  const failures = [];
  let pageClient = null;
  let browserClient = null;

  const cleanup = () => {
    try { pageClient?.close(); } catch { /* noop */ }
    try { browserClient?.close(); } catch { /* noop */ }
    try { chrome.kill('SIGTERM'); } catch { /* noop */ }
    try { httpServer.kill('SIGTERM'); } catch { /* noop */ }
    if (!process.env.KEEP) {
      try { rmSync(userData, { recursive: true, force: true }); } catch { /* noop */ }
    }
  };
  process.on('exit', cleanup);

  try {
    await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/index.html`);
    const version = await waitForJSON(`http://127.0.0.1:${CDP_PORT}/json/version`);
    browserClient = createCDP(version.webSocketDebuggerUrl);
    await browserClient.ready;

    const created = await browserClient.send('Target.createTarget', { url: 'about:blank' });
    await sleep(300);
    const targets = await waitForJSON(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const target = targets.find((t) => t.id === created.targetId && t.type === 'page')
      ?? targets.find((t) => t.type === 'page');
    if (!target?.webSocketDebuggerUrl) throw new Error('未找到页面 CDP target');

    pageClient = createCDP(target.webSocketDebuggerUrl);
    await pageClient.ready;
    await pageClient.send('Runtime.enable');
    await pageClient.send('Page.enable');

    const pageErrors = [];
    pageClient.on('Runtime.exceptionThrown', (p) => {
      pageErrors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
    });
    pageClient.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error') {
        const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
        if (!/favicon|Failed to load resource/i.test(text)) pageErrors.push(`console.error: ${text}`);
      }
    });

    const loaded = new Promise((resolve) => pageClient.on('Page.loadEventFired', resolve));
    await pageClient.send('Page.navigate', { url: BASE_URL });
    await loaded;
    await sleep(800);

    const report = await evaluate(pageClient, scenario);

    // ---- 断言 ----
    const check = (name, cond, detail = '') => {
      if (cond) console.log(`  ✓ ${name}`);
      else failures.push(`${name} ${detail}`);
    };

    check('载入了 3 个示例页', report.pageCount === 3, `实际 ${report.pageCount}`);
    check(
      '近重合角点被拒绝并指出角名',
      report.rejectCoincident?.accepted === false && /几乎重合/.test(report.rejectCoincident.message),
      JSON.stringify(report.rejectCoincident),
    );
    check(
      '交叉四边形被拒绝并提示调整',
      report.rejectCross?.accepted === false && /交叉|退化|内凹/.test(report.rejectCross.message),
      JSON.stringify(report.rejectCross),
    );
    check(
      '真值四角下核对偏差≈0',
      /0\.00 mm/.test(report.precision ?? ''),
      report.precision,
    );
    check('遮挡区已添加', report.regionCount >= 1);
    check(
      '区域往返校验通过',
      /✓/.test(report.verifyText ?? '') && /e-\d+|0\.00/.test(report.verifyText ?? ''),
      report.verifyText,
    );
    check(
      '源图画布有实际像素变化',
      !report.canvas?.source?.error && report.canvas?.source?.variation > 50,
      JSON.stringify(report.canvas?.source),
    );
    check(
      '纸面画布有校正结果',
      !report.canvas?.paper?.error && report.canvas?.paper?.width > 0 && report.canvas?.paper?.variation > 50,
      JSON.stringify(report.canvas?.paper),
    );
    check(
      '批量 3 页全部 success',
      report.batch?.summary?.success === 3 && report.batch?.summary?.adoptable === 3,
      JSON.stringify(report.batch?.summary),
    );
    const allHavePng = report.batch?.records?.every((r) => r.blobSize > 5000 && r.width === 360 && r.hasInfo);
    check('每页产出非空 PNG(宽360) 与矩阵信息', !!allHavePng, JSON.stringify(report.batch?.records));
    check('页面无未捕获异常 / console.error', pageErrors.length === 0, pageErrors.join('\n'));

    console.log('\n冒烟报告摘要:');
    console.log(JSON.stringify({
      precision: report.precision?.replace(/\s+/g, ' ').slice(0, 160),
      verify: report.verifyText?.replace(/\s+/g, ' ').slice(0, 200),
      batch: report.batch?.summary,
      canvas: report.canvas,
    }, null, 2));

    if (failures.length) {
      console.error('\n冒烟失败项:');
      for (const f of failures) console.error(`  ✗ ${f}`);
      if (chromeErr) console.error('\nChrome stderr (tail):\n', chromeErr.slice(-1500));
      process.exitCode = 1;
    } else {
      console.log('\n全部冒烟检查通过 ✅');
    }
  } catch (err) {
    console.error('冒烟脚本错误:', err);
    if (chromeErr) console.error('Chrome stderr (tail):\n', chromeErr.slice(-2000));
    process.exitCode = 1;
  } finally {
    await sleep(200);
    cleanup();
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  }
}

main();
