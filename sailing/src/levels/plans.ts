import { simulate } from '../core/sim.ts';
import type { CoursePlan, Level, Issue } from '../core/types.ts';

/** 内置参考航线：两条都是靠泊成功的样例，玩家可以在此基础上调整。 */
export const LONG_CROSSING_PLAN: CoursePlan = {
  version: 1,
  levelId: 'long-crossing',
  commands: [
    { time: 0, heading: 54.8, sheet: 1 },
    { time: 24.75, heading: 50, sheet: 1 },
    { time: 32.25, heading: 57.2, sheet: 1 },
    { time: 33, heading: 65.1, sheet: 1 },
    { time: 39, heading: 71.5, sheet: 1 },
    { time: 41.25, heading: 76.3, sheet: 1 },
    { time: 43.5, heading: 88.2, sheet: 1 },
    { time: 50.25, heading: 92.9, sheet: 1 },
    { time: 51.75, heading: 103.3, sheet: 1 },
    { time: 56.25, heading: 120.7, sheet: 1 },
    { time: 60.75, heading: 125.5, sheet: 1 },
    { time: 63, heading: 139.8, sheet: 1 },
    { time: 68.25, heading: 144.6, sheet: 1 },
    { time: 71.25, heading: 151.7, sheet: 1 },
    { time: 75.75, heading: 154.9, sheet: 0.61 },
    { time: 81, heading: 157.3, sheet: 0.22 },
  ],
};

export const TIGHT_BERTH_PLAN: CoursePlan = {
  version: 1,
  levelId: 'tight-berth',
  commands: [
    { time: 0, heading: 60.4, sheet: 1 },
    { time: 6, heading: 54.8, sheet: 1 },
    { time: 15.75, heading: 79.4, sheet: 1 },
    { time: 19.5, heading: 85, sheet: 1 },
    { time: 21.75, heading: 90.6, sheet: 1 },
    { time: 36, heading: 85, sheet: 1 },
    { time: 39.75, heading: 67.5, sheet: 1 },
    { time: 46.5, heading: 62.8, sheet: 1 },
    { time: 47.25, heading: 51.6, sheet: 1 },
    { time: 53.25, heading: 46.1, sheet: 1 },
    { time: 58.5, heading: 14.3, sheet: 0.71 },
    { time: 65.25, heading: 109.6, sheet: 0.3 },
  ],
};

export const STARTER_PLANS: Record<string, CoursePlan> = {
  'long-crossing': LONG_CROSSING_PLAN,
  'tight-berth': TIGHT_BERTH_PLAN,
};

/** 开发期校验：内置航线必须真的能完成各自关卡。 */
export function verifyStarterPlans(levels: ReadonlyArray<{ id: string; level: Level }>): void {
  for (const { id, level } of levels) {
    const plan = STARTER_PLANS[id];
    if (!plan) continue;
    const record = simulate(level, plan, { maxSteps: 900_000 });
    if (record.summary.outcome !== 'docked') {
      const reasons = record.summary.issues.map((issue: Issue) => issue.message).join('; ');
      throw new Error(`内置参考航线 ${id} 未能靠泊：${reasons}`);
    }
  }
}
