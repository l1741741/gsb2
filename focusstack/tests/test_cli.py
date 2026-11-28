"""Command-line end-to-end tests.

These run the real CLI in a subprocess so argument parsing, file naming and
exit codes are covered, not just the library functions.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PACKAGE_PARENT = ROOT


def run_cli(*args, cwd=None):
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(PACKAGE_PARENT)
    environment.pop("PYTHONPYCACHEPREFIX", None)
    return subprocess.run(
        [sys.executable, "-m", "focusstack", *args],
        cwd=str(cwd or ROOT),
        env=environment,
        text=True,
        capture_output=True,
    )


class CliTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="focusstack-cli-")
        cls.sample_dir = Path(cls.tmp) / "samples"
        result = run_cli("samples", "--out", str(cls.sample_dir))
        assert result.returncode == 0, result.stderr
        cls.photos = [str(cls.sample_dir / name) for name in
                      ("01-near.png", "02-mid.png", "03-far.png", "04-near-moved.png")]

    def test_samples_are_reproducible(self):
        other = Path(self.tmp) / "samples-again"
        result = run_cli("samples", "--out", str(other))
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("01-near.png", "02-mid.png", "03-far.png", "04-near-moved.png", "edits.json"):
            self.assertEqual(
                (self.sample_dir / name).read_bytes(), (other / name).read_bytes(),
                "%s is not reproducible" % name,
            )

    def test_stack_writes_bundle(self):
        out = Path(self.tmp) / "bundle"
        result = run_cli("stack", "--out", str(out), *self.photos)
        self.assertEqual(result.returncode, 0, result.stderr)
        for name in ("composite.png", "sources.png", "seams.png", "review-overlay.png", "review.json"):
            self.assertTrue((out / name).exists(), name)
        document = json.loads((out / "review.json").read_text())
        self.assertEqual(document["canvas"], {"width": 360, "height": 270})
        self.assertIn("regions", document)
        self.assertIn("reasons_legend", document)
        self.assertEqual(document["usage"]["uncovered"], 0)

    def test_inspect_prints_json_without_files(self):
        result = run_cli("inspect", "--out", str(Path(self.tmp) / "unused-out"), *self.photos)
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertIn("regions", payload)
        self.assertIn("usage", payload)
        self.assertFalse((Path(self.tmp) / "unused-out").exists())

    def test_edits_are_reported_and_applied(self):
        out = Path(self.tmp) / "edited"
        result = run_cli("stack", "--out", str(out), "--edits",
                         str(self.sample_dir / "edits.json"), *self.photos)
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads((out / "review.json").read_text())
        self.assertEqual(len(document["manual_edits"]), 1)
        record = document["manual_edits"][0]
        self.assertEqual(record["id"], "moved-part")
        self.assertGreater(record["painted"], 0)
        self.assertEqual(record["in_window"], record["painted"])

    def test_window_export_matches_full_export(self):
        full = Path(self.tmp) / "full-out"
        block = Path(self.tmp) / "block-out"
        self.assertEqual(run_cli("stack", "--out", str(full), *self.photos).returncode, 0)
        self.assertEqual(run_cli("stack", "--out", str(block), "--window", "110,160,90,80",
                                 *self.photos).returncode, 0)
        from focusstack.pngio import read_png
        full_image = read_png(full / "composite.png")
        block_image = read_png(block / "composite.png")
        self.assertEqual((block_image.width, block_image.height), (90, 80))
        for y in range(80):
            for x in range(90):
                self.assertEqual(full_image.pixel(110 + x, 160 + y), block_image.pixel(x, y))

    def test_offsets_and_error_coverage(self):
        out = Path(self.tmp) / "offset-out"
        result = run_cli("stack", "--out", str(out), "--reference", "1",
                         "--offsets", "4,-3;0,0;-2,5", *self.photos[:3])
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads((out / "review.json").read_text())
        self.assertEqual(document["reference"], 1)
        self.assertEqual([photo["offset"] for photo in document["photos"]],
                         [[4, -3], [0, 0], [-2, 5]])
        bad = run_cli("stack", "--out", str(Path(self.tmp) / "bad"), "--window", "0,0,360,270",
                      "--coverage", "error", "--offsets", "0,0;4,-3;-2,5", *self.photos[:3])
        self.assertEqual(bad.returncode, 2)
        self.assertIn("no photo recorded", bad.stderr)

    def test_bad_inputs_fail_loudly(self):
        result = run_cli("stack", "--out", str(Path(self.tmp) / "nope"), "--offsets", "0,0;1,1",
                         *self.photos[:3])
        self.assertEqual(result.returncode, 2)
        self.assertIn("offset", result.stderr.lower())

        not_png = Path(self.tmp) / "not.png"
        not_png.write_bytes(b"not a png")
        result = run_cli("stack", "--out", str(Path(self.tmp) / "nope2"), str(not_png))
        self.assertEqual(result.returncode, 2)
        self.assertTrue(result.stderr.strip())


if __name__ == "__main__":
    unittest.main()
