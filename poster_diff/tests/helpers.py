"""Helpers for building in-memory RGBA images in tests."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from poster_diff.pngio import Image, read_png, write_png  # noqa: E402


def solid_rgba(width: int, height: int, color: tuple[int, int, int, int]) -> Image:
    r, g, b, a = color
    return Image(width, height, 4, bytearray([r, g, b, a]) * (width * height))


def make_rgba(width: int, height: int, fill=(0, 0, 0, 0)) -> Image:
    return solid_rgba(width, height, fill)


def set_rect(img: Image, x: int, y: int, w: int, h: int,
             color: tuple[int, int, int, int]) -> None:
    r, g, b, a = color
    for py in range(y, y + h):
        for px in range(x, x + w):
            i = (py * img.width + px) * 4
            img.data[i:i + 4] = bytes((r, g, b, a))


def roundtrip_png(tmpdir: str, img: Image, name: str = "t.png") -> Image:
    path = os.path.join(tmpdir, name)
    write_png(path, img)
    back = read_png(path)
    assert back.width == img.width and back.height == img.height
    assert back.data == img.data
    return back
