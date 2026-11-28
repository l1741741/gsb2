"""Geometry and PNG-format tests.

The editor writes shapes in canvas coordinates; ``rasterise_shape`` turns
them into a mask and a canvas bounding box.  The stacker relies on that
rasteriser, so its edges (inclusive rectangle bounds, filled ellipse
interior, polygon fill rule, brush distance) are tested directly.
"""

import tempfile
import unittest
import zlib
import struct
from array import array
from pathlib import Path

from focusstack.edits import (
    EditError,
    apply_edits,
    rasterise_shape,
    validate_document,
)
from focusstack.image import Image
from focusstack.pngio import PngError, read_png, write_png
from focusstack.select import FLAG_MANUAL, FLAG_MANUAL_PARTIAL


class RasteriseTests(unittest.TestCase):
    def test_rect_covers_exact_integer_bounds(self):
        mask, touched = rasterise_shape(
            {"kind": "rect", "x": 4, "y": 6, "width": 5, "height": 3, "strength": 1.0},
            (0, 0, 20, 20), 20, 20,
        )
        self.assertEqual(touched, [(4, 6, 9, 9)])
        for y in range(6, 9):
            for x in range(4, 9):
                self.assertEqual(mask[y * 20 + x], 255)
        self.assertEqual(mask[6 * 20 + 9], 0)
        self.assertEqual(mask[9 * 20 + 4], 0)

    def test_rect_fractions_cover_touched_pixels(self):
        mask, touched = rasterise_shape(
            {"kind": "rect", "x": 4.4, "y": 6.7, "width": 2.2, "height": 1.1},
            (0, 0, 20, 20), 20, 20,
        )
        self.assertEqual(touched, [(4, 6, 7, 8)])
        self.assertEqual(mask[6 * 20 + 4], 255)
        self.assertEqual(mask[7 * 20 + 6], 255)
        self.assertEqual(mask[8 * 20 + 6], 0)

    def test_ellipse_is_round_and_bounded(self):
        mask, touched = rasterise_shape(
            {"kind": "ellipse", "cx": 10.0, "cy": 10.0, "rx": 6.0, "ry": 3.0},
            (0, 0, 24, 24), 24, 24,
        )
        self.assertEqual(touched, [(4, 7, 16, 13)])
        self.assertEqual(mask[10 * 24 + 10], 255)   # centre
        self.assertEqual(mask[7 * 24 + 10], 255)    # top of the major axis
        self.assertEqual(mask[13 * 24 + 10], 0)     # just past ry
        self.assertEqual(mask[10 * 24 + 16], 0)     # just past rx
        self.assertEqual(mask[4 * 24 + 4], 0)       # corner is outside
        self.assertGreater(mask[7 * 24 + 7], 0)     # soft edge pixel
        self.assertLess(mask[7 * 24 + 7], 255)

    def test_polygon_uses_even_odd_fill(self):
        mask, touched = rasterise_shape(
            {"kind": "polygon", "points": [[2, 2], [15, 2], [15, 12], [2, 12]]},
            (0, 0, 20, 16), 20, 16,
        )
        self.assertEqual(touched, [(2, 2, 15, 12)])
        self.assertEqual(mask[6 * 20 + 8], 255)
        self.assertEqual(mask[2 * 20 + 16], 0)

    def test_brush_stroke_covers_distance_and_caps(self):
        mask, touched = rasterise_shape(
            {"kind": "brush", "points": [[3, 10], [17, 10]], "radius": 1.4},
            (0, 0, 20, 20), 20, 20,
        )
        self.assertEqual(touched, [(1, 8, 19, 12)])
        # Pixel centres at y=9.5 and 10.5 lie inside a 1.4px radius; y=8.5
        # and 11.5 lie outside, so the stroke is two rows tall.
        self.assertEqual(mask[9 * 20 + 10], 242)
        self.assertEqual(mask[10 * 20 + 10], 242)
        self.assertEqual(mask[11 * 20 + 10], 0)
        self.assertEqual(mask[10 * 20 + 19], 0)     # ends before the bbox edge

    def test_shape_strength_becomes_partial_coverage(self):
        mask, _ = rasterise_shape(
            {"kind": "rect", "x": 0, "y": 0, "width": 4, "height": 4, "strength": 0.5},
            (0, 0, 8, 8), 8, 8,
        )
        self.assertEqual(mask[0], 128)
        self.assertGreater(mask[0], 0)
        self.assertLess(mask[0], 255)

    def test_shapes_outside_window_do_not_paint(self):
        mask, touched = rasterise_shape(
            {"kind": "rect", "x": 40, "y": 40, "width": 5, "height": 5},
            (0, 0, 10, 10), 100, 100,
        )
        self.assertEqual(touched, [(40, 40, 45, 45)])  # canvas bbox still reported
        self.assertEqual(sum(1 for v in mask if v), 0)


class ApplyEditTests(unittest.TestCase):
    def _document(self):
        return validate_document({"version": 1, "edits": [{
            "id": "e", "image": 2, "enabled": True,
            "shapes": [{"kind": "rect", "x": 2, "y": 2, "width": 3, "height": 3}],
        }]}, 4)

    def test_apply_sets_labels_and_flags(self):
        width = 10
        labels = array("h", [0]) * 100
        flags = array("B", bytes(100))
        valid = [array("B", [255]) * 100 for _ in range(4)]
        records = apply_edits(self._document(), labels, flags, width, 10, photo_valid=valid)
        self.assertEqual(labels[2 * width + 2], 2)
        self.assertEqual(flags[2 * width + 2], FLAG_MANUAL)
        self.assertEqual(records[0]["painted"], 9)

    def test_partial_override_gets_partial_flag(self):
        width = 10
        labels = array("h", [0]) * 100
        flags = array("B", bytes(100))
        valid = [array("B", [255]) * 100 for _ in range(4)]
        document = validate_document({"version": 1, "edits": [{
            "id": "e", "image": 1, "enabled": True,
            "shapes": [{"kind": "rect", "x": 1, "y": 1, "width": 2, "height": 2, "strength": 0.4}],
        }]}, 4)
        apply_edits(document, labels, flags, width, 10, photo_valid=valid)
        self.assertTrue(flags[1 * width + 1] & FLAG_MANUAL_PARTIAL)

    def test_disabled_edits_are_reported_but_not_applied(self):
        document = self._document()
        document["edits"][0]["enabled"] = False
        labels = array("h", [0]) * 100
        flags = array("B", bytes(100))
        valid = [array("B", [255]) * 100 for _ in range(4)]
        records = apply_edits(document, labels, flags, 10, 10, photo_valid=valid)
        self.assertEqual(records[0]["enabled"], False)
        self.assertEqual(records[0]["painted"], 0)
        self.assertEqual(labels[2 * 10 + 2], 0)

    def test_in_window_counts_only_overlap(self):
        width = 10
        labels = array("h", [0]) * 100
        flags = array("B", bytes(100))
        valid = [array("B", [255]) * 100 for _ in range(4)]
        document = validate_document({"version": 1, "edits": [{
            "id": "e", "image": 1, "shapes": [{"kind": "rect", "x": 0, "y": 0, "width": 10, "height": 10}],
        }]}, 4)
        records = apply_edits(document, labels, flags, width, 10, photo_valid=valid,
                              report_window=(5, 0, 5, 10))
        self.assertEqual(records[0]["painted"], 100)
        self.assertEqual(records[0]["in_window"], 50)


class PngFormatTests(unittest.TestCase):
    def _write_raw(self, width, height, bit_depth, color_type, raw_rows, palette=None, trns=None):
        """Build a PNG with explicit scanline bytes (filter type 0)."""
        def chunk(kind, data):
            return (struct.pack(">I4s", len(data), kind) + data
                    + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
        ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, 0)
        body = b"".join(b"\x00" + bytes(row) for row in raw_rows)
        parts = [b"\x89PNG\r\n\x1a\n", chunk(b"IHDR", ihdr)]
        if palette is not None:
            parts.append(chunk(b"PLTE", palette))
        if trns is not None:
            parts.append(chunk(b"tRNS", trns))
        parts.append(chunk(b"IDAT", zlib.compress(body)))
        parts.append(chunk(b"IEND", b""))
        return b"".join(parts)

    def _read_blob(self, blob):
        from focusstack.pngio import _decode
        return _decode(blob, "raw")

    def test_grayscale_8bit(self):
        blob = self._write_raw(4, 2, 8, 0, [[0, 80, 160, 255], [10, 20, 30, 40]])
        image = self._read_blob(blob)
        self.assertEqual(image.pixel(2, 0), (160, 160, 160))
        self.assertEqual(image.pixel(3, 1), (40, 40, 40))

    def test_palette_with_transparency(self):
        blob = self._write_raw(2, 1, 8, 3, [[0, 1]], palette=bytes([10, 20, 30, 40, 50, 60]),
                               trns=bytes([255, 0]))
        image = self._read_blob(blob)
        self.assertEqual(image.pixel(0, 0), (10, 20, 30, 255))
        self.assertEqual(image.pixel(1, 0), (40, 50, 60, 0))

    def test_one_bit_grayscale(self):
        # 8 pixels per byte: 10101010 -> alternating black/white.
        blob = self._write_raw(8, 1, 1, 0, [[0xAA]])
        image = self._read_blob(blob)
        self.assertEqual(image.pixel(0, 0), (255, 255, 255))
        self.assertEqual(image.pixel(1, 0), (0, 0, 0))

    def test_sixteen_bit_keeps_high_byte(self):
        # Two 16-bit samples: 0x0102 and 0xFFEE -> 1 and 255 after truncation.
        blob = self._write_raw(2, 1, 16, 0, [[1, 2, 255, 238]])
        image = self._read_blob(blob)
        self.assertEqual(image.pixel(0, 0), (1, 1, 1))
        self.assertEqual(image.pixel(1, 0), (255, 255, 255))
        self.assertEqual(image.source_bit_depth, 16)

    def test_crc_mismatch_is_rejected(self):
        blob = bytearray(self._write_raw(2, 1, 8, 0, [[1, 2]]))
        blob[16] ^= 0xFF  # corrupt IHDR payload, leaving CRC stale
        with self.assertRaises(PngError):
            self._read_blob(bytes(blob))

    def test_interlaced_rejected(self):
        def chunk(kind, data):
            return (struct.pack(">I4s", len(data), kind) + data
                    + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
        ihdr = struct.pack(">IIBBBBB", 2, 1, 8, 0, 0, 0, 1)
        blob = b"".join([b"\x89PNG\r\n\x1a\n", chunk(b"IHDR", ihdr),
                         chunk(b"IDAT", zlib.compress(b"\x00\x01\x02")),
                         chunk(b"IEND", b"")])
        with self.assertRaises(PngError):
            self._read_blob(blob)

    def test_encoder_roundtrip_is_pixel_identical(self):
        source = Image(5, 3, array("B", range(15)), array("B", range(15, 30)),
                       array("B", range(30, 45)))
        path = Path(tempfile.mkdtemp()) / "roundtrip.png"
        write_png(path, source)
        loaded = read_png(path)
        self.assertEqual(list(loaded.r), list(source.r))
        self.assertEqual(list(loaded.g), list(source.g))
        self.assertEqual(list(loaded.b), list(source.b))
        self.assertIsNone(loaded.a)


if __name__ == "__main__":
    unittest.main()
