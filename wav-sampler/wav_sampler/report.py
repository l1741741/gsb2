"""交付清单与报告输出: JSON 清单、CSV 段落表、Markdown 报告。"""

from __future__ import annotations

import csv
import io
import json
import os

from .model import (
    KIND_OVERLAP,
    KIND_SILENCE,
    KIND_SOURCE,
    Diagnostic,
    ExportRecord,
    RangeResult,
    ResolvedSegment,
    Run,
)

KIND_LABELS = {
    KIND_SOURCE: "source",
    KIND_OVERLAP: "overlap",
    KIND_SILENCE: "silence",
}


def frame_to_seconds(frame: int | None, rate: int) -> float | None:
    if frame is None:
        return None
    return frame / rate


def _run_payload(run: Run, rate: int) -> dict:
    return {
        "kind": run.kind,
        "project_start_frame": run.start_frame,
        "project_end_frame": run.end_frame,
        "project_start_seconds": round(frame_to_seconds(run.start_frame, rate), 6),
        "project_end_seconds": round(frame_to_seconds(run.end_frame, rate), 6),
        "frames": run.end_frame - run.start_frame,
        "segment_id": run.segment_id,
        "source_start_frame": run.source_start_frame,
        "source_end_frame": run.source_end_frame,
        "contenders": list(run.contenders),
    }


def _diagnostic_payload(diag: Diagnostic, rate: int) -> dict:
    interval = diag.affected_interval
    return {
        "level": diag.level,
        "code": diag.code,
        "segment_id": diag.segment_id,
        "path": diag.path,
        "project_frame": diag.project_frame,
        "project_seconds": frame_to_seconds(diag.project_frame, rate),
        "affected_interval_frames": list(interval) if interval is not None else None,
        "affected_interval_seconds": (
            [frame_to_seconds(interval[0], rate), frame_to_seconds(interval[1], rate)]
            if interval is not None
            else None
        ),
        "message": diag.message,
    }


def build_delivery_manifest(record: ExportRecord, manifest_path: str) -> dict:
    """构造交付清单 JSON 可序列化对象。只有 delivered 的范围进入交付列表。"""
    rate = record.sample_rate
    delivered = []
    for result in record.delivered:
        kind_frames = {KIND_SOURCE: 0, KIND_OVERLAP: 0, KIND_SILENCE: 0}
        for run in result.runs:
            kind_frames[run.kind] += run.end_frame - run.start_frame
        delivered.append(
            {
                "range_id": result.range_id,
                "output": result.output_name,
                "status": result.status,
                "project_start_frame": result.start_frame,
                "project_end_frame": result.end_frame,
                "project_start_seconds": frame_to_seconds(result.start_frame, rate),
                "project_end_seconds": frame_to_seconds(result.end_frame, rate),
                "frames_written": result.frames_written,
                "source_frames": kind_frames[KIND_SOURCE],
                "overlap_resolved_frames": kind_frames[KIND_OVERLAP],
                "silence_frames": kind_frames[KIND_SILENCE],
                "provenance": [_run_payload(run, rate) for run in result.runs],
            }
        )

    rejected = [
        {
            "range_id": r.range_id,
            "output": r.output_name,
            "status": r.status,
            "project_start_frame": r.start_frame,
            "project_end_frame": r.end_frame,
            "diagnostics": [_diagnostic_payload(d, rate) for d in r.diagnostics],
        }
        for r in record.results
        if r.status in ("rejected", "skipped_exists")
    ]

    return {
        "schema_version": 1,
        "source_manifest": os.path.abspath(manifest_path),
        "sample_rate": rate,
        "output_channels": record.output_channels,
        "output_sample_width_bytes": record.output_sample_width,
        "delivered": delivered,
        "not_delivered": rejected,
        "global_diagnostics": [
            _diagnostic_payload(d, rate)
            for d in record.diagnostics
            if not any(d in r.diagnostics for r in record.results)
        ],
    }


def write_delivery_manifest(record: ExportRecord, manifest_path: str, out_path: str) -> None:
    payload = build_delivery_manifest(record, manifest_path)
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def build_segment_csv(record: ExportRecord) -> str:
    """每段文件在项目时间轴上的开始时间与有效区间 (一表一行)。"""
    rate = record.sample_rate
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(
        [
            "segment_id",
            "path",
            "priority",
            "source_channels",
            "channel_map_out_to_src",
            "sample_width_bytes",
            "start_frame",
            "start_seconds",
            "effective_start_frame",
            "effective_end_frame",
            "effective_start_seconds",
            "effective_end_seconds",
            "effective_frames",
            "actual_frames",
            "declared_end_frame",
        ]
    )
    for seg in record.segments:
        spec = seg.spec
        writer.writerow(
            [
                spec.segment_id,
                spec.path,
                spec.priority,
                seg.channels,
                "|".join("-" if x == -1 else str(x) for x in seg.channel_map),
                seg.sample_width,
                spec.start_frame,
                frame_to_seconds(spec.start_frame, rate),
                seg.effective_start,
                seg.effective_end,
                frame_to_seconds(seg.effective_start, rate),
                frame_to_seconds(seg.effective_end, rate),
                seg.effective_end - seg.effective_start,
                seg.actual_frames,
                "" if seg.declared_end is None else seg.declared_end,
            ]
        )
    return buf.getvalue()


def write_segment_csv(record: ExportRecord, out_path: str) -> None:
    with open(out_path, "w", encoding="utf-8", newline="") as fh:
        fh.write(build_segment_csv(record))


def _fmt_sec(frame: int | None, rate: int) -> str:
    if frame is None:
        return "-"
    return f"{frame_to_seconds(frame, rate):.6f}s"


def build_markdown_report(record: ExportRecord, manifest_path: str) -> str:
    rate = record.sample_rate
    lines: list[str] = []
    lines.append("# WAV 取样报告")
    lines.append("")
    lines.append(f"- 来源清单: `{os.path.abspath(manifest_path)}`")
    lines.append(f"- 采样率: {rate} Hz")
    lines.append(f"- 输出声道数: {record.output_channels}")
    lines.append(f"- 输出位深: {record.output_sample_width * 8} bit")
    lines.append(
        f"- 范围: 共 {len(record.results)} 个, "
        f"交付 {len(record.delivered)}, "
        f"拒绝 {len(record.rejected)}, "
        f"跳过(文件已存在) {len(record.skipped)}"
    )
    lines.append("")

    lines.append("## 段落在项目时间轴上的位置")
    lines.append("")
    lines.append(
        "| 段 ID | 源文件 | 优先级 | 源声道 | 声道映射(输出→源) | 开始(帧/秒) | 有效区间(帧) | 有效区间(秒) | 实际帧 |"
    )
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for seg in record.segments:
        spec = seg.spec
        mapping = ",".join("静" if x == -1 else str(x) for x in seg.channel_map)
        lines.append(
            "| {sid} | `{path}` | {prio} | {ch} | {mapping} | {sf} / {ss} | [{a}, {b}) | [{as_}, {bs}) | {af} |".format(
                sid=spec.segment_id,
                path=os.path.basename(spec.path),
                prio=spec.priority,
                ch=seg.channels,
                mapping=mapping,
                sf=spec.start_frame,
                ss=_fmt_sec(spec.start_frame, rate),
                a=seg.effective_start,
                b=seg.effective_end,
                as_=_fmt_sec(seg.effective_start, rate),
                bs=_fmt_sec(seg.effective_end, rate),
                af=seg.actual_frames,
            )
        )
    lines.append("")

    lines.append("## 导出范围与 provenance")
    lines.append("")
    for result in record.results:
        lines.append(
            f"### {result.range_id} — {result.status} — `{result.output_name}`"
        )
        lines.append("")
        lines.append(
            f"- 项目区间: [{result.start_frame}, {result.end_frame}) 帧 / "
            f"[{_fmt_sec(result.start_frame, rate)}, {_fmt_sec(result.end_frame, rate)})"
        )
        if result.frames_written:
            lines.append(f"- 写出帧数: {result.frames_written}")
        lines.append("")
        if result.runs:
            lines.append("| 种类 | 项目区间(帧) | 项目区间(秒) | 帧 | 选中段 | 源帧区间 | 竞争段 |")
            lines.append("|---|---|---|---|---|---|---|")
            for run in result.runs:
                lines.append(
                    "| {kind} | [{a}, {b}) | [{as_}, {bs}) | {n} | {sid} | [{sa}, {sb}) | {c} |".format(
                        kind=KIND_LABELS[run.kind],
                        a=run.start_frame,
                        b=run.end_frame,
                        as_=_fmt_sec(run.start_frame, rate),
                        bs=_fmt_sec(run.end_frame, rate),
                        n=run.end_frame - run.start_frame,
                        sid=run.segment_id or "-",
                        sa=run.source_start_frame if run.source_start_frame is not None else "-",
                        sb=run.source_end_frame if run.source_end_frame is not None else "-",
                        c=",".join(run.contenders) if run.contenders else "-",
                    )
                )
            lines.append("")
        if result.diagnostics:
            lines.append("诊断:")
            for diag in result.diagnostics:
                lines.append(
                    f"- **{diag.level} {diag.code}** "
                    f"[段 {diag.segment_id or '-'} @ 帧 {diag.project_frame if diag.project_frame is not None else '-'}]: {diag.message}"
                )
            lines.append("")

    if record.diagnostics:
        lines.append("## 全局诊断")
        lines.append("")
        for diag in record.diagnostics:
            lines.append(
                f"- **{diag.level} {diag.code}** "
                f"[段 {diag.segment_id or '-'} @ 帧 {diag.project_frame if diag.project_frame is not None else '-'}]: {diag.message}"
            )
        lines.append("")

    return "\n".join(lines)


def write_markdown_report(record: ExportRecord, manifest_path: str, out_path: str) -> None:
    with open(out_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(build_markdown_report(record, manifest_path))
        fh.write("\n")
