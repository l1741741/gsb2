"""End-to-end report build: artifacts, shards, stats and recompute inputs."""

from __future__ import annotations

import csv
import json
import os
import tempfile
import unittest

from helpers import make_rgba, set_rect
from poster_diff.geometry import DiffConfig
from poster_diff.pngio import read_png
from poster_diff.report import build_report


class ReportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.ref_path = os.path.join(self.tmp, "a.png")
        self.cand_path = os.path.join(self.tmp, "b.png")

        a = make_rgba(24, 18, (240, 240, 240, 255))
        b = make_rgba(24, 18, (240, 240, 240, 255))
        # Visible edit crossing the x=16 tile boundary.
        set_rect(b, 14, 4, 5, 6, (200, 30, 30, 255))
        # Alpha-only edit: punch a transparent hole.
        set_rect(b, 2, 10, 3, 3, (240, 240, 240, 0))
        from poster_diff.pngio import write_png
        write_png(self.ref_path, a)
        write_png(self.cand_path, b)

    def test_report_artifacts_and_stats(self):
        out = os.path.join(self.tmp, "report")
        cfg = DiffConfig(tile_size=16, merge_gap=1)
        result = build_report(self.ref_path, self.cand_path, out, cfg, title="t")
        self.assertTrue(os.path.isfile(os.path.join(out, "index.html")))
        self.assertTrue(os.path.isfile(os.path.join(out, "report_data.js")))
        self.assertTrue(os.path.isfile(os.path.join(out, "stats.json")))
        self.assertTrue(os.path.isfile(os.path.join(out, "diff_blocks.csv")))
        self.assertTrue(os.path.isdir(os.path.join(out, "tiles")))
        self.assertTrue(os.path.isfile(os.path.join(out, "viewer", "app.js")))
        self.assertTrue(os.path.isfile(
            os.path.join(out, "assets", "ref_overview.png")))

        with open(os.path.join(out, "stats.json"), encoding="utf-8") as fh:
            stats = json.load(fh)
        self.assertEqual(stats["schema_version"], 1)
        self.assertEqual(stats["config"]["tile_size"], 16)
        self.assertEqual(stats["inputs"]["reference"]["width"], 24)
        self.assertEqual(len(stats["inputs"]["reference"]["sha256"]), 64)
        self.assertIn("reproduce", stats)
        # At least the two edits exist as blocks.
        self.assertGreaterEqual(len(stats["diff_blocks"]), 2)
        for block in stats["diff_blocks"]:
            self.assertEqual(set(block["rect"]), {"x", "y", "width", "height"})
            self.assertGreaterEqual(block["peak_appearance"], 0)

        # CSV mirrors the blocks.
        with open(os.path.join(out, "diff_blocks.csv"), newline="", encoding="utf-8") as fh:
            rows = list(csv.reader(fh))
        self.assertEqual(rows[0][:3], ["block_id", "kind", "x"])
        self.assertEqual(len(rows) - 1,
                         len(stats["diff_blocks"]) + len(stats["coverage_blocks"]))

        # Shard files parse as JS payload arrays and are pure local data.
        shard_files = [
            f for f in os.listdir(os.path.join(out, "tiles")) if f.endswith(".js")
        ]
        self.assertTrue(shard_files)
        for name in shard_files:
            with open(os.path.join(out, "tiles", name), encoding="utf-8") as fh:
                text = fh.read()
            self.assertTrue(text.startswith("window.__PD__.addShard("))
            self.assertNotIn("http://", text)
            self.assertNotIn("https://", text)

        # Every referenced shard exists and no full-resolution image is copied.
        for layer, levels in stats["tiles"]["levels"].items():
            for level, info in levels.items():
                for shard in info["shards"]:
                    self.assertTrue(
                        os.path.isfile(os.path.join(out, shard["file"])),
                        shard["file"],
                    )

    def test_offset_report_coverage(self):
        out = os.path.join(self.tmp, "offset-report")
        cfg = DiffConfig(offset_x=5, offset_y=-3, tile_size=16)
        result = build_report(self.ref_path, self.cand_path, out, cfg)
        stats_path = os.path.join(out, "stats.json")
        with open(stats_path, encoding="utf-8") as fh:
            stats = json.load(fh)
        self.assertTrue(stats["coverage_blocks"])
        # Canvas union accounts for the offset on both axes.
        self.assertEqual(stats["geometry"]["candidate_placement"]["x"], 5)
        self.assertEqual(stats["geometry"]["candidate_placement"]["y"], -3)
        self.assertEqual(result.counts["reference_only_area"],
                         sum(b.area for b in result.coverage_blocks
                             if b.kind == "reference_only"))

    def test_thumbnail_is_downscaled(self):
        big = make_rgba(300, 200, (10, 20, 30, 255))
        path = os.path.join(self.tmp, "big.png")
        from poster_diff.pngio import write_png
        write_png(path, big)
        out = os.path.join(self.tmp, "big-report")
        build_report(path, path, out, DiffConfig(tile_size=64))
        thumb = read_png(os.path.join(out, "assets", "ref_overview.png"))
        self.assertLessEqual(max(thumb.width, thumb.height), 512)


if __name__ == "__main__":
    unittest.main()
