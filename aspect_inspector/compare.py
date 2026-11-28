"""母版与交付版的逐窗对比：画幅差异、持续变化与待确认判定。"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from .analysis import WindowAnalysis


class DiffType(str, Enum):
    MATCH = "match"                    # 边界一致
    BOUNDS_DIFF = "bounds_diff"        # 有效画面边界存在持续差异
    ASPECT_SWITCH = "aspect_switch"    # 至少一方在窗内发生画幅切换
    ALL_BLACK = "all_black"            # 双方整窗全黑，无法比较
    INSUFFICIENT = "insufficient"      # 采样证据不足
    GEOMETRY_MISMATCH = "geometry_mismatch"  # 显示几何（旋转/SAR/DAR）不同


@dataclass
class WindowComparison:
    window_id: str
    start: float
    end: float
    diff_type: DiffType
    confirmed: bool
    master_summary: tuple[float, float, float, float] | None
    deliver_summary: tuple[float, float, float, float] | None
    max_bbox_deviation: float | None
    master_segments: int
    deliver_segments: int
    evidence_time: float | None        # 截图时间点（源片时间轴）
    screenshot: str | None = None
    notes: list[str] = field(default_factory=list)


def _bbox_max_dev(a: tuple[float, ...] | None,
                  b: tuple[float, ...] | None) -> float | None:
    if a is None or b is None:
        return None
    return max(abs(x - y) for x, y in zip(a, b))


def compare_window(
    master: WindowAnalysis,
    deliver: WindowAnalysis,
    bbox_diff_tolerance: float = 0.03,
    min_persistent_seconds: float = 0.25,
    sample_fps: float = 10.0,
) -> WindowComparison:
    """对比同一时间窗内母版与交付版的分析结果。

    判定顺序：
    1. 双方全黑 → all_black（不算错误，只记录）；
    2. 任一方证据不足 → insufficient（待确认，不下结论）；
    3. 窗内画幅段数 > 1 → aspect_switch（持续画幅变化）；
    4. 代表性边界偏差超容差且持续足够久 → bounds_diff；
    5. 其余 → match。
    """
    notes: list[str] = []
    confirmed = True
    evidence_t: float | None = None

    # 1. 全黑窗
    if master.status == "all_black" and deliver.status == "all_black":
        return WindowComparison(
            window_id=master.window_id, start=master.start, end=master.end,
            diff_type=DiffType.ALL_BLACK, confirmed=True,
            master_summary=None, deliver_summary=None,
            max_bbox_deviation=None,
            master_segments=0, deliver_segments=0,
            evidence_time=None,
            notes=["双方该时间窗均为全黑，无画面可比，不计入画幅错误"],
        )

    # 2. 证据不足（含一方全黑、另一方有内容这种异常组合）
    weak_sides = []
    if master.status in ("all_black", "insufficient"):
        weak_sides.append("母版")
    if deliver.status in ("all_black", "insufficient"):
        weak_sides.append("交付版")
    if weak_sides:
        notes.append(
            "证据不足（" + "、".join(weak_sides)
            + f"）：母版内容帧 {master.content_count}/{master.sampled_count}，"
            f"交付版内容帧 {deliver.content_count}/{deliver.sampled_count}，标记为待确认"
        )
        # 仍尝试给出证据时间点，供人工复核截图
        evidence_t = _pick_evidence_time(master, deliver)
        return WindowComparison(
            window_id=master.window_id, start=master.start, end=master.end,
            diff_type=DiffType.INSUFFICIENT, confirmed=False,
            master_summary=master.summary_bbox_norm,
            deliver_summary=deliver.summary_bbox_norm,
            max_bbox_deviation=_bbox_max_dev(
                master.summary_bbox_norm, deliver.summary_bbox_norm),
            master_segments=len(master.segments),
            deliver_segments=len(deliver.segments),
            evidence_time=evidence_t, notes=notes,
        )

    # 3. 窗内画幅切换（任一方出现 2 段及以上已确认/待确认段）
    if len(master.segments) > 1 or len(deliver.segments) > 1:
        notes.append(
            f"窗内出现画幅分段：母版 {len(master.segments)} 段，"
            f"交付版 {len(deliver.segments)} 段"
        )
        unconfirmed = [s for side in (master, deliver) for s in side.segments
                       if not s.confirmed]
        if unconfirmed:
            confirmed = False
            notes.append("部分分段有效帧不足，切换结论待确认")
        evidence_t = _pick_evidence_time(master, deliver)
        return WindowComparison(
            window_id=master.window_id, start=master.start, end=master.end,
            diff_type=DiffType.ASPECT_SWITCH, confirmed=confirmed,
            master_summary=master.summary_bbox_norm,
            deliver_summary=deliver.summary_bbox_norm,
            max_bbox_deviation=_bbox_max_dev(
                master.summary_bbox_norm, deliver.summary_bbox_norm),
            master_segments=len(master.segments),
            deliver_segments=len(deliver.segments),
            evidence_time=evidence_t, notes=notes,
        )

    # 4. 边界差异
    deviation = _bbox_max_dev(master.summary_bbox_norm,
                              deliver.summary_bbox_norm)
    evidence_t = _pick_evidence_time(master, deliver)
    if deviation is not None and deviation > bbox_diff_tolerance:
        # 持续性校验：差异必须在足够多的帧上成立，单个异常帧不算
        persistent = _difference_is_persistent(
            master, deliver, bbox_diff_tolerance,
            min_frames=max(2, round(min_persistent_seconds * sample_fps)),
        )
        if not persistent:
            confirmed = False
            notes.append(
                f"边界最大偏差 {deviation:.3f} 超过容差 {bbox_diff_tolerance:.3f}，"
                "但仅在少数帧出现，持续性不足，待确认"
            )
            diff_type = DiffType.INSUFFICIENT
        else:
            notes.append(
                f"有效画面边界持续差异：归一化最大偏差 {deviation:.3f}"
                f"（容差 {bbox_diff_tolerance:.3f}）"
            )
            diff_type = DiffType.BOUNDS_DIFF
    else:
        diff_type = DiffType.MATCH
        notes.append("有效画面边界一致")

    return WindowComparison(
        window_id=master.window_id, start=master.start, end=master.end,
        diff_type=diff_type, confirmed=confirmed,
        master_summary=master.summary_bbox_norm,
        deliver_summary=deliver.summary_bbox_norm,
        max_bbox_deviation=round(deviation, 5) if deviation is not None else None,
        master_segments=len(master.segments),
        deliver_segments=len(deliver.segments),
        evidence_time=evidence_t, notes=notes,
    )


def _difference_is_persistent(master: WindowAnalysis,
                              deliver: WindowAnalysis,
                              tolerance: float,
                              min_frames: int) -> bool:
    """逐帧（按采样序号配对）统计边界超差帧是否达到持续门槛。"""
    m_frames = {f.index: f for f in master.frames if f.bbox_norm is not None}
    d_frames = {f.index: f for f in deliver.frames if f.bbox_norm is not None}
    diff_frames = 0
    for idx in sorted(set(m_frames) & set(d_frames)):
        dev = _bbox_max_dev(m_frames[idx].bbox_norm, d_frames[idx].bbox_norm)
        if dev is not None and dev > tolerance:
            diff_frames += 1
    return diff_frames >= min_frames


def _pick_evidence_time(master: WindowAnalysis,
                        deliver: WindowAnalysis) -> float | None:
    """选一个双方都有内容帧的中间时刻作为截图证据时间点。"""
    m_times = {round(f.pts_time, 3) for f in master.frames if f.bbox_norm}
    d_times = {round(f.pts_time, 3) for f in deliver.frames if f.bbox_norm}
    common = sorted(m_times & d_times)
    if common:
        return common[len(common) // 2]
    any_times = sorted(m_times | d_times)
    if any_times:
        return any_times[len(any_times) // 2]
    return (master.start + master.end) / 2


def compare_geometry(master_info, deliver_info) -> list[str]:
    """检查显示坐标层面的几何元数据是否一致（旋转/SAR/DAR）。"""
    issues: list[str] = []
    if master_info.rotation != deliver_info.rotation:
        issues.append(
            f"旋转角不同：母版 {master_info.rotation}° vs 交付版 {deliver_info.rotation}°"
        )
    if master_info.sar != deliver_info.sar:
        issues.append(
            f"像素宽高比不同：母版 SAR={master_info.sar} vs 交付版 SAR={deliver_info.sar}"
        )
    if master_info.display_aspect != deliver_info.display_aspect:
        issues.append(
            f"显示宽高比不同：母版 DAR={master_info.display_aspect} "
            f"vs 交付版 DAR={deliver_info.display_aspect}"
        )
    if master_info.hflip != deliver_info.hflip:
        issues.append("水平翻转标记不同，需人工确认镜像是否符合预期")
    return issues
