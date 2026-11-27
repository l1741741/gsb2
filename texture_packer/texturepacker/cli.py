"""Command line interface for the local texture atlas packer."""

from __future__ import annotations

import argparse
import json
import sys

from .atlas import build_atlas, load_sources, restore_all
from .samplegen import generate_samples


def _cmd_pack(args: argparse.Namespace) -> int:
    records = load_sources(args.input, args.anchors)
    if not records:
        print(f"error: no PNG files found under {args.input}", file=sys.stderr)
        return 2
    metadata = build_atlas(
        records=records,
        output_dir=args.output,
        page_width=args.page_width,
        page_height=args.page_height,
        max_pages=args.max_pages,
        padding=args.padding,
        allow_rotation=not args.no_rotation,
    )
    placed = sum(1 for s in metadata["sprites"] if s["status"] == "placed")
    transparent = sum(
        1 for s in metadata["sprites"] if s["status"] == "fully_transparent"
    )
    print(
        f"packed {placed} image(s) on {metadata['settings']['pages_used']} "
        f"page(s); {transparent} fully transparent; "
        f"{len(metadata['rejected'])} rejected"
    )
    if metadata["rejected"]:
        print("rejected images:", file=sys.stderr)
        for rej in metadata["rejected"]:
            print(f"  - {rej['name']} ({rej['width']}x{rej['height']}): {rej['reason']}", file=sys.stderr)
    print(f"metadata: {args.output}/atlas.json")
    return 1 if metadata["rejected"] else 0


def _cmd_unpack(args: argparse.Namespace) -> int:
    result = restore_all(args.atlas, args.output)
    print(
        f"restored {len(result['written'])} image(s) into {args.output}; "
        f"skipped {len(result['skipped_rejected'])} rejected"
    )
    for name in result["skipped_rejected"]:
        print(f"  - skipped {name} (not present in atlas)")
    return 0


def _cmd_samples(args: argparse.Namespace) -> int:
    paths = generate_samples(args.output)
    print(json.dumps(paths, indent=2, ensure_ascii=False))
    print(f"\nsample material generated under {args.output}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="texturepacker",
        description="Pack transparent PNGs into a texture atlas with "
        "trim/padding/anchor metadata, and restore them again.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_pack = sub.add_parser("pack", help="pack PNGs into atlas pages")
    p_pack.add_argument("input", help="directory containing source PNGs")
    p_pack.add_argument("output", help="directory to write atlas pages and atlas.json")
    p_pack.add_argument("--anchors", help="optional JSON file with anchor points")
    p_pack.add_argument("--page-width", type=int, default=1024)
    p_pack.add_argument("--page-height", type=int, default=1024)
    p_pack.add_argument("--max-pages", type=int, default=1)
    p_pack.add_argument(
        "--padding",
        type=int,
        default=1,
        help="transparent-sized border per sprite, filled by edge extrusion",
    )
    p_pack.add_argument(
        "--no-rotation", action="store_true", help="disable 90-degree rotation"
    )
    p_pack.set_defaults(func=_cmd_pack)

    p_unpack = sub.add_parser("unpack", help="restore single PNGs from an atlas")
    p_unpack.add_argument("atlas", help="directory containing atlas.json and pages")
    p_unpack.add_argument("output", help="directory to write restored PNGs")
    p_unpack.set_defaults(func=_cmd_unpack)

    p_samples = sub.add_parser(
        "make-samples", help="generate the built-in sample material"
    )
    p_samples.add_argument("output", help="directory to write sample PNGs/anchors")
    p_samples.set_defaults(func=_cmd_samples)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (ValueError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
