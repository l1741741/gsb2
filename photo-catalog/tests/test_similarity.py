"""Tests for the similarity rules that the task explicitly requires.

These are the behavioural guarantees, not implementation details:

* exact duplicates are recognised
* resized / cropped / recoloured copies are recognised
* two different photos with the same background are NOT auto-merged
* A≈B and B≈C with A≠C is reported as a chain, never as one group
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402

from photocatalog.pipeline import (  # noqa: E402
    Photo, candidate_pairs, evaluate_pair, find_chains, group_candidates,
    scan_folder,
)


def _scan(paths: dict[str, object], tmp: str) -> list[Photo]:
    root = os.path.join(tmp, "root")
    os.makedirs(root, exist_ok=True)
    for rel, img in paths.items():
        dest = os.path.join(root, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        helpers.write_png(img, dest)
    return scan_folder(root, external_tools=False)


class DuplicateTests(unittest.TestCase):
    def test_exact_duplicate_pairs(self) -> None:
        img = helpers.gradient(40, 30, box=(10, 6, 30, 24))
        with tempfile.TemporaryDirectory() as tmp:
            photos = _scan({"a.png": img, "a_copy.png": img}, tmp)
        pairs = candidate_pairs(photos)
        self.assertEqual(len(pairs), 1)
        pair = pairs[0]
        self.assertEqual(pair.relation, "identical")
        self.assertAlmostEqual(pair.same_photo, 1.0)
        groups = group_candidates(pairs)
        self.assertEqual(len(groups), 1)
        self.assertTrue(groups[0]["complete"])
        self.assertEqual(set(groups[0]["members"]), {"a.png", "a_copy.png"})


class CopyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.base = helpers.gradient(80, 60, box=(24, 16, 56, 42))

    def test_resized_copy_recognised(self) -> None:
        from photocatalog.analysis import resize_rgb
        small = resize_rgb(self.base, 40, 30)
        with tempfile.TemporaryDirectory() as tmp:
            photos = _scan({"big.png": self.base, "small.png": small}, tmp)
        pair = candidate_pairs(photos)[0]
        self.assertIn(pair.relation, ("resized", "same-image"))
        self.assertGreaterEqual(pair.merge_fit, 0.80)

    def test_cropped_copy_recognised(self) -> None:
        trimmed = helpers.crop(self.base, 3, 2, 77, 58)
        with tempfile.TemporaryDirectory() as tmp:
            photos = _scan({"full.png": self.base, "trim.png": trimmed}, tmp)
        pair = candidate_pairs(photos)[0]
        self.assertIn(pair.relation, ("cropped", "resized", "same-image"))
        self.assertIsNotNone(pair.crop)

    def test_recoloured_copy_recognised(self) -> None:
        warm = helpers.tint(self.base, 16, -8, 6)
        with tempfile.TemporaryDirectory() as tmp:
            photos = _scan({"orig.png": self.base, "warm.png": warm}, tmp)
        pair = candidate_pairs(photos)[0]
        self.assertGreaterEqual(pair.same_photo, 0.80)
        self.assertGreaterEqual(pair.merge_fit, 0.80)


class LookAlikeTests(unittest.TestCase):
    """Two photos of the same scene with different subjects must not merge."""

    def test_same_background_different_subject_not_merged(self) -> None:
        # Identical gradient background; the subject box is in different places.
        left = helpers.gradient(80, 60, box=(6, 20, 22, 40))
        right = helpers.gradient(80, 60, box=(58, 20, 74, 40))
        with tempfile.TemporaryDirectory() as tmp:
            photos = _scan({"scene_left.png": left, "scene_right.png": right}, tmp)
        pairs = candidate_pairs(photos)
        self.assertEqual(len(pairs), 1)
        pair = pairs[0]
        self.assertLess(pair.same_photo, 0.80, pair.reasons)
        self.assertLess(pair.merge_fit, 0.80)
        self.assertEqual(group_candidates(pairs), [])

    def test_identical_flat_colour_images_are_same(self) -> None:
        # Truly identical files remain identical even without structure.
        import struct
        img = helpers.gradient(30, 20)
        with tempfile.TemporaryDirectory() as tmp:
            photos = _scan({"x.png": img, "y.png": img}, tmp)
        pair = candidate_pairs(photos)[0]
        self.assertEqual(pair.relation, "identical")


class ChainTests(unittest.TestCase):
    """A–B and B–C are copies, A–C are not: report a chain, do not merge all."""

    def test_panorama_chain_is_reported_not_grouped(self) -> None:
        wide = helpers.gradient(160, 60, box=(40, 18, 80, 44))
        left = helpers.crop(wide, 0, 0, 96, 60)      # left 60%
        right = helpers.crop(wide, 64, 0, 160, 60)   # right 60%
        with tempfile.TemporaryDirectory() as tmp:
            photos = _scan({"panorama.png": wide, "left.png": left,
                            "right.png": right}, tmp)
        pairs = candidate_pairs(photos)
        chains = find_chains(pairs)
        self.assertEqual(len(chains), 1, "expected exactly one chain")
        members = {chains[0]["left"], chains[0]["middle"], chains[0]["right"]}
        self.assertEqual(members, {"panorama.png", "left.png", "right.png"})
        # The middle (panorama) must be the wide frame.
        self.assertEqual(chains[0]["middle"], "panorama.png")
        # Left and right must not both be in one complete group.
        groups = group_candidates(pairs)
        for g in groups:
            self.assertFalse({"left.png", "right.png"} <= set(g["members"]) and g["complete"],
                             "left and right must not be a complete merge group")


if __name__ == "__main__":
    unittest.main()
