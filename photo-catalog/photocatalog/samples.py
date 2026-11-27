"""Deterministic synthetic photo generator used for the bundled sample set.

The images are small, geometric "photos" rather than real photographs: soft
gradient light, simple scene objects, grain and a vignette, rendered with a
tiny software rasteriser.  They are deliberately constructed so the sample set
exercises the cases the catalog tool must get right:

* a true duplicate (byte-identical file)
* resized, cropped and colour-graded copies of one original
* two *different* photos that share the same background
* a three-image chain where A resembles B and B resembles C but A and C differ
  clearly (progressive cropping), which must not be collapsed into one group

Everything is stdlib-only and deterministic, so the fixtures can be rebuilt on
any machine with Python 3.11+.
"""

from __future__ import annotations

import math
import os
import struct
import zlib

from .imaging.image import Image


# ---------------------------------------------------------------- rasteriser

class _Rng:
    """Small deterministic linear-congruential generator."""

    def __init__(self, seed: int):
        self.state = seed & 0xFFFFFFFF

    def next(self) -> int:
        self.state = (1103515245 * self.state + 12345) & 0x7FFFFFFF
        return self.state

    def uniform(self, low: float, high: float) -> float:
        return low + (high - low) * (self.next() / 0x7FFFFFFF)


def _render(width: int, height: int, seed: int, *, subject: str,
            time_of_day: str = "day", grain: float = 3.0,
            vignette: float = 0.18, blur: bool = True) -> Image:
    """Render one scene.  ``subject`` changes only the focal object."""
    rng = _Rng(seed)
    px = bytearray(width * height * 3)
    horizon = int(height * 0.62)

    palette = {
        "day": ((96, 158, 214), (214, 232, 245), (86, 116, 70), (60, 84, 50)),
        "dusk": ((58, 62, 112), (232, 158, 122), (56, 66, 54), (38, 46, 40)),
    }[time_of_day]
    sky_top, sky_bottom, ground_top, ground_bottom = palette

    for y in range(height):
        for x in range(width):
            o = (y * width + x) * 3
            if y < horizon:
                t = y / max(1, horizon - 1)
                r = int(sky_top[0] * (1 - t) + sky_bottom[0] * t)
                g = int(sky_top[1] * (1 - t) + sky_bottom[1] * t)
                b = int(sky_top[2] * (1 - t) + sky_bottom[2] * t)
                # Soft sun glow that moves with the seed.
                sx = width * (0.25 + 0.5 * ((seed % 97) / 97.0))
                sy = horizon * 0.35
                dist = math.hypot(x - sx, y - sy)
                glow = max(0.0, 1.0 - dist / (width * 0.45))
                r = min(255, int(r + 70 * glow * glow))
                g = min(255, int(g + 64 * glow * glow))
                b = min(255, int(b + 40 * glow * glow))
            else:
                t = (y - horizon) / max(1, height - horizon - 1)
                r = int(ground_top[0] * (1 - t) + ground_bottom[0] * t)
                g = int(ground_top[1] * (1 - t) + ground_bottom[1] * t)
                b = int(ground_top[2] * (1 - t) + ground_bottom[2] * t)
                # Horizontal banding gives the ground texture to compare against.
                band = math.sin((y - horizon) * 0.55 + x * 0.02 + seed) * 7
                r = int(r + band)
                g = int(g + band)
                b = int(b + band)
            px[o] = max(0, min(255, r))
            px[o + 1] = max(0, min(255, g))
            px[o + 2] = max(0, min(255, b))

    img = _Canvas(px, width, height)

    # Distant hills, fixed relative to the scene (shared background).
    img.ellipse(int(width * 0.18), horizon + 6, int(width * 0.22), int(height * 0.10),
                (74, 96, 74), softness=2)
    img.ellipse(int(width * 0.72), horizon + 10, int(width * 0.28), int(height * 0.13),
                (66, 88, 68), softness=2)

    # Two trees whose positions depend only on the scene seed, not the subject.
    tree_rng = _Rng(seed + 101)
    for _ in range(2):
        tx = int(width * tree_rng.uniform(0.12, 0.85))
        ty = horizon + int(height * tree_rng.uniform(0.0, 0.16))
        th = int(height * tree_rng.uniform(0.16, 0.26))
        img.rect(tx - max(1, width // 90), ty - th // 2, max(2, width // 45), th,
                 (84, 62, 42), softness=1)
        img.ellipse(tx, ty - th // 2 - th // 5, int(th * 0.42), int(th * 0.30),
                    (48, 86, 52), softness=2)

    # The subject: the part that differs between "different photos".
    cx = int(width * 0.5)
    cy = horizon - int(height * 0.10)
    if subject == "walker":
        img.capsule(cx, cy, int(width * 0.045), int(height * 0.24), (214, 118, 92), softness=2)
        img.ellipse(cx, cy - int(height * 0.20), int(width * 0.045), int(height * 0.06),
                    (226, 196, 168), softness=2)
        img.rect(cx - int(width * 0.06), cy - int(height * 0.22),
                 int(width * 0.12), int(height * 0.03), (58, 72, 96), softness=1)
    elif subject == "dog":
        img.ellipse(cx + int(width * 0.06), cy + int(height * 0.14),
                    int(width * 0.075), int(height * 0.06), (142, 104, 70), softness=2)
        img.ellipse(cx + int(width * 0.13), cy + int(height * 0.10),
                    int(width * 0.045), int(height * 0.045), (160, 120, 84), softness=2)
    elif subject == "cart":
        img.rect(cx - int(width * 0.10), cy + int(height * 0.02),
                 int(width * 0.20), int(height * 0.10), (168, 74, 54), softness=1)
        for dx in (-0.06, 0.06):
            img.ellipse(cx + int(width * dx), cy + int(height * 0.13),
                        int(width * 0.028), int(height * 0.028), (52, 52, 58), softness=1)
    elif subject == "bench":
        img.rect(cx - int(width * 0.14), cy + int(height * 0.10),
                 int(width * 0.28), int(height * 0.035), (146, 102, 62), softness=1)
        img.rect(cx - int(width * 0.12), cy + int(height * 0.135),
                 int(width * 0.03), int(height * 0.08), (110, 76, 46), softness=1)
        img.rect(cx + int(width * 0.09), cy + int(height * 0.135),
                 int(width * 0.03), int(height * 0.08), (110, 76, 46), softness=1)
    elif subject == "flowerbed":
        for k in range(7):
            fx = cx + int(width * (k - 3) * 0.045)
            fy = cy + int(height * 0.15) + (k % 2) * int(height * 0.02)
            colour = ((214, 96, 128), (232, 186, 72), (150, 96, 200),
                      (236, 132, 96), (120, 192, 128), (208, 84, 168), (240, 202, 110))[k]
            img.ellipse(fx, fy, int(width * 0.020), int(height * 0.026), colour, softness=2)
    else:
        raise ValueError(f"unknown subject {subject!r}")

    # Grain and vignette make the images behave like photographs.
    rng2 = _Rng(seed + 977)
    if grain or vignette:
        for y in range(height):
            for x in range(width):
                o = (y * width + x) * 3
                if grain:
                    n = rng2.uniform(-grain, grain)
                    for c in range(3):
                        px[o + c] = max(0, min(255, int(px[o + c] + n)))
                if vignette:
                    dx = (x - width / 2) / (width / 2)
                    dy = (y - height / 2) / (height / 2)
                    factor = 1.0 - vignette * (dx * dx + dy * dy) * 0.5
                    for c in range(3):
                        px[o + c] = max(0, min(255, int(px[o + c] * factor)))

    if blur:
        img.box_blur(1)
    # Flush the canvas back into the buffer (canvas methods write in place,
    # but box_blur replaces the buffer contents).
    px[:] = img.px
    return Image(width, height, bytes(px), 3, "png", "RGB")


class _Canvas:
    """Tiny float-ish raster helper: draws soft shapes into an RGB buffer."""

    def __init__(self, px: bytearray, width: int, height: int):
        self.px = px
        self.width = width
        self.height = height

    def _blend(self, x: int, y: int, colour: tuple[int, int, int], alpha: float) -> None:
        if x < 0 or y < 0 or x >= self.width or y >= self.height or alpha <= 0:
            return
        o = (y * self.width + x) * 3
        a = min(1.0, alpha)
        self.px[o] = int(self.px[o] * (1 - a) + colour[0] * a)
        self.px[o + 1] = int(self.px[o + 1] * (1 - a) + colour[1] * a)
        self.px[o + 2] = int(self.px[o + 2] * (1 - a) + colour[2] * a)

    def ellipse(self, cx: int, cy: int, rx: int, ry: int,
                colour: tuple[int, int, int], softness: int = 2) -> None:
        if rx <= 0 or ry <= 0:
            return
        for y in range(max(0, cy - ry - softness), min(self.height, cy + ry + softness + 1)):
            for x in range(max(0, cx - rx - softness), min(self.width, cx + rx + softness + 1)):
                nx = (x - cx) / rx
                ny = (y - cy) / ry
                d = math.sqrt(nx * nx + ny * ny)
                alpha = 1.0 if d <= 1.0 else max(0.0, 1.0 - (d - 1.0) * rx / softness)
                self._blend(x, y, colour, alpha)

    def rect(self, x0: int, y0: int, w: int, h: int,
             colour: tuple[int, int, int], softness: int = 1) -> None:
        for y in range(max(0, y0), min(self.height, y0 + h)):
            for x in range(max(0, x0), min(self.width, x0 + w)):
                self._blend(x, y, colour, 1.0)

    def capsule(self, cx: int, cy: int, r: int, h: int,
                colour: tuple[int, int, int], softness: int = 2) -> None:
        for y in range(max(0, cy - h), min(self.height, cy + h)):
            for x in range(max(0, cx - r), min(self.width, cx + r)):
                dx = abs(x - cx)
                if dx <= r:
                    self._blend(x, y, colour, 1.0)

    def box_blur(self, radius: int) -> None:
        if radius <= 0:
            return
        w, h = self.width, self.height
        src = self.px
        dst = bytearray(src)
        for y in range(h):
            for x in range(w):
                for c in range(3):
                    total = 0
                    count = 0
                    for dy in range(-radius, radius + 1):
                        yy = y + dy
                        if 0 <= yy < h:
                            base = (yy * w + x) * 3 + c
                            total += src[base]
                            count += 1
                    dst[(y * w + x) * 3 + c] = total // count
        src2 = dst
        dst2 = bytearray(src2)
        for y in range(h):
            for x in range(w):
                for c in range(3):
                    total = 0
                    count = 0
                    for dx in range(-radius, radius + 1):
                        xx = x + dx
                        if 0 <= xx < w:
                            total += src2[(y * w + xx) * 3 + c]
                            count += 1
                    dst2[(y * w + x) * 3 + c] = total // count
        self.px[:] = dst2
