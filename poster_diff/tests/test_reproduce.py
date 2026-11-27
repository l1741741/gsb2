"""The stats file must be enough to reproduce the same report numbers."""

from __future__ import annotations

import json
import os
import tempfile
import unittest

from helpers import make_rgba, set_rect
from poster_diff.geometry import DiffConfig
from poster_diff.pngio import write_png
from poster_diff.report import build_report


class ReproduceTests(unittest.TestCase):
    def test_recomputed_stats_match(self):
        tmp = tempfile.mkdtemp()
        ref = os.path.join(tmp, "a.png")
        cand = os.path.join(tmp, "b.png")
        a = make_rgba(36, 28, (220, 220, 220, 255))
        b = make_rgba(36, 28, (220, 220, 220, 255))
        set_rect(b, 4, 5, 7, 9, (30, 30, 200, 255))
        set_rect(b, 30, 20, 4, 4, (220, 220, 220, 0))
        write_png(ref, a)
        write_png(cand, b)

        cfg = DiffConfig(
            offset_x=3,
            offset_y=-2,
            appearance_threshold=20,
            alpha_threshold=12,
            merge_gap=3,
            connectivity=4,
            min_block_area=2,
            background=(240, 240, 240),
            tile_size=16,
        )
        out1 = os.path.join(tmp, "r1")
        build_report(ref, cand, out1, cfg)
        with open(os.path.join(out1, "stats.json"), encoding="utf-8") as fh:
            stats = json.load(fh)

        # Rebuild the config purely from the serialized stats.
        c = stats["config"]
        cfg2 = DiffConfig(
            offset_x=c["offset_x"],
            offset_y=c["offset_y"],
            appearance_threshold=c["appearance_threshold"],
            alpha_threshold=c["alpha_threshold"],
            merge_gap=c["merge_gap"],
            connectivity=c["connectivity"],
            min_block_area=c["min_block_area"],
            background=tuple(c["background"]),
            tile_size=c["tile_size"],
        )
        out2 = os.path.join(tmp, "r2")
        build_report(
            stats["inputs"]["reference"]["path"],
            stats["inputs"]["candidate"]["path"],
            out2,
            cfg2,
        )
        with open(os.path.join(out2, "stats.json"), encoding="utf-8") as fh:
            stats2 = json.load(fh)

        for key in ("config", "counts", "geometry", "diff_blocks",
                    "coverage_blocks"):
            self.assertEqual(stats[key], stats2[key], f"field {key} differs")

        # The recorded command line mentions every tunable.
        cmd = stats["reproduce"]
        for flag in ("--offset-x 3", "--offset-y -2",
                     "--appearance-threshold 20", "--alpha-threshold 12",
                     "--merge-gap 3", "--connectivity 4",
                     "--min-block-area 2", "--background '#f0f0f0'",
                     "--tile-size 16"):
            self.assertIn(flag, cmd)


if __name__ == "__main__":
    unittest.main()
