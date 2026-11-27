"""命令行入口：``python -m srt_remap --edl edit_list.json -o out/``。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .errors import RemapError
from .remap import load_project, remap
from .report import write_all
from .timecode import format_srt_timestamp


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m srt_remap",
        description="按剪辑清单把各素材 SRT 字幕重映射到成片时间线",
    )
    parser.add_argument(
        "--edl", required=True,
        help="剪辑清单 JSON 路径（字段说明见 README）",
    )
    parser.add_argument(
        "-o", "--output-dir", default="output",
        help="输出目录（默认 ./output）",
    )
    parser.add_argument(
        "--stem", default="timeline",
        help="输出文件名前缀（默认 timeline，生成 .srt/.manifest.csv/.report.json）",
    )
    parser.add_argument(
        "--mode", choices=("trim", "keep"), default="trim",
        help="重叠处理：trim=按轨道优先级裁剪（默认）；keep=全部保留并报告冲突",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        project = load_project(args.edl)
        result = remap(project, mode=args.mode)
        paths = write_all(
            args.output_dir, args.stem, result,
            edl_path=args.edl, mode=args.mode,
        )
    except RemapError as exc:
        print(f"错误：{exc.describe()}", file=sys.stderr)
        return 2

    print(f"模式: {args.mode}")
    print(f"成片字幕 {len(result.cues)} 条，冲突 {len(result.conflicts)} 处，"
          f"丢弃 {len(result.dropped)} 条，警告 {len(result.warnings)} 条")
    for cue in result.cues:
        print(
            f"  {format_srt_timestamp(cue.start)} --> {format_srt_timestamp(cue.end)}"
            f"  [{cue.provenance()}]  {cue.text.splitlines()[0]}"
        )
    for warning in result.warnings:
        print(f"  警告: {warning}")
    for conflict in result.conflicts:
        print(
            f"  冲突: {conflict.cue_a.provenance()} <-> "
            f"{conflict.cue_b.provenance()} "
            f"重叠 {format_srt_timestamp(conflict.overlap_start)}-"
            f"{format_srt_timestamp(conflict.overlap_end)}（{conflict.reason}）"
        )
    for dropped in result.dropped:
        print(f"  丢弃: 第 {dropped.line_no} 行 素材 {dropped.material!r} "
              f"源字幕 #{dropped.src_cue_index}：{dropped.reason}")
    for kind, path in paths.items():
        print(f"已写出 {kind}: {Path(path).resolve()}")
    # keep 模式下存在冲突时以 1 退出，便于流水线感知；文件仍已正常写出
    return 1 if (args.mode == "keep" and result.conflicts) else 0


if __name__ == "__main__":
    raise SystemExit(main())
