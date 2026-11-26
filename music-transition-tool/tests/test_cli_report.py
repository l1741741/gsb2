import io
import json
import wave
import contextlib
import unittest
from pathlib import Path

from support import TOOL_ROOT, EXAMPLES, DemoProjectMixin  # noqa: F401
from mtp.cli import main
from mtp.report import build_report, report_markdown, report_csv


class TestReport(unittest.TestCase, DemoProjectMixin):
    @classmethod
    def setUpClass(cls):
        cls.setup_demo()
        cls.report = build_report(cls.tl, cls.registry)

    @classmethod
    def tearDownClass(cls):
        cls.teardown_demo()

    def test_report_has_actual_enter_exit_for_each_transition(self):
        by_id = {t["id"]: t for t in self.report["transitions"]}
        cf = by_id["t_garden_to_market"]
        self.assertEqual(cf["sync"]["sample"], 176400)
        self.assertEqual(cf["overlap"]["start_sample"], 165375)
        self.assertEqual(cf["overlap"]["end_sample_exclusive"], 187425)
        self.assertEqual(cf["overlap"]["length_samples"], 22050)
        # 进入/退出实际位置必须明确给出
        self.assertEqual(cf["incoming"]["actual_enter_sample"], 165375)
        self.assertEqual(cf["outgoing"]["actual_exit_sample_exclusive"], 187425)
        self.assertIn("both_effective", cf)
        self.assertGreater(cf["both_effective"]["length_samples"], 0)

        cut = by_id["t_market_to_harbor"]
        self.assertEqual(cut["mode"], "cut")
        self.assertEqual(cut["overlap"]["length_samples"], 0)
        self.assertEqual(cut["both_effective"]["length_samples"], 0)
        self.assertEqual(cut["sync"]["sample"], 352800)

    def test_preview_region_matches_timeline(self):
        for tr in self.tl.transitions:
            rec = next(t for t in self.report["transitions"] if t["id"] == tr.id)
            pv = rec["preview_region"]
            self.assertEqual(pv["start_sample"], tr.preview_start)
            self.assertEqual(pv["end_sample_exclusive"], tr.preview_end)

    def test_markdown_and_csv_render_positions(self):
        md = report_markdown(self.tl, self.registry)
        self.assertIn("t_garden_to_market", md)
        self.assertIn("176400", md)
        self.assertIn("实际进入", md)
        csv_text = report_csv(self.tl, self.registry)
        self.assertIn("sync_sample", csv_text.splitlines()[0])
        self.assertIn("t_market_to_harbor", csv_text)

    def test_json_is_serializable(self):
        json.dumps(self.report, ensure_ascii=False)


class TestCli(unittest.TestCase, DemoProjectMixin):
    @classmethod
    def setUpClass(cls):
        cls.setup_demo()

    @classmethod
    def tearDownClass(cls):
        cls.teardown_demo()

    def test_validate_example_project(self):
        rc = main(["validate", "--plan", str(self.plan_path)])
        self.assertEqual(rc, 0)

    def test_list_formats_to_files(self):
        for fmt, suffix in [("json", ".json"), ("md", ".md"), ("csv", ".csv")]:
            out = self.tmp / ("list" + suffix)
            rc = main([
                "list", "--plan", str(self.plan_path),
                "--format", fmt, "--out", str(out),
            ])
            self.assertEqual(rc, 0)
            self.assertTrue(out.exists() and out.stat().st_size > 100)

    def test_render_full_and_cue_and_verify(self):
        full = self.tmp / "full.wav"
        rc = main([
            "render", "--plan", str(self.plan_path),
            "--out", str(full), "--verify",
        ])
        self.assertEqual(rc, 0)
        with wave.open(str(full), "rb") as wf:
            self.assertEqual(wf.getnframes(), self.tl.total_samples)
            self.assertEqual(wf.getnchannels(), 2)

        cue = self.tmp / "cue.wav"
        rc = main([
            "render", "--plan", str(self.plan_path),
            "--only", "t_garden_to_market", "--out", str(cue), "--verify",
        ])
        self.assertEqual(rc, 0)
        with wave.open(str(cue), "rb") as wf:
            # t1 预听区间 [121275,231525)：2 拍预卷 + 1 拍重叠 + 2 拍后卷 = 5 拍
            self.assertEqual(wf.getnframes(), 5 * 22050)

    def test_strict_verify_passes(self):
        rc = main([
            "render", "--plan", str(self.plan_path),
            "--only", "t_harbor_to_garden", "--verify", "--strict-verify",
            "--out", str(self.tmp / "c.wav"),
        ])
        self.assertEqual(rc, 0)

    def test_missing_material_locates_transition(self):
        # 在临时合成工程里放一个“sting 要响 3 小节”的坏计划
        bad = {
            "assets": "assets.json",
            "sample_rate": 44100, "bpm": 120, "beats_per_bar": 4,
            "output": {"channels": 2},
            "end": {"bar": 6, "beat": 1},
            "program": [
                {"id": "g", "asset": "garden", "at": "1.1"},
                {"id": "s", "asset": "sting", "at": "2.1",
                 "transition": {"id": "t_g_to_s", "mode": "cut"}},
                {"id": "m", "asset": "market", "at": {"bar": 4, "beat": 1},
                 "transition": {"id": "t_sting_to_market", "mode": "cut"}},
            ],
        }
        bad_path = self.tmp / "bad.json"
        bad_path.write_text(json.dumps(bad), encoding="utf-8")
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = main(["render", "--plan", str(bad_path)])
        text = err.getvalue()
        self.assertEqual(rc, 2)
        self.assertIn("t_sting_to_market", text)
        self.assertIn("sting", text)
        self.assertIn("176400", text)

    def test_unknown_transition_id_exit_nonzero(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            rc = main([
                "render", "--plan", str(self.plan_path),
                "--only", "does_not_exist",
            ])
        self.assertEqual(rc, 2)
        self.assertIn("does_not_exist", err.getvalue())


if __name__ == "__main__":
    unittest.main()
