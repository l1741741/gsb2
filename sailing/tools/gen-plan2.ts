import { simulate } from '../src/core/sim.ts';
import { buildReferencePlan, type RouteSpec } from './plan-builder.ts';
import { LEVELS } from '../src/levels/index.ts';

const ROUTES: Record<string, RouteSpec> = {
  'long-crossing': {
    cruise: 5.6, slowDistance: 42, approachDistance: 20, alignWidth: 6,
    path: [
      { x: 68, y: 210 },{ x: 104, y: 184 },{ x: 136, y: 160 },{ x: 176, y: 128 },
      { x: 208, y: 100 },{ x: 218, y: 92 },{ x: 262, y: 86 },{ x: 300, y: 90 },
      { x: 320, y: 98 },{ x: 346, y: 122 },{ x: 368, y: 158 },{ x: 380, y: 184 },
    ],
  },
  'tight-berth': {
    cruise: 4.6, slowDistance: 24, approachDistance: 12, alignWidth: 4,
    path: [
      { x: 54, y: 180 },{ x: 86, y: 162 },{ x: 117, y: 136 },{ x: 148, y: 142 },
      { x: 184, y: 146 },{ x: 216, y: 140 },{ x: 238, y: 124 },{ x: 252, y: 108 },
      { x: 268, y: 90 },
    ],
  },
};

for (const level of LEVELS) {
  const route = ROUTES[level.id]!;
  const plan = buildReferencePlan(level, route, { interval: 0.75, lookAhead: 20 });
  const record = simulate(level, plan, { maxSteps: 900_000 });
  console.log(`=== ${level.id} commands=${plan.commands.length} outcome=${record.summary.outcome} progress=${record.summary.routeProgress}/${level.route.length} finish=${record.summary.finishTime.toFixed(2)} dockSpeed=${record.summary.dockSpeed?.toFixed(2)}`);
  console.log('crossings:', record.summary.crossings.map((c) => `${c.gateId}@${c.time.toFixed(2)}#${c.order}`).join(' | '));
  console.log('issues:', record.summary.issues.map((i) => `${i.kind}@${i.time.toFixed(2)}`).join(' | '));
}
