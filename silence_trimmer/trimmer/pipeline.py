"""Decision-file IO and the end-to-end trim pipeline."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import List, Optional

from .detect import DetectionConfig, Pause, detect_pauses
from .edit import Decision, EditConfig, build_segments, render_edits
from .map import Marker, RegionMap, build_region_map, map_markers
from .reports import parse_markers, render_outputs
from .wavio import read_wav


def write_decisions_template(
    path: str,
    pauses: List[Pause],
    config: DetectionConfig,
    default_action: str = "keep",
) -> None:
    """Write an editable decision file pre-filled with the detected pauses."""
    payload = {
        "detection": {
            "threshold_dbfs": config.threshold_dbfs,
            "min_pause_sec": config.min_pause_sec,
            "frame_ms": config.frame_ms,
            "hop_ms": config.hop_ms,
            "merge_gap_ms": config.merge_gap_ms,
            "amplitude": config.amplitude,
            "channel_rule": config.channel_rule,
        },
        "pauses": [
            {
                "pause_index": i,
                "start_sec": round(p.start_sec, 6),
                "end_sec": round(p.end_sec, 6),
                "duration_sec": round(p.duration_sec, 6),
                "channel_peak_linear": [round(v, 6) for v in p.channel_peak],
                "action": default_action,
                "keep_sec": None,
                "anchor": "start",
                "new_start_sec": None,
                "new_end_sec": None,
            }
            for i, p in enumerate(pauses)
        ],
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


def read_decisions(path: str, n_pauses: int) -> List[Decision]:
    """Parse an editor's decision file and validate every reference."""
    with open(path, "r", encoding="utf-8") as fh:
        payload = json.load(fh)
    if not isinstance(payload, dict) or "pauses" not in payload:
        raise ValueError("decision file must be an object with a 'pauses' list")

    decisions: List[Decision] = []
    seen = set()
    for row in payload["pauses"]:
        idx = row.get("pause_index")
        if not isinstance(idx, int) or idx < 0 or idx >= n_pauses:
            raise ValueError(
                f"decision row references invalid pause_index {idx!r} "
                f"(0..{n_pauses - 1})"
            )
        if idx in seen:
            raise ValueError(f"duplicate decision for pause_index {idx}")
        seen.add(idx)
        action = row.get("action", "keep")
        decisions.append(
            Decision(
                pause_index=idx,
                action=action,
                keep_sec=row.get("keep_sec"),
                anchor=row.get("anchor", "start"),
                new_start_sec=row.get("new_start_sec"),
                new_end_sec=row.get("new_end_sec"),
            )
        )
    return decisions


@dataclass
class PipelineResult:
    rmap: RegionMap
    output_path: str
    deleted_marker_labels: List[str]


def run_pipeline(
    input_wav: str,
    output_wav: str,
    detection: DetectionConfig,
    edit_config: EditConfig,
    decisions: Optional[List[Decision]] = None,
    markers_path: Optional[str] = None,
) -> PipelineResult:
    """Detect, edit, render and publish in one validated transaction."""
    audio = read_wav(input_wav)
    pauses = detect_pauses(audio, detection)
    decisions = decisions or []
    plan = build_segments(audio, pauses, decisions, edit_config)
    rendered = render_edits(audio, plan, edit_config)
    rmap = build_region_map(plan)

    mapped_markers = None
    deleted_labels: List[str] = []
    if markers_path:
        markers: List[Marker] = parse_markers(markers_path)
        mapped_markers = map_markers(rmap, markers)
        deleted_labels = [m.label for m in mapped_markers if m.status == "deleted"]

    # render_outputs validates the WAV and publishes all files atomically:
    # an exception here means no output path is left in place.
    render_outputs(output_wav, rendered, rmap, mapped_markers)
    return PipelineResult(rmap, output_wav, deleted_labels)
