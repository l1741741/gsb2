"""Reproducible sample artwork for crop consistency and plate coverage checks.

``python3 -m inkproof sample <dir>`` writes:

* ``inputs/gradient.png`` — a two-ink gradient with a hard-edged band and a
  soft alpha ramp, which exercises screen quantisation and alpha-aware plates.
* ``inputs/fine_lines.png`` — 1- and 2-pixel lines at several angles, where a
  dot screen must not bleed across strokes.
* ``inputs/transparent_edge.png`` — hard transparent holes plus a soft alpha
  feathered boundary, which exercises the "transparent stays transparent"
  invariant.
* ``colors.json`` — a named four-ink table.
* ``project.json`` — an image group with crops and guard regions.

Every pixel is generated from arithmetic, so the artwork is byte-identical on
every machine and the sample group can be re-run and verified.
"""

from __future__ import annotations

import json
import math
import os

from .pngio import Image, write_png

# The sample ink table.  Names are spot-ink style so renames read naturally.
SAMPLE_INKS = [
    {"name": "vermilion", "rgb": "#D7261E", "previous_names": []},
    {"name": "cobalt", "rgb": "#1F4E9C", "previous_names": []},
    {"name": "saffron", "rgb": "#E8B02A", "previous_names": []},
    {"name": "graphite", "rgb": "#2B2B2B", "previous_names": []},
]

WIDTH = 160
HEIGHT = 120


def _blank(width: int = WIDTH, height: int = HEIGHT) -> Image:
    return Image(width, height, bytearray(width * height * 4))


def _composite(base: tuple[int, int, int, int], overlay: tuple[int, int, int, int]):
    """Overlay RGBA onto a base with straight alpha blending."""
    if overlay[3] == 255:
        return overlay
    if overlay[3] == 0:
        return base
    a = overlay[3] / 255.0
    return (
        round(overlay[0] * a + base[0] * (1 - a)),
        round(overlay[1] * a + base[1] * (1 - a)),
        round(overlay[2] * a + base[2] * (1 - a)),
        255 if base[3] == 255 else round(overlay[3] + base[3] * (1 - a)),
    )


def _draw_rect(image: Image, x: int, y: int, w: int, h: int, rgba) -> None:
    for row in range(max(0, y), min(image.height, y + h)):
        for column in range(max(0, x), min(image.width, x + w)):
            image.set_pixel(column, row, _composite(image.pixel(column, row), rgba))


def _punch_rect(image: Image, x: int, y: int, w: int, h: int) -> None:
    """Erase a rectangle to fully transparent (a hard hole, not a blend)."""
    for row in range(max(0, y), min(image.height, y + h)):
        for column in range(max(0, x), min(image.width, x + w)):
            image.set_pixel(column, row, (0, 0, 0, 0))


def gradient_artwork() -> Image:
    image = _blank()
    ink_a = (215, 38, 30)
    ink_b = (31, 78, 156)
    # A horizontal two-ink gradient across the top two thirds.
    for y in range(80):
        for x in range(WIDTH):
            t = x / (WIDTH - 1)
            rgb = (
                round(ink_a[0] * (1 - t) + ink_b[0] * t),
                round(ink_a[1] * (1 - t) + ink_b[1] * t),
                round(ink_a[2] * (1 - t) + ink_b[2] * t),
            )
            image.set_pixel(x, y, (rgb[0], rgb[1], rgb[2], 255))
    # Hard-edged band, no anti-aliasing: must print on exactly one plate.
    _draw_rect(image, 10, 88, 60, 14, (215, 38, 30, 255))
    _draw_rect(image, 90, 88, 60, 14, (31, 78, 156, 255))
    # Soft alpha ramp over the gradient: alpha 0 at the left edge to 255.
    for y in range(104, 120):
        for x in range(WIDTH):
            alpha = round(255 * x / (WIDTH - 1))
            rgb = (232, 176, 42)
            image.set_pixel(x, y, (rgb[0], rgb[1], rgb[2], alpha))
    return image


def fine_lines_artwork() -> Image:
    image = _blank()
    # Line art sits on transparency, like real spot-colour line work.
    ink = (43, 43, 43, 255)
    # 1-pixel horizontal rules at regular intervals.
    for y in range(6, HEIGHT, 12):
        for x in range(8, WIDTH - 8):
            image.set_pixel(x, y, ink)
    # 2-pixel vertical rules.
    for x in range(12, WIDTH, 16):
        for y in range(24, 70):
            image.set_pixel(x, y, ink)
            image.set_pixel(x + 1, y, ink)
    # 45-degree 1-pixel diagonals: the hardest case for a dot screen.
    for offset in range(-40, 60, 24):
        for step in range(60):
            x = 40 + step
            y = 80 + offset + step
            if 0 <= x < WIDTH and 0 <= y < HEIGHT:
                image.set_pixel(x, y, (31, 78, 156, 255))
    # A warm patch to give the saffron ink something to cover.
    _draw_rect(image, 118, 96, 34, 18, (232, 176, 42, 255))
    return image


def transparent_edge_artwork() -> Image:
    image = _blank()
    # Opaque vermilion field with three hard transparent holes.
    _draw_rect(image, 8, 8, 64, 64, (215, 38, 30, 255))
    for (x, y, w, h) in ((24, 24, 12, 12), (48, 40, 14, 10), (30, 52, 8, 8)):
        _punch_rect(image, x, y, w, h)
    # Opaque cobalt disc with a soft (feathered) alpha edge.
    centre_x, centre_y, radius = 112, 40, 26
    for y in range(HEIGHT):
        for x in range(WIDTH):
            distance = math.hypot(x - centre_x, y - centre_y)
            if distance <= radius - 3:
                image.set_pixel(x, y, (31, 78, 156, 255))
            elif distance <= radius:
                alpha = round(255 * (radius - distance) / 3)
                image.set_pixel(x, y, (31, 78, 156, alpha))
    # A graphite rectangle with a 1-pixel fully transparent outline.
    _draw_rect(image, 20, 88, 100, 24, (43, 43, 43, 255))
    for x in range(20, 120):
        image.set_pixel(x, 88, (0, 0, 0, 0))
        image.set_pixel(x, 111, (0, 0, 0, 0))
    for y in range(88, 112):
        image.set_pixel(20, y, (0, 0, 0, 0))
        image.set_pixel(119, y, (0, 0, 0, 0))
    return image


def generate_samples(directory: str) -> dict:
    os.makedirs(os.path.join(directory, "inputs"), exist_ok=True)

    gradient = gradient_artwork()
    fine_lines = fine_lines_artwork()
    transparent = transparent_edge_artwork()
    write_png(os.path.join(directory, "inputs", "gradient.png"), gradient)
    write_png(os.path.join(directory, "inputs", "fine_lines.png"), fine_lines)
    write_png(os.path.join(directory, "inputs", "transparent_edge.png"), transparent)

    colours = {"inks": SAMPLE_INKS, "metric": "lab", "tie_epsilon": 0.05}
    colours_path = os.path.join(directory, "colors.json")
    with open(colours_path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(colours, indent=2, ensure_ascii=False) + "\n")

    project = {
        "colour_table": "colors.json",
        "mode": "screened",
        "screen": {"type": "dots", "cell": 6, "angle_degrees": 22.5, "levels": 32},
        "images": [
            {
                "name": "gradient",
                "source": "inputs/gradient.png",
                "crop": {"name": "band", "x": 8, "y": 70, "width": 96, "height": 44},
                "regions": [
                    {
                        "name": "forced-vermilion-band",
                        "policy": "force:vermilion",
                        "rect": [10, 88, 60, 14],
                    }
                ],
            },
            {
                "name": "fine_lines",
                "source": "inputs/fine_lines.png",
                "crop": {"name": "diagonal", "x": 30, "y": 74, "width": 70, "height": 40},
                "regions": [],
            },
            {
                "name": "transparent_edge",
                "source": "inputs/transparent_edge.png",
                "crop": {"name": "left-holes", "x": 8, "y": 8, "width": 80, "height": 64},
                "regions": [
                    {
                        "name": "reserved-margin",
                        "policy": "keep-transparent",
                        "rect": [128, 88, 24, 24],
                    }
                ],
            },
        ],
    }
    project_path = os.path.join(directory, "project.json")
    with open(project_path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(project, indent=2, ensure_ascii=False) + "\n")
    return {
        "images": ["gradient", "fine_lines", "transparent_edge"],
        "colors": colours_path,
        "project": project_path,
    }
