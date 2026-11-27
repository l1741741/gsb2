import type { Level, Vec2 } from '../src/core/types.ts';
import { LEVELS } from '../src/levels/index.ts';

function pointSegDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const len2 = dx*dx+dy*dy;
  const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((p.x-a.x)*dx + (p.y-a.y)*dy)/len2)) : 0;
  return Math.hypot(a.x+dx*t-p.x, a.y+dy*t-p.y);
}

export function routeClearance(level: Level): Array<{ from: string; to: string; minClearance: number; obstacle: string }> {
  const points: Array<{ id: string; p: Vec2 }> = [];
  points.push({ id: 'start', p: level.start.position });
  for (const id of level.route) {
    const g = level.buoys.find(b => b.id === id)!;
    points.push({ id, p: { x: (g.a.x+g.b.x)/2, y: (g.a.y+g.b.y)/2 } });
  }
  points.push({ id: 'dock', p: level.dock.mouth });
  const out: Array<{ from: string; to: string; minClearance: number; obstacle: string }> = [];
  for (let i = 0; i + 1 < points.length; i++) {
    for (const o of level.obstacles) {
      let d: number; let radius: number;
      if (o.kind === 'circle') { d = pointSegDistance(o.center, points[i]!.p, points[i+1]!.p); radius = o.radius; }
      else {
        d = Infinity; radius = 0;
        for (let k = 0; k + 1 <= o.vertices.length; k++) {
          const a = o.vertices[k % o.vertices.length]!;
          const b = o.vertices[(k+1) % o.vertices.length]!;
          d = Math.min(d, pointSegDistance(a, points[i]!.p, points[i+1]!.p));
        }
      }
      out.push({ from: points[i]!.id, to: points[i+1]!.id, minClearance: d - radius, obstacle: o.id });
    }
  }
  return out;
}

for (const level of LEVELS) {
  console.log(`\n${level.id}`);
  const rows = routeClearance(level);
  const tight = rows.filter(r => r.minClearance < 12).sort((a,b)=>a.minClearance-b.minClearance);
  console.log('tightest clearances:');
  for (const r of tight.slice(0, 8)) console.log(`  ${r.from}->${r.to} vs ${r.obstacle}: ${r.minClearance.toFixed(1)} m`);
  if (tight.length === 0) console.log('  none under 12 m');
}
