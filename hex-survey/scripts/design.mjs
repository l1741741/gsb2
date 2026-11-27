// design.mjs — 地图平衡性/视线诊断小工具（不参与游戏运行时）。
// 用法：
//   node scripts/design.mjs maps/xxx.json [observerQ observerR [eyeExtra]]
// 不传观测格时用 start。打印可视域网格、信标视线裁定与最省预算解。
import { readFileSync } from 'node:fs';
import { computeViewshed, queryLos, ratToNumber } from '../dist/los.js';
import { validateMap, getStances } from '../dist/mapio.js';
import { solveFrom } from '../dist/solve.js';
import { replay } from '../dist/engine.js';

const path = process.argv[2];
const raw = JSON.parse(readFileSync(path, 'utf8'));
const v = validateMap(raw);
if (!v.ok) {
  console.error('地图校验失败：\n - ' + v.errors.join('\n - '));
  process.exit(1);
}
const map = v.map;
const R = map.shape.radius;

let oq = process.argv[3] !== undefined ? Number(process.argv[3]) : map.start.q;
let or = process.argv[4] !== undefined ? Number(process.argv[4]) : map.start.r;
let eye = process.argv[5] !== undefined ? Number(process.argv[5]) : map.eyeHeight;

const vs = computeViewshed(map, { q: oq, r: or }, eye);

function ch(q, r) {
  const key = `${q},${r}`;
  const b = map.beacons.find((x) => x.q === q && x.r === r);
  const o = (map.obstacles ?? []).find((x) => x.q === q && x.r === r);
  const h = map.heights?.[key] ?? 0;
  if (q === oq && r === or) return '@';
  if (b) return vs.visible.has(key) ? 'B' : 'b';
  if (o?.kind === 'wall') return vs.visible.has(key) ? 'W' : 'w';
  if (o) return vs.visible.has(key) ? 'O' : 'o';
  if (!vs.results.has(key)) return ' ';
  if (vs.visible.has(key)) return h > 0 ? String(h) : '.';
  return h > 0 ? String(h).replace?.(/./, '^') ?? '^' : 'x';
}

console.log(`\n=== ${map.name} (R=${R}) observer=(${oq},${or}) eye=${eye} eyeZ=${vs.eyeZ} ===`);
for (let r = -R; r <= R; r++) {
  const qmin = Math.max(-R, -r - R);
  const qmax = Math.min(R, -r + R);
  const indent = '  '.repeat(R + r);
  let row = '';
  for (let q = qmin; q <= qmax; q++) {
    row += ch(q, r) + ' ';
  }
  console.log(`${String(r).padStart(3)} ${indent}${row}`);
}
console.log('@ 观测格  B/b 信标(可见/不可见)  W/w 墙  ./数字 可见  x 被挡  空格 视距外');

for (const b of map.beacons) {
  const los = queryLos(map, { q: oq, r: or }, eye, b);
  if (los.clear) {
    console.log(`信标 ${b.id} (${b.q},${b.r}): 可见 ✔`);
  } else {
    const p = los.primary;
    console.log(
      `信标 ${b.id} (${b.q},${b.r}): 被挡 ✘ 首要阻挡 (${p.q},${p.r}) ` +
        `kind=${p.kind} top=${p.blockTop} hitT=${ratToNumber(p.hitT).toFixed(3)} ` +
        `hitZ=${ratToNumber(p.hitZ).toFixed(2)}；全部阻挡: ` +
        los.blockers.map((x) => `(${x.q},${x.r})@${ratToNumber(x.hitT).toFixed(2)}`).join(' '),
    );
  }
}

const sol = solveFrom(map, map.start, [], map.budget);
if (!sol) {
  console.log(`\n求解：预算 ${map.budget} 内无解！`);
} else {
  console.log(`\n求解：最小消耗 ${sol.totalCost}（预算 ${map.budget}），${sol.actions.length} 个行动`);
  let q = map.start.q;
  let r = map.start.r;
  for (const a of sol.actions) {
    if (a.type === 'move') {
      console.log(`  move -> (${a.to.q},${a.to.r})`);
      q = a.to.q; r = a.to.r;
    } else {
      const st = getStances(map).find((s) => s.id === a.stanceId);
      const m = solveFrom; // noop ref
      console.log(`  observe [${a.stanceId}] eye=${st?.eye} at (${q},${r})`);
      void m;
    }
  }
  const st = replay(map, sol.actions);
  console.log(`replay 校验: found=${st.foundIds.join(',')} status=${st.status} budgetLeft=${st.budgetLeft}`);
}
