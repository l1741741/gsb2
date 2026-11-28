"""In-window consistency guarantees for the focus stacker.

These tests are the contract behind requirement 4 ("导出局部块时，该块的
选择必须与完整结果对应位置一致"):

* the stacker computes labels and compositing on the full canvas only;
* an export window crops those planes;
* therefore the block composite and source map must match the full export
  pixel for pixel;
* and the same holds when a manual override is active.

The comparative tests across parameter values (not absolute snapshots) keep
these meaningful even if scoring internals are tuned later.
"""

import os
import tempfile
import unittest
from array import array
from pathlib import Path

from focusstack.align import OffsetPair, resolve_window, window_coverage
from focusstack.image import Image
from focusstack.pipeline import run_stack, write_result, StackError
from focusstack.pngio import read_png, write_png
from focusstack.select import FLAG_UNCOVERED
from focusstack.edits import validate_document

from tests.helpers import synthetic_depth_stack


class BlockConsistencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="focusstack-test-")
        cls.photos = synthetic_depth_stack(cls.tmp)

    def _export(self, **kwargs):
        result, window = run_stack(self.photos, **kwargs)
        out = tempfile.mkdtemp(prefix="focusstack-out-", dir=self.tmp)
        write_result(result, window, out, coverage=kwargs.get("coverage", "crop"))
        return result, window, out

    def test_labels_are_window_independent(self):
        full, full_window = run_stack(self.photos, window=(0, 0, 64, 64))
        block, block_window = run_stack(self.photos, window=(16, 20, 24, 22))
        self.assertEqual(list(full.labels), list(block.labels))
        self.assertEqual(list(full.flags), list(block.flags))
        self.assertEqual(list(full.composite.r), list(block.composite.r))

    def test_block_composite_matches_full_export(self):
        full_result, full_window = run_stack(self.photos)
        block_result, block_window = run_stack(self.photos, window=(16, 20, 24, 22))
        full_dir = tempfile.mkdtemp(dir=self.tmp)
        block_dir = tempfile.mkdtemp(dir=self.tmp)
        write_result(full_result, full_window, full_dir)
        write_result(block_result, block_window, block_dir)

        full_png = read_png(Path(full_dir) / "composite.png")
        block_png = read_png(Path(block_dir) / "composite.png")
        self.assertEqual(block_png.width, 24)
        self.assertEqual(block_png.height, 22)
        mismatch = 0
        for y in range(block_png.height):
            for x in range(block_png.width):
                if full_png.pixel(block_window[0] + x, block_window[1] + y) != block_png.pixel(x, y):
                    mismatch += 1
        self.assertEqual(mismatch, 0)

        full_sources = read_png(Path(full_dir) / "sources.png")
        block_sources = read_png(Path(block_dir) / "sources.png")
        for y in range(block_png.height):
            for x in range(block_png.width):
                self.assertEqual(
                    full_sources.pixel(block_window[0] + x, block_window[1] + y),
                    block_sources.pixel(x, y),
                )

    def test_override_block_matches_full_with_override(self):
        document = {
            "version": 1,
            "edits": [{
                "id": "box", "image": 1, "enabled": True,
                "shapes": [{"kind": "rect", "x": 20, "y": 24, "width": 12, "height": 10}],
            }],
        }
        validated = validate_document(document, 3)
        full_result, full_window = run_stack(self.photos, edits=validated)
        block_result, block_window = run_stack(self.photos, edits=validated, window=(16, 20, 24, 22))
        self.assertEqual(list(full_result.labels), list(block_result.labels))
        full_dir = tempfile.mkdtemp(dir=self.tmp)
        block_dir = tempfile.mkdtemp(dir=self.tmp)
        full_doc = write_result(full_result, full_window, full_dir)
        block_doc = write_result(block_result, block_window, block_dir)
        full_png = read_png(Path(full_dir) / "composite.png")
        block_png = read_png(Path(block_dir) / "composite.png")
        for y in range(block_png.height):
            for x in range(block_png.width):
                self.assertEqual(
                    full_png.pixel(block_window[0] + x, block_window[1] + y),
                    block_png.pixel(x, y),
                )
        # Reporting: the override intersects the block and says so.
        edit = block_doc["manual_edits"][0]
        self.assertGreater(edit["in_window"], 0)
        self.assertEqual(edit["in_window"], block_doc["manual_edits"][0]["painted"])

    def test_window_outside_common_region_is_cropped_or_rejected(self):
        offsets = [(0, 0), (5, -4), (-3, 6)]
        result, window = run_stack(self.photos, offsets=offsets, window=(0, 0, 64, 64), coverage="crop")
        # Canvas is the union (72x74 here); the common region starts at (8, 10).
        self.assertEqual(window, result.common)
        with self.assertRaises(StackError):
            run_stack(self.photos, offsets=offsets, window=(100, 60, 8, 8), coverage="crop")
        # A 2x2 corner of the union that only one photo records is allowed by
        # keep but rejected by error only if it is truly empty; this corner is
        # recorded by photo 2, so error accepts it.
        ok, missing = window_coverage(
            (64, 64), [OffsetPair(*pair) for pair in offsets], (0, 70, 4, 4)
        )
        self.assertTrue(ok)
        self.assertEqual(missing, 0)

    def test_keep_mode_preserves_margins_only_covered_by_some_photos(self):
        offsets = [(0, 0), (6, 0), (0, 0)]
        result, window = run_stack(self.photos, offsets=offsets, coverage="keep")
        # The union grows to 70x64 because photo 1 sits 6 px right.
        self.assertEqual(window, (0, 0, 70, 64))
        cover_window = resolve_window((64, 64), result.offsets, (0, 0, 70, 64), "crop")
        self.assertEqual(cover_window, (6, 0, 58, 64))
        self.assertGreater(window[2], cover_window[2])
        # Every union pixel here is recorded by some photo, so no marks.
        document = write_result(result, window, tempfile.mkdtemp(dir=self.tmp), coverage="keep")
        self.assertEqual(document["usage"]["uncovered"], 0)
        self.assertEqual(sum(document["usage"]["by_photo"].values()), 70 * 64)

    def test_keep_mode_marks_union_holes(self):
        # Three photos: one at the origin, one far right, one bottom-left
        # leaves a corner where nothing was recorded.
        offsets = [(0, 0), (40, 0), (0, 40)]
        result, window = run_stack(self.photos, offsets=offsets, coverage="keep")
        document = write_result(result, window, tempfile.mkdtemp(dir=self.tmp), coverage="keep")
        self.assertGreater(document["usage"]["uncovered"], 0)
        covered, missing = window_coverage(
            (64, 64), [OffsetPair(*pair) for pair in offsets], (0, 0, 104, 104)
        )
        self.assertFalse(covered)
        self.assertEqual(missing, document["usage"]["uncovered"])
        with self.assertRaises(StackError):
            run_stack(self.photos, offsets=offsets, window=(0, 0, 104, 104), coverage="error")

    def test_keep_mode_marks_transparent_pixels(self):
        # Uncovered canvas pixels require that no photo recorded them.  A
        # transparent hole in the reference plus offsets that push the other
        # photos away from the hole produces exactly that.
        tmp = tempfile.mkdtemp(dir=self.tmp)
        paths = synthetic_depth_stack(tmp)
        clear = read_png(paths[0])
        alpha = array("B", [255]) * (clear.width * clear.height)
        for y in range(8, 16):
            for x in range(8, 16):
                alpha[y * clear.width + x] = 0
        cutout = Image(clear.width, clear.height, array("B", clear.r), array("B", clear.g),
                       array("B", clear.b), alpha, name="cutout")
        cut_path = Path(tmp) / "cutout.png"
        write_png(cut_path, cutout)
        offsets = [(0, 0), (20, 0), (20, 0)]
        result, window = run_stack([str(cut_path), paths[1], paths[2]], offsets=offsets,
                                   coverage="keep")
        self.assertEqual(result.flags.count(FLAG_UNCOVERED), 64)
        document = write_result(result, window, tempfile.mkdtemp(), coverage="keep")
        self.assertEqual(document["usage"]["uncovered"], 64)


class ReferenceTests(unittest.TestCase):
    def test_reference_rebases_offsets(self):
        tmp = tempfile.mkdtemp()
        photos = synthetic_depth_stack(tmp)
        # Same physical geometry, expressed from photo 1's viewpoint.
        base, _ = run_stack(photos, offsets=[(0, 0), (2, -3), (5, 1)])
        rebased, _ = run_stack(photos, reference=1, offsets=[(-2, 3), (0, 0), (3, 4)])
        self.assertEqual(rebased.reference, 1)
        self.assertEqual(rebased.offsets[1].as_tuple(), (0, 0))
        self.assertEqual(rebased.offsets[0].as_tuple(), (-2, 3))
        self.assertEqual(base.offsets[0].as_tuple(), (0, 0))
        # Because the canvas is the union of all placements, expressing the
        # same geometry from another photo's base changes only the origin
        # metadata: the common region is identical in canvas coordinates.
        self.assertEqual(base.common, rebased.common)
        self.assertEqual(base.origin, (0, -3))
        self.assertEqual(rebased.origin, (-2, 0))
        self.assertEqual((base.width, base.height), (rebased.width, rebased.height))

    def test_bad_reference_index_rejected(self):
        tmp = tempfile.mkdtemp()
        photos = synthetic_depth_stack(tmp)
        with self.assertRaises(StackError):
            run_stack(photos, reference=3)


class DeterminismTests(unittest.TestCase):
    def test_repeated_runs_are_identical(self):
        tmp = tempfile.mkdtemp()
        photos = synthetic_depth_stack(tmp)
        first, _ = run_stack(photos)
        second, _ = run_stack(photos)
        self.assertEqual(list(first.labels), list(second.labels))
        self.assertEqual(list(first.composite.r), list(second.composite.r))
        self.assertEqual(list(first.flags), list(second.flags))


if __name__ == "__main__":
    unittest.main()
