import type { GateCrossing, Issue, RunLeg, RunRecord, TimelineEvent, Vec2 } from './types.ts';

/**
 * 把一次记录拆成“航段”：起点 → 每次有效通过浮标 → 靠泊 / 终止。
 * kind 描述该航段的终点；第一条航段终点就是第 1 个浮标。
 */
export function buildLegs(record: RunRecord): RunLeg[] {
  const summary = record.summary;
  const points: Array<{
    time: number;
    position: Vec2;
    kind: 'start' | 'gate' | 'dock' | 'issue';
    label: string;
    order: number;
  }> = [
    {
      time: 0,
      position: record.frames[0]?.position ?? summary.finalPosition,
      kind: 'start',
      label: '起点',
      order: 0,
    },
  ];

  for (const crossing of summary.crossings) {
    if (crossing.order <= 0) continue;
    points.push({
      time: crossing.time,
      position: crossing.position,
      kind: 'gate',
      label: `浮标 ${crossing.order}`,
      order: crossing.order,
    });
  }

  const finalKind: 'dock' | 'issue' = summary.outcome === 'docked' ? 'dock' : 'issue';
  points.push({
    time: summary.finishTime,
    position: summary.finalPosition,
    kind: finalKind,
    label: summary.outcome === 'docked' ? '靠泊完成' : firstIssueLabel(summary.issues),
    order: summary.routeProgress,
  });

  const legs: RunLeg[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end.time < start.time - 1e-9) continue;
    legs.push({
      index: legs.length,
      label: `${start.label} → ${end.label}`,
      kind: end.kind,
      startTime: start.time,
      endTime: end.time,
      startPosition: start.position,
      endPosition: end.position,
      order: end.order,
    });
  }
  return legs;
}

function firstIssueLabel(issues: Issue[]): string {
  const issue = issues[0];
  return issue ? issueLabel(issue) : '航次结束';
}

export function issueLabel(issue: Issue): string {
  switch (issue.kind) {
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
  }
}

/** 时间轴定位点：起点、全部过标事件、全部问题、风变化、靠泊。 */
export function buildTimeline(
  record: RunRecord,
  windChanges: Array<{ time: number; label: string }> = [],
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  events.push({
    id: 'start',
    time: 0,
    kind: 'start',
    label: '起点',
    position: record.frames[0]?.position ?? record.summary.finalPosition,
    frameIndex: 0,
  });

  for (const crossing of record.summary.crossings) {
    events.push({
      id: `gate-${crossing.order}-${crossing.gateId}-${crossing.time.toFixed(3)}`,
      time: crossing.time,
      kind: 'gate',
      label: crossing.order > 0 ? `通过浮标 #${crossing.order}` : `非次序过标 ${crossing.gateId}`,
      position: crossing.position,
      frameIndex: frameIndexAt(record, crossing.time),
    });
  }

  for (const issue of record.summary.issues) {
    events.push({
      id: `issue-${issue.kind}-${issue.time.toFixed(3)}`,
      time: issue.time,
      kind: 'issue',
      label: issueLabel(issue),
      position: issue.position,
      frameIndex: frameIndexAt(record, issue.time),
    });
  }

  for (const change of windChanges) {
    events.push({
      id: `wind-${change.time}`,
      time: change.time,
      kind: 'wind',
      label: change.label,
      position: record.summary.finalPosition,
      frameIndex: frameIndexAt(record, change.time),
    });
  }

  if (record.summary.outcome === 'docked') {
    events.push({
      id: 'dock',
      time: record.summary.finishTime,
      kind: 'dock',
      label: '靠泊',
      position: record.summary.finalPosition,
      frameIndex: frameIndexAt(record, record.summary.finishTime),
    });
  }

  events.sort((a, b) => a.time - b.time || a.frameIndex - b.frameIndex);
  return events;
}

/** 小于等于 time 的最近帧索引（二分）。 */
export function frameIndexAt(record: RunRecord, time: number): number {
  const frames = record.frames;
  if (frames.length === 0) return 0;
  if (time <= (frames[0] as { time: number }).time) return 0;
  if (time >= (frames[frames.length - 1] as { time: number }).time) return frames.length - 1;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((frames[mid] as { time: number }).time <= time + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** 找到覆盖 time 的帧区间 [i, i+1]，用于线性插值。 */
export function frameAround(record: RunRecord, time: number): { index: number; alpha: number } {
  const frames = record.frames;
  if (frames.length <= 1) return { index: 0, alpha: 0 };
  const index = frameIndexAt(record, time);
  const next = Math.min(frames.length - 1, index + 1);
  const a = frames[index] as { time: number };
  const b = frames[next] as { time: number };
  const alpha = b.time > a.time ? Math.min(1, Math.max(0, (time - a.time) / (b.time - a.time))) : 0;
  return { index, alpha };
}

/** 任意时刻的船位（线性插值），回放定位用。 */
export function sampleAt(record: RunRecord, time: number): RunRecord['frames'][number] {
  const frames = record.frames;
  const a = frames[frameAround(record, time).index];
  if (!a) throw new RangeError('record has no frames');
  const b = frames[Math.min(frames.length - 1, frameAround(record, time).index + 1)] ?? a;
  const alpha = frameAround(record, time).alpha;
  if (alpha <= 0 || !b) return a;
  return {
    time,
    position: {
      x: a.position.x + (b.position.x - a.position.x) * alpha,
      y: a.position.y + (b.position.y - a.position.y) * alpha,
    },
    heading: b.heading,
    track: b.track,
    speed: a.speed + (b.speed - a.speed) * alpha,
    sheet: a.sheet + (b.sheet - a.sheet) * alpha,
    windSpeed: b.windSpeed,
    windDirection: b.windDirection,
    zoneId: b.zoneId,
    zoneName: b.zoneName,
  };
}

/** 记录中截至 time 的有效过标数。 */
export function progressAt(record: RunRecord, time: number): number {
  let progress = 0;
  for (const crossing of record.summary.crossings) {
    if (crossing.time > time + 1e-9) break;
    if (crossing.order > 0) progress = Math.max(progress, crossing.order);
  }
  return progress;
}

/** 记录中截至 time 已发生的全部事件（回放面板用）。 */
export function eventsBefore(record: RunRecord, time: number): Array<GateCrossing | Issue> {
  const result: Array<GateCrossing | Issue> = [];
  for (const crossing of record.summary.crossings) {
    if (crossing.time <= time + 1e-9) result.push(crossing);
  }
  for (const issue of record.summary.issues) {
    if (issue.time <= time + 1e-9) result.push(issue);
  }
  return result;
}
