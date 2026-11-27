"""输出文件：成片 SRT、带来源区间的 CSV 对照清单、JSON 处理报告。"""

from __future__ import annotations

import csv
import json
from decimal import Decimal
from pathlib import Path
from typing import Any, Dict, List

from .remap import RemapResult
from .srt_io import write_srt
from .timecode import format_srt_timestamp


def write_manifest_csv(path: str | Path, result: RemapResult) -> None:
    """写出成片字幕与源区间的逐条对照清单（UTF-8，带 BOM 方便表格软件）。"""
    fieldnames = [
        "seq",
        "dst_start_ms", "dst_end_ms",
        "dst_start", "dst_end",
        "material", "edl_line", "track", "speed",
        "src_cue_index", "src_start_ms", "src_end_ms",
        "src_start", "src_end",
        "provenance", "text",
    ]
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        for seq, cue in enumerate(result.cues, start=1):
            writer.writerow({
                "seq": seq,
                "dst_start_ms": cue.start,
                "dst_end_ms": cue.end,
                "dst_start": format_srt_timestamp(cue.start),
                "dst_end": format_srt_timestamp(cue.end),
                "material": cue.material,
                "edl_line": cue.line_no,
                "track": cue.track,
                "speed": format(cue.speed, "f"),
                "src_cue_index": cue.src_cue_index,
                "src_start_ms": cue.src_start,
                "src_end_ms": cue.src_end,
                "src_start": format_srt_timestamp(cue.src_start),
                "src_end": format_srt_timestamp(cue.src_end),
                "provenance": cue.provenance(),
                "text": cue.text,
            })


def _cue_to_dict(cue: Any) -> Dict[str, Any]:
    return {
        "start_ms": cue.start,
        "end_ms": cue.end,
        "start": format_srt_timestamp(cue.start),
        "end": format_srt_timestamp(cue.end),
        "text": cue.text,
        "material": cue.material,
        "edl_line": cue.line_no,
        "track": cue.track,
        "speed": format(cue.speed, "f"),
        "src_cue_index": cue.src_cue_index,
        "src_start_ms": cue.src_start,
        "src_end_ms": cue.src_end,
        "src_start": format_srt_timestamp(cue.src_start),
        "src_end": format_srt_timestamp(cue.src_end),
        "provenance": cue.provenance(),
    }


def write_report_json(path: str | Path, result: RemapResult, *,
                      edl_path: str, mode: str) -> None:
    payload = {
        "edl": str(edl_path),
        "mode": mode,
        "output_cue_count": len(result.cues),
        "conflict_count": len(result.conflicts),
        "dropped_count": len(result.dropped),
        "warnings": result.warnings,
        "conflicts": [
            {
                "reason": c.reason,
                "overlap_start_ms": c.overlap_start,
                "overlap_end_ms": c.overlap_end,
                "overlap_start": format_srt_timestamp(c.overlap_start),
                "overlap_end": format_srt_timestamp(c.overlap_end),
                "cue_a": _cue_to_dict(c.cue_a),
                "cue_b": _cue_to_dict(c.cue_b),
            }
            for c in result.conflicts
        ],
        "dropped": [vars(d) for d in result.dropped],
        "cues": [_cue_to_dict(c) for c in result.cues],
    }
    Path(path).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8",
    )


def write_all(output_dir: str | Path, stem: str, result: RemapResult, *,
              edl_path: str, mode: str) -> Dict[str, Path]:
    """一次性写出 SRT + CSV + JSON，返回文件路径表。"""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    srt_path = out / f"{stem}.srt"
    csv_path = out / f"{stem}.manifest.csv"
    json_path = out / f"{stem}.report.json"
    write_srt(srt_path, result.to_srt_cues())
    write_manifest_csv(csv_path, result)
    write_report_json(json_path, result, edl_path=edl_path, mode=mode)
    return {"srt": srt_path, "manifest": csv_path, "report": json_path}
