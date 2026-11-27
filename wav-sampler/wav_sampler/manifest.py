"""段落清单的加载、校验, 以及与实际 WAV 文件的核对。"""

from __future__ import annotations

import json
import os

from .channels import ChannelMapError, resolve_channel_map
from .model import (
    Diagnostic,
    LEVEL_ERROR,
    LEVEL_WARNING,
    Manifest,
    RangeSpec,
    ResolvedSegment,
    SegmentSpec,
)
from .pcm import PcmError, open_wave


class ManifestError(ValueError):
    """清单本身不合法 (JSON 结构 / 取值错误), 无法继续处理。"""


def seconds_to_frames(value, frame_rate: int) -> int:
    """秒 -> 帧。允许 int/float 或精确的 {"frames": n} / {"seconds": s} 写法。"""
    if isinstance(value, dict):
        if "frames" in value:
            n = value["frames"]
            if not isinstance(n, int) or isinstance(n, bool):
                raise ManifestError(f"frames 必须是整数, 得到 {n!r}")
            return n
        if "seconds" in value:
            s = value["seconds"]
            if not isinstance(s, (int, float)) or isinstance(s, bool):
                raise ManifestError(f"seconds 必须是数值, 得到 {s!r}")
            return round(float(s) * frame_rate)
        raise ManifestError(f"时间值必须含 frames 或 seconds 键: {value!r}")
    if isinstance(value, int) and not isinstance(value, bool):
        # 裸整数按秒处理, 避免歧义请用 {"frames": n}
        return value * frame_rate
    if isinstance(value, float):
        return round(value * frame_rate)
    raise ManifestError(f"无法解析的时间值: {value!r}")


def _require(obj: dict, key: str, ctx: str):
    if key not in obj:
        raise ManifestError(f"{ctx} 缺少必需字段 {key!r}")
    return obj[key]


def load_manifest(path: str) -> tuple[Manifest, list[Diagnostic], list[ResolvedSegment]]:
    """加载并核对清单。

    返回 (Manifest, 诊断列表, 已解析段落列表)。
    清单结构错误抛 ManifestError; 文件层面的问题以 error 诊断返回,
    出错段落不会出现在 ResolvedSegment 列表中。
    """
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError as exc:
        raise ManifestError(f"清单不存在: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ManifestError(f"清单不是合法 JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise ManifestError("清单顶层必须是对象")

    rate = _require(data, "sample_rate", "清单")
    if not isinstance(rate, int) or isinstance(rate, bool) or rate <= 0:
        raise ManifestError(f"sample_rate 必须是正整数, 得到 {rate!r}")
    out_ch = _require(data, "output_channels", "清单")
    if not isinstance(out_ch, int) or isinstance(out_ch, bool) or out_ch <= 0:
        raise ManifestError(f"output_channels 必须是正整数, 得到 {out_ch!r}")

    out_width = data.get("output_sample_width")
    if out_width is not None and (
        not isinstance(out_width, int) or isinstance(out_width, bool) or out_width not in (1, 2, 3, 4)
    ):
        raise ManifestError("output_sample_width 必须是 1/2/3/4 之一")

    base_dir = os.path.dirname(os.path.abspath(path))

    segments: list[SegmentSpec] = []
    seen_ids: set[str] = set()
    for idx, raw in enumerate(data.get("segments", [])):
        ctx = f"segments[{idx}]"
        if not isinstance(raw, dict):
            raise ManifestError(f"{ctx} 必须是对象")
        seg_id = str(_require(raw, "id", ctx))
        if seg_id in seen_ids:
            raise ManifestError(f"段落 id 重复: {seg_id!r}")
        seen_ids.add(seg_id)
        rel_path = str(_require(raw, "path", ctx))
        start = seconds_to_frames(_require(raw, "start", ctx), rate)
        if start < 0:
            raise ManifestError(f"{ctx} start 不能为负")
        declared = None
        if "duration" in raw:
            declared = seconds_to_frames(raw["duration"], rate)
            if declared <= 0:
                raise ManifestError(f"{ctx} duration 必须为正")
        priority = raw.get("priority", 0)
        if not isinstance(priority, int) or isinstance(priority, bool):
            raise ManifestError(f"{ctx} priority 必须是整数")
        channel_map_raw = raw.get("channel_map")
        if channel_map_raw is not None:
            if not isinstance(channel_map_raw, list) or not all(
                isinstance(x, int) and not isinstance(x, bool) for x in channel_map_raw
            ):
                raise ManifestError(f"{ctx} channel_map 必须是整数数组")
            channel_map = tuple(channel_map_raw)
        else:
            channel_map = None
        segments.append(
            SegmentSpec(
                segment_id=seg_id,
                path=os.path.join(base_dir, rel_path) if not os.path.isabs(rel_path) else rel_path,
                start_frame=start,
                declared_frames=declared,
                priority=priority,
                channel_map=channel_map,
            )
        )

    ranges: list[RangeSpec] = []
    seen_range_ids: set[str] = set()
    for idx, raw in enumerate(_require(data, "ranges", "清单")):
        ctx = f"ranges[{idx}]"
        if not isinstance(raw, dict):
            raise ManifestError(f"{ctx} 必须是对象")
        range_id = str(_require(raw, "id", ctx))
        if range_id in seen_range_ids:
            raise ManifestError(f"范围 id 重复: {range_id!r}")
        seen_range_ids.add(range_id)
        start = seconds_to_frames(_require(raw, "start", ctx), rate)
        end = seconds_to_frames(_require(raw, "end", ctx), rate)
        if start < 0 or end <= start:
            raise ManifestError(f"{ctx} 必须满足 0 <= start < end")
        output_name = str(raw.get("output") or f"{range_id}.wav")
        if os.path.basename(output_name) != output_name:
            raise ManifestError(f"{ctx} output 只能是文件名, 不能含路径分隔符")
        ranges.append(RangeSpec(range_id, start, end, output_name))

    manifest = Manifest(
        sample_rate=rate,
        output_channels=out_ch,
        segments=tuple(segments),
        ranges=tuple(ranges),
        output_sample_width=out_width,
    )

    diagnostics: list[Diagnostic] = []
    resolved: list[ResolvedSegment] = []
    for spec in segments:
        resolved_seg, seg_diags = _resolve_segment(spec, rate, out_ch)
        diagnostics.extend(seg_diags)
        if resolved_seg is not None:
            resolved.append(resolved_seg)

    return manifest, diagnostics, resolved


def _resolve_segment(
    spec: SegmentSpec,
    expected_rate: int,
    output_channels: int,
) -> tuple[ResolvedSegment | None, list[Diagnostic]]:
    diags: list[Diagnostic] = []
    # 段落声称覆盖的区间: 有声明时长按声明, 否则未知 (None = 影响全部范围)
    claimed_end = (
        spec.start_frame + spec.declared_frames
        if spec.declared_frames is not None
        else None
    )
    claimed_interval = (
        (spec.start_frame, claimed_end) if claimed_end is not None else None
    )
    try:
        wf = open_wave(spec.path)
    except PcmError as exc:
        diags.append(
            Diagnostic(
                LEVEL_ERROR,
                "wav_unreadable",
                spec.segment_id,
                spec.path,
                spec.start_frame,
                str(exc),
                affected_interval=claimed_interval,
            )
        )
        return None, diags

    with wf:
        actual_rate = wf.getframerate()
        actual_frames = wf.getnframes()
        channels = wf.getnchannels()
        sample_width = wf.getsampwidth()

    if actual_rate != expected_rate:
        diags.append(
            Diagnostic(
                LEVEL_ERROR,
                "sample_rate_mismatch",
                spec.segment_id,
                spec.path,
                spec.start_frame,
                f"采样率 {actual_rate} Hz 与清单 {expected_rate} Hz 不一致",
                affected_interval=claimed_interval,
            )
        )
        return None, diags
    if actual_frames <= 0:
        diags.append(
            Diagnostic(
                LEVEL_ERROR,
                "empty_wav",
                spec.segment_id,
                spec.path,
                spec.start_frame,
                "WAV 文件不包含任何帧",
                affected_interval=claimed_interval,
            )
        )
        return None, diags

    declared_end = claimed_end
    actual_end = spec.start_frame + actual_frames

    effective_end = actual_end
    if declared_end is not None and declared_end != actual_end:
        if declared_end > actual_end:
            # 清单声称的时长超过实际文件: 文件提前结束, 截断到实际长度
            diags.append(
                Diagnostic(
                    LEVEL_ERROR,
                    "segment_ended_early",
                    spec.segment_id,
                    spec.path,
                    actual_end,
                    (
                        f"清单声明有效至项目帧 {declared_end} (时长 {spec.declared_frames} 帧), "
                        f"但文件只有 {actual_frames} 帧, 在项目帧 {actual_end} 提前结束; "
                        f"项目帧 [{actual_end}, {declared_end}) 无数据"
                    ),
                    affected_interval=(actual_end, declared_end),
                )
            )
        else:
            # 文件比声明长: 声明区间之外的素材不参与取样, 给出警告
            effective_end = declared_end
            diags.append(
                Diagnostic(
                    LEVEL_WARNING,
                    "segment_longer_than_declared",
                    spec.segment_id,
                    spec.path,
                    declared_end,
                    (
                        f"文件实际 {actual_frames} 帧, 超出清单声明的 {spec.declared_frames} 帧; "
                        f"仅项目帧 [{spec.start_frame}, {declared_end}) 视为有效"
                    ),
                    affected_interval=(declared_end, actual_end),
                )
            )

    try:
        mapping = resolve_channel_map(spec.channel_map, channels, output_channels)
    except ChannelMapError as exc:
        diags.append(
            Diagnostic(
                LEVEL_ERROR,
                "bad_channel_map",
                spec.segment_id,
                spec.path,
                spec.start_frame,
                str(exc),
                affected_interval=(spec.start_frame, actual_end),
            )
        )
        return None, diags

    return (
        ResolvedSegment(
            spec=spec,
            actual_frames=actual_frames,
            channels=channels,
            sample_width=sample_width,
            effective_start=spec.start_frame,
            effective_end=effective_end,
            declared_end=declared_end,
            channel_map=mapping,
        ),
        diags,
    )
