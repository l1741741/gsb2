"""Tests for the review list and the reason taxonomy.

Requirement 5 ("from the list, review low-confidence areas and manual
overrides") is covered here: every low-confidence pixel is reachable through
`regions[]`, manual overrides appear as their own reasons, and the overlay
keeps high-priority tinting while leaving ordinary low confidence untinted.
"""

import tempfile
import unittest
from array import array

from focusstack.image import Image
from focusstack.pipeline import run_stack, write_result
from focusstack.review import COLORS, build_regions, legend, render_overlay
from focusstack.select import (
    FLAG_LOW_CONF,
    FLAG_LOW_CONF_DIVERGENT,
    FLAG_MANUAL,
    FLAG_MANUAL_PARTIAL,
    FLAG_SEAM_CONFLICT,
    FLAG_TIE,
    FLAG_UNCOVERED,
    REASON_NAMES,
)

from tests.helpers import synthetic_depth_stack


def _flags(width, height, spots):
    """Build a byte flag plane with given {(x, y): bits}."""
    plane = array("B", bytes(width * height))
    for (x, y), bits in spots.items():
        plane[y * width + x] = bits
    return plane


def _labels(width, height, value=0):
    return array("h", [value]) * (width * height)


class ReasonNameTests(unittest.TestCase):
    def test_reason_names_exist_for_every_review_flag(self):
        for flag in (FLAG_LOW_CONF, FLAG_LOW_CONF_DIVERGENT, FLAG_TIE,
                     FLAG_SEAM_CONFLICT, FLAG_UNCOVERED, FLAG_MANUAL, FLAG_MANUAL_PARTIAL):
            self.assertIn(flag, REASON_NAMES)

    def test_legend_covers_priority_reasons(self):
        rows = legend()
        names = {row["reason"] for row in rows}
        for name in ("seam_conflict", "ambiguous_near_tie", "low_confidence",
                     "low_confidence_divergent", "uncovered", "manual_override_partial"):
            self.assertIn(name, names)
        for row in rows:
            self.assertEqual(len(row["rgb"]), 3)
            self.assertTrue(row["guidance"])


class OverlayTests(unittest.TestCase):
    def _image(self, width, height):
        n = width * height
        return Image(width, height, array("B", [80]) * n, array("B", [90]) * n,
                     array("B", [100]) * n)

    def test_high_priority_pixels_are_tinted(self):
        width, height = 16, 8
        flags = _flags(width, height, {(2, 2): FLAG_SEAM_CONFLICT})
        image = self._image(width, height)
        overlay = render_overlay(image, flags, [])
        tinted = overlay.pixel(2, 2)
        self.assertNotEqual(tinted, image.pixel(2, 2))
        # The dim factor (0.45) moves the pixel toward the reason colour.
        expected = tuple(int(image.pixel(2, 2)[i] * 0.55 + COLORS[FLAG_SEAM_CONFLICT][i] * 0.45)
                         for i in range(3))
        self.assertEqual(tinted, expected)

    def test_ordinary_low_confidence_is_not_tinted(self):
        width, height = 16, 8
        flags = _flags(width, height, {(5, 3): FLAG_LOW_CONF})
        image = self._image(width, height)
        overlay = render_overlay(image, flags, [])
        self.assertEqual(overlay.pixel(5, 3), image.pixel(5, 3))

    def test_divergent_low_confidence_is_tinted(self):
        width, height = 16, 8
        flags = _flags(width, height, {(5, 3): FLAG_LOW_CONF_DIVERGENT})
        image = self._image(width, height)
        overlay = render_overlay(image, flags, [])
        self.assertNotEqual(overlay.pixel(5, 3), image.pixel(5, 3))
        self.assertLess(overlay.pixel(5, 3)[0], 255)  # dimmed, not the pure tint
        self.assertGreater(overlay.pixel(5, 3)[0], image.pixel(5, 3)[0])


class RegionListTests(unittest.TestCase):
    def test_low_confidence_regions_are_reachable(self):
        width, height = 12, 10
        flags = bytearray(width * height)
        for y in range(2, 7):
            for x in range(2, 9):
                flags[y * width + x] = FLAG_LOW_CONF
        regions, truncated, area = build_regions(array("B", flags), _labels(width, height),
                                                 [], width, height, min_area=1)
        self.assertEqual(truncated, 0)
        self.assertEqual(area, 5 * 7)
        match = [r for r in regions if r["reason"] == "low_confidence"]
        self.assertEqual(len(match), 1)
        self.assertEqual(match[0]["bbox"], [2, 2, 7, 5])

    def test_all_reasons_get_distinct_ids(self):
        width, height = 20, 10
        flags = _flags(width, height, {
            (1, 1): FLAG_SEAM_CONFLICT,
            (5, 5): FLAG_TIE,
            (9, 5): FLAG_LOW_CONF,
            (13, 5): FLAG_LOW_CONF_DIVERGENT,
            (17, 5): FLAG_UNCOVERED,
        })
        regions, _, _ = build_regions(flags, _labels(width, height), [], width, height, min_area=1)
        self.assertEqual(len({r["id"] for r in regions}), len(regions))
        priorities = [r["priority"] for r in regions]
        self.assertEqual(priorities, sorted(priorities))
        reasons = {r["reason"] for r in regions}
        self.assertEqual(reasons, {"seam_conflict", "ambiguous_near_tie",
                                   "low_confidence", "low_confidence_divergent", "uncovered"})

    def test_window_clips_bbox_but_keeps_identity(self):
        width, height = 20, 20
        flags = bytearray(width * height)
        for y in range(5, 15):
            for x in range(5, 15):
                flags[y * width + x] = FLAG_LOW_CONF
        regions, _, area = build_regions(array("B", flags), _labels(width, height),
                                         [], width, height, min_area=1,
                                         window=(0, 0, 10, 10))
        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0]["bbox"], [5, 5, 5, 5])
        self.assertEqual(regions[0]["area"], 25)
        self.assertEqual(area, 100)  # full-canvas flagged area, not the window

    def test_max_regions_truncation_is_reported(self):
        width, height = 30, 30
        flags = bytearray(width * height)
        for i in range(6):
            x = 2 + i * 4
            flags[4 * width + x] = FLAG_TIE
        regions, truncated, _ = build_regions(array("B", flags), _labels(width, height),
                                              [], width, height, min_area=1, max_regions=4)
        self.assertEqual(len(regions), 4)
        self.assertEqual(truncated, 2)


class ManualOverrideReviewTests(unittest.TestCase):
    def test_manual_override_is_listed(self):
        photos = synthetic_depth_stack(tempfile.mkdtemp())
        document = {
            "version": 1,
            "edits": [{"id": "pin", "image": 0, "shapes": [
                {"kind": "rect", "x": 40, "y": 36, "width": 8, "height": 8}]}],
        }
        from focusstack.edits import validate_document
        result, window = run_stack(photos, edits=validate_document(document, 3))
        out = tempfile.mkdtemp()
        review = write_result(result, window, out)
        painted = review["manual_edits"][0]
        self.assertEqual(painted["painted"], 64)
        self.assertTrue(result.flags[36 * result.width + 40] & FLAG_MANUAL)

    def test_partial_override_reason_visible_in_list(self):
        photos = synthetic_depth_stack(tempfile.mkdtemp())
        document = {
            "version": 1,
            "edits": [{"id": "soft", "image": 0, "shapes": [
                {"kind": "rect", "x": 40, "y": 36, "width": 4, "height": 4, "strength": 0.4}]}],
        }
        from focusstack.edits import validate_document
        result, window = run_stack(photos, edits=validate_document(document, 3))
        regions, _, _ = build_regions(result.flags, result.labels, result.focus,
                                      result.width, result.height, min_area=1)
        self.assertTrue(any("manual_override_partial" in r["reason"]
                            or r["reason"] == "manual_override_partial"
                            for r in regions))


if __name__ == "__main__":
    unittest.main()
