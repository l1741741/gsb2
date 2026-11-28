/**
 * 关卡求解 CLI：node scripts/solve.ts [关卡 id]
 *
 * 开发期核对关卡设计用，不是运行时依赖。
 */
import { compileLevel } from '../src/level.ts';
import { solveLevel } from '../src/solver.ts';
import { sampleLevels } from '../src/levels/index.ts';
import type { TurnRecord } from '../src/types.ts';

function formatSteps(steps: readonly TurnRecord[]): void {
  for (const step of steps) {
    const gates = Object.entries(step.gates)
      .map(([id, state]) => `${id}:${state === 'open' ? '开' : '关'}`)
      .join(' ');
    const pools = Object.entries(step.pools).map(([id, value]) => `${id}=${value}`).join(' ');
    const spill = Object.entries(step.spill)
      .filter(([, value]) => value > 0)
      .map(([id, value]) => `${id}:${value}`)
      .join(' ');
    console.log(`    回合 ${step.turn}: ${gates}`);
    console.log(`      水位 ${pools}${spill ? `  溢流 ${spill}` : ''}  结果 ${step.outcome}`);
  }
}

const requested = process.argv[2];
for (const spec of sampleLevels) {
  if (requested && spec.id !== requested) continue;
  const level = compileLevel(spec);
  console.log(`\n${spec.id}  ${spec.name}  （${spec.turns} 回合，${level.gates.size} 条闸门）`);
  const result = solveLevel(level);
  if (result.solutions.length === 0) {
    console.log('  ✗ 未找到通关走法');
    process.exitCode = 1;
  } else {
    const solution = result.solutions[0];
    console.log(`  ✓ 找到通关走法（${solution.steps.length} 回合）`);
    formatSteps(solution.steps);
  }
}
