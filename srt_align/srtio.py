"""SRT 解析与写出。

解析侧容错：
- UTF-8 BOM、CRLF / LF 混用
- 毫秒分隔符为逗号（标准）或点（常见非标准写法）
- 序号行缺失或不是数字（按物理位置回退）
- 各文件自带独立序号，解析结果只按物理位置/时间轴使用
写出侧保证合法 SRT：连续序号、毫秒逗号、时间格式 HH:MM:SS,mmm。
"""

from __future__ import annotations

import re

from .models import Cue, Issue, IssueCode

_TIME_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)


class SRTParseError(ValueError):
    """整个文件无法作为 SRT 读取（一个可解析块都没有）。"""


def parse_time(value: str) -> int:
    """把 SRT 时间码转成毫秒。"""
    h1, m1, s1, ms1, h2, m2, s2, ms2 = _TIME_RE.match(value.strip()).groups()
    start = (int(h1) * 3600 + int(m1) * 60 + int(s1)) * 1000 + int(ms1.ljust(3, "0"))
    end = (int(h2) * 3600 + int(m2) * 60 + int(s2)) * 1000 + int(ms2.ljust(3, "0"))
    return start, end


def format_time(value_ms: int) -> str:
    """毫秒转 SRT 时间码，负数向上钳到 0。"""
    if value_ms < 0:
        value_ms = 0
    h, rem = divmod(value_ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def parse_srt(content: str) -> tuple[list[Cue], list[Issue]]:
    """解析 SRT 文本，返回 (字幕条列表, 解析期问题)。

    列表保持文件中的物理顺序；错序修正交给 normalize_order。
    """
    if content and content.startswith("﻿"):
        content = content[1:]
    content = content.replace("\r\n", "\n").replace("\r", "\n")

    issues: list[Issue] = []
    cues: list[Cue] = []
    blocks = [b for b in re.split(r"\n[ \t]*\n", content.strip("\n")) if b.strip()]

    for pos, raw_block in enumerate(blocks, start=1):
        block = raw_block.strip("\n")
        lines = block.split("\n")
        time_idx = next(
            (i for i, line in enumerate(lines) if "-->" in line), None
        )
        if time_idx is None:
            issues.append(Issue(
                IssueCode.INVALID_BLOCK,
                f"第 {pos} 个块缺少时间轴，已跳过",
                refs=[f"物理位置{pos}"],
            ))
            continue

        try:
            start, end = parse_time(lines[time_idx])
        except (AttributeError, ValueError):
            issues.append(Issue(
                IssueCode.INVALID_BLOCK,
                f"第 {pos} 个块时间轴无法解析，已跳过",
                refs=[f"物理位置{pos}"],
            ))
            continue
        if end < start:
            issues.append(Issue(
                IssueCode.INVALID_BLOCK,
                f"第 {pos} 个块结束时间早于开始时间，已跳过",
                refs=[f"物理位置{pos}"],
            ))
            continue

        header = lines[time_idx - 1].strip() if time_idx >= 1 else ""
        if header.isdigit():
            sequence = int(header)
        else:
            sequence = pos
            if header:
                issues.append(Issue(
                    IssueCode.INVALID_BLOCK,
                    f"第 {pos} 个块序号行非数字（{header!r}），回退为位置序号",
                    refs=[f"物理位置{pos}"],
                ))
            else:
                issues.append(Issue(
                    IssueCode.INVALID_BLOCK,
                    f"第 {pos} 个块缺少序号行，回退为位置序号",
                    refs=[f"物理位置{pos}"],
                ))

        text = "\n".join(lines[time_idx + 1:]).strip("\n").rstrip()
        # 去掉每行尾部空白，保留字幕员手工的中间换行
        text = "\n".join(line.rstrip() for line in text.split("\n"))
        if not text:
            issues.append(Issue(
                IssueCode.EMPTY_TEXT,
                f"第 {pos} 个块正文为空",
                refs=[f"物理位置{pos}"],
            ))

        cues.append(Cue(sequence=sequence, source_pos=pos,
                        start=start, end=end, text=text))

    if not cues:
        raise SRTParseError("文件中没有可解析的字幕块")
    return cues, issues


def normalize_order(cues: list[Cue], side: str) -> tuple[list[Cue], list[Issue]]:
    """按开始时间稳定排序；若文件本身错序则给出警告（顺序不被静默改写）。"""
    ordered = sorted(enumerate(cues), key=lambda pair: (pair[1].start, pair[0]))
    sorted_cues = [cue for _, cue in ordered]
    if sorted_cues == cues:
        return list(cues), []
    moved = [cue.label for cue, original in
             zip(sorted_cues, cues) if cue is not original]
    issue = Issue(
        IssueCode.ORDER_FIXED,
        "输入字幕存在错序，已按开始时间重排后再对齐；涉及条目: "
        + ", ".join(moved),
        side=side,
        refs=moved,
    )
    return sorted_cues, [issue]


def write_srt(groups: list["AlignmentGroupLike"]) -> str:  # noqa: F821
    """按组写出合法 SRT。

    每个 AlignmentGroup 的 timed 与 translation 等长，逐条输出；
    孤立译文（未匹配项）由调用方构造成同样结构传入。
    输出前按开始时间稳定排序并重新连续编号。
    """
    entries: list[tuple[int, int, str]] = []
    for group in groups:
        for cue, (start, end) in zip(group.translation, group.timed):
            entries.append((start, end, cue.text))

    entries.sort(key=lambda item: item[0])
    parts = []
    for index, (start, end, text) in enumerate(entries, start=1):
        parts.append(
            f"{index}\n{format_time(start)} --> {format_time(end)}\n{text}\n"
        )
    return "\n".join(parts)
