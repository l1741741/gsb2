"""Behavioural tests for focus selection, seam treatment and review output.

These tests assert the *contracts* the tool promises, not specific pixel
values, so they stay meaningful when thresholds are tuned:

* a sharp layer is chosen for the photo that actually resolves it;
* flat low-contrast areas never flip source between photos that agree;
* one-pixel lines survive compositing (they are not averaged to grey);
* manual overrides replace an area, persist in the edit JSON, and show up
  in the review document;
* the review list names the regions a human should inspect.
"""

import json
import tempfile
import unittest
from array import array
from pathlib import Path

from focusstack.edits import validate_document, save_edits, load_edits, EditError
from focusstack.image import Image
from focusstack.ops import box_blur
from focusstack.pipeline import run_stack, write_result
from focusstack.pngio import read_png, write_png
from focusstack.select import FLAG_MANUAL, FLAG_UNCOVERED

from tests.helpers import synthetic_depth_stack, two_tone_photos, WIDTH, HEIGHT


def _layer_image(values, name):
    plane = array("B", [max(0, min(255, v)) for v in values])
    return Image(WIDTH, HEIGHT, array("B", plane), array("B", plane), array("B", plane), name=name)


class SelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.photos = synthetic_depth_stack(cls.tmp)
        cls.result, _ = run_stack(cls.photos)

    def _label(self, x, y):
        return self.result.labels[y * self.result.width + x]

    def test_sharp_depth_wins_where_layer_is_visible(self):
        # Each depth is textured only in the photo that resolves it.
        self.assertEqual(self._label(50, 44), 0, "near-sharp photo should own the near disc")
        self.assertEqual(self._label(20, 30), 1, "mid-sharp photo should own the card")
        self.assertEqual(self._label(55, 10), 2, "far-sharp photo should own the far wedge")

    def test_flat_area_uses_reference_when_photos_agree(self):
        # Top-left corner is plain background in all shots.
        self.assertEqual(self._label(2, 2), 0)
        self.assertEqual(self._label(2, 2), self.result.selection.reference)

    def test_near_texture_never_falls_to_a_blurred_photo(self):
        owners = set()
        for x in range(42, 58):
            for y in range(36, 52):
                if (x - 50) ** 2 + (y - 44) ** 2 <= 8 * 8:
                    owners.add(self._label(x, y))
        self.assertEqual(owners, {0}, "near disc picked up blurred sources: %r" % (owners,))

    def test_speckle_cleanup_removes_singletons(self):
        from focusstack.select import remove_isolated

        labels = array("h", [0]) * (8 * 8)
        labels[3 * 8 + 3] = 1  # single-pixel island
        changed = remove_isolated(labels, 8, 8, passes=1)
        self.assertEqual(changed, 1)
        self.assertEqual(labels[3 * 8 + 3], 0)


class SeamTests(unittest.TestCase):
    def _two_photo_stack(self, line_at_x=32):
        return two_tone_photos(tempfile.mkdtemp(), line_x=line_at_x)

    def test_thin_line_keeps_contrast_through_seam(self):
        photos = self._two_photo_stack()
        result, _ = run_stack(photos)
        composite = result.composite
        line_x = 32
        darkest = min(composite.r[y * WIDTH + line_x] for y in range(HEIGHT // 4, 3 * HEIGHT // 4))
        self.assertLess(darkest, 90, "one-pixel line was averaged away (min %d)" % darkest)

    def test_edge_protection_can_be_disabled(self):
        photos = self._two_photo_stack()
        protected, _ = run_stack(photos, protect_edges=True)
        unprotected, _ = run_stack(photos, protect_edges=False)
        line_x = 32
        mid = HEIGHT // 2 * WIDTH + line_x
        # Protection should not make the line *lighter* than unprotected.
        self.assertLessEqual(protected.composite.r[mid], unprotected.composite.r[mid])


class EditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.photos = synthetic_depth_stack(self.tmp)

    def _document(self):
        return validate_document({
            "version": 1,
            "edits": [{
                "id": "force-near",
                "image": 0,
                "note": "keep the near detail here",
                "enabled": True,
                "shapes": [{"kind": "rect", "x": 44, "y": 38, "width": 10, "height": 8}],
            }],
        }, 3)

    def test_override_replaces_labels_and_survives_roundtrip(self):
        document = self._document()
        path = Path(self.tmp) / "edits.json"
        save_edits(path, document)
        loaded = load_edits(path, 3)
        self.assertEqual(loaded, document)
        result, window = run_stack(self.photos, edits=loaded)
        for y in range(38, 46):
            for x in range(44, 54):
                self.assertEqual(result.labels[y * result.width + x], 0)
                self.assertTrue(result.flags[y * result.width + x] & FLAG_MANUAL)
        document_out = write_result(result, window, tempfile.mkdtemp(dir=self.tmp))
        record = document_out["manual_edits"][0]
        self.assertEqual(record["id"], "force-near")
        self.assertEqual(record["painted"], 10 * 8)

    def test_override_is_reproducible_across_runs(self):
        document = self._document()
        first, _ = run_stack(self.photos, edits=document)
        second, _ = run_stack(self.photos, edits=document)
        self.assertEqual(list(first.labels), list(second.labels))

    def test_edit_geometry_is_reused_from_file_not_rerasterised(self):
        # Changing only the file content must change the output; rerunning the
        # same file must not.  Together these pin the edit file as the source
        # of truth.
        document = self._document()
        first, _ = run_stack(self.photos, edits=document)
        edited = validate_document({
            "version": 1,
            "edits": [{
                "id": "force-near", "image": 0, "enabled": True,
                "shapes": [{"kind": "rect", "x": 44, "y": 38, "width": 20, "height": 8}],
            }],
        }, 3)
        second, _ = run_stack(self.photos, edits=edited)
        self.assertNotEqual(list(first.labels), list(second.labels))

    def test_bad_edit_documents_are_rejected(self):
        with self.assertRaises(EditError):
            validate_document({"version": 99, "edits": []}, 3)
        with self.assertRaises(EditError):
            validate_document({"version": 1, "edits": [{"image": 9, "shapes": []}]}, 3)
        with self.assertRaises(EditError):
            validate_document({"version": 1, "edits": [{
                "image": 0, "shapes": [{"kind": "rect", "x": 0, "y": 0, "width": -1, "height": 1}],
            }]}, 3)
        with self.assertRaises(EditError):
            validate_document({"version": 1, "edits": [{
                "image": 0, "shapes": [{"kind": "polygon", "points": [[0, 0], [1, 1]]}],
            }]}, 3)

    def test_override_cannot_invent_unrecorded_pixels(self):
        document = validate_document({
            "version": 1,
            "edits": [{"image": 1, "shapes": [{"kind": "rect", "x": 0, "y": 0, "width": 4, "height": 4}]}],
        }, 3)
        result, _ = run_stack(self.photos, edits=document, offsets=[(0, 0), (16, 0), (0, 0)])
        # Photo 1 covers canvas x >= 16, so the top-left override cannot apply.
        for y in range(4):
            for x in range(4):
                self.assertNotEqual(result.labels[y * result.width + x], 1)


class ReviewTests(unittest.TestCase):
    def test_review_document_lists_regions_and_legend(self):
        tmp = tempfile.mkdtemp()
        photos = synthetic_depth_stack(tmp)
        result, window = run_stack(photos)
        out = tempfile.mkdtemp(dir=tmp)
        document = write_result(result, window, out)
        self.assertIn("regions", document)
        self.assertIn("reasons_legend", document)
        self.assertTrue(Path(out, "review.json").exists())
        self.assertTrue(Path(out, "review-overlay.png").exists())
        self.assertTrue(Path(out, "sources.png").exists())
        self.assertTrue(Path(out, "seams.png").exists())
        for region in document["regions"]:
            self.assertIn("bbox", region)
            self.assertIn("reason", region)
            self.assertGreater(region["area"], 0)
            self.assertLessEqual(region["area"], 64 * 64)
        saved = json.loads(Path(out, "review.json").read_text())
        self.assertEqual(saved["tool"], "focusstack")

    def test_review_mentions_manual_edits(self):
        tmp = tempfile.mkdtemp()
        photos = synthetic_depth_stack(tmp)
        document_in = validate_document({
            "version": 1,
            "edits": [{"id": "pin", "image": 2, "enabled": True,
                       "shapes": [{"kind": "ellipse", "cx": 20, "cy": 20, "rx": 5, "ry": 5}]}],
        }, 3)
        result, window = run_stack(photos, edits=document_in)
        document = write_result(result, window, tempfile.mkdtemp())
        self.assertEqual(len(document["manual_edits"]), 1)
        self.assertGreater(document["manual_edits"][0]["painted"], 0)

    def test_uncovered_regions_are_reported(self):
        tmp = tempfile.mkdtemp()
        photos = synthetic_depth_stack(tmp)
        clear = read_png(photos[0])
        alpha = array("B", [0]) * (WIDTH * HEIGHT)
        cutout = Image(WIDTH, HEIGHT, array("B", clear.r), array("B", clear.g),
                       array("B", clear.b), alpha, name="transparent")
        path = Path(tmp) / "transparent.png"
        write_png(path, cutout)
        result, window = run_stack([str(path), photos[1], photos[2]],
                                   offsets=[(0, 0), (20, 0), (20, 0)], coverage="keep")
        document = write_result(result, window, tempfile.mkdtemp())
        uncovered = [r for r in document["regions"] if r["reason"] == "uncovered"]
        self.assertTrue(uncovered)
        # Only the left 20 columns have no source: the reference is
        # transparent everywhere and the other two photos start at x=20.
        self.assertEqual(document["usage"]["uncovered"], 20 * HEIGHT)
        uncovered_region = next(r for r in document["regions"] if r["reason"] == "uncovered")
        self.assertEqual(uncovered_region["area"], 20 * HEIGHT)
        self.assertEqual(uncovered_region["bbox"], [0, 0, 20, HEIGHT])


class PngTests(unittest.TestCase):
    def test_rgba_roundtrip_and_dimension_validation(self):
        tmp = tempfile.mkdtemp()
        image = Image(3, 2, array("B", [1, 2, 3, 4, 5, 6]),
                      array("B", [7, 8, 9, 10, 11, 12]),
                      array("B", [13, 14, 15, 16, 17, 18]),
                      array("B", [0, 64, 128, 192, 250, 255]))
        path = Path(tmp) / "rgba.png"
        write_png(path, image)
        loaded = read_png(path)
        self.assertIsNotNone(loaded.a)
        self.assertEqual(list(loaded.a), list(image.a))
        self.assertEqual(loaded.pixel(2, 1), (6, 12, 18, 255))
        with self.assertRaises(Exception):
            Image(4, 2, array("B", [0]) * 7, array("B", [0]) * 8, array("B", [0]) * 8)


if __name__ == "__main__":
    unittest.main()
