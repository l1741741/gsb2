"""命令行入口的端到端测试。"""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

from srt_remap.cli import main
from srt_remap.srt_io import parse_srt


class TestCli(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        (self.tmp / "a.srt").write_text(
            "1\n00:00:01,000 --> 00:00:04,000\n你好\n", encoding="utf-8",
        )
        self.edl = self.tmp / "edl.json"
        self.edl.write_text(json.dumps({"clips": [{
            "material": "A", "srt": "a.srt",
            "src_in": 0, "src_out": 5, "dst_start": 0, "speed": 1.0,
        }]}), encoding="utf-8")
        self.out = self.tmp / "out"

    def tearDown(self):
        self._tmp.cleanup()

    def test_writes_three_artifacts(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = main([
                "--edl", str(self.edl), "-o", str(self.out),
                "--stem", "tl", "--mode", "trim",
            ])
        self.assertEqual(code, 0)
        for name in ("tl.srt", "tl.manifest.csv", "tl.report.json"):
            self.assertTrue((self.out / name).exists(), name)
        cues = parse_srt((self.out / "tl.srt").read_text(encoding="utf-8"))
        self.assertEqual(len(cues), 1)
        self.assertEqual(cues[0].text, "你好")

    def test_missing_file_exit_code_two(self):
        err = io.StringIO()
        with redirect_stderr(err):
            code = main(["--edl", str(self.tmp / "nope.json"),
                         "-o", str(self.out)])
        self.assertEqual(code, 2)
        self.assertIn("错误", err.getvalue())

    def test_keep_mode_conflict_exit_one(self):
        # 两份同轨重叠字幕 -> keep 模式报告冲突并以 1 退出，但文件仍写出
        (self.tmp / "b.srt").write_text(
            "1\n00:00:01,000 --> 00:00:03,000\nB\n", encoding="utf-8",
        )
        self.edl.write_text(json.dumps({"clips": [
            {"material": "A", "srt": "a.srt", "src_in": 0, "src_out": 5,
             "dst_start": 0, "speed": 1.0, "track": 0},
            {"material": "B", "srt": "b.srt", "src_in": 0, "src_out": 5,
             "dst_start": 1, "speed": 1.0, "track": 0},
        ]}), encoding="utf-8")
        with redirect_stdout(io.StringIO()):
            code = main(["--edl", str(self.edl), "-o", str(self.out),
                         "--mode", "keep"])
        self.assertEqual(code, 1)
        self.assertTrue((self.out / "timeline.srt").exists())


if __name__ == "__main__":
    unittest.main()
