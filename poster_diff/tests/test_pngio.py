"""PNG codec round trips and color-type handling (stdlib only)."""

from __future__ import annotations

import os
import struct
import tempfile
import unittest
import zlib

from helpers import make_rgba, roundtrip_png, set_rect
from poster_diff.pngio import Image, PngError, read_png, write_png


def _manual_png(path: str, width: int, height: int, color_type: int,
                 bit_depth: int, raw_rows: bytes, palette=None, trns=None):
    """Encode a PNG with arbitrary color type for decoder tests."""
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color_type]
    stride = (width * bit_depth * channels + 7) // 8

    def chunk(tag, payload):
        return (
            struct.pack(">I", len(payload)) + tag + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    raw = bytearray()
    for y in range(height):
        raw.append(0)
        raw.extend(raw_rows[y * stride:(y + 1) * stride])
    with open(path, "wb") as fh:
        fh.write(b"\x89PNG\r\n\x1a\n")
        ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, 0)
        fh.write(chunk(b"IHDR", ihdr))
        if palette is not None:
            fh.write(chunk(b"PLTE", palette))
        if trns is not None:
            fh.write(chunk(b"tRNS", trns))
        fh.write(chunk(b"IDAT", zlib.compress(bytes(raw))))
        fh.write(chunk(b"IEND", b""))


class PngTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def test_rgb_rgba_roundtrip(self):
        rgb = Image(5, 4, 3, bytearray(range(60)))
        path = os.path.join(self.tmp, "rgb.png")
        write_png(path, rgb)
        self.assertEqual(read_png(path).data, rgb.data)

        rgba = make_rgba(7, 3)
        set_rect(rgba, 1, 1, 3, 2, (10, 200, 90, 128))
        roundtrip_png(self.tmp, rgba, "rgba.png")

    def test_grayscale_decode(self):
        path = os.path.join(self.tmp, "gray.png")
        rows = bytes([0, 128, 255, 64])  # 4 pixels, 8-bit gray
        _manual_png(path, 4, 1, 0, 8, rows)
        img = read_png(path)
        self.assertEqual(img.channels, 1)
        self.assertEqual(list(img.data), [0, 128, 255, 64])

    def test_subbyte_grayscale_scaling(self):
        path = os.path.join(self.tmp, "gray1.png")
        # 8 pixels at bit depth 1, packed in one byte: 10110010
        rows = bytes([0b10110010])
        _manual_png(path, 8, 1, 0, 1, rows)
        img = read_png(path)
        self.assertEqual(list(img.data), [255, 0, 255, 255, 0, 0, 255, 0])

    def test_palette_with_trns(self):
        path = os.path.join(self.tmp, "p.png")
        palette = bytes([255, 0, 0, 0, 255, 0, 0, 0, 255])
        trns = bytes([0, 255])  # index 0 fully transparent
        _manual_png(path, 3, 1, 3, 8, bytes([0, 1, 2]), palette=palette, trns=trns)
        img = read_png(path)
        self.assertEqual(img.channels, 4)
        self.assertEqual(img.pixel(0, 0), (255, 0, 0, 0))
        self.assertEqual(img.pixel(1, 0), (0, 255, 0, 255))
        self.assertEqual(img.pixel(2, 0), (0, 0, 255, 255))

    def test_16bit_scales_endpoints(self):
        path = os.path.join(self.tmp, "g16.png")
        rows = struct.pack(">HH", 0, 65535)
        _manual_png(path, 2, 1, 0, 16, rows)
        img = read_png(path)
        self.assertEqual(list(img.data), [0, 255])

    def test_to_rgba_and_composite(self):
        img = Image(1, 1, 4, bytearray([200, 100, 50, 128]))
        flat = img.composite_on((0, 0, 0))
        r, g, b = flat.pixel(0, 0)
        self.assertEqual((r, g, b), (100, 50, 25))
        flat_white = img.composite_on((255, 255, 255))
        r2, g2, b2 = flat_white.pixel(0, 0)
        self.assertEqual((r2, g2, b2), (227, 177, 152))

    def test_bad_signature(self):
        path = os.path.join(self.tmp, "bad.png")
        with open(path, "wb") as fh:
            fh.write(b"not a png at all")
        with self.assertRaises(PngError):
            read_png(path)

    def test_interlaced_rejected(self):
        path = os.path.join(self.tmp, "i.png")
        with open(path, "wb") as fh:
            fh.write(b"\x89PNG\r\n\x1a\n")
            ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 1)
            fh.write(struct.pack(">I", 13) + b"IHDR" + ihdr
                     + struct.pack(">I", zlib.crc32(b"IHDR" + ihdr) & 0xFFFFFFFF))
        with self.assertRaises(PngError):
            read_png(path)


if __name__ == "__main__":
    unittest.main()
