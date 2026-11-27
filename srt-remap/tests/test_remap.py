"""重映射核心行为测试：相交裁剪、变速、复用、边界碰齐、轨道冲突。"""

import json
import tempfile
import unittest
from decimal import Decimal
from pathlib import Path

from srt_remap.edl import load_edit_list
from srt_remap.errors import RemapError
from srt_remap.remap import load_project, remap
from srt_remap.srt_io import parse_srt, write_srt


def _write_srt(directory: Path, name: str, cues):
    path = directory / name
    parsed = parse_srt("\n\n".join(
        f"{i}\n{a} --> {b}\n{text}" for i, (a, b, text) in enumerate(cues, 1)
    ))
    write_srt(path, parsed)
    return path


def _write_edl(directory: Path, clips):
    path = directory / "edl.json"
    path.write_text(json.dumps({"clips": clips}), encoding="utf-8")
    return path


def _clip(material, srt, src_in, src_out, dst_start, speed, track=0):
    return {
        "material": material, "srt": srt,
        "src_in": src_in, "src_out": src_out,
        "dst_start": dst_start, "speed": speed, "track": track,
    }


class RemapFixture(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        # 源字幕：#1 1-4s，#2 4-6s（跨 5s 切点），#3 8.5-12s，#4 15-17s
        self.srt_a = _write_srt(self.tmp, "a.srt", [
            ("00:00:01,000", "00:00:04,000", "一"),
            ("00:00:04,000", "00:00:06,000", "二"),
            ("00:00:08,500", "00:00:12,000", "三"),
            ("00:00:15,000", "00:00:17,000", "四"),
        ])
        self.srt_b = _write_srt(self.tmp, "b.srt", [
            ("00:00:00,500", "00:00:03,000", "B1"),
            ("00:00:03,000", "00:00:05,500", "B2"),
        ])

    def tearDown(self):
        self._tmp.cleanup()

    def _project(self, clips):
        edl = _write_edl(self.tmp, clips)
        return load_project(edl)


class TestIntersectionAndReuse(RemapFixture):
    def test_partial_intersection_keeps_only_overlap(self):
        # 片段只覆盖 cue#3 的前 1.5s（8.5-10s）
        project = self._project([
            _clip("A", "a.srt", 8.5, 10, 0, 1.0),
        ])
        result = remap(project)
        self.assertEqual(len(result.cues), 1)
        cue = result.cues[0]
        self.assertEqual((cue.start, cue.end), (0, 1500))
        self.assertEqual((cue.src_start, cue.src_end), (8500, 10000))
        self.assertEqual(cue.src_cue_index, 3)

    def test_same_source_cue_split_across_clips(self):
        # cue#2(4-6s) 被两个相邻片段在 5s 处切开，各自保留来源
        project = self._project([
            _clip("A", "a.srt", 0, 5, 0, 1.0),
            _clip("A", "a.srt", 5, 10, 5, 2.0),
        ])
        result = remap(project)
        pieces = [c for c in result.cues if c.src_cue_index == 2]
        self.assertEqual(len(pieces), 2)
        self.assertEqual([(p.start, p.end) for p in pieces],
                         [(4000, 5000), (5000, 5500)])
        # 两条成片字幕来源不同剪辑行，但指向同一源字幕
        self.assertEqual({p.line_no for p in pieces}, {1, 2})
        self.assertTrue(all(p.text == "二" for p in pieces))

    def test_same_srt_referenced_twice_loaded_once(self):
        project = self._project([
            _clip("A", "a.srt", 0, 2, 0, 1.0),
            _clip("A", "a.srt", 8.5, 10, 5, 1.0),
        ])
        self.assertEqual(len(project.subtitles), 1)
        result = remap(project)
        self.assertEqual([c.text for c in result.cues], ["一", "三"])

    def test_unreferenced_and_blank_regions_stay_empty(self):
        project = self._project([_clip("A", "a.srt", 0, 2, 10, 1.0)])
        result = remap(project)
        # 只有 cue#1 的一部分；0-10s 与片段外的 cue#3/#4 全部缺席
        self.assertEqual(len(result.cues), 1)
        self.assertEqual(result.cues[0].start, 11000)
        self.assertEqual(result.cues[0].end, 12000)


class TestSpeedAndRounding(RemapFixture):
    def test_speed_up_shrinks_duration(self):
        project = self._project([_clip("A", "a.srt", 1, 4, 0, 2.0)])
        result = remap(project)
        cue = result.cues[0]  # cue#1 完整落在片段内
        self.assertEqual((cue.start, cue.end), (0, 1500))  # 3s / 2
        self.assertEqual(cue.speed, Decimal("2"))

    def test_slow_motion_expands_duration(self):
        project = self._project([_clip("B", "b.srt", 0, 6, 8, 0.5)])
        result = remap(project)
        # cue B1: src 0.5-3 -> dst 8+(0.5..3)/0.5 = 9..14
        b1 = next(c for c in result.cues if c.text == "B1")
        self.assertEqual((b1.start, b1.end), (9000, 14000))

    def test_adjacent_clips_no_phantom_overlap_or_gap(self):
        # 两个紧邻片段共享源切点 5s 与成片切点 5s（第二个 2x）
        project = self._project([
            _clip("A", "a.srt", 0, 5, 0, 1.0),
            _clip("A", "a.srt", 5, 10, 5, 2.0),
        ])
        result = remap(project)
        ends = sorted((c.start, c.end) for c in result.cues)
        # 任意两条不得真重叠（半开区间，端点相碰允许）
        for (s1, e1), (s2, e2) in zip(ends, ends[1:]):
            self.assertLessEqual(e1, s2)
        # cue#2 两片必须在 5000ms 处严格相接
        pieces = sorted(
            (c for c in result.cues if c.src_cue_index == 2),
            key=lambda c: c.start,
        )
        self.assertEqual(pieces[0].end, pieces[1].start)
        self.assertEqual(pieces[0].end, 5000)
        self.assertEqual(result.conflicts, [])

    def test_sub_millisecond_intersection_dropped_not_zero_length(self):
        # 片段只覆盖 cue 开头 0.0004s，10x 后更短，舍入为零时长 -> 丢弃
        project = self._project([_clip("A", "a.srt", 1, 1.0004, 0, 10.0)])
        result = remap(project)
        self.assertEqual(result.cues, [])
        self.assertEqual(len(result.dropped), 1)
        self.assertIn("零时长", result.dropped[0].reason)
        # 定位信息完整
        self.assertEqual(result.dropped[0].line_no, 1)
        self.assertEqual(result.dropped[0].material, "A")


class TestConflicts(RemapFixture):
    def _overlap_project(self):
        # 低轨慢放 B：dst 8-20s；高轨 A：dst 17-20.5s，重叠 17-20s
        return self._project([
            _clip("B", "b.srt", 0, 6, 8, 0.5, track=0),
            _clip("A", "a.srt", 8.5, 12, 17, 1.0, track=1),
        ])

    def test_trim_cuts_higher_track_behind_lower(self):
        result = remap(self._overlap_project(), mode="trim")
        high = [c for c in result.cues if c.material == "A"]
        self.assertEqual(len(high), 1)
        # 17-19s 被低轨 B2 遮挡（B2 在 19s 结束），只剩 19-20.5s
        self.assertEqual((high[0].start, high[0].end), (19000, 20500))
        # 低轨字幕原样保留
        low = sorted((c.start, c.end) for c in result.cues if c.material == "B")
        self.assertEqual(low, [(9000, 14000), (14000, 19000)])
        self.assertTrue(any("裁剪" in w for w in result.warnings))

    def test_trim_drops_cue_fully_covered_by_lower_track(self):
        # 高轨片段成片区间完全落在低轨字幕覆盖内 -> 整条丢弃并记录
        project = self._project([
            _clip("B", "b.srt", 0, 6, 0, 1.0, track=0),   # dst 0-6s
            _clip("A", "a.srt", 1, 3, 1, 1.0, track=1),    # dst 1-3s 被全覆盖
        ])
        result = remap(project, mode="trim")
        self.assertEqual(
            [c.material for c in result.cues], ["B", "B"],
        )
        self.assertEqual(len(result.dropped), 1)
        self.assertIn("遮挡", result.dropped[0].reason)

    def test_keep_reports_conflict_and_keeps_all(self):
        result = remap(self._overlap_project(), mode="keep")
        high = [c for c in result.cues if c.material == "A"]
        self.assertEqual((high[0].start, high[0].end), (17000, 20500))
        self.assertEqual(len(result.conflicts), 1)
        conflict = result.conflicts[0]
        self.assertEqual((conflict.overlap_start, conflict.overlap_end),
                         (17000, 19000))
        self.assertIn("轨道 0 优先", conflict.reason)

    def test_same_track_overlap_cannot_be_trimmed(self):
        # 同轨两个片段在成片时间轴重叠，trim 也不能判优先级 -> 保留并报告
        project = self._project([
            _clip("A", "a.srt", 1, 4, 0, 1.0, track=0),
            _clip("B", "b.srt", 0.5, 3, 2, 1.0, track=0),
        ])
        result = remap(project, mode="trim")
        self.assertEqual(len(result.conflicts), 1)
        self.assertIn("相同", result.conflicts[0].reason)

    def test_touching_endpoints_are_not_conflicts(self):
        project = self._project([
            _clip("A", "a.srt", 0, 5, 0, 1.0),
            _clip("B", "b.srt", 0.5, 3, 5, 1.0),  # 紧接 5s
        ])
        result = remap(project)
        self.assertEqual(result.conflicts, [])


class TestErrorReporting(RemapFixture):
    def test_missing_srt_points_to_material_and_line(self):
        edl = _write_edl(self.tmp, [
            _clip("A", "nope/missing.srt", 0, 1, 0, 1.0),
        ])
        with self.assertRaises(RemapError) as ctx:
            load_project(edl)
        message = ctx.exception.describe()
        self.assertIn("第 1 行", message)
        self.assertIn("'A'", message)
        self.assertIn("missing.srt", message)

    def test_bad_speed_zero_and_negative(self):
        for bad in (0, -1, "abc"):
            with self.subTest(bad=bad):
                edl = _write_edl(self.tmp, [
                    _clip("A", "a.srt", 0, 1, 0, bad),
                ])
                with self.assertRaises(RemapError) as ctx:
                    load_edit_list(edl)
                message = ctx.exception.describe()
                self.assertIn("速度", message)
                self.assertIn("第 1 行", message)
                self.assertIn("'A'", message)

    def test_multiple_bad_lines_reported_together(self):
        # 两行都有问题时应一次全部指出，而不是只报第一个
        edl = _write_edl(self.tmp, [
            _clip("A", "a.srt", 5, 5, 0, 1.0),          # 源点倒挂
            _clip("B", "b.srt", 0, 6, 8, 0),              # 非法速度
        ])
        with self.assertRaises(RemapError) as ctx:
            load_edit_list(edl)
        message = ctx.exception.describe()
        self.assertIn("第 1 行", message)
        self.assertIn("第 2 行", message)
        self.assertIn("'A'", message)
        self.assertIn("'B'", message)

    def test_src_out_before_in(self):
        edl = _write_edl(self.tmp, [
            _clip("A", "a.srt", 5, 5, 0, 1.0),
        ])
        with self.assertRaises(RemapError) as ctx:
            load_edit_list(edl)
        self.assertIn("源出点必须晚于源入点", ctx.exception.describe())
        self.assertIn("第 1 行", ctx.exception.describe())

    def test_bad_time_value(self):
        edl = _write_edl(self.tmp, [
            _clip("A", "a.srt", "not-a-time", 5, 0, 1.0),
        ])
        with self.assertRaises(RemapError) as ctx:
            load_edit_list(edl)
        self.assertIn("src_in", ctx.exception.describe())

    def test_missing_field_names_line(self):
        edl = _write_edl(self.tmp, [{
            "material": "A", "srt": "a.srt",
            "src_in": 0, "src_out": 5, "dst_start": 0,
            # 缺 speed
        }])
        with self.assertRaises(RemapError) as ctx:
            load_edit_list(edl)
        message = ctx.exception.describe()
        self.assertIn("speed", message)
        self.assertIn("第 1 行", message)

    def test_bad_srt_timestamp_reports_cue(self):
        bad = self.tmp / "bad.srt"
        bad.write_text("1\n00:00:05,000 --> 00:00:01,000\n倒挂\n", encoding="utf-8")
        edl = _write_edl(self.tmp, [_clip("X", "bad.srt", 0, 10, 0, 1.0)])
        with self.assertRaises(RemapError) as ctx:
            load_project(edl)
        self.assertIn("X", ctx.exception.describe())


if __name__ == "__main__":
    unittest.main()
