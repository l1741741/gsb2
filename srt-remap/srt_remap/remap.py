"""核心重映射逻辑。

流程
----
1. 按解析后的绝对路径去重加载每个素材的 SRT（多片段可引用同一文件）。
2. 对每个剪辑片段与每条源字幕求源时间轴上的相交区间，只保留相交部分；
   同一条源字幕被多个片段引用时，每个片段各自产出成片字幕并保留来源。
3. 用 Decimal 完成变速映射后，在毫秒边界统一 HALF_UP 舍入（唯一舍入点
   见 :mod:`srt_remap.timecode`），舍入后零时长的字幕丢弃并记入报告。
4. 冲突处理：

   * ``trim``（默认）——轨道号小的片段优先，高轨字幕被低轨已占用区间
     裁掉（可能被切成多段）；同轨重叠无法判定优先级，保留并标记冲突。
   * ``keep``——全部保留，所有成片时间轴重叠都写入冲突报告。

   区间按半开区间 ``[start, end)`` 处理：端点相碰（``a.end == b.start``）
   不算重叠，紧挨着的片段不会凭空产生冲突。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from .edl import Clip, EditList, load_edit_list
from .errors import RemapError
from .srt_io import Cue, read_srt
from .timecode import to_millis


@dataclass
class MappedCue:
    """一条成片字幕及其完整来源信息。"""

    start: int          # 成片起点，毫秒
    end: int            # 成片终点，毫秒
    text: str
    material: str       # 素材标识
    line_no: int        # 剪辑清单行（clips 数组序号，从 1 开始）
    track: int
    speed: Decimal
    src_cue_index: int  # 源 SRT 中的条目序号
    src_start: int      # 保留下来的源区间起点，毫秒
    src_end: int        # 保留下来的源区间终点，毫秒

    def provenance(self) -> str:
        return (
            f"{self.material}#L{self.line_no}/cue{self.src_cue_index}"
            f"[{self.src_start}-{self.src_end}]"
        )


@dataclass
class Conflict:
    cue_a: MappedCue
    cue_b: MappedCue
    overlap_start: int
    overlap_end: int
    reason: str


@dataclass
class DroppedCue:
    material: str
    line_no: int
    src_cue_index: int
    src_start: int
    src_end: int
    reason: str


@dataclass
class Project:
    edit_list: EditList
    # 解析后的 SRT 绝对路径 -> 源字幕
    subtitles: Dict[Path, List[Cue]]


@dataclass
class RemapResult:
    cues: List[MappedCue]
    conflicts: List[Conflict] = field(default_factory=list)
    dropped: List[DroppedCue] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    def to_srt_cues(self) -> List[Cue]:
        return [
            Cue(start=c.start, end=c.end, text=c.text, index=i)
            for i, c in enumerate(self.cues, start=1)
        ]


def load_project(edl_path: str | Path) -> Project:
    """加载剪辑清单并一次性校验全部字幕文件是否可读。"""
    edit_list = load_edit_list(edl_path)
    subtitles: Dict[Path, List[Cue]] = {}
    problems: List[str] = []
    for clip in edit_list.clips:
        resolved = clip.srt_path.resolve()
        if resolved in subtitles:
            continue
        try:
            subtitles[resolved] = read_srt(clip.srt_path, material=clip.material)
        except RemapError as exc:
            problems.append(
                f"剪辑清单第 {clip.line_no} 行（素材 {clip.material!r}）：{exc.message}"
            )
    if problems:
        raise RemapError("字幕文件校验失败：\n  - " + "\n  - ".join(problems))
    return Project(edit_list=edit_list, subtitles=subtitles)


def _map_clip_cues(clip: Clip, src_cues: Sequence[Cue]) -> Tuple[List[MappedCue], List[DroppedCue]]:
    """把单个片段覆盖到的源字幕映射到成片时间（未做冲突裁剪）。

    求交与变速映射全程在 Decimal 秒域进行：片段边界（如 5.0s）保持精确，
    相邻片段共享的切点不会因提前舍入而凭空产生 1ms 重叠/缝隙。毫秒舍入
    只在产出 :class:`MappedCue` 时经 :func:`to_millis` 统一发生一次。
    """
    mapped: List[MappedCue] = []
    dropped: List[DroppedCue] = []
    thousand = Decimal(1000)
    for cue in src_cues:
        # SRT 本身是毫秒精度，转成 Decimal 秒后与片段边界同域比较
        cue_start = Decimal(cue.start) / thousand
        cue_end = Decimal(cue.end) / thousand
        # 半开区间求交；完全不相交则跳过（空白区间天然无字幕）
        isec_start = max(clip.src_in, cue_start)
        isec_end = min(clip.src_out, cue_end)
        if isec_start >= isec_end:
            continue

        # 精确映射：成片时间 = 成片起点 + (源相对偏移) / 速度
        dst_start_exact = clip.dst_start + (isec_start - clip.src_in) / clip.speed
        dst_end_exact = clip.dst_start + (isec_end - clip.src_in) / clip.speed
        dst_start = to_millis(dst_start_exact)
        dst_end = to_millis(dst_end_exact)
        src_start_ms = to_millis(isec_start)
        src_end_ms = to_millis(isec_end)

        if dst_end <= dst_start:
            dropped.append(DroppedCue(
                material=clip.material, line_no=clip.line_no,
                src_cue_index=cue.index,
                src_start=src_start_ms, src_end=src_end_ms,
                reason=(
                    f"变速 {format(clip.speed, 'f')}x 后相交区间不足 1ms，"
                    f"舍入为零时长（{dst_start}ms），已丢弃"
                ),
            ))
            continue

        mapped.append(MappedCue(
            start=dst_start, end=dst_end, text=cue.text,
            material=clip.material, line_no=clip.line_no, track=clip.track,
            speed=clip.speed, src_cue_index=cue.index,
            src_start=src_start_ms, src_end=src_end_ms,
        ))
    return mapped, dropped


def _subtract(interval: Tuple[int, int],
              blockers: Sequence[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """从 ``interval`` 中减去若干不相交的阻塞区间，返回剩余片段。"""
    start, end = interval
    pieces: List[Tuple[int, int]] = []
    cursor = start
    for b_start, b_end in blockers:
        if b_end <= cursor:
            continue
        if b_start >= end:
            break
        if b_start > cursor:
            pieces.append((cursor, min(b_start, end)))
        cursor = max(cursor, b_end)
        if cursor >= end:
            break
    if cursor < end:
        pieces.append((cursor, end))
    return pieces


def _find_conflicts(cues: Sequence[MappedCue]) -> List[Conflict]:
    """成对检测成片时间轴重叠（端点相碰不算）。"""
    conflicts: List[Conflict] = []
    ordered = sorted(cues, key=lambda c: (c.start, c.end, c.line_no, c.src_cue_index))
    for i, a in enumerate(ordered):
        for b in ordered[i + 1:]:
            if b.start >= a.end:
                break  # 已按起点排序，之后的都不可能与 a 相交
            overlap_start = max(a.start, b.start)
            overlap_end = min(a.end, b.end)
            if overlap_start < overlap_end:
                if a.line_no == b.line_no:
                    reason = "同一剪辑片段内源字幕时间轴重叠（请检查 SRT）"
                elif a.track == b.track:
                    reason = f"轨道 {a.track} 相同，无法按优先级裁剪"
                else:
                    lo = a if a.track < b.track else b
                    reason = f"轨道 {lo.track} 优先，另一轨被遮挡"
                conflicts.append(Conflict(
                    cue_a=a, cue_b=b,
                    overlap_start=overlap_start, overlap_end=overlap_end,
                    reason=reason,
                ))
    return conflicts


def remap(project: Project, *, mode: str = "trim") -> RemapResult:
    """执行重映射。``mode`` 取 ``"trim"`` 或 ``"keep"``。"""
    if mode not in ("trim", "keep"):
        raise RemapError(f"未知冲突处理模式: {mode!r}（可选 trim / keep）")

    warnings = list(project.edit_list.warnings)
    all_cues: List[MappedCue] = []
    all_dropped: List[DroppedCue] = []

    for clip in project.edit_list.clips:
        src_cues = project.subtitles[clip.srt_path.resolve()]
        mapped, dropped = _map_clip_cues(clip, src_cues)
        all_cues.extend(mapped)
        all_dropped.extend(dropped)

    conflicts = _find_conflicts(all_cues)

    if mode == "trim":
        # 轨道号小（优先级高）先占位；同轨之间不互相裁剪
        placed: List[MappedCue] = []
        blockers_by_track: Dict[int, List[Tuple[int, int]]] = {}
        for cue in sorted(all_cues, key=lambda c: (c.track, c.line_no, c.src_cue_index)):
            blockers: List[Tuple[int, int]] = []
            for track, intervals in blockers_by_track.items():
                if track < cue.track:
                    blockers.extend(intervals)
            blockers.sort()
            pieces = _subtract((cue.start, cue.end), blockers)
            if not pieces:
                all_dropped.append(DroppedCue(
                    material=cue.material, line_no=cue.line_no,
                    src_cue_index=cue.src_cue_index,
                    src_start=cue.src_start, src_end=cue.src_end,
                    reason=f"整条被更高优先级轨道（轨道号 < {cue.track}）遮挡，已裁剪",
                ))
                continue
            for piece_start, piece_end in pieces:
                if piece_start == cue.start and piece_end == cue.end:
                    placed.append(cue)
                else:
                    placed.append(MappedCue(
                        start=piece_start, end=piece_end, text=cue.text,
                        material=cue.material, line_no=cue.line_no,
                        track=cue.track, speed=cue.speed,
                        src_cue_index=cue.src_cue_index,
                        src_start=cue.src_start, src_end=cue.src_end,
                    ))
                    warnings.append(
                        f"素材 {cue.material!r}（第 {cue.line_no} 行，源字幕 "
                        f"#{cue.src_cue_index}）与高轨重叠，已裁剪为 "
                        f"{piece_start}-{piece_end}ms"
                    )
            blockers_by_track.setdefault(cue.track, []).append((cue.start, cue.end))
            blockers_by_track[cue.track].sort()
        all_cues = placed
        # 裁剪后重新检测：跨轨冲突已由高轨占位解决，同轨重叠仍需报告
        conflicts = [
            c for c in _find_conflicts(all_cues)
            if c.cue_a.track == c.cue_b.track
        ]

    all_cues.sort(key=lambda c: (c.start, c.track, c.line_no, c.src_cue_index))
    return RemapResult(
        cues=all_cues, conflicts=conflicts,
        dropped=all_dropped, warnings=warnings,
    )
