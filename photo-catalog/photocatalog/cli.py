"""Command line entry point for the photo catalog tool.

Typical use::

    python3 -m photocatalog scan /path/to/photos
    python3 -m photocatalog scan /path/to/photos --decisions decisions.json
    python3 -m photocatalog decide decisions.json --merge A B
    python3 -m photocatalog decide decisions.json --exclude A B

``scan`` writes an HTML contact sheet, a Markdown summary, and a machine-readable
JSON record into an output directory, without ever touching the source photos.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .pipeline import (
    DecisionStore, Photo, apply_decisions, candidate_pairs, evaluate_pair,
    find_chains, group_candidates, scan_folder,
)
from .report import render_html, render_markdown

DEFAULT_STATE = "decisions.json"


def _progress(index: int, total: int, path: str) -> None:
    if total and (index % 10 == 0 or index == total - 1):
        print(f"\r扫描 {index + 1}/{total} …", end="", file=sys.stderr)


def _decision_map(store: DecisionStore, photos: list[Photo],
                  pairs: list) -> dict[tuple[str, str], str]:
    """Human decisions keyed by (path_a, path_b), usable by both reports."""
    by_rel = {p.relpath: p for p in photos}
    result: dict[tuple[str, str], str] = {}
    for pair in pairs:
        a, b = by_rel.get(pair.a), by_rel.get(pair.b)
        if a is None or b is None:
            continue
        record = store.lookup(a, b)
        if record is not None:
            result[tuple(sorted((pair.a, pair.b)))] = record["decision"]
    return result


def cmd_scan(args: argparse.Namespace) -> int:
    root = os.path.abspath(args.folder)
    if not os.path.isdir(root):
        print(f"错误：目录不存在：{root}", file=sys.stderr)
        return 2
    out_dir = os.path.abspath(args.out or "photo-catalog-report")
    state_path = os.path.abspath(args.decisions or os.path.join(out_dir, DEFAULT_STATE))

    store = DecisionStore(state_path)
    print(f"扫描 {root} …", file=sys.stderr)
    photos = scan_folder(root, external_tools=not args.no_external, progress=_progress)
    print("", file=sys.stderr)

    pairs = candidate_pairs(photos)
    notices = apply_decisions(photos, pairs, store)
    chains = find_chains(pairs)
    groups = group_candidates(pairs)
    decisions = _decision_map(store, photos, pairs)

    os.makedirs(out_dir, exist_ok=True)
    html_path = os.path.join(out_dir, "report.html")
    md_path = os.path.join(out_dir, "report.md")
    json_path = os.path.join(out_dir, "report.json")

    render_html(root, photos, pairs, chains, notices, decisions, html_path,
                report_dir=out_dir)
    render_markdown(root, photos, pairs, chains, notices, decisions, md_path)

    payload = {
        "root": root,
        "files": [
            {
                "path": p.relpath,
                "size": p.size,
                "sha256": p.sha256,
                "width": p.width,
                "height": p.height,
                "format": p.format,
                "error": p.error,
            }
            for p in photos
        ],
        "groups": groups,
        "chains": [
            {
                "left": c["left"], "middle": c["middle"], "right": c["right"],
                "explanation": c["explanation"],
            }
            for c in chains
        ],
        "notices": notices,
        "pairs": [
            {
                "a": p.a, "b": p.b,
                "relation": p.relation,
                "same_photo": round(p.same_photo, 4),
                "merge_fit": round(p.merge_fit, 4),
                "phash_distance": p.phash_distance,
                "dhash_distance": p.dhash_distance,
                "colour_distance": round(p.colour_distance, 4),
                "structure": round(p.structure, 4),
                "region_correlation": round(p.region_correlation, 4),
                "residual_flat": round(p.residual_flat, 2),
                "crop": list(p.crop) if p.crop else None,
                "reasons": p.reasons,
                "warnings": p.warnings,
            }
            for p in pairs
        ],
    }
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2, sort_keys=True)
        fh.write("\n")

    # The decision store only changes via `decide`; do not rewrite it on scan.
    print(f"完成：{len(photos)} 个文件，{len(pairs)} 组候选，"
          f"{len(groups)} 个建议分组，{len(chains)} 个链式关系。", file=sys.stderr)
    print(f"报告：{html_path}")
    print(f"摘要：{md_path}")
    print(f"数据：{json_path}")
    errors = [p for p in photos if not p.ok]
    if errors:
        print(f"注意：{len(errors)} 个文件读取失败，详见报告。", file=sys.stderr)
    return 0


def _resolve_photo(target: str, photos: list[Photo] | None) -> Photo:
    path = os.path.abspath(target)
    rel = os.path.relpath(path) if os.path.exists(path) else target
    photo = Photo(path, rel)
    try:
        st = os.stat(path)
        photo.size = st.st_size
        photo.mtime = int(st.st_mtime)
    except OSError:
        pass
    from .pipeline import _hash_file
    try:
        photo.sha256 = _hash_file(path)
    except OSError:
        pass
    return photo


def cmd_decide(args: argparse.Namespace) -> int:
    store = DecisionStore(os.path.abspath(args.decisions))
    a = _resolve_photo(args.file_a, None)
    b = _resolve_photo(args.file_b, None)
    if not a.sha256 or not b.sha256:
        print("错误：无法读取文件以计算内容哈希。", file=sys.stderr)
        return 2
    store.record("merge" if args.merge else "exclude", a, b, note=args.note or "")
    store.save()
    verb = "合并" if args.merge else "排除"
    print(f"已记录：{verb} {a.relpath} ↔ {b.relpath}", file=sys.stderr)
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    store = DecisionStore(os.path.abspath(args.decisions))
    if not store.records:
        print("（尚未记录任何人工决定）")
        return 0
    for i, record in enumerate(store.records, 1):
        verb = "合并" if record["decision"] == "merge" else "排除"
        print(f"{i}. [{verb}] {record.get('path_a')} ↔ {record.get('path_b')}"
              + (f"  # {record['note']}" if record.get("note") else ""))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="photocatalog",
        description="为照片档案整理相似候选：只提出建议，不自动合并。",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    scan = sub.add_parser("scan", help="扫描目录并生成报告")
    scan.add_argument("folder", help="要扫描的照片目录")
    scan.add_argument("-o", "--out", help="报告输出目录（默认 photo-catalog-report）")
    scan.add_argument("--decisions", help="人工决定文件（默认放在输出目录）")
    scan.add_argument("--no-external", action="store_true",
                      help="不使用 ffmpeg/sips 等外部解码器")
    scan.set_defaults(func=cmd_scan)

    decide = sub.add_parser("decide", help="记录一对文件的人工决定")
    decide.add_argument("decisions", help="决定文件路径")
    decide.add_argument("file_a", help="文件 A")
    decide.add_argument("file_b", help="文件 B")
    group = decide.add_mutually_exclusive_group(required=True)
    group.add_argument("--merge", action="store_true", help="确认合并")
    group.add_argument("--exclude", action="store_true", help="确认排除")
    decide.add_argument("--note", help="备注")
    decide.set_defaults(func=cmd_decide)

    listing = sub.add_parser("list", help="查看已保存的人工决定")
    listing.add_argument("decisions", nargs="?", default=DEFAULT_STATE)
    listing.set_defaults(func=cmd_list)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
