"""命令行入口。

用法:
  python -m wav_sampler --manifest manifest.json --output-dir build/out
"""

from __future__ import annotations

import argparse
import sys

from .engine import ExportConfig, export
from .manifest import ManifestError
from .report import (
    write_delivery_manifest,
    write_markdown_report,
    write_segment_csv,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="wav_sampler",
        description="离线 PCM WAV 取样工具: 按项目时间轴从多段录音导出交付片段",
    )
    parser.add_argument(
        "-m", "--manifest", required=True, help="段落与取样范围清单 (JSON)"
    )
    parser.add_argument(
        "-o", "--output-dir", required=True, help="WAV 与报告的输出目录"
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="允许覆盖已存在的输出文件 (默认不覆盖, 跳过并报错)",
    )
    parser.add_argument(
        "--block-frames",
        type=int,
        default=8192,
        help="流式处理的分块帧数 (默认 8192)",
    )
    parser.add_argument(
        "--delivery-name",
        default="delivery-manifest.json",
        help="交付清单文件名 (默认 delivery-manifest.json)",
    )
    parser.add_argument(
        "--segments-name",
        default="segments.csv",
        help="段落时间轴表文件名 (默认 segments.csv)",
    )
    parser.add_argument(
        "--report-name",
        default="report.md",
        help="Markdown 报告文件名 (默认 report.md)",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.block_frames <= 0:
        print("wav_sampler: --block-frames 必须为正整数", file=sys.stderr)
        return 2

    try:
        record = export(
            args.manifest,
            ExportConfig(
                output_dir=args.output_dir,
                block_frames=args.block_frames,
                overwrite=args.overwrite,
            ),
        )
    except ManifestError as exc:
        print(f"wav_sampler: 清单错误: {exc}", file=sys.stderr)
        return 2

    write_delivery_manifest(
        record, args.manifest, f"{args.output_dir}/{args.delivery_name}"
    )
    write_segment_csv(record, f"{args.output_dir}/{args.segments_name}")
    write_markdown_report(
        record, args.manifest, f"{args.output_dir}/{args.report_name}"
    )

    n_delivered = len(record.delivered)
    n_rejected = len(record.rejected)
    n_skipped = len(record.skipped)
    n_errors = sum(1 for d in record.diagnostics if d.level == "error")
    n_warnings = sum(1 for d in record.diagnostics if d.level == "warning")
    print(
        f"wav_sampler: 交付 {n_delivered} 个, 拒绝 {n_rejected} 个, "
        f"跳过 {n_skipped} 个; 诊断 error={n_errors} warning={n_warnings}"
    )
    print(f"wav_sampler: 报告已写入 {args.output_dir}/")

    # 仅当存在不合法产出 (拒绝或 error 诊断) 时返回非零;
    # skipped 是有意保护已有交付, 不算失败
    return 0 if n_rejected == 0 and n_errors == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
