"""Shared test helpers: deterministic synthetic depth stacks.

The scene is three deliberately disjoint regions, each carrying fine
texture with a different orientation.  A photo is rendered sharp for exactly
one depth and blurred for the others, so the focus metric has an unambiguous
answer at every textured point:

* ``near``  -- a disc around (50, 44) hatched with vertical stripes;
* ``mid``   -- a card in x=8..34, y=20..44 hatched horizontally;
* ``far``   -- a wedge on the right filled with a diagonal chequer.

Background and any blurred layer are flat enough to test the stable fallback.
"""

from __future__ import annotations

from array import array
from pathlib import Path

from focusstack.image import Image
from focusstack.ops import box_blur
from focusstack.pngio import write_png

WIDTH = 64
HEIGHT = 64
BACKGROUND = 200


def _texture_mask(x, y, depth):
    if depth == "near":
        if (x - 50) ** 2 + (y - 44) ** 2 > 9 * 9:
            return None
        return 40 if x % 3 == 0 else 90
    if depth == "mid":
        if not (8 <= x < 34 and 20 <= y < 44):
            return None
        return 230 if y % 4 == 0 else 205
    if depth == "far":
        edge = 40 - (y * 12) // HEIGHT
        if x < edge:
            return None
        return 120 if (x + y) % 5 < 2 else 155
    raise ValueError(depth)


def _scene_values(depth):
    values = [BACKGROUND] * (WIDTH * HEIGHT)
    for y in range(HEIGHT):
        for x in range(WIDTH):
            value = _texture_mask(x, y, depth)
            if value is not None:
                values[y * WIDTH + x] = value
    return values


def _blur(values, radius):
    plane = box_blur(array("f", (float(v) for v in values)), WIDTH, HEIGHT, radius)
    return [int(v + 0.5) for v in plane]


def _render(sharp_depth):
    combined = [float(BACKGROUND)] * (WIDTH * HEIGHT)
    for depth in ("far", "mid", "near"):
        values = _scene_values(depth)
        values = _blur(values, 0) if depth == sharp_depth else _blur(values, 3)
        for i, value in enumerate(values):
            if value != BACKGROUND:
                combined[i] = value
    n = WIDTH * HEIGHT
    r = array("B", [max(0, min(255, int(v + 0.5))) for v in combined])
    return Image(WIDTH, HEIGHT, array("B", r), array("B", r), array("B", r))


def synthetic_depth_stack(directory) -> list:
    """Write three 64x64 photos sharp at near/mid/far; return their paths."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    paths = []
    for name, depth in zip(("near.png", "mid.png", "far.png"), ("near", "mid", "far")):
        image = _render(depth)
        image.name = name
        path = directory / name
        write_png(path, image)
        paths.append(str(path))
    return paths


def two_tone_photos(directory, *, line_x=32, line_value=20, background=200):
    """Two photos of a single one-pixel vertical line: sharp and blurred."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    values = [background] * (WIDTH * HEIGHT)
    for y in range(HEIGHT):
        values[y * WIDTH + line_x] = line_value
    sharp_plane = array("B", values)
    sharp = Image(WIDTH, HEIGHT, array("B", sharp_plane), array("B", sharp_plane),
                  array("B", sharp_plane), name="sharp")
    blurred_values = _blur(values, 2)
    blurred_plane = array("B", blurred_values)
    soft = Image(WIDTH, HEIGHT, array("B", blurred_plane), array("B", blurred_plane),
                 array("B", blurred_plane), name="soft")
    first = directory / "sharp.png"
    second = directory / "soft.png"
    write_png(first, sharp)
    write_png(second, soft)
    return [str(first), str(second)]
