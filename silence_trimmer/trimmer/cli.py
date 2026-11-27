"""Command-line interface for the WAV silence trimmer.

Subcommands:

* ``detect``  - list candidate pauses and write an editable decision file;
* ``apply``   - render the output from a decision file, reports included;
* ``trim``    - one-shot detect + shorten every pause (scripting friendly);
* ``locate``  - map a time point either direction using a published map.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from .detect import DetectionConfig, dbfs, detect_pauses
from .edit import Decision, EditConfig
from .map import RegionMap, locate_original, locate_output
from .pipeline import (
    read_decisions,
    run_pipeline,
    write_decisions_template,
)
from .wavio import format_timestamp, read_wav


def _add_detection_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--threshold-dbfs", type=float, default=-40.0,
        help="silence amplitude threshold in dBFS (default: -40)",
    )
    parser.add_argument(
        "--min-pause", type=float, default=0.8,
        help="minimum pause duration in seconds (default: 0.8)",
    )
    parser.add_argument("--frame-ms", type=float, default=20.0)
    parser.add_argument("--hop-ms", type=float, default=None)
    parser.add_argument(
        "--merge-gap-ms", type=float, default=200.0,
        help="noisy gaps shorter than this merge adjacent silent runs",
    )
    parser.add_argument(
        "--amplitude", choices=["peak", "rms"], default="peak",
    )
    parser.add_argument(
        "--channel-rule", choices=["all", "any", "avg"], default="all",
        help="joint rule for multi-channel audio (default: every channel quiet)",
    )


def _detection_from_args(args: argparse.Namespace) -> DetectionConfig:
    return DetectionConfig(
        threshold_dbfs=args.threshold_dbfs,
        min_pause_sec=args.min_pause,
        frame_ms=args.frame_ms,
        hop_ms=args.hop_ms,
        merge_gap_ms=args.merge_gap_ms,
        amplitude=args.amplitude,
        channel_rule=args.channel_rule,
    )


def _add_edit_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--fade-ms", type=float, default=8.0,
        help="crossfade duration at each cut junction (default: 8ms)",
    )
    parser.add_argument(
        "--fade-curve", choices=["linear", "equal_power"], default="equal_power",
    )


def _edit_from_args(args: argparse.Namespace) -> EditConfig:
    return EditConfig(fade_ms=args.fade_ms, fade_curve=args.fade_curve)


def _print_pauses(pauses) -> None:
    if not pauses:
        print("No pauses found under the current settings.")
        return
    print(
        f"{'#':>3}  {'start':>12}  {'end':>12}  {'duration':>9}  "
        f"{'peak dBFS (per channel)'}"
    )
    for i, p in enumerate(pauses):
        peaks = ", ".join(
            ("-inf" if v <= 0 else f"{dbfs(v):.1f}") for v in p.channel_peak
        )
        print(
            f"{i:>3}  {format_timestamp(p.start_sec):>12}  "
            f"{format_timestamp(p.end_sec):>12}  "
            f"{p.duration_sec:>8.3f}s  {peaks}"
        )


def cmd_detect(args: argparse.Namespace) -> int:
    config = _detection_from_args(args)
    audio = read_wav(args.input)
    pauses = detect_pauses(audio, config)
    _print_pauses(pauses)
    if args.decisions:
        write_decisions_template(args.decisions, pauses, config, args.default_action)
        print(f"\nDecision template written to {args.decisions}")
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    config = _detection_from_args(args)
    edit_config = _edit_from_args(args)
    audio = read_wav(args.input)
    pauses = detect_pauses(audio, config)
    decisions = read_decisions(args.decisions, len(pauses))
    result = run_pipeline(
        args.input,
        args.output,
        config,
        edit_config,
        decisions=decisions,
        markers_path=args.markers,
    )
    _summarize(result, len(pauses))
    return 0


def cmd_trim(args: argparse.Namespace) -> int:
    config = _detection_from_args(args)
    edit_config = _edit_from_args(args)
    audio = read_wav(args.input)
    pauses = detect_pauses(audio, config)
    decisions: List[Decision] = []
    for idx, pause in enumerate(pauses):
        if pause.duration_sec <= args.keep_pause:
            continue  # leave already-short pauses intact
        decisions.append(
            Decision(
                pause_index=idx,
                action="shorten",
                keep_sec=args.keep_pause,
                anchor=args.anchor,
            )
        )
    result = run_pipeline(
        args.input,
        args.output,
        config,
        edit_config,
        decisions=decisions,
        markers_path=args.markers,
    )
    _summarize(result, len(pauses))
    return 0


def _summarize(result, n_pauses: int) -> None:
    rmap = result.rmap
    print(f"Input duration : {format_timestamp(rmap.input_duration_sec)}")
    print(f"Output duration: {format_timestamp(rmap.output_duration_sec)}")
    print(
        f"Removed        : {format_timestamp(rmap.input_duration_sec - rmap.output_duration_sec)} "
        f"across {len(rmap.deleted)} range(s)"
    )
    print(f"Candidate pauses detected: {n_pauses}")
    print(f"Outputs: {result.output_path} (+ .map.json/.intervals.csv/.deleted.csv)")
    if result.deleted_marker_labels:
        print(
            "WARNING markers inside deleted ranges: "
            + ", ".join(result.deleted_marker_labels)
        )


def cmd_locate(args: argparse.Namespace) -> int:
    with open(args.map, "r", encoding="utf-8") as fh:
        payload = json.load(fh)
    rmap = RegionMap.from_dict(payload)

    if args.direction == "original-to-output":
        point = locate_original(rmap, args.time)
        if point.status == "deleted":
            print(f"{format_timestamp(args.time)} -> DELETED ({point.detail})")
            return 2
        print(
            f"{format_timestamp(args.time)} -> {format_timestamp(point.mapped_time_sec)}"
        )
        return 0

    point = locate_output(rmap, args.time)
    print(
        f"{format_timestamp(args.time)} -> {format_timestamp(point.mapped_time_sec)} "
        f"(original)"
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="trimmer",
        description="Local WAV long-pause detector and trimmer.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_detect = sub.add_parser("detect", help="list candidate pauses")
    p_detect.add_argument("input")
    p_detect.add_argument(
        "--decisions", help="write an editable decision template to this path"
    )
    p_detect.add_argument(
        "--default-action",
        choices=["keep", "shorten", "delete"],
        default="keep",
    )
    _add_detection_args(p_detect)
    p_detect.set_defaults(func=cmd_detect)

    p_apply = sub.add_parser("apply", help="apply a decision file")
    p_apply.add_argument("input")
    p_apply.add_argument("output")
    p_apply.add_argument("--decisions", required=True)
    p_apply.add_argument("--markers", help="optional marker table (csv/json)")
    _add_detection_args(p_apply)
    _add_edit_args(p_apply)
    p_apply.set_defaults(func=cmd_apply)

    p_trim = sub.add_parser("trim", help="one-shot shorten every long pause")
    p_trim.add_argument("input")
    p_trim.add_argument("output")
    p_trim.add_argument(
        "--keep-pause", type=float, default=0.3,
        help="retain this many seconds of each shortened pause (default: 0.3)",
    )
    p_trim.add_argument(
        "--anchor", choices=["start", "end", "center"], default="start",
    )
    p_trim.add_argument("--markers", help="optional marker table (csv/json)")
    _add_detection_args(p_trim)
    _add_edit_args(p_trim)
    p_trim.set_defaults(func=cmd_trim)

    p_locate = sub.add_parser("locate", help="map a time point via a .map.json")
    p_locate.add_argument("map")
    p_locate.add_argument("time", type=float, help="time in seconds")
    p_locate.add_argument(
        "--direction",
        choices=["original-to-output", "output-to-original"],
        default="original-to-output",
    )
    p_locate.set_defaults(func=cmd_locate)
    return parser


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (ValueError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
