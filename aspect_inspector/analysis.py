"""画幅分析核心：从灰度帧序列中提取有效画面边界并做时序分段。

设计原则（对应需求中的误报来源）：
- 单个全黑帧、片头黑场：不计入内容边界统计，只作为黑帧记录，不污染整段结论；
- 淡入淡出：亮度阈值用每帧自适应，暗帧仍能找到亮部边界，再用时间维
  中位数（而非极值并集）抑制短暂波动；
- 黑边上的少量文字：空间维要求内容行列具备“最小连续带”宽度，
  孤立的细亮条（字幕、时间码、台标）无法把边界整体撑开；
- 样本不足（有效帧太少/段太短）一律标为“待确认”，不做确定性结论。
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from enum import Enum

from .ffmpeg_runner import RawFrame


class FrameClass(str, Enum):
    BLACK = "black"
    CONTENT = "content"


@dataclass
class FrameResult:
    index: int
    pts_time: float
    kind: FrameClass
    mean_luma: float
    max_luma: int
    # 内容边界，归一化到 0..1（显示坐标），全黑帧为 None
    bbox_norm: tuple[float, float, float, float] | None = None


@dataclass
class Segment:
    """一段边界稳定的连续内容。"""

    start_time: float
    end_time: float
    bbox_norm: tuple[float, float, float, float]     # 段内代表性边界（中位数）
    bbox_px: tuple[int, int, int, int]               # 分析分辨率下的像素边界
    frame_count: int
    black_frame_count: int
    width_fraction: float                            # 内容宽 / 显示宽
    height_fraction: float                           # 内容高 / 显示高
    area_fraction: float
    confirmed: bool = True                           # 证据是否充分
    note: str = ""


@dataclass
class WindowAnalysis:
    window_id: str
    start: float
    end: float
    frame_width: int
    frame_height: int
    frames: list[FrameResult] = field(default_factory=list)
    segments: list[Segment] = field(default_factory=list)
    black_ranges: list[tuple[float, float]] = field(default_factory=list)
    sampled_count: int = 0
    content_count: int = 0
    black_count: int = 0
    status: str = "ok"                               # ok / all_black / insufficient
    summary_bbox_norm: tuple[float, float, float, float] | None = None

    @property
    def duration(self) -> float:
        return self.end - self.start


# ---------- 单帧分析 ----------

def _row_col_luma(frame: RawFrame) -> tuple[list[int], list[int]]:
    """计算每行/每列的最大亮度（gray8）。

    行最大值交给内置 max()（C 实现），列最大值在同一遍扫描里更新，
    避免纯 Python 双重下标循环过慢。
    """
    w, h, data = frame.width, frame.height, frame.gray
    row_max = [0] * h
    col_max = [0] * w
    base = 0
    for y in range(h):
        row = data[base:base + w]
        row_max[y] = max(row)
        for x, v in enumerate(row):
            if v > col_max[x]:
                col_max[x] = v
        base += w
    return row_max, col_max


def _content_span(values: list[int], threshold: int, min_band: int,
                  gap_fraction: float = 0.1) -> int | None:
    """返回内容的整体外区间 [lo, hi]（含端点）。

    步骤：
    1. 标记所有超阈值位置并切成连续亮带；
    2. 丢弃短于 min_band 的孤立带（黑边上的文字/时间码笔画）；
    3. 对保留下来的亮带，间距小于 gap_fraction*N 的做桥接合并
       （容忍内容内部的暗列/暗行，如测试图样里的黑色几何图形）；
    4. 取合并后覆盖范围最大的带组的外边界。

    注意 gap_fraction 必须明显小于“黑边文字→主内容”的典型间距
    （pillarbox 黑边宽度通常 >= 15% 短边），否则文字会被桥进内容。
    """
    n = len(values)
    above = [v >= threshold for v in values]
    raw_runs: list[tuple[int, int]] = []
    lo = 0
    while lo < n:
        if not above[lo]:
            lo += 1
            continue
        hi = lo
        while hi + 1 < n and above[hi + 1]:
            hi += 1
        if hi - lo + 1 >= min_band:
            raw_runs.append((lo, hi))
        lo = hi + 1
    if not raw_runs:
        return None

    max_gap = max(1, round(n * gap_fraction))
    groups: list[list[tuple[int, int]]] = [[raw_runs[0]]]
    for run in raw_runs[1:]:
        prev_hi = groups[-1][-1][1]
        if run[0] - prev_hi <= max_gap:
            groups[-1].append(run)
        else:
            groups.append([run])

    # 选覆盖宽度最大的组（主内容块），而不是被暗带截断的局部
    best = max(groups, key=lambda g: g[-1][1] - g[0][0])
    return best[0][0], best[-1][1]


def classify_frame(
    frame: RawFrame,
    black_max_luma: int = 24,
    black_mean_luma: int = 10,
    content_min_band_fraction: float = 0.04,
) -> FrameResult:
    """判定单帧是全黑还是内容帧，并提取内容边界（归一化）。"""
    data = frame.gray
    n = len(data)
    total = sum(data)
    mean_luma = total / n
    max_luma = max(data)

    result = FrameResult(
        index=frame.index,
        pts_time=frame.pts_time,
        kind=FrameClass.BLACK,
        mean_luma=round(mean_luma, 2),
        max_luma=max_luma,
    )
    # 全黑：均值和峰值都很低。淡入的第一帧可能整帧 < 24，正确归为黑帧。
    if max_luma <= black_max_luma and mean_luma <= black_mean_luma:
        return result

    row_max, col_max = _row_col_luma(frame)
    # 自适应阈值：以全帧亮度中位数为锚（代表基础画面/灰底），
    # 黑边（全 0）因占比小拉不动中位数，暗内容区（灰底上的暗图形）
    # 仍显著高于黑帧阈值，从而不会被当成黑边
    frame_median = statistics.median(data)
    adaptive = max(black_max_luma + 1, int(frame_median * 0.45))

    def _adaptive_threshold(peaks: list[int]) -> int:
        active = [v for v in peaks if v > black_max_luma]
        if not active:
            return adaptive
        # 活跃峰值的 25 分位再与全帧锚取较小值，避免阈值被亮区抬高
        q = statistics.quantiles(active, n=4, method="inclusive")[0]
        return min(adaptive, max(black_max_luma + 1, int(q * 0.6)))

    row_thr = _adaptive_threshold(row_max)
    col_thr = _adaptive_threshold(col_max)
    min_row_band = max(2, round(frame.height * content_min_band_fraction))
    min_col_band = max(2, round(frame.width * content_min_band_fraction))

    row_span = _content_span(row_max, row_thr, min_row_band)
    col_span = _content_span(col_max, col_thr, min_col_band)
    if row_span is None or col_span is None:
        # 只有零散亮点（如纯字幕帧），按黑帧处理，不产生边界
        return result

    y0, y1 = row_span
    x0, x1 = col_span
    w, h = frame.width, frame.height
    result.kind = FrameClass.CONTENT
    result.bbox_norm = (x0 / w, y0 / h, (x1 + 1) / w, (y1 + 1) / h)
    return result


# ---------- 时序分段 ----------

def _bbox_distance(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    return max(abs(x - y) for x, y in zip(a, b))


def _median_bbox(boxes: list[tuple[float, float, float, float]]
                 ) -> tuple[float, float, float, float]:
    return tuple(statistics.median([b[i] for b in boxes]) for i in range(4))  # type: ignore[return-value]


def _merge_small_segments(groups: list[list[FrameResult]],
                          min_frames: int) -> list[list[FrameResult]]:
    """把过短的组并入相邻主组（画幅切换处的过渡帧不应自成一段）。"""
    if len(groups) <= 1:
        return groups
    merged: list[list[FrameResult]] = []
    for group in groups:
        if len(group) < min_frames and merged:
            merged[-1].extend(group)
        else:
            merged.append(list(group))
    # 首组过短则并入后一组
    if merged and len(merged[0]) < min_frames and len(merged) > 1:
        merged[1] = merged[0] + merged[1]
        merged = merged[1:]
    return merged


def _smooth_bboxes(frames: list[FrameResult], window: int = 5) -> None:
    """对内容帧的 bbox 时间序列做中值滤波，原地替换。

    消除 1~3 帧的瞬时抖动（测试图样运动、压缩噪声、淡入淡出边界），
    持续的真画幅切换因为在整个窗口内一致，中值滤波后仍保留。
    黑帧（bbox 为 None）不参与，保持时间轴位置不变。
    """
    boxes = [f.bbox_norm for f in frames if f.bbox_norm is not None]
    if len(boxes) < window:
        return
    half = window // 2
    smoothed: list[tuple[float, float, float, float]] = []
    for i in range(len(boxes)):
        lo = max(0, i - half)
        hi = min(len(boxes), i + half + 1)
        smoothed.append(_median_bbox(boxes[lo:hi]))  # type: ignore[arg-type]
    it = iter(smoothed)
    for f in frames:
        if f.bbox_norm is not None:
            f.bbox_norm = next(it)


def _coalesce_groups(groups: list[list[FrameResult]],
                     bbox_tolerance: float,
                     min_evidence_frames: int) -> list[list[FrameResult]]:
    """分段后的合并轮询，吸收瞬时抖动而保留真画幅切换。

    合并条件（满足其一即合并相邻两组）：
    - 两组代表性 bbox 距离在容差内（同一稳定画幅的轻微漂移）；
    - 其中一组短于证据门槛（瞬时抖动/切换过渡帧），并入帧更多的邻居。
    两个都足够长且 bbox 差距明显的组不会被合并，真切换得以保留。
    循环到没有可合并对为止。
    """
    if len(groups) <= 1:
        return groups

    def med(g: list[FrameResult]):
        return _median_bbox([f.bbox_norm for f in g if f.bbox_norm])  # type: ignore[arg-type]

    merged = [list(g) for g in groups]
    changed = True
    while changed and len(merged) > 1:
        changed = False
        for i in range(len(merged) - 1):
            a, b = merged[i], merged[i + 1]
            close = _bbox_distance(med(a), med(b)) <= bbox_tolerance
            transient = (len(a) < min_evidence_frames
                         or len(b) < min_evidence_frames)
            if close or transient:
                # 瞬时组并入更大的稳定邻居；相近组直接并入前组
                if transient and not close and len(b) > len(a):
                    b[:0] = a
                    merged[i] = b
                else:
                    a.extend(b)
                merged.pop(i + 1)
                changed = True
                break
    return merged


def segment_frames(
    frames: list[FrameResult],
    frame_width: int,
    frame_height: int,
    bbox_tolerance: float = 0.03,
    min_segment_frames: int = 3,
    min_evidence_frames: int = 4,
) -> list[Segment]:
    """把内容帧按边界稳定性分段，黑帧不参与分段但计入段内黑帧数。"""
    content = [f for f in frames if f.kind == FrameClass.CONTENT and f.bbox_norm]
    if not content:
        return []

    # 1) 贪心聚类：相邻帧边界偏差在容差内归入同组
    groups: list[list[FrameResult]] = [[content[0]]]
    for frame in content[1:]:
        ref = _median_bbox([f.bbox_norm for f in groups[-1] if f.bbox_norm])  # type: ignore[arg-type]
        if _bbox_distance(frame.bbox_norm, ref) <= bbox_tolerance:  # type: ignore[arg-type]
            groups[-1].append(frame)
        else:
            groups.append([frame])

    # 2) 消化过短组
    groups = _merge_small_segments(groups, min_segment_frames)

    # 3) 合并轮询：代表性 bbox 接近的相邻组，或夹在主组间的短抖动组，合并掉。
    #    真画幅切换 = 两个都足够长且 bbox 差距明显的组，不会被此步合并。
    groups = _coalesce_groups(groups, bbox_tolerance, min_evidence_frames)

    # 4) 生成段对象，时间范围用窗口内全部帧（含夹在中间的黑帧）对齐
    all_times = [f.pts_time for f in frames]
    segments: list[Segment] = []
    for gi, group in enumerate(groups):
        boxes = [f.bbox_norm for f in group if f.bbox_norm]
        med = _median_bbox(boxes)  # type: ignore[arg-type]
        first_t = group[0].pts_time
        last_t = group[-1].pts_time
        start_t = first_t
        end_t = last_t
        # 段时间向两侧扩展到相邻段的中点，黑帧时间归到所在段
        if gi > 0:
            start_t = (groups[gi - 1][-1].pts_time + first_t) / 2
        else:
            earlier_black = [t for t in all_times if t < first_t]
            if earlier_black:
                start_t = earlier_black[0]
        if gi + 1 < len(groups):
            end_t = (last_t + groups[gi + 1][0].pts_time) / 2
        else:
            later_black = [t for t in all_times if t > last_t]
            if later_black:
                end_t = later_black[-1]

        black_in_range = sum(
            1 for f in frames
            if f.kind == FrameClass.BLACK and start_t <= f.pts_time <= end_t
        )
        x0, y0, x1, y1 = med
        bbox_px = (
            round(x0 * frame_width), round(y0 * frame_height),
            round(x1 * frame_width), round(y1 * frame_height),
        )
        confirmed = len(group) >= min_evidence_frames
        note = "" if confirmed else f"有效内容帧仅 {len(group)} 个，证据不足，需人工确认"
        segments.append(Segment(
            start_time=round(start_t, 3),
            end_time=round(end_t, 3),
            bbox_norm=tuple(round(v, 5) for v in med),  # type: ignore[arg-type]
            bbox_px=bbox_px,
            frame_count=len(group),
            black_frame_count=black_in_range,
            width_fraction=round(x1 - x0, 5),
            height_fraction=round(y1 - y0, 5),
            area_fraction=round((x1 - x0) * (y1 - y0), 5),
            confirmed=confirmed,
            note=note,
        ))
    return segments


def _black_ranges(frames: list[FrameResult], window_start: float,
                  window_end: float) -> list[tuple[float, float]]:
    """合并连续黑帧为黑场时间区间。"""
    ranges: list[tuple[float, float]] = []
    start: float | None = None
    prev: FrameResult | None = None
    for frame in frames:
        if frame.kind == FrameClass.BLACK:
            if start is None:
                start = frame.pts_time
            prev = frame
        else:
            if start is not None and prev is not None:
                ranges.append((round(start, 3), round(prev.pts_time, 3)))
                start = None
            prev = frame
    if start is not None and prev is not None:
        ranges.append((round(start, 3), round(prev.pts_time, 3)))
    return ranges


def analyze_window(
    window_id: str,
    start: float,
    end: float,
    raw_frames: list[RawFrame],
    min_evidence_frames: int = 4,
    min_segment_seconds: float = 0.2,
) -> WindowAnalysis:
    """对一个时间窗的全部采样帧执行完整分析。"""
    if not raw_frames:
        return WindowAnalysis(
            window_id=window_id, start=start, end=end,
            frame_width=0, frame_height=0,
            status="insufficient",
        )
    width, height = raw_frames[0].width, raw_frames[0].height
    frames = [classify_frame(f) for f in raw_frames]
    # 中值滤波抑制瞬时抖动，再做分段与统计
    _smooth_bboxes(frames)
    content = [f for f in frames if f.kind == FrameClass.CONTENT]
    blacks = [f for f in frames if f.kind == FrameClass.BLACK]

    result = WindowAnalysis(
        window_id=window_id,
        start=start,
        end=end,
        frame_width=width,
        frame_height=height,
        frames=frames,
        sampled_count=len(frames),
        content_count=len(content),
        black_count=len(blacks),
        black_ranges=_black_ranges(frames, start, end),
    )

    # 采样总数不足时，无论全黑与否都不能下确定性结论
    if len(frames) < min_evidence_frames:
        result.status = "insufficient"
        if not content:
            result.summary_bbox_norm = None
        return result

    if not content:
        result.status = "all_black"
        return result

    sample_fps = len(frames) / max(1e-6, end - start)
    min_segment_frames = max(2, round(min_segment_seconds * sample_fps))
    result.segments = segment_frames(
        frames, width, height,
        min_segment_frames=min_segment_frames,
        min_evidence_frames=min_evidence_frames,
    )

    # 窗口级代表性边界：所有内容帧边界的中位数（抗黑帧/淡入淡出干扰）
    result.summary_bbox_norm = tuple(  # type: ignore[assignment]
        round(v, 5) for v in _median_bbox(
            [f.bbox_norm for f in content if f.bbox_norm]  # type: ignore[arg-type]
        )
    )

    if len(content) < min_evidence_frames:
        result.status = "insufficient"
    return result
