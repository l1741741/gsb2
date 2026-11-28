#!/usr/bin/env python3
"""离线自验：生成合成小视频 → 跑完整巡检 → 断言关键行为。

用法：
    python3 tests/run_selftest.py [临时目录]

不依赖 pytest，全部使用标准库 unittest；所有生成物落在临时目录，
不读取、不修改任何既有素材。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aspect_inspector.analysis import (  # noqa: E402
    FrameClass, analyze_window, classify_frame,
)
from aspect_inspector.compare import DiffType  # noqa: E402
from aspect_inspector.ffmpeg_runner import extract_gray_frames  # noqa: E402
from aspect_inspector.inspector import WindowSpec, run_inspection  # noqa: E402
from aspect_inspector.probe import probe_video  # noqa: E402
from aspect_inspector.report import write_html, write_json  # noqa: E402
from aspect_inspector.synth_fixtures import generate_all  # noqa: E402

TMP_ROOT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    tempfile.mkdtemp(prefix="aspect_inspector_selftest_"))
FIXTURE_DIR = TMP_ROOT / "fixtures"
REPORT_DIR = TMP_ROOT / "reports"


class SelftestBase(unittest.TestCase):
    fixtures: dict = {}

    @classmethod
    def setUpClass(cls) -> None:
        if not shutil.which("ffmpeg"):
            raise unittest.SkipTest("本机没有 ffmpeg，跳过自验")
        FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
        cls.fixtures = generate_all(str(FIXTURE_DIR))

    def _inspect(self, scene: str, windows: list[WindowSpec],
                 deliver_key: str = "faithful"):
        fx = self.fixtures[scene]
        deliver = getattr(fx, deliver_key)
        out = REPORT_DIR / f"{scene}_{deliver_key}"
        bundle = run_inspection(
            fx.master, deliver, windows, str(out),
            sample_fps=10.0, analysis_width=480,
        )
        write_json(bundle, str(out / "report.json"))
        write_html(bundle, str(out / "report.html"))
        return bundle, out


class TestConstantBars(SelftestBase):
    """需求 5：恒定边框；需求 2：淡入淡出与黑边文字不污染结论。"""

    def test_faithful_match(self) -> None:
        bundle, out = self._inspect(
            "constant_bars", [WindowSpec("w1", 0.5, 5.5)])
        cmp_ = bundle.comparisons[0]
        self.assertEqual(cmp_.diff_type, DiffType.MATCH,
                         f"忠实转码应判一致，实际 {cmp_.diff_type}: {cmp_.notes}")
        self.assertTrue(cmp_.confirmed)
        # 母版边界应稳定为单段，内容宽约 2/3（640/960）
        m = bundle.windows[0]
        self.assertEqual(len(m.segments), 1)
        wf = m.segments[0].width_fraction
        self.assertAlmostEqual(wf, 640 / 960, delta=0.04,
                               msg=f"内容宽度占比异常: {wf}")
        # 黑边文字不能把 x0 撑到 0 附近
        x0 = m.summary_bbox_norm[0]
        self.assertGreater(x0, 0.10, f"黑边文字污染了左边界: x0={x0}")
        # 淡入淡出帧存在，但黑帧数不应失控
        self.assertGreaterEqual(m.content_count, m.black_count)

    def test_widened_is_diff_with_screenshot(self) -> None:
        bundle, out = self._inspect(
            "constant_bars", [WindowSpec("w1", 0.5, 5.5)],
            deliver_key="widened")
        cmp_ = bundle.comparisons[0]
        self.assertEqual(cmp_.diff_type, DiffType.BOUNDS_DIFF)
        self.assertTrue(cmp_.confirmed)
        self.assertIsNotNone(cmp_.screenshot)
        shot = out / cmp_.screenshot
        self.assertTrue(shot.exists() and shot.stat().st_size > 0)

    def test_fade_frames_classified_content(self) -> None:
        """淡入过程中的暗帧仍应判为内容帧而非黑帧。"""
        info = probe_video(self.fixtures["constant_bars"].master)
        frames, _ = extract_gray_frames(info, 0.0, 1.0, 10.0)
        classes = [classify_frame(f).kind for f in frames]
        # 0.5s 淡入：前几帧黑、之后必须恢复为内容帧
        self.assertIn(FrameClass.CONTENT, classes)
        self.assertEqual(classes[-1], FrameClass.CONTENT)


class TestAspectSwitch(SelftestBase):
    """需求 3：持续的画幅变化要能检出。"""

    def test_switch_detected_in_master(self) -> None:
        bundle, _ = self._inspect(
            "aspect_switch", [WindowSpec("w1", 0.2, 5.8)])
        m = bundle.windows[0]
        self.assertGreaterEqual(len(m.segments), 2,
                                "母版片中画幅切换应分出 >=2 段")
        widths = sorted(round(s.width_fraction, 2) for s in m.segments)
        # 640/960 ≈ 0.67 与 960/960 = 1.0 两种内容宽度
        self.assertLess(widths[0], 0.75)
        self.assertGreater(widths[-1], 0.95)

    def test_faithful_preserves_switch(self) -> None:
        bundle, _ = self._inspect(
            "aspect_switch", [WindowSpec("w1", 0.2, 5.8)])
        cmp_ = bundle.comparisons[0]
        self.assertEqual(cmp_.diff_type, DiffType.ASPECT_SWITCH)
        self.assertTrue(cmp_.confirmed)

    def test_widened_persistent_diff(self) -> None:
        # 交付版全程 pillarbox：后半段母版全屏而交付版有黑边
        bundle, out = self._inspect(
            "aspect_switch", [WindowSpec("w1", 0.2, 5.8)],
            deliver_key="widened")
        cmp_ = bundle.comparisons[0]
        self.assertIn(cmp_.diff_type,
                      (DiffType.BOUNDS_DIFF, DiffType.ASPECT_SWITCH))
        self.assertTrue(cmp_.confirmed)
        self.assertIsNotNone(cmp_.screenshot)


class TestAllBlack(SelftestBase):
    """需求 2/3：全黑窗不报错；孤立黑帧不带偏整段；证据不足标待确认。"""

    def test_pure_black_window(self) -> None:
        # 合成素材结构：0-1.5s 黑场 / 1.5-4.5s 内容 / 4.5-5.5s 全黑 / 5.5-7.5s 内容
        bundle, _ = self._inspect(
            "all_black", [WindowSpec("dark", 4.7, 5.3)])
        cmp_ = bundle.comparisons[0]
        self.assertEqual(cmp_.diff_type, DiffType.ALL_BLACK)
        self.assertTrue(cmp_.confirmed)
        self.assertIsNone(cmp_.screenshot)

    def test_content_window_with_black_frames_stable(self) -> None:
        # 窗覆盖片头黑场 + 内容（含约 3.5s 处的孤立黑帧）
        bundle, _ = self._inspect(
            "all_black", [WindowSpec("w1", 0.3, 4.2)])
        m = bundle.windows[0]
        # 内容边界应是接近全屏的单段，孤立黑帧不产生新段
        self.assertEqual(len(m.segments), 1)
        self.assertGreater(m.segments[0].width_fraction, 0.95)
        self.assertGreater(m.black_count, 0)

    def test_short_window_pending(self) -> None:
        # 0.15s 的窗在 10fps 下只有 1~2 帧，证据不足必须待确认。
        # 取在全黑段内：双方都几乎无采样，应判待确认而非确定结论
        bundle, _ = self._inspect(
            "all_black", [WindowSpec("tiny", 4.8, 4.95)])
        cmp_ = bundle.comparisons[0]
        self.assertEqual(cmp_.diff_type, DiffType.INSUFFICIENT)
        self.assertFalse(cmp_.confirmed)


class TestRotationAndSAR(SelftestBase):
    """需求 1：旋转与非方形像素反映到显示坐标。"""

    def test_probe_metadata(self) -> None:
        info = probe_video(self.fixtures["rotated_sar"].master)
        self.assertEqual(info.rotation, 90)
        self.assertNotEqual(info.sar, 1)
        # 旋转后显示坐标应为竖屏（高 > 宽）
        self.assertGreater(info.display_height, info.display_width)

    def test_decoded_frames_are_display_oriented(self) -> None:
        info = probe_video(self.fixtures["rotated_sar"].master)
        frames, _ = extract_gray_frames(info, 0.2, 1.0, 10.0)
        self.assertTrue(frames)
        # 显示坐标竖屏：高 > 宽
        self.assertGreater(frames[0].height, frames[0].width)

    def test_faithful_match_after_geometry_normalize(self) -> None:
        bundle, _ = self._inspect(
            "rotated_sar", [WindowSpec("w1", 0.2, 3.8)])
        cmp_ = bundle.comparisons[0]
        self.assertEqual(cmp_.diff_type, DiffType.MATCH,
                         f"旋转/SAR 归一化后应可比: {cmp_.notes}")

    def test_widened_geometry_issue(self) -> None:
        bundle, _ = self._inspect(
            "rotated_sar", [WindowSpec("w1", 0.2, 3.8)],
            deliver_key="widened")
        self.assertTrue(bundle.geometry_issues)
        self.assertIn(bundle.comparisons[0].diff_type,
                      (DiffType.BOUNDS_DIFF, DiffType.GEOMETRY_MISMATCH,
                       DiffType.ASPECT_SWITCH, DiffType.INSUFFICIENT))


class TestBlackFrameUnit(unittest.TestCase):
    """不依赖视频文件的纯算法单测：合成字节帧。"""

    @staticmethod
    def _frame(width: int, height: int, fill: int,
               box: tuple[int, int, int, int] | None = None,
               thin_line: tuple[int, int, int, int] | None = None):
        from aspect_inspector.ffmpeg_runner import RawFrame
        data = bytearray([fill]) * (width * height)
        if box:
            x0, y0, x1, y1 = box
            for y in range(y0, y1):
                for x in range(x0, x1):
                    data[y * width + x] = 200
        if thin_line:
            x0, y0, x1, y1 = thin_line
            for y in range(y0, y1):
                for x in range(x0, x1):
                    data[y * width + x] = 230
        return RawFrame(0, 0.0, width, height, bytes(data))

    def test_pure_black(self) -> None:
        r = classify_frame(self._frame(120, 90, 0))
        self.assertEqual(r.kind, FrameClass.BLACK)
        self.assertIsNone(r.bbox_norm)

    def test_content_box(self) -> None:
        r = classify_frame(self._frame(120, 90, 0, box=(30, 20, 90, 70)))
        self.assertEqual(r.kind, FrameClass.CONTENT)
        x0, y0, x1, y1 = r.bbox_norm
        self.assertAlmostEqual(x0, 30 / 120, delta=0.02)
        self.assertAlmostEqual(x1, 90 / 120, delta=0.02)

    def test_thin_text_on_black_bar_ignored(self) -> None:
        # 整帧黑，仅顶部一条 2px 高的细亮线（模拟黑边文字）
        r = classify_frame(self._frame(
            120, 90, 0, thin_line=(10, 2, 60, 4)))
        self.assertEqual(r.kind, FrameClass.BLACK,
                         "黑边上的少量文字不应被判为内容")

    def test_dark_fade_frame_kept(self) -> None:
        # 暗场：整帧 18 灰 + 一块 40 灰的内容（模拟淡入过程中的暗帧）
        data = bytearray([18]) * (120 * 90)
        for y in range(15, 75):
            for x in range(20, 100):
                data[y * 120 + x] = 40
        from aspect_inspector.ffmpeg_runner import RawFrame
        dark = RawFrame(0, 0.0, 120, 90, bytes(data))
        r = classify_frame(dark)
        self.assertEqual(r.kind, FrameClass.CONTENT)


class TestReportArtifacts(SelftestBase):
    """需求 4：报告与截图产物完整、可离线打开、可定位回原片。"""

    def test_report_files(self) -> None:
        bundle, out = self._inspect(
            "constant_bars",
            [WindowSpec("w1", 0.5, 2.0), WindowSpec("w2", 2.0, 5.5)],
            deliver_key="widened")
        html_path = out / "report.html"
        json_path = out / "report.json"
        self.assertTrue(html_path.exists() and json_path.exists())
        payload = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertEqual(len(payload["windows"]), 2)
        # HTML 不引用任何外部网络资源
        text = html_path.read_text(encoding="utf-8")
        self.assertNotIn("http://", text)
        self.assertNotIn("https://", text)
        # JSON 里保留了源片绝对路径，可从时间窗定位回原片
        self.assertTrue(Path(payload["master"]["path"]).exists())
        self.assertTrue(Path(payload["deliver"]["path"]).exists())
        for w in payload["windows"]:
            if w["comparison"]["screenshot"]:
                self.assertTrue((out / w["comparison"]["screenshot"]).exists())


if __name__ == "__main__":
    print(f"自验临时目录: {TMP_ROOT}")
    TMP_ROOT.mkdir(parents=True, exist_ok=True)
    unittest.main(verbosity=2, argv=[sys.argv[0]])
