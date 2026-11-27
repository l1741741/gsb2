"""End-to-end tests for the command line: scan writes the three reports and
does not modify any source file; bad files are reported, not fatal."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class CliTests(unittest.TestCase):
    def _run(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "photocatalog", *args],
            cwd=ROOT, capture_output=True, text=True, timeout=120,
            env={**os.environ, "PYTHONPATH": ROOT},
        )

    def test_scan_writes_reports_and_keeps_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = os.path.join(tmp, "photos")
            os.makedirs(root)
            a = helpers.gradient(40, 30, box=(8, 6, 26, 22))
            helpers.write_png(a, os.path.join(root, "a.png"))
            helpers.write_png(helpers.tint(a, 8, 0, 0), os.path.join(root, "b.png"))
            with open(os.path.join(root, "broken.jpg"), "wb") as fh:
                fh.write(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00")  # no scan
            before = sorted(os.listdir(root))

            out = os.path.join(tmp, "out")
            proc = self._run("scan", root, "-o", out, "--no-external")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            for name in ("report.html", "report.md", "report.json"):
                self.assertTrue(os.path.exists(os.path.join(out, name)), name)
            # Source files are untouched.
            self.assertEqual(sorted(os.listdir(root)), before)
            with open(os.path.join(out, "report.json"), encoding="utf-8") as fh:
                payload = json.load(fh)
            errors = [f for f in payload["files"] if f["error"]]
            self.assertEqual(len(errors), 1)
            self.assertTrue(errors[0]["path"].endswith("broken.jpg"))

    def test_decide_and_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            a = os.path.join(tmp, "a.png")
            b = os.path.join(tmp, "b.png")
            helpers.write_png(helpers.gradient(20, 16), a)
            helpers.write_png(helpers.gradient(20, 16, seed=3), b)
            state = os.path.join(tmp, "decisions.json")
            proc = self._run("decide", state, a, b, "--merge", "--note", "same shot")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            proc = self._run("list", state)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertIn("合并", proc.stdout)
            with open(state, encoding="utf-8") as fh:
                saved = json.load(fh)
            self.assertEqual(len(saved["decisions"]), 1)


if __name__ == "__main__":
    unittest.main()
