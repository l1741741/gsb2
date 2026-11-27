"""Tests for the dependency-free PNG reader/writer.

Run from the inkproof directory:

    python3 -m unittest discover -s tests -v
"""

import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inkproof.pngio import (  # noqa: E402
    Image,
    PNGError,
    decode_png_bytes,
    encode_gray8_png,
    encode_rgba_png,
    parse_hex_colour,
    read_gray8,
    read_png,
    write_png,
)


def _chunk(kind: bytes, payload: bytes, crc: bool = True) -> bytes:
    body = struct.pack(">I", len(payload)) + kind + payload
    if not crc:
        return body + struct.pack(">I", 0)
    return body + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def _png(width, height, depth, color_type, raw_scanlines, extra=b"", interlace=0):
    ihdr = struct.pack(">IIBBBBB", width, height, depth, color_type, 0, 0, interlace)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + extra
        + _chunk(b"IDAT", zlib.compress(b"".join(raw_scanlines), 9))
        + _chunk(b"IEND", b"")
    )


class PNGRoundTripTests(unittest.TestCase):
    def test_rgba_round_trip_is_pixel_exact(self):
        pixels = [
            (255, 0, 0, 255),
            (0, 255, 0, 255),
            (0, 0, 255, 0),
            (1, 2, 3, 4),
            (128, 128, 128, 128),
            (17, 34, 51, 255),
        ]
        image = Image(3, 2, bytearray(bytes(channel for pixel in pixels for channel in pixel)))
        decoded = decode_png_bytes(encode_rgba_png(image))
        self.assertEqual(decoded.width, 3)
        self.assertEqual(decoded.height, 2)
        self.assertEqual(decoded.pixel(0, 0), pixels[0])
        self.assertEqual(decoded.pixel(2, 1), pixels[5])

    def test_gray8_round_trip(self):
        payload = bytes([0, 1, 2, 3, 4, 5])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "gray.png"
            path.write_bytes(encode_gray8_png(3, 2, payload))
            width, height, data = read_gray8(path)
        self.assertEqual((width, height), (3, 2))
        self.assertEqual(bytes(data), payload)

    def test_palette_with_trns_reads_alpha(self):
        palette = bytes([255, 0, 0, 0, 255, 0])
        transparency = bytes([255, 0])
        blob = _png(
            2,
            1,
            8,
            3,
            [bytes([0, 0, 1])],
            extra=_chunk(b"PLTE", palette) + _chunk(b"tRNS", transparency),
        )
        image = decode_png_bytes(blob)
        self.assertEqual(image.pixel(0, 0), (255, 0, 0, 255))
        self.assertEqual(image.pixel(1, 0), (0, 255, 0, 0))

    def test_rgb_trns_key_becomes_transparent(self):
        blob = _png(
            2,
            1,
            8,
            2,
            [bytes([0, 10, 20, 30, 200, 100, 50])],
            extra=_chunk(b"tRNS", struct.pack(">HHH", 10, 20, 30)),
        )
        image = decode_png_bytes(blob)
        self.assertEqual(image.pixel(0, 0), (0, 0, 0, 0))
        self.assertEqual(image.pixel(1, 0), (200, 100, 50, 255))

    def test_sixteen_bit_rgba_is_reduced_to_eight_bit(self):
        blob = _png(
            1,
            1,
            16,
            6,
            [bytes([0, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF])],
        )
        self.assertEqual(decode_png_bytes(blob).pixel(0, 0), (255, 0, 0, 255))

    def test_one_bit_grayscale(self):
        blob = _png(8, 1, 1, 0, [bytes([0, 0b10000000])])
        image = decode_png_bytes(blob)
        self.assertEqual(image.pixel(0, 0), (255, 255, 255, 255))
        self.assertEqual(image.pixel(1, 0), (0, 0, 0, 255))

    def test_adam7_interlaced_image(self):
        width, height = 8, 8
        expected = Image(
            width,
            height,
            bytearray(
                channel
                for y in range(height)
                for x in range(width)
                for channel in (x * 16, y * 16, 0, 255)
            ),
        )
        passes = (
            (0, 0, 8, 8),
            (4, 0, 8, 8),
            (0, 4, 4, 8),
            (2, 0, 4, 4),
            (0, 2, 2, 4),
            (1, 0, 2, 2),
            (0, 1, 1, 2),
        )
        scanlines = []
        for x_start, y_start, x_step, y_step in passes:
            xs = list(range(x_start, width, x_step))
            ys = list(range(y_start, height, y_step))
            if not xs or not ys:
                continue
            for y in ys:
                row = bytearray([0])
                for x in xs:
                    row.extend(expected.pixel(x, y))
                scanlines.append(bytes(row))
        blob = _png(width, height, 8, 6, scanlines, interlace=1)
        decoded = decode_png_bytes(blob)
        for y in range(height):
            for x in range(width):
                self.assertEqual(decoded.pixel(x, y), expected.pixel(x, y), (x, y))

    def test_each_filter_type_is_decoded(self):
        # A 3-pixel-wide RGBA image, one scanline per filter type, chosen so
        # every filter has non-trivial left/up neighbours.
        width, height = 3, 5
        source = Image(
            width,
            height,
            bytearray(
                channel
                for y in range(height)
                for x in range(width)
                for channel in (x * 40 + 5, y * 30 + 7, x * y + 10, 200)
            ),
        )
        bpp = 4
        row_bytes = width * bpp
        previous = bytearray(row_bytes)
        scanlines = []
        for y in range(height):
            row = bytearray(source.data[y * row_bytes : (y + 1) * row_bytes])
            filter_type = y
            if filter_type == 0:
                filtered = row
            elif filter_type == 1:
                filtered = bytearray(
                    (row[index] - (row[index - bpp] if index >= bpp else 0)) & 0xFF
                    for index in range(row_bytes)
                )
            elif filter_type == 2:
                filtered = bytearray(
                    (row[index] - previous[index]) & 0xFF for index in range(row_bytes)
                )
            elif filter_type == 3:
                filtered = bytearray(
                    (
                        row[index]
                        - (((row[index - bpp] if index >= bpp else 0) + previous[index]) >> 1)
                    )
                    & 0xFF
                    for index in range(row_bytes)
                )
            else:
                filtered = bytearray()
                for index in range(row_bytes):
                    left = row[index - bpp] if index >= bpp else 0
                    up = previous[index]
                    upper_left = previous[index - bpp] if index >= bpp else 0
                    estimate = left + up - upper_left
                    pa, pb, pc = abs(estimate - left), abs(estimate - up), abs(estimate - upper_left)
                    predictor = left if (pa <= pb and pa <= pc) else (up if pb <= pc else upper_left)
                    filtered.append((row[index] - predictor) & 0xFF)
            scanlines.append(bytes([filter_type]) + bytes(filtered))
            previous = row
        blob = _png(width, height, 8, 6, scanlines)
        decoded = decode_png_bytes(blob)
        for y in range(height):
            for x in range(width):
                self.assertEqual(decoded.pixel(x, y), source.pixel(x, y), (x, y))

    def test_bad_crc_is_rejected(self):
        blob = _png(1, 1, 8, 6, [bytes([0, 0, 0, 0, 0])])
        corrupted = bytearray(blob)
        corrupted[29] ^= 0xFF  # flip a byte of the IHDR CRC
        with self.assertRaises(PNGError):
            decode_png_bytes(bytes(corrupted))

    def test_truncated_file_is_rejected(self):
        blob = _png(1, 1, 8, 6, [bytes([0, 10, 20, 30, 40])])
        with self.assertRaises(PNGError):
            decode_png_bytes(blob[:-12])

    def test_not_a_png_is_rejected(self):
        with self.assertRaises(PNGError):
            decode_png_bytes(b"hello")

    def test_crop_copies_the_right_rectangle(self):
        image = Image(
            4,
            3,
            bytearray(
                channel
                for y in range(3)
                for x in range(4)
                for channel in (x, y, 0, 255)
            ),
        )
        cropped = image.crop(1, 1, 2, 2)
        self.assertEqual(cropped.pixel(0, 0), (1, 1, 0, 255))
        self.assertEqual(cropped.pixel(1, 1), (2, 2, 0, 255))
        with self.assertRaises(ValueError):
            image.crop(3, 0, 2, 1)

    def test_write_png_is_byte_identical_across_runs(self):
        image = Image(2, 2, bytearray(bytes([1, 2, 3, 4] * 4)))
        with tempfile.TemporaryDirectory() as directory:
            first = Path(directory) / "a.png"
            second = Path(directory) / "b.png"
            write_png(first, image)
            write_png(second, image)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(read_png(first).pixel(1, 1), (1, 2, 3, 4))

    def test_parse_hex_colour(self):
        self.assertEqual(parse_hex_colour("#F00"), (255, 0, 0))
        self.assertEqual(parse_hex_colour("#1f4e9c"), (31, 78, 156))
        with self.assertRaises(ValueError):
            parse_hex_colour("red")


if __name__ == "__main__":
    unittest.main()
