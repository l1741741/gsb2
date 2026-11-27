import { stableStringify } from './hash.ts';
import { normalizePlan } from './level.ts';
import type { CommandChange, CoursePlan, Level, RunComparison, RunRecord } from './types.ts';

/**
 * 记录对比：分别回答“关卡是否变了”和“玩家指令是否变了”，
 * 再列出结果差异与首个分歧点。
 *
 * 这样玩家能分清：同样是失败，究竟是关卡被调整（比如风力增强），
 * 还是自己改了航线（比如提前收帆）。
 */
export function compareRuns(
  levelA: Level,
  levelB: Level,
  recordA: RunRecord,
  recordB: RunRecord,
): RunComparison {
  const levelFields = changedTopLevelFields(levelA, levelB);
  const sameLevel = levelFields.length === 0;

  const commandChanges = diffCommands(normalizePlan(recordA.plan), normalizePlan(recordB.plan));
  const sameCommands = commandChanges.length === 0;

  const resultChanges = diffResults(recordA, recordB);
  const firstDivergence = describeFirstDivergence(recordA, recordB, sameLevel, sameCommands);

  let cause: RunComparison['cause'] = 'none';
  if (!sameLevel && !sameCommands) cause = 'both';
  else if (!sameLevel) cause = 'level';
  else if (!sameCommands) cause = 'plan';

  return {
    sameLevel,
    sameCommands,
    levelFields,
    commandChanges,
    resultChanges,
    firstDivergence,
    cause,
  };
}

/** 仅用于显示的字段不参与“关卡变化”判定。 */
const DISPLAY_FIELDS = new Set(['palette', 'briefing', 'name', 'subtitle']);

function changedTopLevelFields(a: Level, b: Level): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (DISPLAY_FIELDS.has(key)) continue;
    const left = (a as unknown as Record<string, unknown>)[key];
    const right = (b as unknown as Record<string, unknown>)[key];
    if (stableStringify(left) !== stableStringify(right)) changed.push(key);
  }
  return changed.sort();
}

/**
 * 指令差异按“时间顺序逐条配对”：
 * - 条数相同 → 逐条比较时间 / 航向 / 帆位；
 * - 条数不同 → 多出来的记为 added / removed。
 * 这比按内容匹配更容易读懂“第几条被改了”。
 */
function diffCommands(a: CoursePlan, b: CoursePlan): CommandChange[] {
  const changes: CommandChange[] = [];
  const left = a.commands;
  const right = b.commands;
  const common = Math.min(left.length, right.length);

  for (let index = 0; index < common; index++) {
    const before = left[index]!;
    const after = right[index]!;
    if (before.time !== after.time) {
      changes.push({ kind: 'changed', time: before.time, field: 'time', before: before.time, after: after.time });
    }
    if (before.heading !== after.heading) {
      changes.push({ kind: 'changed', time: before.time, field: 'heading', before: before.heading, after: after.heading });
    }
    if (before.sheet !== after.sheet) {
      changes.push({ kind: 'changed', time: before.time, field: 'sheet', before: before.sheet, after: after.sheet });
    }
  }
  for (let index = common; index < left.length; index++) {
    const command = left[index]!;
    changes.push({ kind: 'removed', time: command.time, field: 'time', before: command.time });
  }
  for (let index = common; index < right.length; index++) {
    const command = right[index]!;
    changes.push({ kind: 'added', time: command.time, field: 'time', after: command.time });
  }
  return changes.sort((x, y) => x.time - y.time);
}

function diffResults(a: RunRecord, b: RunRecord): string[] {
  const changes: string[] = [];
  if (a.summary.outcome !== b.summary.outcome) {
    changes.push(`结果：${outcomeLabel(a.summary.outcome)} → ${outcomeLabel(b.summary.outcome)}`);
  }
  if (a.summary.routeProgress !== b.summary.routeProgress) {
    changes.push(`按次序通过：${a.summary.routeProgress} → ${b.summary.routeProgress} 个浮标`);
  }
  if (Math.abs(a.summary.finishTime - b.summary.finishTime) > 1e-6) {
    changes.push(`结束时间：${a.summary.finishTime.toFixed(2)}s → ${b.summary.finishTime.toFixed(2)}s`);
  }
  const orderA = validOrderSequence(a);
  const orderB = validOrderSequence(b);
  if (orderA !== orderB) changes.push(`过标次序：${orderA || '（无）'} → ${orderB || '（无）'}`);
  const issuesA = issueSignature(a);
  const issuesB = issueSignature(b);
  if (issuesA !== issuesB) changes.push(`事件：${issuesA || '（无）'} → ${issuesB || '（无）'}`);
  if (changes.length === 0) changes.push('结果一致');
  return changes;
}

interface TimedEvent {
  time: number;
  key: string;
}

/** 把记录压平成事件序列，用于定位首个分歧。 */
function eventSequence(record: RunRecord): TimedEvent[] {
  const events: TimedEvent[] = [];
  for (const crossing of record.summary.crossings) {
    events.push({
      time: crossing.time,
      key: `gate:${crossing.gateId}:${crossing.order > 0 ? 'ok' : crossing.repeat ? 'repeat' : 'wrong'}`,
    });
  }
  for (const issue of record.summary.issues) {
    events.push({ time: issue.time, key: `issue:${issue.kind}:${issue.subjectId ?? ''}` });
  }
  events.push({ time: record.summary.finishTime, key: `end:${record.summary.outcome}` });
  events.sort((x, y) => x.time - y.time);
  return events;
}

function describeFirstDivergence(
  a: RunRecord,
  b: RunRecord,
  sameLevel: boolean,
  sameCommands: boolean,
): string | null {
  if (sameLevel && sameCommands) {
    const identical =
      a.summary.outcome === b.summary.outcome &&
      Math.abs(a.summary.finishTime - b.summary.finishTime) < 1e-6 &&
      validOrderSequence(a) === validOrderSequence(b) &&
      issueSignature(a) === issueSignature(b);
    return identical ? null : '关卡与航线相同但结果不同：请检查仿真版本或运行环境是否一致';
  }

  const causeText = sameLevel
    ? '玩家修改了指令'
    : sameCommands
      ? '关卡内容变化'
      : '关卡内容与玩家指令都变了';

  const seqA = eventSequence(a);
  const seqB = eventSequence(b);
  const common = Math.min(seqA.length, seqB.length);
  for (let index = 0; index < common; index++) {
    const left = seqA[index]!;
    const right = seqB[index]!;
    if (left.key !== right.key || Math.abs(left.time - right.time) > 1e-6) {
      const delta = right.time - left.time;
      const timeText = Math.abs(delta) < 1e-6 ? '同一时刻' : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}s`;
      return `${causeText}：第 ${index + 1} 个事件不同（${describeEvent(left.key)} → ${describeEvent(right.key)}，${timeText}）`;
    }
  }
  if (seqA.length !== seqB.length) {
    const longer = seqA.length > seqB.length ? seqA : seqB;
    const extra = longer[common]!;
    return `${causeText}：${describeEvent(extra.key)} 只出现在其中一条记录（${extra.time.toFixed(2)}s）`;
  }
  return `${causeText}：事件序列相同，但结束时间或细节不同`;
}

function describeEvent(key: string): string {
  const [kind, ...rest] = key.split(':');
  if (kind === 'gate') {
    const id = rest[0] ?? '?';
    const state = rest[1] ?? '';
    return state === 'ok' ? `按次序通过 ${id}` : state === 'repeat' ? `回穿 ${id}` : `非次序通过 ${id}`;
  }
  if (kind === 'issue') {
    const issueKind = rest[0] ?? '?';
    return issueKindLabel(issueKind);
  }
  if (kind === 'end') {
    return `结束（${outcomeLabel(rest[0] as RunRecord['summary']['outcome'])}）`;
  }
  return key;
}

function issueKindLabel(kind: string): string {
  switch (kind) {
    case 'wrong-order':
      return '逆序过标';
    case 'obstacle-contact':
      return '擦碰障碍';
    case 'over-speed-dock':
      return '进港超速';
    case 'dock-missed':
      return '未对准泊位';
    case 'outside-bounds':
      return '触岸出界';
    case 'timeout':
      return '超时';
    default:
      return kind;
  }
}

function validOrderSequence(record: RunRecord): string {
  return record.summary.crossings
    .filter((crossing) => crossing.order > 0)
    .map((crossing) => crossing.gateId)
    .join('>');
}

function issueSignature(record: RunRecord): string {
  return record.summary.issues.map((issue) => issue.kind).join(',');
}

function outcomeLabel(outcome: RunRecord['summary']['outcome']): string {
  if (outcome === 'docked') return '靠泊成功';
  if (outcome === 'failed') return '航次失败';
  return '超时未完成';
}
