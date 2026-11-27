"""Shared helpers for the test suite: build tiny images in memory."""

from __future__ import annotations

import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from photocatalog.imaging.image import Image  # noqa: E402


def png_bytes(img: Image) -> bytes:
    def chunk(tag: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))

    raw = bytearray()
    for y in range(img.height):
        raw.append(0)
        base = y * img.width * 3
        raw += img.pixels[base:base + img.width * 3]
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", img.width, img.height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))


def write_png(img: Image, path: str) -> None:
    with open(path, "wb") as fh:
        fh.write(png_bytes(img))


def gradient(width: int, height: int, *, seed: int = 0,
             box: tuple[int, int, int, int] | None = None) -> Image:
    """A small deterministic image: gradient background plus an optional box.

    ``box`` is given as (x0, y0, x1, y1) and painted a distinct colour, which
    lets tests create "same background, different foreground" look-alikes.
    """
    import math
    px = bytearray(width * height * 3)
    for y in range(height):
        for x in range(width):
            o = (y * width + x) * 3
            # Smooth shading, like a real photograph: no hard wrap-around edges.
            fx = x / max(1, width - 1)
            fy = y / max(1, height - 1)
            px[o] = int(40 + 120 * fx + 30 * math.sin(6.0 * fx + seed))
            px[o + 1] = int(60 + 110 * fy + 25 * math.cos(5.0 * fy + seed))
            px[o + 2] = int(90 + 90 * (fx + fy) / 2 + 20 * math.sin(4.0 * fx + 2.0 * fy))
    if box is not None:
        x0, y0, x1, y1 = box
        for y in range(y0, y1):
            for x in range(x0, x1):
                o = (y * width + x) * 3
                px[o] = 220
                px[o + 1] = 90
                px[o + 2] = 60
    return Image(width, height, bytes(px), 3, "png", "RGB")


def crop(img: Image, x0: int, y0: int, x1: int, y1: int) -> Image:
    w, h = x1 - x0, y1 - y0
    out = bytearray(w * h * 3)
    for y in range(h):
        src = ((y0 + y) * img.width + x0) * 3
        out[y * w * 3:(y + 1) * w * 3] = img.pixels[src:src + w * 3]
    return Image(w, h, bytes(out), 3, "png", "RGB")


def tint(img: Image, dr: int = 0, dg: int = 0, db: int = 0) -> Image:
    out = bytearray(img.pixels)
    for i in range(0, len(out), 3):
        out[i] = max(0, min(255, out[i] + dr))
        out[i + 1] = max(0, min(255, out[i + 1] + dg))
        out[i + 2] = max(0, min(255, out[i + 2] + db))
    return Image(img.width, img.height, bytes(out), 3, "png", "RGB")
