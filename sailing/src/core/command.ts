import { sortCommands, normalizeHeading, clampSheet } from './level.ts';
import type { BoatCommandLike, CourseCommand, CoursePlan, Level } from './types.ts';

/**
 * 关卡时间 time 生效的指令。同刻多条指令中最后一条胜出；
 * 无指令时使用关卡初始航向与帆位。
 */
export function commandAt(level: Level, plan: CoursePlan, time: number): BoatCommandLike {
  const commands = sortCommands(plan.commands);
  let heading = normalizeHeading(level.start.heading);
  let sheet = clampSheet(level.start.sheet);
  for (const command of commands) {
    if (command.time <= time + 1e-9) {
      heading = normalizeHeading(command.heading);
      sheet = clampSheet(command.sheet);
    } else {
      break;
    }
  }
  return { heading, sheet };
}

/** 返回 (time, command) 区间；用于 UI 上的当前指令高亮。 */
export function activeCommandIndex(plan: CoursePlan, time: number): number {
  const commands = sortCommands(plan.commands);
  let index = -1;
  for (let i = 0; i < commands.length; i++) {
    if ((commands[i] as CourseCommand).time <= time + 1e-9) index = i;
    else break;
  }
  return index;
}

export function commandsInWindow(plan: CoursePlan, from: number, to: number): CourseCommand[] {
  return sortCommands(plan.commands).filter((command) => command.time >= from && command.time <= to);
}
