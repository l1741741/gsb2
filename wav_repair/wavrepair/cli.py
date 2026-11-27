"""Command line interface for wavrepair."""

from __future__ import annotations

import argparse
import json
import sys

from .confirm import load_confirm, resolve_edits
from .detect import DetectionSettings, scan_audio
from .errors import WavRepairError
from .export import (
    build_manifest,
    export_excerpts,
    verify_untouched,
    write_json,
)
from .repair import apply_repairs
from .wavio import read_wav, write_wav


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="wavrepair",
        description=(
            "Locate short suspicious sample jumps in PCM WAV takes, then apply "
            "only the human-confirmed short ranges. Detection is advisory; "
            "repair is opt-in per range."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser(
        "scan",
        help="find suspicious sample jumps and write a JSON report",
        description=(
            "Scan PCM WAV channels for short suspicious sample jumps and write "
            "a human-readable JSON report. Candidates are 'suspect' (proposed "
            "for review) or 'rejected_transient' (considered and deliberately "
            "not proposed). Each candidate carries channel, frame/time range, "
            "highlighted context samples and a reason. This command never "
            "modifies audio."
        ),
    )
    _add_scan_options(scan)
    scan.add_argument(
        "--draft-confirm",
        metavar="PATH",
        help=(
            "write a confirmation-file draft containing every suspect candidate "
            "(method interpolate, overlap_policy merge). Review and trim it "
            "before repairing."
        ),
    )

    repair = sub.add_parser(
        "repair",
        help="apply confirmed ranges and write the repaired WAV plus a manifest",
        description=(
            "Apply only the ranges listed in the confirmation file. The repaired "
            "WAV keeps the original frame count, sample rate and channel layout. "
            "A manifest with before/after excerpts, per-range detail and an "
            "unconfirmed-samples integrity digest is written alongside."
        ),
    )
    repair.add_argument("input", help="source PCM WAV file")
    repair.add_argument("--confirm", required=True, metavar="PATH", help="confirmation JSON file")
    repair.add_argument("--output", required=True, metavar="PATH", help="repaired WAV to write")
    repair.add_argument("--manifest", metavar="PATH", help="manifest JSON to write (default: <output>.manifest.json)")
    repair.add_argument("--excerpts-out", metavar="DIR", help="directory for before/after excerpt WAVs")
    repair.add_argument(
        "--max-merge-width",
        type=int,
        default=4096,
        metavar="N",
        help="largest frame span a merged overlap may cover (default: 4096)",
    )
    repair.add_argument(
        "--timestamp",
        metavar="TEXT",
        help=(
            "record a generated_at string in the manifest. Omit for byte-identical "
            "manifests across re-runs."
        ),
    )

    verify = sub.add_parser(
        "verify",
        help="check that a repaired WAV only differs inside the confirmed ranges",
        description=(
            "Compare a repaired WAV against its original input and confirm that "
            "every sample outside the resolved ranges is bit-identical, and that "
            "frame count, sample rate and channel layout are unchanged."
        ),
    )
    verify.add_argument("input", help="original PCM WAV file")
    verify.add_argument("repaired", help="repaired PCM WAV file to check")
    verify.add_argument("--confirm", required=True, metavar="PATH", help="confirmation JSON file")
    verify.add_argument("--report", metavar="PATH", help="write the verification result as JSON")
    verify.add_argument(
        "--max-merge-width",
        type=int,
        default=4096,
        metavar="N",
        help="must match the value used by repair (default: 4096)",
    )

    return parser


def _add_scan_options(scan: argparse.ArgumentParser) -> None:
    scan.add_argument("input", help="source PCM WAV file")
    scan.add_argument("--report", metavar="PATH", help="write the JSON report here (default: stdout)")
    scan.add_argument("--channel", action="append", type=int, metavar="N", help="scan only this channel (repeatable)")
    scan.add_argument("--radius", type=int, default=4, help="median filter radius in frames (default: 4)")
    scan.add_argument("--mad-block", type=int, default=256, help="block size for robust MAD estimate (default: 256)")
    scan.add_argument("--sensitivity", type=float, default=6.0, help="residual threshold in block MADs (default: 6.0)")
    scan.add_argument("--floor", type=float, default=0.120, help="absolute hull-excess floor, full-scale units (default: 0.120)")
    scan.add_argument("--hull-span", type=int, default=3, help="neighbours each side for the hull test (default: 3)")
    scan.add_argument("--merge-gap", type=int, default=24, help="merge flagged frames closer than this many frames (default: 24)")
    scan.add_argument("--max-width", type=int, default=12, help="widest proposed range in frames; wider is rejected as transient (default: 12)")
    scan.add_argument("--envelope-window", type=int, default=48, help="frames either side for the attack guard (default: 48)")
    scan.add_argument("--envelope-rise", type=float, default=3.0, help="before/after RMS ratio that marks an attack (default: 3.0)")
    scan.add_argument("--envelope-rise-min", type=float, default=0.050, help="minimum after-RMS for the attack guard (default: 0.050)")
    scan.add_argument("--silence-floor", type=float, default=0.0005, help="sample magnitude counted as silent (default: 0.0005)")
    scan.add_argument("--dropout-min", type=int, default=2, help="shortest dropout run in frames (default: 2)")
    scan.add_argument("--dropout-max", type=int, default=2048, help="longest dropout run in frames (default: 2048)")
    scan.add_argument("--stuck-min", type=int, default=4, help="shortest stuck run in frames (default: 4)")
    scan.add_argument("--stuck-max", type=int, default=2048, help="longest stuck run in frames (default: 2048)")
    scan.add_argument("--boundary-jump", type=float, default=0.050, help="jump required at both edges of dropout/stuck runs (default: 0.050)")
    scan.add_argument("--excerpt-before", type=int, default=12, help="context frames before a candidate (default: 12)")
    scan.add_argument("--excerpt-after", type=int, default=12, help="context frames after a candidate (default: 12)")


def main(argv: list | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "scan":
            return _cmd_scan(args, parser)
        if args.command == "repair":
            return _cmd_repair(args, parser)
        if args.command == "verify":
            return _cmd_verify(args, parser)
    except WavRepairError as exc:
        print(f"wavrepair: error: {exc}", file=sys.stderr)
        return 2
    return 2


def _settings_from_args(args) -> DetectionSettings:
    settings = DetectionSettings(
        radius=args.radius,
        mad_block=args.mad_block,
        sensitivity=args.sensitivity,
        floor=args.floor,
        hull_span=args.hull_span,
        merge_gap=args.merge_gap,
        max_width=args.max_width,
        envelope_window=args.envelope_window,
        envelope_rise=args.envelope_rise,
        envelope_rise_min=args.envelope_rise_min,
        silence_floor=args.silence_floor,
        dropout_min=args.dropout_min,
        dropout_max=args.dropout_max,
        stuck_min=args.stuck_min,
        stuck_max=args.stuck_max,
        boundary_jump=args.boundary_jump,
        excerpt_before=args.excerpt_before,
        excerpt_after=args.excerpt_after,
        channels=tuple(args.channel or ()),
    )
    settings.validate()
    return settings


def _cmd_scan(args, parser) -> int:
    audio = read_wav(args.input)
    settings = _settings_from_args(args)
    result = scan_audio(audio, settings)
    report = result.as_dict()

    if args.draft_confirm:
        draft = _draft_confirmation(result, audio)
        write_json(args.draft_confirm, draft)
        report["draft_confirmation"] = args.draft_confirm

    if args.report:
        write_json(args.report, report)
        print(
            f"wavrepair: scanned {audio.frames} frames on "
            f"{len(result.analysed_channels)} channel(s): "
            f"{len(result.suspects)} suspect, {len(result.rejected)} rejected "
            f"transient(s); report -> {args.report}",
            file=sys.stderr,
        )
    else:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if not result.suspects else 1


def _draft_confirmation(result, audio) -> dict:
    edits = [
        {
            "channel": candidate.channel,
            "start": candidate.start,
            "end": candidate.end,
            "method": "interpolate",
            "note": f"candidate {candidate.id}: {candidate.kind}",
        }
        for candidate in result.suspects
    ]
    return {
        "format": "wavrepair-confirm",
        "version": 1,
        "input": {
            "path": audio.source_path,
            "sha256": audio.source_sha256,
            "frames": audio.frames,
            "sample_rate": audio.sample_rate,
            "channels": audio.channels,
        },
        "overlap_policy": "merge",
        "edits": edits,
        "ignored_candidates": [],
    }


def _cmd_repair(args, parser) -> int:
    audio = read_wav(args.input)
    document = load_confirm(args.confirm, audio, default_max_width=args.max_merge_width)
    edits = resolve_edits(document, audio, args.max_merge_width)
    repaired, record = apply_repairs(audio, edits)
    write_wav(args.output, repaired)

    manifest_path = args.manifest or f"{args.output}.manifest.json"
    if args.excerpts_out:
        excerpts = export_excerpts(audio, repaired, record["edits"], args.excerpts_out)
    else:
        excerpts = {"padding_frames": None, "entries": [], "note": "no --excerpts-out given"}

    manifest = build_manifest(
        input_audio=audio,
        input_path=args.input,
        output_path=args.output,
        confirm_path=args.confirm,
        document=document,
        resolved_edits=edits,
        record=record,
        excerpts=excerpts,
        timestamp=args.timestamp,
    )
    write_json(manifest_path, manifest)

    verification = manifest["verification"]
    print(
        f"wavrepair: repaired {len(record['edits'])} range(s) across "
        f"{len({e.channel for e in edits})} channel(s); "
        f"{verification['confirmed_samples_changed']} sample(s) changed, "
        f"{verification['unconfirmed_samples_changed']} changed outside confirmed ranges; "
        f"output -> {args.output}; manifest -> {manifest_path}",
        file=sys.stderr,
    )
    return 0


def _cmd_verify(args, parser) -> int:
    original = read_wav(args.input)
    repaired = read_wav(args.repaired)
    if (original.frames, original.channels, original.sample_rate, original.codec) != (
        repaired.frames, repaired.channels, repaired.sample_rate, repaired.codec
    ):
        print(
            "wavrepair: error: repaired file geometry differs from the original "
            f"(frames {original.frames}->{repaired.frames}, "
            f"channels {original.channels}->{repaired.channels}, "
            f"sample_rate {original.sample_rate}->{repaired.sample_rate}, "
            f"codec {original.codec}->{repaired.codec})",
            file=sys.stderr,
        )
        return 2
    document = load_confirm(args.confirm, original, default_max_width=args.max_merge_width)
    edits = resolve_edits(document, original, args.max_merge_width)

    result = verify_untouched(original, repaired, edits)
    result["ok"] = result["unconfirmed_untouched"]
    if args.report:
        write_json(args.report, {"format": "wavrepair-verify", "version": 1, **result})
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if result["ok"] else 1
