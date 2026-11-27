"""项目时间轴 -> 逐段 provenance 的扫线算法。"""

from __future__ import annotations

from .model import (
    KIND_OVERLAP,
    KIND_SILENCE,
    KIND_SOURCE,
    ResolvedSegment,
    Run,
)


def _active_at(frame: int, segments: tuple[ResolvedSegment, ...]) -> list[ResolvedSegment]:
    """覆盖帧 frame (即有效区间含 [frame, frame+1)) 的所有段落。"""
    return [s for s in segments if s.effective_start <= frame < s.effective_end]


def _pick_winner(active: list[ResolvedSegment]) -> tuple[ResolvedSegment, list[ResolvedSegment]]:
    """重叠优先级: priority 大者胜; 相同则按段落 id 字典序, 保证确定性。"""
    ordered = sorted(active, key=lambda s: (-s.spec.priority, s.spec.segment_id))
    return ordered[0], ordered


def build_runs(
    range_start: int,
    range_end: int,
    segments: tuple[ResolvedSegment, ...],
) -> tuple[Run, ...]:
    """把 [range_start, range_end) 切成连续的 Run 序列。

    切分点只取范围端点与各段落有效区间端点, 因此每个 Run 内部的
    来源关系恒定。相邻同来源的 Run 会被合并。
    """
    if range_end <= range_start:
        return ()

    boundaries = {range_start, range_end}
    for seg in segments:
        if seg.effective_end > range_start and seg.effective_start < range_end:
            boundaries.add(max(range_start, seg.effective_start))
            boundaries.add(min(range_end, seg.effective_end))

    points = sorted(boundaries)
    raw_runs: list[Run] = []
    for a, b in zip(points, points[1:]):
        active = _active_at(a, segments)
        if not active:
            raw_runs.append(Run(start_frame=a, end_frame=b, kind=KIND_SILENCE))
            continue
        winner, ordered = _pick_winner(active)
        kind = KIND_OVERLAP if len(active) > 1 else KIND_SOURCE
        offset = winner.spec.start_frame
        raw_runs.append(
            Run(
                start_frame=a,
                end_frame=b,
                kind=kind,
                segment_id=winner.spec.segment_id,
                source_start_frame=a - offset,
                source_end_frame=b - offset,
                contenders=tuple(s.spec.segment_id for s in ordered),
            )
        )

    # 合并相邻且来源/种类相同的段, 减少碎片
    merged: list[Run] = []
    for run in raw_runs:
        if (
            merged
            and merged[-1].end_frame == run.start_frame
            and merged[-1].kind == run.kind
            and merged[-1].segment_id == run.segment_id
        ):
            prev = merged[-1]
            merged[-1] = Run(
                start_frame=prev.start_frame,
                end_frame=run.end_frame,
                kind=prev.kind,
                segment_id=prev.segment_id,
                source_start_frame=prev.source_start_frame,
                source_end_frame=run.source_end_frame,
                contenders=prev.contenders if prev.kind == KIND_SILENCE else run.contenders,
            )
        else:
            merged.append(run)
    return tuple(merged)


def summarize_runs(runs: tuple[Run, ...]) -> dict[str, int]:
    """统计三类 Run 的帧数。"""
    totals = {KIND_SOURCE: 0, KIND_OVERLAP: 0, KIND_SILENCE: 0}
    for run in runs:
        totals[run.kind] += run.end_frame - run.start_frame
    return totals
