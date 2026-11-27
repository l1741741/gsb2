/**
 * render.test.ts — 不依赖浏览器的渲染冒烟测试。
 * 用最小 Canvas 2D mock 让 HexRenderer.draw 跑完整绘制路径，
 * 捕获未实现的上下文方法与 NaN/Infinity 坐标。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HexRenderer, type DrawModel } from '../src/render.js';
import {
  getMoveOptions,
  initialState,
  replay,
} from '../src/engine.js';
import { computeViewshed, queryLos } from '../src/los.js';
import { getStances, validateMap } from '../src/mapio.js';
import { solveFrom } from '../src/solve.js';
import type { MapDef } from '../src/types.js';

// render.ts 的 resize 会读 window.devicePixelRatio。
(globalThis as unknown as { window: unknown }).window = { devicePixelRatio: 1 };

function loadMap(file: string): MapDef {
  const url = new URL(`../../maps/${file}`, import.meta.url);
  const v = validateMap(JSON.parse(readFileSync(url, 'utf8')));
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.map!;
}

interface MockCtx {
  [k: string]: unknown;
}

function makeCtx(): MockCtx {
  const finite = (args: unknown[]) => {
    for (const a of args) {
      if (typeof a === 'number') assert.ok(Number.isFinite(a), `非有限绘制参数: ${a}`);
    }
  };
  const grad = { addColorStop: () => {} };
  const ctx: MockCtx = {
    canvas: null,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    setTransform: (...a: unknown[]) => finite(a),
    translate: (...a: unknown[]) => finite(a),
    rotate: () => {},
    scale: (...a: unknown[]) => finite(a),
    resetTransform: () => {},
    clearRect: (...a: unknown[]) => finite(a),
    fillRect: (...a: unknown[]) => finite(a),
    beginPath: () => {},
    closePath: () => {},
    save: () => {},
    restore: () => {},
    clip: () => {},
    moveTo: (...a: unknown[]) => finite(a),
    lineTo: (...a: unknown[]) => finite(a),
    arc: (...a: unknown[]) => finite(a),
    arcTo: (...a: unknown[]) => finite(a),
    ellipse: (...a: unknown[]) => finite(a),
    rect: (...a: unknown[]) => finite(a),
    strokeRect: (...a: unknown[]) => finite(a),
    fill: () => {},
    stroke: () => {},
    fillText: (...a: unknown[]) => {
      // fillText(text, x, y)
      finite([a[1], a[2]]);
    },
    setLineDash: () => {},
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    measureText: (text: string) => ({ width: String(text).length * 7 }),
  };
  return ctx;
}

function makeCanvas(ctx: MockCtx): HTMLCanvasElement {
  return {
    style: {},
    width: 0,
    height: 0,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ width: 1400, height: 900 }),
  } as unknown as HTMLCanvasElement;
}

function baseModel(map: MapDef, extra: Partial<DrawModel> = {}): DrawModel {
  const state = extra.state ?? initialState(map);
  const eye = getStances(map)[0].eye;
  const view = computeViewshed(map, state.player, eye);
  return {
    map,
    state,
    view,
    moveOptions: getMoveOptions(map, state),
    hover: { q: 1, r: 0 },
    selected: { q: 1, r: 0 },
    mode: 'play',
    queryA: null,
    queryB: null,
    queryLos: null,
    liveLos: null,
    hintAction: { type: 'move', to: { q: 1, r: 0 } },
    showCoords: true,
    time: 1234,
    ...extra,
  };
}

test('HexRenderer 在两张地图的初始/获胜/查询状态下都能完整绘制', () => {
  const ctx = makeCtx();
  const renderer = new HexRenderer(makeCanvas(ctx), loadMap('open-plain.json'));
  renderer.resize(1400, 900);

  for (const file of ['open-plain.json', 'ridgeline.json']) {
    const map = loadMap(file);
    renderer.setMap(map);

    // 初始局面（含移动高亮、悬停、选中、提示）
    assert.doesNotThrow(() => renderer.draw(baseModel(map)));

    // 求解路线通关后的局面（绘制所有已发现信标）
    const sol = solveFrom(map, map.start, [], map.budget)!;
    assert.ok(sol, `${file} 应可解`);
    const won = replay(map, sol.actions);
    assert.doesNotThrow(() =>
      renderer.draw(baseModel(map, { state: won, time: 9999, hintAction: null })),
    );

    // 视线查询：起点 -> 一个信标（含阻挡叠加层）
    const b = map.beacons[map.beacons.length - 1];
    const los = queryLos(map, map.start, getStances(map)[0].eye, b);
    assert.doesNotThrow(() =>
      renderer.draw(
        baseModel(map, {
          mode: 'query',
          queryA: { ...map.start },
          queryB: { q: b.q, r: b.r },
          queryLos: los,
          moveOptions: [],
        }),
      ),
    );

    // 任意 A 格 + 实时 liveLos
    const arbitrary = { q: 2, r: -1 };
    const live = queryLos(map, arbitrary, getStances(map)[0].eye, b);
    assert.doesNotThrow(() =>
      renderer.draw(
        baseModel(map, {
          mode: 'query',
          queryA: arbitrary,
          liveLos: live,
          queryLos: null,
          moveOptions: [],
        }),
      ),
    );
  }
});

test('pick() 对画布角点与中心不会抛出，且中心附近能选回格或 null', () => {
  const ctx = makeCtx();
  const renderer = new HexRenderer(makeCanvas(ctx), loadMap('open-plain.json'));
  renderer.resize(1200, 800);
  assert.doesNotThrow(() => {
    renderer.pick(0, 0);
    renderer.pick(600, 400);
    renderer.pick(1200, 800);
  });
});
