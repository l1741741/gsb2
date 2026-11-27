"""Comparison engine semantics: transparency, offsets, tile-spanning blocks."""

from __future__ import annotations

import unittest

from helpers import make_rgba, set_rect
from poster_diff.engine import compare
from poster_diff.geometry import (
    CanvasGeometry,
    CoverageKind,
    DiffConfig,
    DiffKind,
    PlacedImage,
)


def geometry_for(width_a, height_a, width_b, height_b, ox=0, oy=0):
    return CanvasGeometry(
        PlacedImage(width_a, height_a, 0, 0),
        PlacedImage(width_b, height_b, ox, oy),
    )


class EngineTests(unittest.TestCase):
    def test_identical_images_have_no_blocks(self):
        a = make_rgba(20, 20, (10, 20, 30, 255))
        b = make_rgba(20, 20, (10, 20, 30, 255))
        cfg = DiffConfig(tile_size=8)
        result = compare(a, b, geometry_for(20, 20, 20, 20), cfg)
        self.assertEqual(result.blocks, [])
        self.assertEqual(result.counts["changed_appearance_pixels"], 0)
        self.assertEqual(result.coverage_blocks, [])

    def test_hidden_color_of_transparent_pixels_ignored(self):
        # Same alpha=0 everywhere; wildly different stored RGB must not count.
        a = make_rgba(12, 12, (0, 0, 0, 0))
        b = make_rgba(12, 12, (250, 120, 10, 0))
        cfg = DiffConfig(appearance_threshold=1, alpha_threshold=1, tile_size=5)
        result = compare(a, b, geometry_for(12, 12, 12, 12), cfg)
        self.assertEqual(result.counts["changed_appearance_pixels"], 0)
        self.assertEqual(result.counts["changed_alpha_pixels"], 0)
        self.assertEqual(result.blocks, [])

    def test_semi_transparent_uses_configured_background(self):
        # A: 50% black; B: 50% white. On white they differ strongly,
        # on black A blends to black and B to mid gray — still differ,
        # but the peak depends on the chosen background.
        a = make_rgba(4, 4, (0, 0, 0, 128))
        b = make_rgba(4, 4, (255, 255, 255, 128))
        cfg_white = DiffConfig(
            appearance_threshold=1, background=(255, 255, 255), tile_size=3
        )
        r_white = compare(a, b, geometry_for(4, 4, 4, 4), cfg_white)
        peak_white = r_white.blocks[0].peak_appearance

        cfg_black = DiffConfig(
            appearance_threshold=1, background=(0, 0, 0), tile_size=3
        )
        r_black = compare(a, b, geometry_for(4, 4, 4, 4), cfg_black)
        peak_black = r_black.blocks[0].peak_appearance

        # On white: A -> 127, B -> 255 => 128. On black: A -> 0, B -> 127.
        self.assertAlmostEqual(peak_white, 128, delta=1)
        self.assertAlmostEqual(peak_black, 127, delta=1)
        self.assertEqual(r_white.blocks[0].kind, DiffKind.APPEARANCE.value)

    def test_alpha_difference_is_separate_metric(self):
        # Same stored RGB, different alpha only.
        a = make_rgba(6, 6, (100, 100, 100, 255))
        b = make_rgba(6, 6, (100, 100, 100, 40))
        cfg = DiffConfig(appearance_threshold=10, alpha_threshold=10,
                         background=(255, 255, 255), tile_size=4)
        result = compare(a, b, geometry_for(6, 6, 6, 6), cfg)
        # Every pixel exceeds both thresholds, so the single block is 'both'.
        self.assertEqual({bl.kind for bl in result.blocks}, {DiffKind.BOTH.value})
        self.assertEqual(result.counts["changed_alpha_pixels"], 36)
        self.assertGreater(result.counts["changed_appearance_pixels"], 0)
        self.assertEqual(result.blocks[0].peak_alpha, 215)

    def test_offset_creates_coverage_regions(self):
        a = make_rgba(10, 10, (200, 30, 30, 255))
        b = make_rgba(10, 10, (200, 30, 30, 255))
        cfg = DiffConfig(offset_x=4, offset_y=2, tile_size=6)
        geo = geometry_for(10, 10, 10, 10, ox=4, oy=2)
        result = compare(a, b, geo, cfg)
        kinds = {bl.kind for bl in result.coverage_blocks}
        self.assertIn(CoverageKind.REFERENCE_ONLY.value, kinds)
        self.assertIn(CoverageKind.CANDIDATE_ONLY.value, kinds)
        # Canvas is the union: 14 x 12.
        self.assertEqual(result.canvas.width, 14)
        self.assertEqual(result.canvas.height, 12)
        ref_only = sum(
            bl.area for bl in result.coverage_blocks
            if bl.kind == CoverageKind.REFERENCE_ONLY.value
        )
        cand_only = sum(
            bl.area for bl in result.coverage_blocks
            if bl.kind == CoverageKind.CANDIDATE_ONLY.value
        )
        self.assertEqual(ref_only, 10 * 10 - 6 * 8)
        self.assertEqual(cand_only, 10 * 10 - 6 * 8)

    def test_change_crossing_tile_border_is_one_block(self):
        # A vertical stripe straddling the tile boundary at x=8.
        a = make_rgba(16, 16, (0, 0, 0, 255))
        b = make_rgba(16, 16, (0, 0, 0, 255))
        set_rect(b, 7, 2, 3, 12, (255, 255, 255, 255))
        cfg = DiffConfig(
            appearance_threshold=10, merge_gap=0, tile_size=8, connectivity=8
        )
        result = compare(a, b, geometry_for(16, 16, 16, 16), cfg)
        self.assertEqual(len(result.blocks), 1)
        block = result.blocks[0]
        self.assertEqual((block.rect.x, block.rect.y, block.rect.width,
                          block.rect.height), (7, 2, 3, 12))
        self.assertEqual(block.area, 36)
        self.assertEqual(block.peak_appearance, 255)

    def test_change_crossing_horizontal_tile_border(self):
        a = make_rgba(10, 20, (10, 10, 10, 255))
        b = make_rgba(10, 20, (10, 10, 10, 255))
        set_rect(b, 1, 6, 8, 6, (200, 200, 200, 255))  # spans y=6..11, tile edge y=8
        cfg = DiffConfig(appearance_threshold=5, merge_gap=0, tile_size=8)
        result = compare(a, b, geometry_for(10, 20, 10, 20), cfg)
        self.assertEqual(len(result.blocks), 1)
        self.assertEqual(result.blocks[0].rect.y, 6)
        self.assertEqual(result.blocks[0].rect.height, 6)

    def test_merge_gap_joins_nearby_components(self):
        a = make_rgba(20, 8, (0, 0, 0, 255))
        b = make_rgba(20, 8, (0, 0, 0, 255))
        set_rect(b, 1, 2, 2, 2, (255, 255, 255, 255))
        set_rect(b, 7, 2, 2, 2, (255, 255, 255, 255))  # 4px gap between edges
        no_merge = DiffConfig(appearance_threshold=10, merge_gap=0, tile_size=16)
        r0 = compare(a, b, geometry_for(20, 8, 20, 8), no_merge)
        self.assertEqual(len(r0.blocks), 2)
        merged = DiffConfig(appearance_threshold=10, merge_gap=4, tile_size=16)
        r1 = compare(a, b, geometry_for(20, 8, 20, 8), merged)
        self.assertEqual(len(r1.blocks), 1)
        self.assertEqual(r1.blocks[0].area, 8)
        self.assertEqual((r1.blocks[0].rect.x, r1.blocks[0].rect.width), (1, 8))

    def test_min_block_area_filters_small_changes(self):
        a = make_rgba(10, 10, (0, 0, 0, 255))
        b = make_rgba(10, 10, (0, 0, 0, 255))
        set_rect(b, 0, 0, 1, 1, (255, 255, 255, 255))
        cfg = DiffConfig(appearance_threshold=10, min_block_area=2, tile_size=4)
        result = compare(a, b, geometry_for(10, 10, 10, 10), cfg)
        self.assertEqual(result.blocks, [])

    def test_four_vs_eight_connectivity(self):
        a = make_rgba(8, 8, (0, 0, 0, 255))
        b = make_rgba(8, 8, (0, 0, 0, 255))
        # Two diagonally touching pixels.
        b.set_pixel(2, 2, (255, 255, 255, 255))
        b.set_pixel(3, 3, (255, 255, 255, 255))
        cfg4 = DiffConfig(appearance_threshold=10, connectivity=4,
                          merge_gap=0, tile_size=4)
        cfg8 = DiffConfig(appearance_threshold=10, connectivity=8,
                          merge_gap=0, tile_size=4)
        geo = geometry_for(8, 8, 8, 8)
        self.assertEqual(len(compare(a, b, geo, cfg4).blocks), 2)
        self.assertEqual(len(compare(a, b, geo, cfg8).blocks), 1)

    def test_tile_sink_receives_full_tiles(self):
        a = make_rgba(10, 10, (0, 0, 0, 255))
        b = make_rgba(10, 10, (0, 0, 0, 255))
        received = []
        cfg = DiffConfig(tile_size=4)
        compare(a, b, geometry_for(10, 10, 10, 10), cfg,
                tile_sink=lambda t, ap, al, cov: received.append((t, len(ap))))
        # 3 x 3 tile grid; edge tiles have reduced pixel counts.
        self.assertEqual(len(received), 9)
        total = sum(n for _, n in received)
        self.assertEqual(total, 100)


if __name__ == "__main__":
    unittest.main()
