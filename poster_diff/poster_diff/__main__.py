"""Command line entry point: ``python3 -m poster_diff``."""

from __future__ import annotations

import argparse
import sys

from .geometry import parse_color
from .pngio import PngError
from .report import build_report
from .geometry import DiffConfig


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="poster_diff",
        description=(
            "Compare two PNG poster images and build a pan/zoom offline "
            "difference report. Coordinates use the reference image origin; "
            "the candidate is shifted by (--offset-x, --offset-y)."
        ),
    )
    p.add_argument("-r", "--reference", required=True, help="reference PNG (version A)")
    p.add_argument("-c", "--candidate", required=True, help="candidate PNG (version B)")
    p.add_argument(
        "-o", "--output", required=True, help="output report directory (created if missing)"
    )
    p.add_argument("--offset-x", type=int, default=0, help="integer x shift of B on A's canvas")
    p.add_argument("--offset-y", type=int, default=0, help="integer y shift of B on A's canvas")
    p.add_argument(
        "--appearance-threshold",
        type=int,
        default=16,
        help="min composited color difference (0..255) to count as a change",
    )
    p.add_argument(
        "--alpha-threshold",
        type=int,
        default=16,
        help="min alpha difference (0..255) to count as a change",
    )
    p.add_argument(
        "--merge-gap",
        type=int,
        default=2,
        help="merge change blocks whose bounding boxes are within this gap (px)",
    )
    p.add_argument("--connectivity", type=int, choices=(4, 8), default=8)
    p.add_argument(
        "--min-block-area", type=int, default=1, help="drop change blocks smaller than this"
    )
    p.add_argument(
        "--background",
        type=str,
        default="#ffffff",
        help="flattening background for semi-transparent pixels: #rrggbb or r,g,b",
    )
    p.add_argument(
        "--tile-size",
        type=int,
        default=512,
        help="processing tile size in pixels (report tiles are always 256px)",
    )
    p.add_argument("--title", type=str, default=None, help="report title")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        config = DiffConfig(
            offset_x=args.offset_x,
            offset_y=args.offset_y,
            appearance_threshold=args.appearance_threshold,
            alpha_threshold=args.alpha_threshold,
            merge_gap=args.merge_gap,
            connectivity=args.connectivity,
            min_block_area=args.min_block_area,
            background=parse_color(args.background),
            tile_size=args.tile_size,
        )
        result = build_report(
            args.reference, args.candidate, args.output, config, title=args.title
        )
    except (PngError, OSError, ValueError) as exc:
        print(f"poster_diff: error: {exc}", file=sys.stderr)
        return 2

    counts = result.counts
    print(f"report written to: {args.output}")
    print(
        f"canvas {counts['canvas_width']}x{counts['canvas_height']} | "
        f"common {counts['common_area']}px | "
        f"ref-only {counts['reference_only_area']}px | "
        f"cand-only {counts['candidate_only_area']}px"
    )
    print(
        f"diff blocks: {counts['diff_block_count']} | "
        f"coverage blocks: {counts['coverage_block_count']} | "
        f"changed appearance px: {counts['changed_appearance_pixels']} | "
        f"changed alpha px: {counts['changed_alpha_pixels']}"
    )
    print(f"open: {args.output}/index.html")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
