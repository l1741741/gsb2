import type { SegmentDef } from './types.js';

export interface LocatedSegment {
  index: number;
  def: SegmentDef;
  /** 段内已经过的时间 */
  elapsed: number;
}

export function segmentDuration(seg: SegmentDef): number {
  return seg.duration;
}

export function programDuration(program: SegmentDef[]): number {
  return program.reduce((acc, s) => acc + s.duration, 0);
}

/** 定位场景时间 t 落在哪一段，以及段内时间。调用方负责先把 t 规范到 [0, total)。 */
export function locateSegment(program: SegmentDef[], t: number): LocatedSegment {
  let start = 0;
  for (let i = 0; i < program.length; i++) {
    const dur = program[i].duration;
    if (t < start + dur || i === program.length - 1) {
      return { index: i, def: program[i], elapsed: t - start };
    }
    start += dur;
  }
  throw new Error('empty program');
}
