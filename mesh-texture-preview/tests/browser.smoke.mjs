/**
 * Browser smoke test using headless Chromium over the DevTools protocol.
 *
 * There is no test-runner dependency: the script starts a local static server
 * and a headless browser, drives the real page through `window.__meshPreview`,
 * takes screenshots, and asserts on the rendered pixels. This is the only check
 * that exercises the actual WebGL path.
 *
 * Chromium is looked up from the Playwright cache first (common on dev
 * machines) and falls back to `CHROME_BIN`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../tools/png-decode.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');
const PORT = 4175;

const CANDIDATES = [
  process.env.CHROME_BIN,
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);

function findChrome() {
  for (const candidate of CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到 Chromium / Chrome。设置 CHROME_BIN 后重试。');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.fabricmesh': 'text/plain; charset=utf-8',
  '.fmesh': 'text/plain; charset=utf-8',
};

/** Static file server limited to the project directory. */
function startServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${PORT}`);
    const pathname = decodeURIComponent(url.pathname);
    const filePath = path.join(projectRoot, pathname === '/' ? 'index.html' : pathname);
    if (!filePath.startsWith(projectRoot)) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }
    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) {
        response.writeHead(404);
        response.end('not found');
        return;
      }
      const type = MIME[path.extname(filePath)] ?? 'application/octet-stream';
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      fs.createReadStream(filePath).pipe(response);
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

/** Minimal CDP client: message ids, one page target, method promises. */
async function connect(port) {
  const started = Date.now();
  let targets = [];
  while (Date.now() - started < 5000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await response.json();
      if (targets.some((t) => t.type === 'page')) break;
    } catch {
      // Chromium not ready yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的浏览器页面');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return {
    send,
    close: () => socket.close(),
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(`页面脚本异常: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
}

async function screenshot(client, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  const bytes = new Uint8Array(Buffer.from(shot.data, 'base64'));
  const outDir = path.join(projectRoot, 'artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${name}.png`), bytes);
  return decodePng(bytes);
}

/** Canvas CSS rect in screenshot pixels (screenshots are CSS-pixel sized). */
async function canvasRect(client) {
  return evaluate(client, `(() => {
    const rect = document.querySelector('#view').getBoundingClientRect();
    return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
  })()`);
}

/** Splits the canvas rect into fabric and texture pane rects. */
function panesOf(rect) {
  const gutter = 8;
  const half = Math.floor((rect.width - gutter) / 2);
  return {
    fabric: { x: rect.x, y: rect.y, width: half, height: rect.height },
    texture: { x: rect.x + half + gutter, y: rect.y, width: rect.width - half - gutter, height: rect.height },
  };
}

/* ---------------------------------------------------------------- checks */

const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Counts pixels close to a colour, in a rectangle. */
function countColour(image, rgb, tolerance = 40, rect) {
  const area = rect ?? { x: 0, y: 0, width: image.width, height: image.height };
  let count = 0;
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      const index = (y * image.width + x) * 4;
      if (
        Math.abs(image.data[index] - rgb[0]) < tolerance &&
        Math.abs(image.data[index + 1] - rgb[1]) < tolerance &&
        Math.abs(image.data[index + 2] - rgb[2]) < tolerance
      ) {
        count += 1;
      }
    }
  }
  return count;
}

/** Fraction of pixels that are not near the dark background colour. */
function nonBackgroundFraction(image, rect) {
  const bg = [14, 18, 24];
  const area = rect ?? { x: 0, y: 0, width: image.width, height: image.height };
  let lit = 0;
  let total = 0;
  for (let y = area.y; y < area.y + area.height; y++) {
    for (let x = area.x; x < area.x + area.width; x++) {
      const index = (y * image.width + x) * 4;
      const d =
        Math.abs(image.data[index] - bg[0]) +
        Math.abs(image.data[index + 1] - bg[1]) +
        Math.abs(image.data[index + 2] - bg[2]);
      if (d > 60) lit += 1;
      total += 1;
    }
  }
  return total === 0 ? 0 : lit / total;
}

/* ------------------------------------------------------------------ main */

const server = await startServer();
const chromePath = findChrome();
const profileDir = path.join(process.env.TMPDIR ?? '/tmp', `mesh-preview-smoke-${Date.now()}`);
fs.mkdirSync(profileDir, { recursive: true });
const browser = spawn(
  chromePath,
  [
    `--user-data-dir=${profileDir}`,
    '--single-process',
    '--no-sandbox',
    '--headless=old',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--remote-debugging-port=9335',
    '--hide-crash-restore-bubble',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

let client;
try {
  client = await connect(9335);
  await client.send('Page.enable');
  await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });

  // Wait for the app to report it is ready.
  const readyDeadline = Date.now() + 8000;
  while (Date.now() < readyDeadline) {
    try {
      const ready = await evaluate(client, 'Boolean(window.__meshPreview && window.__meshPreview.getState().triangles > 0)');
      if (ready) break;
    } catch {
      // Page not ready yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const glInfo = await evaluate(
    client,
    `(() => {
      const canvas = document.querySelector('#view');
      const gl = canvas.getContext('webgl2');
      return {
        unavailable: window.__meshPreview.glUnavailable,
        vendor: gl ? gl.getParameter(gl.VERSION) : null,
      };
    })()`,
  );
  console.log(`\nWebGL: ${glInfo.unavailable ? '不可用' : glInfo.vendor}`);

  await evaluate(client, `window.__meshPreview.fit(); window.__meshPreview.refresh();`);
  await new Promise((r) => setTimeout(r, 350));
  const ginghamShot = await screenshot(client, 'browser-gingham');
  console.log('\n[格纹样例]');
  const state = await evaluate(client, 'window.__meshPreview.getState()');
  check('样例载入 32 个三角形', state.triangles === 32, `实际 ${state.triangles}`);
  check('没有翻面三角形', state.flipped === 0, `实际 ${state.flipped}`);
  check('分栏画布有像素输出', state.canvasPixels.width > 400 && state.canvasPixels.height > 200, JSON.stringify(state.canvasPixels));
  const ginghamPanes = panesOf(await canvasRect(client));
  check('布面栏有纹理内容', nonBackgroundFraction(ginghamShot, ginghamPanes.fabric) > 0.25, `${(nonBackgroundFraction(ginghamShot, ginghamPanes.fabric) * 100).toFixed(1)}%`);
  check('纹理栏有纹理内容', nonBackgroundFraction(ginghamShot, ginghamPanes.texture) > 0.1, `${(nonBackgroundFraction(ginghamShot, ginghamPanes.texture) * 100).toFixed(1)}%`);
  check('诊断面板与快照一致', state.panelsMatch === true);
  check('摘要含翻面指标', state.summaryHtml.includes('翻面'));

  // ---- split sample: split seams must be visible and diagnosed.
  console.log('\n[断开拼缝样例]');
  await evaluate(client, 'window.__meshPreview.loadSample("split").then(() => { window.__meshPreview.fit(); window.__meshPreview.refresh(); })');
  await new Promise((r) => setTimeout(r, 400));
  const splitState = await evaluate(client, 'window.__meshPreview.getState()');
  check('识别出 4 条断开拼缝', splitState.splitSeams === 4, `实际 ${splitState.splitSeams}`);
  check('没有意外断开', splitState.accidentalSplits === 0, `实际 ${splitState.accidentalSplits}`);
  const splitShot = await screenshot(client, 'browser-split');
  // The split seam colour is a strong magenta; the overlay draws it.
  const splitPanes = panesOf(await canvasRect(client));
  check('拼缝叠加层出现在画面上', countColour(splitShot, [255, 107, 219], 60, splitPanes.fabric) > 20, String(countColour(splitShot, [255, 107, 219], 60, splitPanes.fabric)));

  // ---- flipped sample: flipped triangle visible, then repaired by dragging.
  console.log('\n[翻面样例]');
  await evaluate(client, 'window.__meshPreview.loadSample("flipped").then(() => { window.__meshPreview.fit(); window.__meshPreview.refresh(); })');
  await new Promise((r) => setTimeout(r, 400));
  const flippedState = await evaluate(client, 'window.__meshPreview.getState()');
  check('检测到翻面三角形', flippedState.flipped >= 1, `实际 ${flippedState.flipped}`);
  const flippedShot = await screenshot(client, 'browser-flipped');
  const flippedPanes = panesOf(await canvasRect(client));
  check('翻面三角形以洋红色绘制', countColour(flippedShot, [255, 31, 140], 60, flippedPanes.fabric) > 40, String(countColour(flippedShot, [255, 31, 140], 60, flippedPanes.fabric)));

  // Repair by dragging the offending vertex back through the app command API.
  const repair = await evaluate(
    client,
    `(() => {
      const api = window.__meshPreview;
      const before = api.getState();
      const ok = api.dragVertex(18, 300, 300);
      api.fit(); api.refresh();
      return { ok, beforeFlipped: before.flipped, after: api.getState() };
    })()`,
  );
  await new Promise((r) => setTimeout(r, 300));
  check('拖动修复后翻面消失', repair.after.flipped === 0, `实际 ${repair.after.flipped}`);
  check('修复操作进入撤销栈', repair.after.canUndo === true);
  check('诊断指纹随修复而变化', repair.after.diagnosticsFingerprint !== flippedState.diagnosticsFingerprint);
  const repairedShot = await screenshot(client, 'browser-repaired');
  check(
    '修复后画面不再有大片洋红',
    countColour(repairedShot, [255, 31, 140], 60, flippedPanes.fabric) < 40,
  );

  // ---- undo must restore the flipped diagnostics exactly.
  console.log('\n[撤销/重做]');
  const undoState = await evaluate(
    client,
    `(() => {
      const api = window.__meshPreview;
      api.app.undo(); api.refresh();
      const undone = api.getState();
      api.app.redo(); api.refresh();
      const redone = api.getState();
      return { undone, redone, flippedAtExport: ${JSON.stringify(flippedState.diagnosticsFingerprint)} };
    })()`,
  );
  check('撤销恢复翻面诊断', undoState.undone.flipped >= 1, `实际 ${undoState.undone.flipped}`);
  check('撤销后诊断指纹与初始翻面一致', undoState.undone.diagnosticsFingerprint === undoState.flippedAtExport);
  check('重做恢复修复后的状态', undoState.redone.flipped === 0);

  // ---- bad patch mode: disable hides the patch but keeps overlays.
  console.log('\n[坏片停用]');
  await evaluate(
    client,
    `(() => {
      const api = window.__meshPreview;
      api.app.undo(); // back to the flipped state
      api.app.setBadPatchMode('disable');
      api.fit(); api.refresh();
    })()`,
  );
  await new Promise((r) => setTimeout(r, 350));
  const disabledShot = await screenshot(client, 'browser-disabled');
  const enabledShot = flippedShot;
  const magentaDisabled = countColour(disabledShot, [255, 31, 140], 60, flippedPanes.fabric);
  const magentaEnabled = countColour(enabledShot, [255, 31, 140], 60, flippedPanes.fabric);
  check('停用后填充洋红减少、轮廓仍保留', magentaDisabled < magentaEnabled && magentaDisabled > 0, `${magentaDisabled} vs ${magentaEnabled}`);
  await evaluate(client, `window.__meshPreview.app.setBadPatchMode('retain'); window.__meshPreview.refresh();`);

  // ---- picking and selection via the real view.
  console.log('\n[拾取]');
  const pick = await evaluate(
    client,
    `(() => {
      const api = window.__meshPreview;
      api.loadSample('gingham').then(() => {
        api.fit(); api.refresh();
      });
      return true;
    })()`,
  );
  void pick;
  await new Promise((r) => setTimeout(r, 400));
  const selection = await evaluate(
    client,
    `(() => {
      const api = window.__meshPreview;
      const layout = { width: api.app.camera.scale, height: 0 };
      api.app.select({ kind: 'vertex', vertex: 18 });
      api.refresh();
      return api.getState();
    })()`,
  );
  check('选中顶点后面板显示局部数值', selection.detailLabel === '顶点 18', selection.detailLabel);
  check('选中顶点后面板与快照一致', selection.panelsMatch === true);

  // ---- export round-trip through the browser's own exporter.
  console.log('\n[导出与重载]');
  const exportState = await evaluate(
    client,
    `(async () => {
      const api = window.__meshPreview;
      const { buildMeshJson } = await import('/build/src/core/export.js');
      const { buildDiagnostics } = await import('/build/src/core/diagnostics.js');
      const before = api.getState();
      const json = buildMeshJson(api.app.document, { textureDigest: null, now: () => new Date('2026-01-01T00:00:00Z') });
      const report = api.app.loadJson(json, 'roundtrip.json');
      api.refresh();
      const after = api.getState();
      return {
        before,
        after,
        mismatches: report.mismatches,
        docFingerprintBefore: before.fingerprint,
        recomputed: buildDiagnostics(api.app.document).fingerprint,
      };
    })()`,
  );
  check('导出 JSON 重载无诊断偏差', exportState.mismatches.length === 0, exportState.mismatches.join(' | '));
  check('重载后几何指纹相同', exportState.after.fingerprint === exportState.before.fingerprint);
  check('重载后诊断指纹相同', exportState.after.diagnosticsFingerprint === exportState.before.diagnosticsFingerprint);
  check('重载后历史被清空', exportState.after.historyDepth === 0, `实际 ${exportState.after.historyDepth}`);

  const finalShot = await screenshot(client, 'browser-final');
  const finalPanes = panesOf(await canvasRect(client));
  check('重载后画布仍有纹理内容', nonBackgroundFraction(finalShot, finalPanes.texture) > 0.1, `${(nonBackgroundFraction(finalShot, finalPanes.texture) * 100).toFixed(1)}%`);
} finally {
  try {
    client?.close();
  } catch {
    // Ignore close errors.
  }
  browser.kill();
  server.close();
  // The browser keeps touching its cache while exiting; cleanup is best-effort.
  await new Promise((r) => setTimeout(r, 300));
  try {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Leave the temp profile behind rather than failing the run.
  }
}

console.log(`\n结果: ${failures.length === 0 ? '全部通过' : `${failures.length} 项失败`}`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
