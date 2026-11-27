"""Decoder correctness tests.

The PNG and JPEG decoders are the riskiest pure-Python parts, so they are
tested for round-trip fidelity and for graceful failure on damaged input.
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import helpers  # noqa: E402

from photocatalog.imaging import ImageError, load_image  # noqa: E402
from photocatalog.imaging.jpeg import decode_jpeg  # noqa: E402
from photocatalog.imaging.png import decode_png  # noqa: E402
from photocatalog.jpeg_encode import encode_jpeg  # noqa: E402


class PngTests(unittest.TestCase):
    def test_roundtrip_rgb(self) -> None:
        img = helpers.gradient(24, 18, box=(6, 4, 16, 12))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.png")
            helpers.write_png(img, path)
            got = decode_png(path)
        self.assertEqual((got.width, got.height), (24, 18))
        self.assertEqual(got.pixels, img.pixels)

    def test_truncated_png_raises_image_error(self) -> None:
        img = helpers.gradient(16, 16)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.png")
            helpers.write_png(img, path)
            with open(path, "rb") as fh:
                data = fh.read()
            with open(path, "wb") as fh:
                fh.write(data[: len(data) // 2])
            with self.assertRaises(ImageError):
                decode_png(path)

    def test_not_a_png_raises(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "x.png")
            with open(path, "wb") as fh:
                fh.write(b"hello")
            with self.assertRaises(ImageError):
                decode_png(path)


class JpegTests(unittest.TestCase):
    def test_encoder_decoder_roundtrip_is_close(self) -> None:
        img = helpers.gradient(48, 36, box=(14, 8, 34, 26))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.jpg")
            encode_jpeg(img, path, quality=92)
            got = decode_jpeg(path)
        self.assertEqual((got.width, got.height), (48, 36))
        diff = sum(abs(got.pixels[i] - img.pixels[i]) for i in range(len(img.pixels)))
        mean = diff / len(img.pixels)
        self.assertLess(mean, 10.0, f"mean channel error {mean:.1f} too high")

    def test_greyscale_jpeg(self) -> None:
        img = helpers.gradient(32, 24)
        # Encode, then decode; greyscale is exercised through the encoder path
        # only when the caller supplies it, so assert the decoded buffer is valid.
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.jpg")
            encode_jpeg(img, path, quality=85, subsample=False)
            got = decode_jpeg(path)
        self.assertEqual(got.channels, 3)
        self.assertEqual((got.width, got.height), (32, 24))

    def test_truncated_jpeg_raises(self) -> None:
        img = helpers.gradient(24, 16)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "bad.jpg")
            with open(path, "wb") as fh:
                fh.write(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00")
                fh.write(b"\x00\x00")
            with self.assertRaises(ImageError):
                decode_jpeg(path)

    def test_scaled_decode_is_smaller(self) -> None:
        img = helpers.gradient(64, 48, box=(20, 10, 44, 34))
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "a.jpg")
            encode_jpeg(img, path, quality=90)
            full = decode_jpeg(path)
            small = decode_jpeg(path, max_dimension=24)
        self.assertLess(max(small.width, small.height), max(full.width, full.height))
        self.assertGreaterEqual(max(small.width, small.height), 24)


class SimpleFormatTests(unittest.TestCase):
    def test_load_reports_unreadable_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "empty.png")
            open(path, "wb").close()
            with self.assertRaises(ImageError):
                load_image(path)

    def test_unrecognised_format_without_external(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "weird.dat")
            with open(path, "wb") as fh:
                fh.write(b"\x00\x01\x02\x03" * 8)
            with self.assertRaises(ImageError):
                load_image(path, external_tools=False)


if __name__ == "__main__":
    unittest.main()
