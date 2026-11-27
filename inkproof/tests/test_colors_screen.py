"""Tests for colour tables, stable nearest selection, and the screen."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inkproof.colors import (  # noqa: E402
    ColourError,
    InkTable,
    make_table,
    rgb_to_lab,
)
from inkproof.screen import Screen  # noqa: E402


def rgb_table(inks, metric="rgb", tie_epsilon=0.0):
    return make_table(
        [(name, rgb, ()) for name, rgb in inks],
        metric=metric,
        tie_epsilon=tie_epsilon,
    )


class NearestSelectionTests(unittest.TestCase):
    def test_exact_ink_match_is_chosen(self):
        table = rgb_table([("black", (0, 0, 0)), ("white", (255, 255, 255))])
        self.assertEqual(table.nearest((0, 0, 0))[0], 0)
        self.assertEqual(table.nearest((255, 255, 255))[0], 1)

    def test_tie_resolves_to_first_declared_ink(self):
        # (127.5, 0, 0) is exactly equidistant from black and (255, 0, 0) in
        # RGB, but colours are integers; use a pair whose distance is equal.
        table = rgb_table([("black", (0, 0, 0)), ("red", (200, 0, 0))])
        self.assertEqual(table.nearest((100, 0, 0))[0], 0)
        reversed_table = rgb_table([("red", (200, 0, 0)), ("black", (0, 0, 0))])
        self.assertEqual(reversed_table.nearest((100, 0, 0))[0], 0)
        self.assertEqual(reversed_table.inks[0].name, "red")

    def test_zero_distance_to_each_ink(self):
        table = rgb_table([("black", (0, 0, 0)), ("white", (255, 255, 255))])
        self.assertEqual(table.nearest((0, 0, 0))[0], 0)
        self.assertEqual(table.nearest((255, 255, 255))[0], 1)

    def test_tie_epsilon_absorbs_near_ties(self):
        table = rgb_table(
            [("black", (0, 0, 0)), ("near-black", (1, 1, 1))], tie_epsilon=5.0
        )
        self.assertEqual(table.nearest((0, 0, 0))[0], 0)
        self.assertEqual(table.nearest((1, 1, 1))[0], 0)  # tie band -> declared first

    def test_selection_is_deterministic(self):
        table = make_table(
            [("a", (10, 20, 30), ()), ("b", (200, 100, 40), ()), ("c", (5, 5, 5), ())]
        )
        colour = (150, 90, 60)
        results = {table.nearest(colour)[0] for _ in range(50)}
        self.assertEqual(len(results), 1)

    def test_metric_change_can_change_the_choice(self):
        # Mid grey: RGB distance favours the mid-grey ink; Lab favours the
        # ink that is closer in perceptual lightness/chroma balance.
        table_rgb = make_table(
            [("mid", (128, 128, 128), ()), ("blue", (100, 100, 160), ())],
            metric="rgb",
        )
        table_lab = make_table(
            [("mid", (128, 128, 128), ()), ("blue", (100, 100, 160), ())],
            metric="lab",
        )
        self.assertEqual(table_rgb.nearest((128, 128, 128))[0], 0)
        self.assertEqual(table_lab.nearest((128, 128, 128))[0], 0)

    def test_lab_reference_values(self):
        white = rgb_to_lab((255, 255, 255))
        self.assertAlmostEqual(white[0], 100.0, places=2)
        black = rgb_to_lab((0, 0, 0))
        self.assertAlmostEqual(black[0], 0.0, places=3)
        red = rgb_to_lab((255, 0, 0))
        self.assertGreater(red[1], 0)  # a* positive for red
        self.assertGreater(red[2], 0)  # b* positive for red

    def test_two_nearest_returns_distinct_inks_when_possible(self):
        table = make_table(
            [("red", (210, 30, 25), ()), ("blue", (20, 70, 150), ()), ("paper", (240, 232, 210), ())]
        )
        first, second, d1, d2 = table.two_nearest((120, 50, 80))
        self.assertNotEqual(first, second)
        self.assertLessEqual(d1, d2)


class ColourTableValidationTests(unittest.TestCase):
    def test_duplicate_names_are_rejected(self):
        with self.assertRaises(ColourError):
            make_table([("a", (0, 0, 0), ()), ("a", (255, 255, 255), ())])

    def test_order_must_cover_every_ink(self):
        with self.assertRaises(ColourError):
            make_table(
                [("a", (0, 0, 0), ()), ("b", (1, 1, 1), ())], order_names=["a"]
            )

    def test_order_accepts_an_alias(self):
        table = make_table(
            [("a", (0, 0, 0), ()), ("b", (1, 1, 1), ("old-b",))],
            order_names=["old-b", "a"],
        )
        self.assertEqual(table.display_order()[0].name, "b")

    def test_reserved_transparent_name_is_rejected(self):
        with self.assertRaises(ColourError):
            make_table([("transparent", (0, 0, 0), ())])

    def test_alias_lookup(self):
        table = make_table([("new", (0, 0, 0), ("old",))])
        self.assertIs(table.resolve("old"), table.inks[0])
        self.assertIsNone(table.resolve("transparent"))
        self.assertIsNone(table.resolve("missing"))


class ScreenTests(unittest.TestCase):
    def test_dot_occupancy_tracks_the_request(self):
        screen = Screen(kind="dots", cell=8, levels=16)
        width = height = 64
        for occupancy, expected in ((64, 0.25), (128, 0.5), (192, 0.75), (255, 1.0)):
            mask = screen.apply(bytes([occupancy]) * (width * height), screen.threshold_field(width, height))
            ratio = sum(mask) / (width * height)
            self.assertAlmostEqual(ratio, expected, delta=0.06, msg=f"occupancy {occupancy}")

    def test_zero_occupancy_prints_nothing_and_full_prints_everything(self):
        screen = Screen()
        field = screen.threshold_field(16, 16)
        self.assertEqual(sum(screen.apply(bytes(256), field)), 0)
        self.assertEqual(sum(screen.apply(bytes([255]) * 256, field)), 256)

    def test_threshold_field_is_crop_consistent(self):
        screen = Screen(kind="dots", cell=6, angle=22.5, levels=32)
        full = screen.threshold_field(40, 40, origin=(0, 0))
        crop = screen.threshold_field(12, 12, origin=(7, 5))
        for y in range(12):
            for x in range(12):
                self.assertEqual(
                    crop[y * 12 + x], full[(y + 5) * 40 + (x + 7)], (x, y)
                )

    def test_lines_screen_produces_parallel_rules(self):
        screen = Screen(kind="lines", cell=8, angle=0.0, levels=16)
        mask = screen.apply(bytes([128]) * (64 * 64), screen.threshold_field(64, 64))
        ratio = sum(mask) / (64 * 64)
        self.assertAlmostEqual(ratio, 0.5, delta=0.08)

    def test_screen_rejects_bad_parameters(self):
        with self.assertRaises(ValueError):
            Screen(kind="spiral")
        with self.assertRaises(ValueError):
            Screen(cell=1)
        with self.assertRaises(ValueError):
            Screen(levels=1)


if __name__ == "__main__":
    unittest.main()
