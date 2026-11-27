// spots.mjs — 列出能看见指定信标的最近观测格（设计辅助）。
import { readFileSync } from 'node:fs';
import { validateMap } from '../dist/mapio.js';
import { computeViewshed } from '../dist/los.js';
import { hexRadiusTiles, hexDistance } from '../dist/hex.js';

const path = process.argv[2];
const beaconId = process.argv[3];
const eye = Number(process.argv[4] ?? 2);
const map = validateMap(JSON.parse(readFileSync(path, 'utf8'))).map;
const b = map.beacons.find((x) => x.id === beaconId);
const from = map.start;

const spots = [];
for (const o of hexRadiusTiles(map.shape.radius)) {
  const vs = computeViewshed(map, o, eye);
  if (vs.visible.has(`${b.q},${b.r}`)) {
    spots.push({ q: o.q, r: o.r, dStart: hexDistance(from, o), passable: !(map.obstacles ?? []).some((x) => x.q === o.q && x.r === o.r), h: map.heights?.[`${o.q},${o.r}`] ?? 0 });
  }
}
spots.sort((a, b2) => a.dStart - b2.dStart);
console.log(`能看见信标 ${beaconId} (${b.q},${b.r}) 的格（按距起点）:`);
for (const s of spots.slice(0, 12)) {
  console.log(`  (${s.q},${s.r}) dist=${s.dStart} h=${s.h} passable=${s.passable}`);
}
