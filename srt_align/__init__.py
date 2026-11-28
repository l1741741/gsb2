"""离线 SRT 对齐工具。

把译文字幕的文字（含字幕员手工换行）保留下来，时间轴对齐到原版字幕，
支持少量拆句（一对多）、合句（多对一）、缺行与孤立行，不做翻译。
"""

from .models import Cue, Issue, AlignmentGroup, IssueCode
from .srtio import parse_srt, write_srt, normalize_order
from .anchors import AnchorError, parse_anchor_file, resolve_anchors
from .engine import align, AlignmentResult, AlignConfig

__all__ = [
    "Cue",
    "Issue",
    "AlignmentGroup",
    "IssueCode",
    "parse_srt",
    "write_srt",
    "normalize_order",
    "AnchorError",
    "parse_anchor_file",
    "resolve_anchors",
    "align",
    "AlignmentResult",
    "AlignConfig",
]
