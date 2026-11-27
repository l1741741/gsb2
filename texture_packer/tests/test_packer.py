"""End-to-end and unit tests for the texture atlas packer.

Run from texture_packer/ with:  python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import shutil
import unittest

from texturepacker.atlas import (
    STATUS_FULLY_TRANSPARENT,
    STATUS_PLACED,
    STATUS_REJECTED,
    build_atlas,
    load_sources,
    restore_all,
    restore_sprite,
)
from texturepacker.image import Image, rotate_point_90_cw
from texturepacker.png import read_png
from texturepacker.packer import (
    PackItem,
    Rect,
    pack,
    rectangles_overlap,
    verify_no_overlap,
)
from texturepacker.samplegen import generate_samples


class TempDirCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = os.path.join(
            os.environ.get("TMPDIR", "/tmp"), f"tp_test_{type(self).__name__}_{id(self)}"
        )
        os.makedirs(self.tmp, exist_ok=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def path(self, *parts: str) -> str:
        return os.path.join(self.tmp, *parts)


class TestImagePrimitives(unittest.TestCase):
    def test_alpha_bbox_and_trim(self):
        img = Image(10, 8)
        # Content occupies x=3..6, y=2..4
        for y in range(2, 5):
            for x in range(3, 7):
                img.pixels[(y * 10 + x) * 4 + 3] = 255
        self.assertEqual(img.alpha_bbox(), (3, 2, 7, 5))
        cropped = img.crop(3, 2, 7, 5)
        self.assertEqual((cropped.width, cropped.height), (4, 3))

    def test_fully_transparent_bbox(self):
        self.assertIsNone(Image(4, 4).alpha_bbox())

    def test_rotation_roundtrip(self):
        img = Image(5, 3)
        for y in range(3):
            for x in range(5):
                i = (y * 5 + x) * 4
                img.pixels[i : i + 4] = bytes((x * 50, y * 80, 10, 255))
        back = img.rotate_90_cw().rotate_90_ccw()
        self.assertEqual((back.width, back.height), (5, 3))
        self.assertEqual(back.pixels, img.pixels)

    def test_rotation_point_mapping(self):
        # (0,0) top-left goes to top-right after CW rotation.
        self.assertEqual(rotate_point_90_cw(0, 0, 5, 3), (2, 0))
        self.assertEqual(rotate_point_90_cw(4, 2, 5, 3), (0, 4))

    def test_extruded_padding_content_vs_fill(self):
        img = Image(2, 1)
        img.pixels[:] = bytes((10, 20, 30, 255, 40, 50, 60, 255))
        padded = img.add_extruded_padding(2)
        self.assertEqual((padded.width, padded.height), (6, 5))
        # Inner rect is the original image untouched.
        inner = padded.crop(2, 2, 4, 3)
        self.assertEqual(inner.pixels, img.pixels)
        # Corner fill copies the nearest edge pixel (clamp to edge).
        self.assertEqual(padded.get_pixel(0, 0), (10, 20, 30, 255))
        self.assertEqual(padded.get_pixel(5, 4), (40, 50, 60, 255))

    def test_blit_rejects_overflow(self):
        canvas = Image(4, 4)
        with self.assertRaises(ValueError):
            canvas.blit(Image(3, 3), 3, 3)


class TestPngRoundTrip(TempDirCase):
    def test_write_read_preserves_pixels(self):
        img = Image(3, 2)
        values = [
            (0, 0, 0, 0),
            (255, 0, 0, 128),
            (0, 255, 0, 255),
            (0, 0, 255, 64),
            (255, 255, 255, 255),
            (1, 2, 3, 4),
        ]
        for i, c in enumerate(values):
            img.pixels[i * 4 : i * 4 + 4] = bytes(c)
        path = self.path("roundtrip.png")
        img.save_png(path)
        loaded = Image.from_png(path)
        self.assertEqual((loaded.width, loaded.height), (3, 2))
        self.assertEqual(loaded.pixels, img.pixels)


class TestPacker(unittest.TestCase):
    def test_no_overlap_and_within_page(self):
        items = [PackItem(f"i{k}", 10 + k, 8 + (k % 3) * 4) for k in range(12)]
        result = pack(items, 40, 40, max_pages=2)
        self.assertEqual(result.rejected, [])
        verify_no_overlap(result.placements)
        for p in result.placements:
            self.assertGreaterEqual(p.x, 0)
            self.assertGreaterEqual(p.y, 0)
            self.assertLessEqual(p.x + p.width, 40)
            self.assertLessEqual(p.y + p.height, 40)

    def test_rotation_required(self):
        # 30x10 fits a 16x32 page only when rotated to 10x30.
        result = pack([PackItem("wide", 30, 10)], 16, 32, max_pages=1)
        self.assertEqual(len(result.placements), 1)
        self.assertTrue(result.placements[0].rotated)

    def test_no_rotation_rejected(self):
        result = pack(
            [PackItem("wide", 30, 10, rotatable=False)], 16, 32, max_pages=1
        )
        self.assertEqual(len(result.placements), 0)
        self.assertIn("oversized", result.rejected[0].reason)

    def test_oversized_reason(self):
        result = pack([PackItem("huge", 100, 100)], 40, 40, max_pages=1)
        self.assertEqual(len(result.placements), 0)
        reason = result.rejected[0].reason
        self.assertIn("oversized", reason)
        self.assertIn("100x100", reason)
        self.assertIn("40x40", reason)

    def test_no_space_reason(self):
        items = [PackItem(f"b{k}", 25, 25) for k in range(4)]
        result = pack(items, 40, 40, max_pages=1)
        # A 40x40 page holds at most one 25x25 rect under non-overlapping splits.
        self.assertEqual(len(result.placements), 1)
        self.assertEqual(len(result.rejected), 3)
        self.assertIn("no space", result.rejected[0].reason)

    def test_deterministic_regardless_of_order(self):
        a = [PackItem(f"i{k}", 7 + (k * 3) % 11, 6 + (k * 5) % 13) for k in range(15)]
        b = list(reversed(a))
        r1 = pack(a, 48, 48, max_pages=2)
        r2 = pack(b, 48, 48, max_pages=2)
        key = lambda ps: [(p.item_id, p.page, p.x, p.y, p.rotated) for p in ps.placements]
        self.assertEqual(key(r1), key(r2))

    def test_rectangles_overlap_helper(self):
        self.assertTrue(rectangles_overlap(Rect(0, 0, 5, 5), Rect(4, 4, 2, 2)))
        self.assertFalse(rectangles_overlap(Rect(0, 0, 5, 5), Rect(5, 0, 2, 2)))


class TestAtlasPipeline(TempDirCase):
    def _make_source(self, name: str, img: Image, anchor=None) -> str:
        d = self.path("src")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, name)
        img.save_png(path)
        if anchor is not None:
            anchors_path = self.path("anchors.json")
            data = {"images": []}
            if os.path.exists(anchors_path):
                with open(anchors_path) as fh:
                    data = json.load(fh)
            data["images"].append({"name": name, "anchor": list(anchor)})
            with open(anchors_path, "w") as fh:
                json.dump(data, fh)
        return path

    def test_trim_metadata_and_exact_restore(self):
        img = Image(12, 10)
        for y in range(3, 8):
            for x in range(4, 9):
                img.pixels[(y * 12 + x) * 4 : (y * 12 + x) * 4 + 4] = (
                    bytes((120, 30, 200, 255))
                )
        self._make_source("blob.png", img, anchor=(5.0, 7.5))
        records = load_sources(self.path("src"), self.path("anchors.json"))
        meta = build_atlas(
            records,
            self.path("out"),
            page_width=64,
            page_height=64,
            max_pages=1,
            padding=2,
            allow_rotation=True,
        )
        sprite = next(s for s in meta["sprites"] if s["name"] == "blob.png")
        self.assertEqual(sprite["status"], STATUS_PLACED)
        self.assertEqual(sprite["source_size"], {"w": 12, "h": 10})
        self.assertEqual(sprite["trim_offset"], {"x": 4, "y": 3})
        self.assertEqual(sprite["trimmed_size"], {"w": 5, "h": 5})
        self.assertEqual(sprite["padding"], 2)
        # Frame includes padding on both sides: 5 + 4 = 9.
        self.assertEqual((sprite["frame"]["w"], sprite["frame"]["h"]), (9, 9))
        self.assertIsNotNone(sprite["anchor"])
        self.assertIsNotNone(sprite["atlas_anchor"])

        written = restore_all(self.path("out"), self.path("restored"))["written"]
        restored = Image.from_png(written[0])
        self.assertEqual((restored.width, restored.height), (12, 10))
        self.assertEqual(restored.pixels, img.pixels)

    def test_fully_transparent_recorded(self):
        self._make_source("blank.png", Image(7, 5))
        records = load_sources(self.path("src"))
        meta = build_atlas(
            records, self.path("out"), 32, 32, 1, padding=1, allow_rotation=True
        )
        sprite = meta["sprites"][0]
        self.assertEqual(sprite["status"], STATUS_FULLY_TRANSPARENT)
        self.assertIsNone(sprite["frame"])
        self.assertEqual(sprite["source_size"], {"w": 7, "h": 5})
        # Restore yields an empty canvas of the original size.
        restore_all(self.path("out"), self.path("restored"))
        restored = read_png(self.path("restored", "blank.png"))
        self.assertEqual((restored["width"], restored["height"]), (7, 5))
        self.assertEqual(set(restored["pixels"][3::4]), {0})

    def test_rotation_restore_and_anchor(self):
        # Wide image that must rotate to fit a narrow page.
        img = Image(30, 8)
        for y in range(2, 6):
            for x in range(1, 29):
                img.pixels[(y * 30 + x) * 4 : (y * 30 + x) * 4 + 4] = bytes(
                    (50, 150, 90, 255)
                )
        self._make_source("wide.png", img, anchor=(10.0, 4.0))
        records = load_sources(self.path("src"), self.path("anchors.json"))
        meta = build_atlas(
            records, self.path("out"), 16, 40, 1, padding=1, allow_rotation=True
        )
        sprite = meta["sprites"][0]
        self.assertTrue(sprite["frame"]["rotated90"])
        # Anchor must map to a point inside the placed frame.
        ax, ay = sprite["atlas_anchor"]["x"], sprite["atlas_anchor"]["y"]
        f = sprite["frame"]
        self.assertTrue(f["x"] <= ax < f["x"] + f["w"])
        self.assertTrue(f["y"] <= ay < f["y"] + f["h"])
        restore_all(self.path("out"), self.path("restored"))
        restored = Image.from_png(self.path("restored", "wide.png"))
        self.assertEqual(restored.pixels, img.pixels)

    def test_overflow_diagnosis_through_pipeline(self):
        # Content fills the whole 80x80 canvas: even after trimming it cannot
        # fit a 32x32 page in either orientation.
        img = Image(80, 80)
        for y in range(80):
            for x in range(80):
                i = (y * 80 + x) * 4
                img.pixels[i : i + 4] = bytes((100, 100, 100, 255))
        self._make_source("big.png", img)
        records = load_sources(self.path("src"))
        meta = build_atlas(
            records, self.path("out"), 32, 32, 1, padding=0, allow_rotation=True
        )
        self.assertEqual(meta["sprites"][0]["status"], STATUS_REJECTED)
        self.assertIn("oversized", meta["rejected"][0]["reason"])
        with self.assertRaises(ValueError):
            restore_sprite({}, meta["sprites"][0])

    def test_input_order_independence_end_to_end(self):
        colors = [(200, 30, 30), (30, 200, 30), (30, 30, 200), (200, 200, 30)]
        for k, c in enumerate(colors):
            img = Image(10 + k * 2, 8 + k)
            for y in range(img.height):
                for x in range(img.width):
                    img.pixels[(y * img.width + x) * 4 : (y * img.width + x) * 4 + 4] = bytes(
                        (*c, 255)
                    )
            self._make_source(f"c{k}.png", img)

        def run():
            records = load_sources(self.path("src"))
            return build_atlas(
                records, self.path(f"out_{id(records)}"), 64, 64, 1, 1, True
            )

        meta1 = run()
        # Rename source files into a different traversal order and rebuild.
        src = self.path("src")
        shutil.move(os.path.join(src, "c0.png"), os.path.join(src, "zz_c0.png"))
        records2 = load_sources(src)
        # Normalize ids back so metadata can be compared structurally.
        for rec in records2:
            if rec.item_id == "zz_c0.png":
                rec.item_id = "c0.png"
        meta2 = build_atlas(
            records2, self.path("out2"), 64, 64, 1, 1, True
        )
        frames1 = {s["name"]: s["frame"] for s in meta1["sprites"]}
        frames2 = {s["name"]: s["frame"] for s in meta2["sprites"]}
        self.assertEqual(frames1, frames2)


class TestBuiltinSamples(TempDirCase):
    def test_sample_workflow(self):
        sample_dir = self.path("samples")
        generate_samples(sample_dir)
        records = load_sources(
            os.path.join(sample_dir, "src"),
            os.path.join(sample_dir, "anchors.json"),
        )
        names = {r.item_id for r in records}
        self.assertEqual(
            names,
            {
                "icon_slim_margin.png",
                "tower_asymmetric.png",
                "ribbon_wide.png",
                "blank_fully_transparent.png",
                "giant_overflow.png",
            },
        )
        # Non-square page: the 62px-wide ribbon only fits after rotation,
        # while the tall tower fits upright.
        meta = build_atlas(
            records,
            self.path("atlas"),
            page_width=48,
            page_height=64,
            max_pages=2,
            padding=2,
            allow_rotation=True,
        )
        statuses = {s["name"]: s["status"] for s in meta["sprites"]}
        self.assertEqual(statuses["blank_fully_transparent.png"], STATUS_FULLY_TRANSPARENT)
        self.assertEqual(statuses["giant_overflow.png"], STATUS_REJECTED)
        placed = [s for s in meta["sprites"] if s["status"] == STATUS_PLACED]
        # The ribbon only fits via rotation on a 64px page.
        ribbon = next(s for s in placed if s["name"] == "ribbon_wide.png")
        self.assertTrue(ribbon["frame"]["rotated90"])
        # Padding metadata distinguishes real content from bleed fill.
        for s in placed:
            self.assertEqual(s["padding"], 2)
            self.assertEqual(meta["settings"]["padding_policy"], "edge_extrude")

        # Every placed image restores byte-for-byte to its source.
        restore_all(self.path("atlas"), self.path("restored"))
        for s in placed:
            src_img = Image.from_png(os.path.join(sample_dir, "src", s["name"]))
            out_img = Image.from_png(self.path("restored", s["name"]))
            self.assertEqual(out_img.pixels, src_img.pixels, msg=s["name"])
            self.assertEqual((out_img.width, out_img.height), (src_img.width, src_img.height))

        # Running again with rotation disabled: ribbon now fails with a reason.
        records2 = load_sources(
            os.path.join(sample_dir, "src"),
            os.path.join(sample_dir, "anchors.json"),
        )
        meta_no_rot = build_atlas(
            records2,
            self.path("atlas_norot"),
            page_width=48,
            page_height=64,
            max_pages=2,
            padding=2,
            allow_rotation=False,
        )
        rejected_names = {r["name"] for r in meta_no_rot["rejected"]}
        self.assertIn("ribbon_wide.png", rejected_names)
        self.assertIn("giant_overflow.png", rejected_names)


if __name__ == "__main__":
    unittest.main()
