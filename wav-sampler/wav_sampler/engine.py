"""取样导出引擎: 校验、流式混音、原子写盘、交付清单。"""

from __future__ import annotations

import os
import wave
from dataclasses import dataclass

from .channels import apply_channel_map
from .manifest import load_manifest
from .model import (
    Diagnostic,
    ExportRecord,
    KIND_SILENCE,
    LEVEL_ERROR,
    LEVEL_WARNING,
    RangeResult,
    ResolvedSegment,
    Run,
)
from .pcm import (
    decode_bytes,
    encode_samples,
    make_writer,
    silence_sample,
)
from .timeline import build_runs

# 单次读取的最大帧数, 避免把整天的录音读进内存
DEFAULT_BLOCK_FRAMES = 8192


@dataclass(frozen=True)
class ExportConfig:
    output_dir: str
    block_frames: int = DEFAULT_BLOCK_FRAMES
    overwrite: bool = False  # 默认 False: 已存在的输出文件不覆盖


def _range_has_blocking_error(
    range_start: int,
    range_end: int,
    diagnostics: list[Diagnostic],
) -> list[Diagnostic]:
    """找出会让该范围输出不合法的 error 诊断。

    判定基于诊断携带的受影响项目区间与导出范围是否相交;
    区间为 None (无法界定, 如无时长声明的整文件不可读) 时保守视为相交。
    与问题段在时间轴上不相交的范围仍可正常交付。
    """
    blocking: list[Diagnostic] = []
    for diag in diagnostics:
        if diag.level != LEVEL_ERROR:
            continue
        interval = diag.affected_interval
        if interval is None or (interval[0] < range_end and interval[1] > range_start):
            blocking.append(diag)
    return blocking


def _write_source_run(
    reader: wave.Wave_read,
    writer: wave.Wave_write,
    segment: ResolvedSegment,
    run: Run,
    out_channels: int,
    out_width: int,
    block_frames: int,
) -> int:
    """从源文件流式读取一个 Run 并写入输出, 返回写入帧数。"""
    assert run.source_start_frame is not None
    reader.setpos(run.source_start_frame)
    remaining = run.end_frame - run.start_frame
    mapping = segment.channel_map
    src_width = segment.sample_width
    written = 0
    while remaining > 0:
        n = min(block_frames, remaining)
        raw = reader.readframes(n)
        frames_in_block = len(raw) // (src_width * segment.channels)
        if frames_in_block == 0:
            # 理论上不会发生 (有效区间已按实际帧裁剪), 兜底防御
            raise EOFError(
                f"源 {segment.spec.segment_id} 在请求帧 {reader.tell()} 处提前耗尽"
            )
        samples = decode_bytes(raw, src_width)
        converted: list[int] = []
        for i in range(frames_in_block):
            frame = samples[i * segment.channels:(i + 1) * segment.channels]
            converted.extend(apply_channel_map(frame, mapping, out_channels))
        writer.writeframes(encode_samples(converted, out_width))
        written += frames_in_block
        remaining -= frames_in_block
    return written


def _write_silence(
    writer: wave.Wave_write,
    frames: int,
    out_channels: int,
    out_width: int,
    block_frames: int,
) -> int:
    fill = silence_sample(out_width)
    remaining = frames
    written = 0
    while remaining > 0:
        n = min(block_frames, remaining)
        writer.writeframes(bytes([fill]) * (n * out_channels * out_width))
        written += n
        remaining -= n
    return written


def _export_one(
    result: RangeResult,
    segments: tuple[ResolvedSegment, ...],
    record: ExportRecord,
    config: ExportConfig,
) -> None:
    by_id = {s.spec.segment_id: s for s in segments}
    final_path = os.path.join(config.output_dir, result.output_name)

    if not config.overwrite and os.path.exists(final_path):
        # 已有文件 (可能是上次成功的交付): 绝不覆盖
        result.status = "skipped_exists"
        result.diagnostics.append(
            Diagnostic(
                LEVEL_WARNING,
                "output_exists",
                None,
                final_path,
                result.start_frame,
                f"输出文件已存在且未开启 overwrite, 保留原文件, 本次不产出 {result.output_name}",
            )
        )
        return

    readers: dict[str, wave.Wave_read] = {}
    part_path = final_path + ".part"
    writer = make_writer(
        part_path,
        channels=record.output_channels,
        sample_width=record.output_sample_width,
        frame_rate=record.sample_rate,
    )
    try:
        total = 0
        for run in result.runs:
            if run.kind == KIND_SILENCE:
                total += _write_silence(
                    writer,
                    run.end_frame - run.start_frame,
                    record.output_channels,
                    record.output_sample_width,
                    config.block_frames,
                )
                continue
            seg = by_id[run.segment_id]
            reader = readers.get(seg.spec.segment_id)
            if reader is None:
                reader = wave.open(seg.spec.path, "rb")
                readers[seg.spec.segment_id] = reader
            total += _write_source_run(
                reader,
                writer,
                seg,
                run,
                record.output_channels,
                record.output_sample_width,
                config.block_frames,
            )
        expected = result.end_frame - result.start_frame
        if total != expected:
            raise EOFError(f"写出 {total} 帧, 预期 {expected} 帧")
        writer.close()
        # 原子替换: 只有完整写完的 .part 才会落到正式文件名
        os.replace(part_path, final_path)
    except BaseException:
        try:
            writer.close()
        except Exception:
            pass
        if os.path.exists(part_path):
            os.unlink(part_path)
        raise
    finally:
        for reader in readers.values():
            reader.close()

    result.frames_written = total
    result.output_path = final_path
    result.status = "delivered"


def export(manifest_path: str, config: ExportConfig) -> ExportRecord:
    """按清单执行一次完整导出。"""
    manifest, diagnostics, resolved_segments = load_manifest(manifest_path)
    os.makedirs(config.output_dir, exist_ok=True)

    if manifest.output_sample_width is not None:
        out_width = manifest.output_sample_width
    else:
        out_width = max((s.sample_width for s in resolved_segments), default=2)

    record = ExportRecord(
        sample_rate=manifest.sample_rate,
        output_channels=manifest.output_channels,
        output_sample_width=out_width,
        diagnostics=diagnostics,
        segments=resolved_segments,
    )

    for spec_range in manifest.ranges:
        result = RangeResult(
            range_id=spec_range.range_id,
            output_name=spec_range.output_name,
            start_frame=spec_range.start_frame,
            end_frame=spec_range.end_frame,
        )
        blocking = _range_has_blocking_error(
            spec_range.start_frame, spec_range.end_frame, diagnostics
        )
        if blocking:
            result.diagnostics.extend(blocking)
            result.status = "rejected"
            record.results.append(result)
            continue

        result.runs = build_runs(
            spec_range.start_frame,
            spec_range.end_frame,
            tuple(resolved_segments),
        )
        try:
            _export_one(result, tuple(resolved_segments), record, config)
        except (OSError, EOFError, wave.Error) as exc:
            result.status = "rejected"
            result.diagnostics.append(
                Diagnostic(
                    LEVEL_ERROR,
                    "export_failed",
                    None,
                    spec_range.output_name,
                    spec_range.start_frame,
                    f"导出失败: {exc}",
                )
            )
        record.results.append(result)

    return record
