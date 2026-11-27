// shot.mjs — 用 @napi-rs/canvas 跑真实 HexRenderer 并导出 PNG（仅本地视觉自检）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';

globalThis.window = { devicePixelRatio: 1 };

const { HexRenderer } = await import('../dist/render.js');
const { initialState, replay, getMoveOptions } = await import('../dist/engine.js');
const { computeViewshed, queryLos } = await import('../dist/los.js');
const { getStances, heightAt } = await import('../dist/mapio.js');
const { solveFrom } = await import('../dist/solve.js');

mkdirSync('.shots', { recursive: true });

function load(file) {
  return JSON.parse(readFileSync(new URL(`../maps/${file}`, import.meta.url), 'utf8'));
}

const W = 1560;
const H = 1000;

function makeRenderer(map) {
  const cv = createCanvas(W, H);
  cv.style = {};
  cv.getBoundingClientRect = () => ({ width: W, height: H, left: 0, top: 0 });
  const r = new HexRenderer(cv, map);
  r.resize(W, H);
  return { cv, r };
}

function model(map, state, extra = {}) {
  const stanceEye = getStances(map)[0].eye;
  const eye = extra.eye ?? stanceEye;
  const player = state.player;
  return {
    map,
    state,
    view: computeViewshed(map, extra.origin ?? player, eye),
    playerEyeZ: heightAt(map, player.q, player.r) + eye,
    moveOptions: getMoveOptions(map, state),
    hover: null,
    selected: null,
    mode: 'play',
    queryA: null,
    queryB: null,
    queryLos: null,
    liveLos: null,
    hintAction: null,
    showCoords: false,
    time: 1200,
    ...extra,
  };
}

function save(cv, name) {
  writeFileSync(`.shots/${name}.png`, cv.toBuffer('image/png'));
  console.log('wrote', name);
}

// 1) 开阔关初始
const open = load('open-plain.json');
{
  const { cv, r } = makeRenderer(open);
  r.draw(model(open, initialState(open), { selected: { q: 1, r: 2 } }));
  save(cv, '1-open-start');
}

// 2) 开阔关：观测后（发现 near、留下记录），并给一个提示移动
{
  const { cv, r } = makeRenderer(open);
  const state = replay(open, [{ type: 'observe', stanceId: 'stand' }]);
  r.draw(model(open, state, { hintAction: { type: 'move', to: { q: 1, r: 1 } } }));
  save(cv, '2-open-observed');
}

// 3) 开阔关：观测杆高度下的可视域（原地 eye=4）
{
  const { cv, r } = makeRenderer(open);
  const st = initialState(open);
  r.draw(model(open, st, { eye: 4 }));
  save(cv, '3-open-mast-view');
}

// 4) 山脊关：起点查询岭北信标被挡
const ridge = load('ridgeline.json');
{
  const { cv, r } = makeRenderer(ridge);
  const st = initialState(ridge);
  const north = ridge.beacons.find((b) => b.id === 'north');
  const los = queryLos(ridge, ridge.start, 2, north);
  r.draw(
    model(ridge, st, {
      mode: 'query',
      queryA: { ...ridge.start },
      queryB: { q: north.q, r: north.r },
      queryLos: los,
      moveOptions: [],
    }),
  );
  save(cv, '4-ridge-blocked');
}

// 5) 山脊关：登上瞭望岩观测后（求解路线通关）
{
  const { cv, r } = makeRenderer(ridge);
  const sol = solveFrom(ridge, ridge.start, [], ridge.budget);
  const st = replay(ridge, sol.actions);
  r.draw(model(ridge, st));
  save(cv, '5-ridge-solved');
}

// 6) 山脊关：任意 A=(2,2) 瞭望岩的可视域
{
  const { cv, r } = makeRenderer(ridge);
  const st = initialState(ridge);
  const origin = { q: 2, r: 2 };
  const north = ridge.beacons.find((b) => b.id === 'north');
  const los = queryLos(ridge, origin, 2, north);
  r.draw(
    model(ridge, st, {
      origin,
      mode: 'query',
      queryA: origin,
      queryB: { q: north.q, r: north.r },
      queryLos: los,
      moveOptions: [],
    }),
  );
  save(cv, '6-ridge-tor-view');
}
