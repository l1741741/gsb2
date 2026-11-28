"""srt_align 单元测试，运行: python -m unittest discover -s tests -v"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from srt_align import (  # noqa: E402
    AlignConfig,
    AnchorError,
    align,
    parse_anchor_file,
    parse_srt,
    resolve_anchors,
    write_srt,
)
from srt_align.engine import constrain_times  # noqa: E402
from srt_align.models import AlignmentGroup, Cue, IssueCode  # noqa: E402
from srt_align.srtio import format_time, normalize_order  # noqa: E402


def cue(pos, start, end, text="行", sequence=None):
    return Cue(sequence=sequence or pos, source_pos=pos,
               start=start, end=end, text=text)


class ParseTests(unittest.TestCase):
    def test_basic_and_independent_numbers(self):
        content = "1\n00:00:01,000 --> 00:00:02,000\n甲\n\n2\n00:00:03,000 --> 00:00:04,000\n乙\n"
        cues, issues = parse_srt(content)
        self.assertEqual(len(cues), 2)
        self.assertEqual([c.sequence for c in cues], [1, 2])
        self.assertEqual(cues[0].start, 1000)
        self.assertEqual(cues[0].end, 2000)
        self.assertEqual(issues, [])

    def test_crlf_bom_dot_separator_and_missing_sequence(self):
        content = "﻿1\r\n00:00:01.500 --> 00:00:02.000\r\n甲\r\n\r\n\r\n00:00:03,000 --> 00:00:04,000\r\n乙\r\n"
        cues, issues = parse_srt(content)
        self.assertEqual(cues[0].start, 1500)
        self.assertEqual(cues[1].sequence, 2)  # 缺序号回退为物理位置
        self.assertTrue(any(i.code == IssueCode.INVALID_BLOCK for i in issues))

    def test_hard_line_break_preserved(self):
        content = "1\n00:00:01,000 --> 00:00:03,000\n第一行\n第二行  \n"
        cues, _ = parse_srt(content)
        self.assertEqual(cues[0].text, "第一行\n第二行")

    def test_invalid_blocks_skipped(self):
        content = "1\n没有时间轴\n\n2\n00:00:01,000 --> 00:00:02,000\n正常\n"
        cues, issues = parse_srt(content)
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0].text, "正常")
        self.assertTrue(issues)

    def test_order_normalize_flags_reorder(self):
        cues = [cue(1, 5000, 6000), cue(2, 1000, 2000)]
        ordered, issues = normalize_order(cues, "translation")
        self.assertEqual([c.start for c in ordered], [1000, 5000])
        self.assertEqual(issues[0].code, IssueCode.ORDER_FIXED)

    def test_format_time_clamps_negative(self):
        self.assertEqual(format_time(0), "00:00:00,000")
        self.assertEqual(format_time(-5), "00:00:00,000")
        self.assertEqual(format_time(3_723_456), "01:02:03,456")


class AlignmentTests(unittest.TestCase):
    def test_one_to_many_split(self):
        # 原版一条长窗，译文拆成两条
        orig = [cue(1, 0, 4000, "original sentence")]
        trans = [cue(1, 0, 2000, "译 上"), cue(2, 2000, 4000, "译 下")]
        result = align(orig, trans)
        self.assertEqual(len(result.groups), 1)
        g = result.groups[0]
        self.assertEqual(len(g.original), 1)
        self.assertEqual(len(g.translation), 2)
        # 译文文字与手工换行原样保留
        self.assertEqual([c.text for c in g.translation], ["译 上", "译 下"])
        # 时间被约束在原版窗内且不重叠、保序
        self.assertEqual(g.timed[0][0], 0)
        self.assertEqual(g.timed[1][1], 4000)
        self.assertLessEqual(g.timed[0][1], g.timed[1][0])

    def test_many_to_one_merge(self):
        orig = [cue(1, 0, 2000), cue(2, 2000, 4000)]
        trans = [cue(1, 0, 4000, "合并的一句译文")]
        result = align(orig, trans)
        self.assertEqual(len(result.groups), 1)
        g = result.groups[0]
        self.assertEqual(len(g.original), 2)
        self.assertEqual(len(g.translation), 1)
        self.assertEqual(g.timed, [(0, 4000)])

    def test_missing_translation_line(self):
        # 原版 3 条，译文只有 2 条，中间那条缺行
        orig = [cue(1, 0, 1000), cue(2, 2000, 3000), cue(3, 4000, 5000)]
        trans = [cue(1, 0, 1000, "甲"), cue(2, 4000, 5000, "丙")]
        result = align(orig, trans)
        self.assertEqual([c.source_pos for c in result.unmatched_original], [2])
        self.assertEqual(result.unmatched_translation, [])
        matched_pos = {c.source_pos for g in result.groups for c in g.original}
        self.assertEqual(matched_pos, {1, 3})

    def test_orphan_translation_not_forced_into_neighbor(self):
        # 译文多出一条时间远离任何原版条目的孤立行
        orig = [cue(1, 0, 1000, "甲")]
        trans = [cue(1, 0, 1000, "译甲"),
                 cue(2, 90_000, 91_000, "不知来源的一句")]
        result = align(orig, trans, config=AlignConfig())
        self.assertEqual([c.source_pos for c in result.unmatched_translation], [2])
        # 孤立行没有被塞进任何组
        for group in result.groups:
            self.assertEqual(
                [c.source_pos for c in group.translation], [1]
            )

    def test_order_is_never_crossed(self):
        # 译文时间整体平移但顺序对应，DP 不得产生交叉匹配
        orig = [cue(i, i * 2000, i * 2000 + 1500, f"o{i}") for i in range(1, 5)]
        trans = [cue(i, i * 2000 + 300, i * 2000 + 1700, f"t{i}")
                 for i in range(1, 5)]
        result = align(orig, trans)
        pairs = [(g.original[0].source_pos, g.translation[0].source_pos)
                 for g in result.groups]
        self.assertEqual(pairs, [(1, 1), (2, 2), (3, 3), (4, 4)])

    def test_tight_span_warning(self):
        # 译文很长，原版窗极短 -> 挤不下警告
        orig = [cue(1, 0, 500, "hi")]
        trans = [cue(1, 0, 500, "字" * 40)]
        group = AlignmentGroup(original=orig, translation=trans)
        constrain_times(group, AlignConfig())
        self.assertTrue(
            any(i.code == IssueCode.TIGHT_SPAN for i in group.issues)
        )

    def test_tiny_window_split_never_emits_invalid_time(self):
        # 原版窗只有 2ms，译文拆成 3 条：物理上无法在窗内容纳，
        # 输出仍须是合法 SRT（正时长、不重叠），并由 tight_span 明确警告
        orig = [cue(1, 1000, 1002, "hi")]
        trans = [cue(i, 1000, 1002, f"t{i}") for i in range(1, 4)]
        result = align(orig, trans, config=AlignConfig(max_run=3))
        g = result.groups[0]
        self.assertEqual(len(g.timed), 3)
        for start, end in g.timed:
            self.assertGreater(end, start)
        for a, b in zip(g.timed, g.timed[1:]):
            self.assertLessEqual(a[1], b[0])
        self.assertTrue(
            any(i.code == IssueCode.TIGHT_SPAN for i in g.issues)
        )

    def test_output_srt_is_valid_and_renumbered(self):
        orig = [cue(1, 0, 4000)]
        trans = [cue(7, 0, 2000, "上\n下"), cue(8, 2000, 4000, "末")]
        result = align(orig, trans)
        text = write_srt(result.groups)
        blocks = [b for b in text.strip().split("\n\n")]
        self.assertEqual(len(blocks), 2)
        self.assertTrue(blocks[0].startswith("1\n"))
        self.assertTrue(blocks[1].startswith("2\n"))
        self.assertIn("上\n下", blocks[0])  # 手工换行保留
        # 毫秒使用逗号
        self.assertIn(",", blocks[0].splitlines()[1])


class AnchorTests(unittest.TestCase):
    def _cues(self):
        orig = [cue(i, i * 1000, i * 1000 + 900, f"o{i}") for i in range(1, 6)]
        trans = [cue(i, i * 1000, i * 1000 + 900, f"t{i}") for i in range(1, 6)]
        return orig, trans

    def test_anchor_forces_match_and_segments(self):
        orig, trans = self._cues()
        raw = parse_anchor_file("3 = 3\n")
        resolved = resolve_anchors(raw, orig, trans)
        result = align(orig, trans, resolved)
        anchored = [g for g in result.groups if g.anchored]
        self.assertEqual(len(anchored), 1)
        self.assertEqual(anchored[0].original[0].source_pos, 3)

    def test_conflicting_crossing_anchors_rejected(self):
        orig, trans = self._cues()
        # 原版侧 1..2 与 2..3 交叉
        raw = parse_anchor_file("1+2 = 1\n2+3 = 2\n")
        with self.assertRaises(AnchorError):
            resolve_anchors(raw, orig, trans)

    def test_duplicate_position_rejected(self):
        orig, trans = self._cues()
        raw = parse_anchor_file("1 = 1\n2 = 1\n")
        with self.assertRaises(AnchorError):
            resolve_anchors(raw, orig, trans)

    def test_reversed_anchor_rejected(self):
        orig, trans = self._cues()
        # 译文侧逆序：先 3 后 2
        raw = parse_anchor_file("1 = 3\n2 = 2\n")
        with self.assertRaises(AnchorError):
            resolve_anchors(raw, orig, trans)

    def test_temporal_crossing_after_order_normalize_rejected(self):
        # 译文文件错序：物理位置 2 的条目时间最晚。
        # 锚点按物理位置书写为 1=1、2=2，但时间序上译文 2 在最后，构成交叉。
        orig = [cue(i, i * 1000, i * 1000 + 900, f"o{i}") for i in range(1, 4)]
        trans = [cue(1, 1000, 1900, "t1"),
                 cue(2, 2000, 2900, "t2"),
                 cue(3, 0, 900, "t3")]
        trans, _ = normalize_order(trans, "translation")  # 时间序变为 3,1,2
        # 物理位置 1 < 3 单调，能过物理校验；但时间序中 pos1 在 pos3 之后
        raw = parse_anchor_file("1 = 1\n2 = 3\n")
        with self.assertRaises(AnchorError):
            resolve_anchors(raw, orig, trans)

    def test_out_of_range_rejected(self):
        orig, trans = self._cues()
        raw = parse_anchor_file("99 = 1\n")
        with self.assertRaises(AnchorError):
            resolve_anchors(raw, orig, trans)

    def test_bad_syntax_rejected(self):
        with self.assertRaises(AnchorError):
            parse_anchor_file("1 2\n")
        with self.assertRaises(AnchorError):
            parse_anchor_file("a = 1\n")

    def test_anchor_blocks_crossing_match(self):
        # 锚点强制 1->2，自动匹配不得让原版 2 跨回去配译文 1
        orig = [cue(1, 0, 1000), cue(2, 1000, 2000)]
        trans = [cue(1, 50_000, 51_000, "孤立行"),
                 cue(2, 0, 1000, "对应原版1")]
        raw = parse_anchor_file("1 = 2\n")
        resolved = resolve_anchors(raw, orig, trans)
        result = align(orig, trans, resolved)
        anchored_group = next(g for g in result.groups if g.anchored)
        self.assertEqual(
            ([c.source_pos for c in anchored_group.original],
             [c.source_pos for c in anchored_group.translation]),
            ([1], [2]),
        )
        # 译文 1 只能作为孤立行留在锚点区间外
        self.assertEqual(
            [c.source_pos for c in result.unmatched_translation], [1]
        )


if __name__ == "__main__":
    unittest.main()
