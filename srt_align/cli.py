"""命令行入口。

用法:
    python -m srt_align 原版.srt 译文.srt \
        --anchors anchors.txt --output aligned.srt \
        --report report.json [--text-report report.txt] [--strict]
"""

from __future__ import annotations

import argparse
import sys

from .anchors import AnchorError, parse_anchor_file, resolve_anchors
from .engine import AlignConfig, align
from .models import AlignmentGroup, IssueCode
from .report import render_text_report, write_json_report
from .srtio import normalize_order, parse_srt, write_srt


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m srt_align",
        description="离线 SRT 时间轴对齐：保留译文文字与手工换行，"
                    "把时间轴对齐到原版，支持少量拆句、合句、缺行与锚点。",
    )
    parser.add_argument("original", help="原版 SRT 路径（时间轴基准）")
    parser.add_argument("translation", help="译文 SRT 路径（文字与换行被保留）")
    parser.add_argument("--anchors", help="人工锚点文件，每行 '原版位置 = 译文位置'，"
                                          "多位置用 + 连接，# 开头为注释")
    parser.add_argument("--output", "-o", help="对齐后的 SRT 输出路径")
    parser.add_argument("--report", help="结构化 JSON 报告路径（每组来源与未匹配项）")
    parser.add_argument("--text-report", help="纯文本报告路径")
    parser.add_argument("--max-run", type=int, default=3,
                        help="单个组每侧最多消费的条目数（默认 3）")
    parser.add_argument("--drop-orphans", action="store_true",
                        help="输出 SRT 中剔除译文侧孤立行（默认保留并沿用其原时间）")
    parser.add_argument("--strict", action="store_true",
                        help="存在挤不下/未匹配等警告时以退出码 1 结束")
    return parser


def run(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)

    try:
        with open(args.original, "r", encoding="utf-8-sig") as handle:
            orig_cues, parse_issues_o = parse_srt(handle.read())
        with open(args.translation, "r", encoding="utf-8-sig") as handle:
            trans_cues, parse_issues_t = parse_srt(handle.read())
    except OSError as exc:
        print(f"读取失败: {exc}", file=sys.stderr)
        return 2

    orig_cues, order_issue_o = normalize_order(orig_cues, "original")
    trans_cues, order_issue_t = normalize_order(trans_cues, "translation")

    raw_anchors = []
    if args.anchors:
        try:
            with open(args.anchors, "r", encoding="utf-8-sig") as handle:
                raw_anchors = parse_anchor_file(handle.read())
        except OSError as exc:
            print(f"锚点文件读取失败: {exc}", file=sys.stderr)
            return 2
        except AnchorError as exc:
            print(f"锚点被拒绝: {exc}", file=sys.stderr)
            return 2

    try:
        resolved = resolve_anchors(raw_anchors, orig_cues, trans_cues)
    except AnchorError as exc:
        print(f"锚点冲突，已拒绝全部锚点并终止: {exc}", file=sys.stderr)
        return 2

    config = AlignConfig(max_run=args.max_run)
    result = align(orig_cues, trans_cues, resolved, config)
    result.issues = (parse_issues_o + parse_issues_t
                     + order_issue_o + order_issue_t + result.issues)

    # 组装输出 SRT：已对齐组 + 译文孤立行（沿用自身时间，保证不丢内容）
    output_groups = list(result.groups)
    if not args.drop_orphans:
        for cue in result.unmatched_translation:
            output_groups.append(AlignmentGroup(
                original=[], translation=[cue],
                timed=[(cue.start, cue.end)],
            ))
    srt_text = write_srt(output_groups)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            handle.write(srt_text)
    else:
        sys.stdout.write(srt_text)

    text_report = render_text_report(result)
    if args.text_report:
        with open(args.text_report, "w", encoding="utf-8") as handle:
            handle.write(text_report + "\n")
    else:
        print(text_report, file=sys.stderr)

    if args.report:
        write_json_report(result, args.report)

    severe = {IssueCode.TIGHT_SPAN, IssueCode.UNMATCHED_ORIG,
              IssueCode.UNMATCHED_TRANS, IssueCode.INVALID_BLOCK}
    has_severe = any(issue.code in severe for issue in result.issues)
    if args.strict and has_severe:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
