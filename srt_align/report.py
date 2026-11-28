"""对齐结果导出：每组来源字幕行、未匹配项与全部诊断。"""

from __future__ import annotations

import json

from .engine import AlignmentResult
from .srtio import format_time


def _cue_dict(cue, timed: tuple[int, int] | None = None) -> dict:
    data = {
        "ref": cue.label,
        "sequence": cue.sequence,
        "source_pos": cue.source_pos,
        "original_time": f"{format_time(cue.start)} --> {format_time(cue.end)}",
        "text": cue.text,
        "hard_line_breaks": cue.text.count("\n"),
    }
    if timed is not None:
        data["aligned_time"] = f"{format_time(timed[0])} --> {format_time(timed[1])}"
    return data


def build_report(result: AlignmentResult) -> dict:
    """生成可 json.dump 的结构化报告。"""
    return {
        "summary": {
            "group_count": len(result.groups),
            "matched_original": sum(len(g.original) for g in result.groups),
            "matched_translation": sum(len(g.translation) for g in result.groups),
            "unmatched_original": len(result.unmatched_original),
            "unmatched_translation": len(result.unmatched_translation),
            "warning_count": len(result.issues),
        },
        "groups": [
            {
                "index": idx,
                "anchored": group.anchored,
                "original_window": (
                    f"{format_time(group.orig_start)} --> "
                    f"{format_time(group.orig_end)}"
                ),
                "original": [_cue_dict(c) for c in group.original],
                "translation": [
                    _cue_dict(c, group.timed[i] if i < len(group.timed) else None)
                    for i, c in enumerate(group.translation)
                ],
                "issues": [issue.to_dict() for issue in group.issues],
            }
            for idx, group in enumerate(result.groups, start=1)
        ],
        "unmatched": {
            "original": [_cue_dict(c) for c in result.unmatched_original],
            "translation": [_cue_dict(c) for c in result.unmatched_translation],
        },
        "issues": [issue.to_dict() for issue in result.issues],
    }


def render_text_report(result: AlignmentResult) -> str:
    """生成适合终端查看的纯文本报告。"""
    lines: list[str] = []
    lines.append("=" * 68)
    lines.append("SRT 对齐报告")
    lines.append("=" * 68)
    for idx, group in enumerate(result.groups, start=1):
        tag = " [锚点]" if group.anchored else ""
        lines.append(
            f"组 {idx}{tag}  原版窗 {format_time(group.orig_start)} --> "
            f"{format_time(group.orig_end)}"
        )
        for cue in group.original:
            lines.append(f"    原版 {cue.label}  {cue.text!r}")
        for cue, timed in zip(group.translation, group.timed):
            lines.append(
                f"    译文 {cue.label}  "
                f"[{format_time(timed[0])} --> {format_time(timed[1])}]  "
                f"{cue.text!r}"
            )
        for issue in group.issues:
            lines.append(f"    ! [{issue.code}] {issue.message}")
        lines.append("-" * 68)

    if result.unmatched_original:
        lines.append("未匹配的原版条目（译文缺行）:")
        for cue in result.unmatched_original:
            lines.append(f"    {cue.label}  {cue.text!r}")
    if result.unmatched_translation:
        lines.append("未匹配的译文条目（孤立行，未并入相邻组）:")
        for cue in result.unmatched_translation:
            lines.append(f"    {cue.label}  {cue.text!r}")

    flat = [i for i in result.issues if i.code not in ("anchor_forced",)]
    if flat:
        lines.append("-" * 68)
        lines.append("全部诊断:")
        for issue in flat:
            lines.append(f"  [{issue.code}] {issue.message}")
    lines.append("=" * 68)
    return "\n".join(lines)


def write_json_report(result: AlignmentResult, path: str) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(build_report(result), handle, ensure_ascii=False, indent=2)
        handle.write("\n")
