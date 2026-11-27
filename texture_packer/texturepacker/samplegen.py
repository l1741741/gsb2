"""Generate the built-in sample material described in the project README.

Samples deliberately cover the tricky cases:
  * narrow transparent margins around the content,
  * asymmetric anchor points,
  * an image wider than the demo page (overflow diagnosis),
  * a fully transparent image,
  * a wide short image that only fits after 90-degree rotation.
"""

from __future__ import annotations

import json
import os

from .image import Image


def _put(img: Image, x: int, y: int, color: tuple[int, int, int, int]) -> None:
    i = (y * img.width + x) * 4
    img.pixels[i : i + 4] = bytes(color)


def _rect(
    img: Image, x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int, int]
) -> None:
    for y in range(y0, y1):
        for x in range(x0, x1):
            _put(img, x, y, color)


def _frame(
    img: Image, x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int, int]
) -> None:
    for x in range(x0, x1):
        _put(img, x, y0, color)
        _put(img, x, y1 - 1, color)
    for y in range(y0, y1):
        _put(img, x0, y, color)
        _put(img, x1 - 1, y, color)


def generate_samples(output_dir: str) -> dict[str, str]:
    png_dir = os.path.join(output_dir, "src")
    os.makedirs(png_dir, exist_ok=True)
    paths: dict[str, str] = {}

    # 1. icon_slim_margin.png — 34x30 canvas, content only 24x18, with a
    #    2-5px asymmetric transparent margin and an off-center anchor.
    icon = Image(34, 30)
    _rect(icon, 5, 7, 29, 25, (220, 60, 60, 255))
    _rect(icon, 9, 11, 25, 21, (255, 200, 90, 255))
    icon_path = os.path.join(png_dir, "icon_slim_margin.png")
    icon.save_png(icon_path)
    paths["icon_slim_margin"] = icon_path

    # 2. tower_asymmetric.png — tall narrow sprite with a deliberately
    #    asymmetric anchor near its bottom-left corner.
    tower = Image(18, 44)
    _rect(tower, 4, 2, 14, 42, (60, 130, 220, 255))
    _rect(tower, 2, 38, 16, 42, (40, 70, 120, 255))
    tower_path = os.path.join(png_dir, "tower_asymmetric.png")
    tower.save_png(tower_path)
    paths["tower_asymmetric"] = tower_path

    # 3. ribbon_wide.png — wide and short. After trimming and padding its
    #    content is 56x10+padding; on a 64x64 demo page with padding=2 the
    #    frame is 60x14, which only fits after 90-degree rotation given the
    #    other sprites already occupying the page.
    ribbon = Image(58, 12)
    _frame(ribbon, 0, 0, 58, 12, (80, 200, 120, 255))
    _rect(ribbon, 4, 4, 54, 8, (180, 240, 160, 255))
    ribbon_path = os.path.join(png_dir, "ribbon_wide.png")
    ribbon.save_png(ribbon_path)
    paths["ribbon_wide"] = ribbon_path

    # 4. blank_fully_transparent.png — every pixel alpha 0.
    blank = Image(20, 16)
    blank_path = os.path.join(png_dir, "blank_fully_transparent.png")
    blank.save_png(blank_path)
    paths["blank_fully_transparent"] = blank_path

    # 5. giant_overflow.png — larger than the 64x64 demo page even after
    #    rotation, so packing must emit a precise rejection reason.
    giant = Image(90, 72)
    _frame(giant, 0, 0, 90, 72, (200, 80, 200, 255))
    _rect(giant, 30, 24, 60, 48, (240, 180, 240, 255))
    giant_path = os.path.join(png_dir, "giant_overflow.png")
    giant.save_png(giant_path)
    paths["giant_overflow"] = giant_path

    anchors = {
        "images": [
            {"name": "icon_slim_margin.png", "anchor": [6.5, 26.0]},
            {"name": "tower_asymmetric.png", "anchor": [3.0, 41.0]},
            {"name": "ribbon_wide.png", "anchor": [29.0, 6.0]},
            # The blank and giant images intentionally have no anchors.
        ]
    }
    anchors_path = os.path.join(output_dir, "anchors.json")
    with open(anchors_path, "w", encoding="utf-8") as fh:
        json.dump(anchors, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    paths["anchors"] = anchors_path
    return paths
