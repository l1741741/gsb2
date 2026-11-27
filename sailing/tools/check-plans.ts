import { simulate } from '../src/core/sim.ts';
import { validateLevel } from '../src/core/level.ts';
import { LEVELS } from '../src/levels/index.ts';
import { STARTER_PLANS } from '../src/levels/plans.ts';

for (const level of LEVELS) {
  const v = validateLevel(level);
  const plan = STARTER_PLANS[level.id]!;
  const record = simulate(level, plan, { maxSteps: 900_000 });
  console.log(`\n${level.id}: level=${v.ok ? 'ok' : v.errors.join('; ')} plan=${plan.commands.length} commands`);
  console.log(`  outcome=${record.summary.outcome} progress=${record.summary.routeProgress}/${level.route.length} finish=${record.summary.finishTime.toFixed(2)}/${level.duration}s dockSpeed=${record.summary.dockSpeed?.toFixed(2)}`);
  console.log(`  crossings=${record.summary.crossings.map((c) => `${c.gateId}@${c.time.toFixed(2)}#${c.order}`).join(' | ')}`);
  console.log(`  issues=${record.summary.issues.map((i) => i.message).join(' | ') || '(none)'}`);
}
