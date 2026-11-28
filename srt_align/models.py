"""核心数据模型。"""

from __future__ import annotations

from dataclasses import dataclass, field


class IssueCode:
    """诊断信息类型常量。"""

    ORDER_FIXED = "order_fixed"          # 输入文件中存在错序，已按开始时间重排
    INVALID_BLOCK = "invalid_block"      # 无法解析的 SRT 块
    EMPTY_TEXT = "empty_text"            # 字幕正文为空
    UNMATCHED_ORIG = "unmatched_original"   # 原版有、译文缺
    UNMATCHED_TRANS = "unmatched_translation"  # 译文多出的孤立行
    TIGHT_SPAN = "tight_span"            # 译文组在原版时间窗内确实挤不下
    CPS_HIGH = "cps_high"                # 字符速率过高（可读性警告）
    ANCHOR_FORCED = "anchor_forced"      # 该组由人工锚点强制对应


@dataclass
class Cue:
    """一条字幕。

    sequence  : SRT 文件里写的序号（缺失或非法时回退为文件中的位置序号）
    source_pos: 该条在文件中的 1 基物理位置，重排后仍稳定，锚点按它引用
    start/end : 毫秒
    text      : 字幕正文，保留内部手工换行（\\n），去掉首尾空行
    """

    sequence: int
    source_pos: int
    start: int
    end: int
    text: str

    @property
    def label(self) -> str:
        """用于报告的稳定引用标签。"""
        return f"#{self.source_pos}(序号{self.sequence})"


@dataclass
class Issue:
    """一条诊断/警告。"""

    code: str
    message: str
    side: str = ""          # "original" / "translation" / "output" / ""
    refs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"code": self.code, "side": self.side,
                "refs": list(self.refs), "message": self.message}


@dataclass
class AlignmentGroup:
    """一组已确认的对应关系：若干原版条 ↔ 若干译文条。"""

    original: list[Cue]
    translation: list[Cue]
    anchored: bool = False
    issues: list[Issue] = field(default_factory=list)
    # 应用原版时间约束后，译文侧每条的 (start, end)，毫秒
    timed: list[tuple[int, int]] = field(default_factory=list)

    @property
    def orig_start(self) -> int:
        return min(c.start for c in self.original)

    @property
    def orig_end(self) -> int:
        return max(c.end for c in self.original)

    def orig_refs(self) -> list[str]:
        return [c.label for c in self.original]

    def trans_refs(self) -> list[str]:
        return [c.label for c in self.translation]
