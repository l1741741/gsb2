"""Command line interface for the focus stacker.

Subcommands::

    python3 -m focusstack stack    [options] PHOTO...
    python3 -m focusstack samples  [--out DIR]
    python3 -m focusstack inspect  [options] PHOTO...
    python3 -m focusstack editor   [options] PHOTO...

``stack`` runs the pipeline and writes the export bundle.  ``inspect`` runs
the same pipeline but prints the review summary to stdout without writing
files (useful for CI or a quick look).  ``editor`` opens a tkinter window
for drawing manual overrides; it requires a Python build that ships tkinter.
"""

from __future__ import annotations

import argparse
import json
import sys

from .align import parse_offset
from .edits import EditError, load_edits, save_edits, validate_document
from .pipeline import StackError, _usage_summary, run_stack, write_result
from .review import build_regions
from .pngio import PngError

PROGRAM = "focusstack"


def _window(text):
    if text is None:
        return None
    parts = text.replace(" ", "").split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("window must be 'x,y,width,height'")
    try:
        values = [int(part) for part in parts]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("window values must be integers") from exc
    if values[2] <= 0 or values[3] <= 0:
        raise argparse.ArgumentTypeError("window width and height must be positive")
    return tuple(values)


def _offsets(text):
    if text is None:
        return None
    parts = [part for part in text.split(";") if part.strip()]
    try:
        return [parse_offset(part) for part in parts]
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROGRAM,
        description="Local, dependency-free PNG focus stacking with reviewable seams.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("photos", nargs="+", help="same-size PNG photos of one scene")
        p.add_argument("--out", default="focusstack-out", help="output directory")
        p.add_argument("--reference", type=int, default=0,
                       help="photo index used as the coordinate base (default 0)")
        p.add_argument("--offsets", type=_offsets, default=None,
                       help="per-photo integer offsets 'dx,dy' separated by ';', all in one "
                            "common frame (the reference is rebased to 0,0 automatically)")
        p.add_argument("--edits", default=None, help="JSON file with manual overrides")
        p.add_argument("--window", type=_window, default=None,
                       help="export only this canvas block: x,y,width,height")
        p.add_argument("--coverage", choices=("crop", "keep", "error"), default="crop",
                       help="outside the common region: crop (default), keep with marked holes, or error")
        p.add_argument("--seam-radius", type=int, default=2,
                       help="blend radius in pixels around a source change (default 2)")
        p.add_argument("--no-edge-protection", action="store_true",
                       help="disable ridge protection during blending (for comparison)")
        p.add_argument("--focus-window", type=int, default=2, help="focus measurement window radius")
        p.add_argument("--noise-scale", type=float, default=1.0,
                       help="multiplier for the sensor-noise estimate used in scoring")
        p.add_argument("--confidence-threshold", type=float, default=0.25,
                       help="below this, flat pixels keep the reference photo (default 0.25)")
        p.add_argument("--tie-fraction", type=float, default=0.12,
                       help="relative score gap treated as a tie (default 0.12)")
        p.add_argument("--tie-visual-diff", type=float, default=8.0,
                       help="mean RGB difference that makes a tie reviewable (default 8)")
        p.add_argument("--tie-flag-confidence", type=float, default=0.5,
                       help="minimum confidence before a tie is reviewable (default 0.5)")
        p.add_argument("--low-conf-visual-diff", type=float, default=8.0,
                       help="RGB difference that makes a flat area worth reviewing (default 8)")
        p.add_argument("--speckle-passes", type=int, default=1,
                       help="0 disables isolated-label cleanup")
        p.add_argument("--seam-conflict-threshold", type=float, default=26.0,
                       help="luma difference across a seam that is flagged (default 26)")
        p.add_argument("--min-review-area", type=int, default=4,
                       help="smallest flagged region listed (default 4 px)")
        p.add_argument("--max-regions", type=int, default=400,
                       help="cap on listed regions; the rest are counted as truncated")
        p.add_argument("--masks", action="store_true",
                       help="also write one black/white mask per photo")
        p.add_argument("--source-kind", choices=("labels", "photos"), default="labels",
                       help="sources.png style: colour-coded labels (default) or used-pixel grayscale")

    stack = sub.add_parser("stack", help="run the stack and write the export bundle")
    common(stack)

    inspect = sub.add_parser("inspect", help="run the stack and print the review summary only")
    common(inspect)

    samples = sub.add_parser("samples", help="generate the sample stack")
    samples.add_argument("--out", default="samples", help="destination directory (default ./samples)")
    samples.add_argument("--seed", type=int, default=20261128, help="noise seed for reproducible output")

    editor = sub.add_parser("editor", help="draw manual overrides (needs tkinter)")
    editor.add_argument("photos", nargs="+")
    editor.add_argument("--edits", required=True, help="edit JSON to load and update")
    editor.add_argument("--reference", type=int, default=0)
    editor.add_argument("--offsets", type=_offsets, default=None)
    editor.add_argument("--window", type=_window, default=None,
                        help="edit inside this block only (canvas coordinates)")
    return parser


def _run_stack_from_args(args):
    """Run the pipeline using every selection option the CLI exposes."""
    edits = None
    if getattr(args, "edits", None):
        try:
            edits = load_edits(args.edits, len(args.photos))
        except EditError as exc:
            raise SystemExit("%s: edit file error: %s" % (PROGRAM, exc)) from exc
    return run_stack(
        args.photos,
        reference=args.reference,
        offsets=args.offsets,
        edits=edits,
        window=args.window,
        coverage=args.coverage,
        seam_radius=args.seam_radius,
        focus_window=args.focus_window,
        noise_scale=args.noise_scale,
        confidence_threshold=args.confidence_threshold,
        tie_fraction=args.tie_fraction,
        tie_visual_diff=args.tie_visual_diff,
        low_conf_visual_diff=args.low_conf_visual_diff,
        tie_flag_confidence=args.tie_flag_confidence,
        remove_speckle=args.speckle_passes,
        seam_conflict_threshold=args.seam_conflict_threshold,
        protect_edges=not args.no_edge_protection,
        min_review_area=args.min_review_area,
        review_max_regions=args.max_regions,
    )


def _run_common(args):
    result, export_window = _run_stack_from_args(args)
    meta = {"command_line": " ".join(sys.argv)}
    document = write_result(
        result,
        export_window,
        args.out,
        coverage=args.coverage,
        emit_masks=args.masks,
        source_kind=args.source_kind,
        extra_meta=meta,
    )
    return result, export_window, document


def command_stack(args) -> int:
    result, export_window, document = _run_common(args)
    x, y, w, h = export_window
    print("wrote %s" % args.out)
    print("  composite   %dx%d at %d,%d" % (w, h, x, y))
    print("  regions     %d listed, %d truncated, %d flagged px"
          % (len(document["regions"]), document["regions_truncated"],
             document["flagged_pixel_area"]))
    print("  usage       %s" % ", ".join(
        "photo %s: %s px" % (key, value) for key, value in document["usage"]["by_photo"].items()))
    if document["manual_edits"]:
        for record in document["manual_edits"]:
            print("  edit %-12s image %d painted %d (inside window %d)"
                  % (record["id"], record["image"], record["painted"], record["in_window"]))
    return 0


def command_inspect(args) -> int:
    result, export_window = _run_stack_from_args(args)
    regions, truncated, flagged_area = build_regions(
        result.flags, result.labels, result.focus, result.width, result.height,
        window=export_window, min_area=args.min_review_area, max_regions=args.max_regions,
    )
    summary = {
        "export_window": {"x": export_window[0], "y": export_window[1],
                          "width": export_window[2], "height": export_window[3]},
        "usage": _usage_summary(result, export_window),
        "flagged_pixel_area": flagged_area,
        "regions": regions,
        "regions_truncated": truncated,
        "manual_edits": result.edit_records,
    }
    json.dump(summary, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


def command_samples(args) -> int:
    from .samples import generate_samples

    meta = generate_samples(args.out, seed=args.seed)
    print("wrote sample stack to %s" % meta["directory"])
    for name in meta["photos"]:
        print("  %s" % name)
    print("  edits.json (manual override for the moved fastener)")
    return 0


def command_editor(args) -> int:
    try:
        from .editor.app import run_editor
    except ImportError as exc:
        print("focusstack: the editor needs tkinter, which this Python lacks (%s)" % exc, file=sys.stderr)
        print("Use a Python build with tkinter, or write the edit JSON by hand; see docs/EDIT-FORMAT.md.",
              file=sys.stderr)
        return 2
    return run_editor(args, load_edits, validate_document, save_edits, run_stack)


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    command = args.command
    try:
        if command == "stack":
            return command_stack(args)
        if command == "inspect":
            return command_inspect(args)
        if command == "samples":
            return command_samples(args)
        if command == "editor":
            return command_editor(args)
    except (StackError, PngError, EditError, OSError, ValueError) as exc:
        print("%s: %s" % (PROGRAM, exc), file=sys.stderr)
        return 2
    parser.error("unknown command %r" % command)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
