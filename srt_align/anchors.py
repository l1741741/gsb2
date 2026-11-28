"""人工锚点：已确认的对应关系。

锚点文件为纯文本，每行一个对应关系，# 开头为注释，例如：

    # 原版位置 = 译文位置
    3 = 2
    5 = 4+5        # 原版第 5 条对应译文第 4、5 条（合句）
    7+8 = 6        # 原版第 7、8 条合到译文第 6 条（拆句的反方向）

位置指字幕在该 SRT 文件中的物理位置（1 基，即不依赖文件自带序号），
多个位置用 + 连接。锚点必须整体顺序一致：
- 任一侧被同一锚点重复引用、或锚点范围相互交叉，均拒绝；
- 自动匹配只能在相邻锚点切出的区间内进行，绝不跨过锚点。
"""

from __future__ import annotations

import re

from .models import Cue, Issue, IssueCode


class AnchorError(ValueError):
    """锚点文件无法使用：语法错误、越界或相互冲突。"""


def _parse_side(token: str, line_no: int, side_name: str) -> tuple[int, ...]:
    parts = [p.strip() for p in token.split("+") if p.strip()]
    if not parts:
        raise AnchorError(f"第 {line_no} 行{side_name}为空")
    positions = []
    for part in parts:
        if not part.isdigit():
            raise AnchorError(
                f"第 {line_no} 行{side_name}含非数字位置: {part!r}"
            )
        value = int(part)
        if value <= 0:
            raise AnchorError(f"第 {line_no} 行位置必须为正整数: {value}")
        positions.append(value)
    if len(set(positions)) != len(positions):
        raise AnchorError(f"第 {line_no} 行{side_name}存在重复位置: {token.strip()}")
    return tuple(positions)


def parse_anchor_file(content: str) -> list[tuple[tuple[int, ...], tuple[int, ...]]]:
    """解析锚点文本，返回 [(原版位置元组, 译文位置元组), ...]（按文件顺序）。"""
    anchors: list[tuple[tuple[int, ...], tuple[int, ...]]] = []
    for line_no, raw in enumerate(content.splitlines(), start=1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if "=" not in line:
            raise AnchorError(f"第 {line_no} 行缺少 '=' 分隔符: {raw.strip()!r}")
        left, right = line.split("=", 1)
        orig_pos = _parse_side(left, line_no, "原版侧")
        trans_pos = _parse_side(right, line_no, "译文侧")
        anchors.append((orig_pos, trans_pos))
    return anchors


def _check_monotonic(ranges: list[tuple[int, ...]], side_name: str) -> None:
    """每侧锚点范围必须严格递增且互不重叠。"""
    seen: set[int] = set()
    prev_max = 0
    for index, positions in enumerate(ranges, start=1):
        ordered = tuple(sorted(positions))
        for pos in ordered:
            if pos in seen:
                raise AnchorError(
                    f"{side_name}位置 {pos} 在多个锚点中被重复引用"
                )
            seen.add(pos)
        if min(ordered) <= prev_max:
            raise AnchorError(
                f"第 {index} 个锚点的{side_name}范围 {ordered} "
                f"与前一锚点交叉或逆序（此前已用到位置 {prev_max}）"
            )
        prev_max = max(ordered)


def resolve_anchors(
    raw_anchors: list[tuple[tuple[int, ...], tuple[int, ...]]],
    original: list[Cue],
    translation: list[Cue],
) -> list[tuple[list[Cue], list[Cue], Issue]]:
    """把物理位置解析成实际字幕条，并做全部冲突校验。

    返回 [(原版字幕条, 译文字幕条, 锚点问题), ...]，保持文件顺序。
    """
    if not raw_anchors:
        return []

    orig_ranges = [a[0] for a in raw_anchors]
    trans_ranges = [a[1] for a in raw_anchors]
    _check_monotonic(orig_ranges, "原版")
    _check_monotonic(trans_ranges, "译文")

    orig_by_pos = {cue.source_pos: cue for cue in original}
    trans_by_pos = {cue.source_pos: cue for cue in translation}

    # 先校验所有引用位置都存在
    for orig_pos, trans_pos in raw_anchors:
        for pos in orig_pos:
            if pos not in orig_by_pos:
                raise AnchorError(
                    f"锚点引用的原版位置 {pos} 超出原版字幕条数 "
                    f"（共 {len(original)} 条）"
                )
        for pos in trans_pos:
            if pos not in trans_by_pos:
                raise AnchorError(
                    f"锚点引用的译文位置 {pos} 超出译文字幕条数 "
                    f"（共 {len(translation)} 条）"
                )

    # 解析后两列表均为时间序；锚点引用的条目在时间序中也必须严格递增，
    # 否则与「时间先后不能被打乱」冲突（常见于错序输入引用了文件位置）。
    orig_index = {cue.source_pos: idx for idx, cue in enumerate(original)}
    trans_index = {cue.source_pos: idx for idx, cue in enumerate(translation)}
    prev_o = prev_t = -1
    for anchor_no, (orig_pos, trans_pos) in enumerate(raw_anchors, start=1):
        o_idx = max(orig_index[p] for p in orig_pos)
        t_idx = max(trans_index[p] for p in trans_pos)
        if o_idx <= prev_o or t_idx <= prev_t:
            raise AnchorError(
                f"第 {anchor_no} 个锚点与前一锚点在时间顺序上交叉或逆序；"
                "若输入文件本身错序，请按重排后的时间顺序书写锚点"
            )
        prev_o, prev_t = o_idx, t_idx

    resolved: list[tuple[list[Cue], list[Cue], Issue]] = []
    for orig_pos, trans_pos in raw_anchors:
        orig_cues = [orig_by_pos[p] for p in sorted(orig_pos)]
        trans_cues = [trans_by_pos[p] for p in sorted(trans_pos)]
        issue = Issue(
            IssueCode.ANCHOR_FORCED,
            "人工锚点强制对应，自动匹配不得跨越",
            refs=[c.label for c in orig_cues]
            + [c.label for c in trans_cues],
        )
        resolved.append((orig_cues, trans_cues, issue))
    return resolved
