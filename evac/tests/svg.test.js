import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPlan } from '../src/model.js';
import { renderFloorSvg } from '../src/svg.js';
import { STYLE } from '../src/layout.js';

const demoPath = fileURLToPath(new URL('../demo/data/demo.json', import.meta.url));

function demoPlan() {
  return loadPlan(JSON.parse(readFileSync(demoPath, 'utf8'))).plan;
}

const VIEW = { scale: 1.5, panX: 30, panY: 20, width: 900, height: 600 };

test('输出确定性：同一视图渲染两次完全一致（导出与屏幕一致的前提）', () => {
  const plan = demoPlan();
  const a = renderFloorSvg(plan, 'F1', VIEW);
  const b = renderFloorSvg(plan, 'F1', VIEW);
  assert.equal(a, b);
});

test('线宽不随缩放变化：所有路线描边使用 non-scaling-stroke 且宽度恒定', () => {
  const plan = demoPlan();
  for (const scale of [0.5, 1, 2, 4]) {
    const svg = renderFloorSvg(plan, 'F1', { ...VIEW, scale });
    const routeStrokes = [...svg.matchAll(/<path\b[^>]*data-route="[^"]*"[^>]*>/g)]
      .map((m) => m[0].match(/stroke-width="([\d.]+)"/)?.[1]);
    assert.ok(routeStrokes.length > 0);
    assert.ok(routeStrokes.every((w) => Number(w) === STYLE.routeWidth), `scale=${scale} 时线宽应恒为 ${STYLE.routeWidth}`);
    assert.ok(svg.includes('vector-effect="non-scaling-stroke"'));
  }
});

test('箭头屏幕尺寸不随缩放变化（世界尺寸 ∝ 1/scale）', () => {
  const plan = demoPlan();
  const span = (scale) => {
    const svg = renderFloorSvg(plan, 'F1', { ...VIEW, scale });
    const pts = svg.match(/<polygon class="arrow"[^>]*points="([^"]+)"/)[1]
      .split(' ').map((p) => p.split(',').map(Number));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };
  const s1 = span(1);
  const s2 = span(2);
  assert.ok(Math.abs(s1 * 1 - s2 * 2) < 0.01, `屏幕尺寸应恒定：scale=1 时 ${s1}，scale=2 时 ${s2}`);
});

test('楼梯符号含编号与方向，延续标记指向另一楼层', () => {
  const plan = demoPlan();
  const f1 = renderFloorSvg(plan, 'F1', VIEW);
  assert.match(f1, /1#楼梯 ↑二层/);
  assert.match(f1, /续 → 二层/);
  const f2 = renderFloorSvg(plan, 'F2', VIEW);
  assert.match(f2, /1#楼梯 ↓一层/);
  assert.match(f2, /← 接 一层/);
});

test('SVG 结构合法：根元素、视口、楼层标识齐全', () => {
  const plan = demoPlan();
  const svg = renderFloorSvg(plan, 'F1', VIEW);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /viewBox="0 0 900 600"/);
  assert.match(svg, /data-floor="F1"/);
  assert.match(svg, /<\/svg>$/);
});

test('文本转义：标签中的特殊字符不会破坏 SVG', () => {
  const data = JSON.parse(readFileSync(demoPath, 'utf8'));
  data.nodes.find((n) => n.id === 'D-N1').label = '北门 <A&B> "1"';
  const { plan } = loadPlan(data);
  const svg = renderFloorSvg(plan, 'F1', VIEW);
  assert.ok(svg.includes('北门 &lt;A&amp;B&gt; &quot;1&quot;'));
  assert.ok(!svg.includes('<A&B>'));
});
