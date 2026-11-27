"""Deterministic halftone screens.

Screen geometry is a pure function of **full-image** pixel coordinates.  The
field for a crop is built with the crop's origin, so the dot at a given pixel
is identical whether it is rendered as part of the full image or as a crop.
That is the property the crop-consistency checks rely on.

The screen is compiled to a per-pixel *threshold field*: a byte holding the
minimum quantised occupancy level that inks that pixel.  Screening a plate is
then one comparison per pixel, and the same field is shared by every ink.

``dots``
    A round dot of period ``cell`` pixels.  Occupancy 0 prints nothing,
    occupancy 100% prints a solid area, and the inked area between those
    extremes approximates the requested occupancy.

``lines``
    Parallel diagonal rules with period ``cell``.  Useful for fine-line and
    gradient artwork where a dot screen visibly beats against thin strokes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

SCREEN_TYPES = ("dots", "lines")


@dataclass(frozen=True)
class Screen:
    kind: str = "dots"
    cell: int = 8
    angle: float = 15.0
    levels: int = 32

    def __post_init__(self) -> None:
        if self.kind not in SCREEN_TYPES:
            raise ValueError(
                f"unknown screen type {self.kind!r}; expected one of {SCREEN_TYPES}"
            )
        if not isinstance(self.cell, int) or isinstance(self.cell, bool) or self.cell < 2:
            raise ValueError("screen cell must be an integer of at least 2 pixels")
        if not isinstance(self.angle, (int, float)) or not math.isfinite(self.angle):
            raise ValueError("screen angle must be a finite number")
        if (
            not isinstance(self.levels, int)
            or isinstance(self.levels, bool)
            or not 2 <= self.levels <= 254
        ):
            raise ValueError("screen levels must be between 2 and 254")

    # -- quantisation -----------------------------------------------------
    def level(self, occupancy: int) -> int:
        """Quantise 0-255 occupancy to a screen level in ``0..levels``."""
        if occupancy <= 0:
            return 0
        if occupancy >= 255:
            return self.levels
        return math.floor(occupancy / 255.0 * self.levels + 0.5)

    def as_json(self) -> dict:
        return {
            "type": self.kind,
            "cell": self.cell,
            "angle_degrees": self.angle,
            "levels": self.levels,
        }

    # -- geometry ---------------------------------------------------------
    def threshold_field(
        self, width: int, height: int, origin: tuple[int, int] = (0, 0)
    ) -> bytearray:
        """Per-pixel minimum level needed to ink, in full-image coordinates."""
        origin_x, origin_y = origin
        cell = float(self.cell)
        radians = math.radians(self.angle)
        cos_angle = math.cos(radians)
        sin_angle = math.sin(radians)
        # u = (x cos + y sin) / cell and v = (-x sin + y cos) / cell are
        # separable, which avoids two trig calls per pixel.
        x_cos = [(x + origin_x) * cos_angle / cell for x in range(width)]
        x_sin = [(x + origin_x) * sin_angle / cell for x in range(width)]
        y_sin = [(y + origin_y) * sin_angle / cell for y in range(height)]
        y_cos = [(y + origin_y) * cos_angle / cell for y in range(height)]
        levels = self.levels
        field = bytearray(width * height)
        for y in range(height):
            base = y * width
            for x in range(width):
                u = x_cos[x] + y_sin[y]
                v = -x_sin[x] + y_cos[y]
                cell_x = u - math.floor(u) - 0.5
                cell_y = v - math.floor(v) - 0.5
                if self.kind == "dots":
                    needed = math.pi * (cell_x * cell_x + cell_y * cell_y)
                else:
                    distance = (cell_x + cell_y) / math.sqrt(2.0)
                    needed = 2.0 * abs(distance)
                needed_level = math.ceil(needed * levels)
                if needed_level < 1:
                    needed_level = 1
                elif needed_level > levels:
                    needed_level = levels
                field[base + x] = needed_level
        return field

    def apply(self, plate: bytes, field: bytes) -> bytearray:
        """Turn an occupancy plate into a 0/1 ink mask using the field."""
        if len(plate) != len(field):
            raise ValueError("screen plate and threshold field differ in size")
        levels = self.levels
        result = bytearray(len(plate))
        for index, occupancy in enumerate(plate):
            if occupancy == 0:
                continue
            if occupancy >= 255:
                result[index] = 1
                continue
            if self.level(occupancy) >= field[index]:
                result[index] = 1
        return result

    def mask(self, plate: bytes, width: int, height: int, origin=(0, 0)) -> bytearray:
        return self.apply(plate, self.threshold_field(width, height, origin))


def screen_from_json(entry: object) -> Screen:
    if entry is None:
        return Screen()
    if not isinstance(entry, dict):
        raise ValueError("screen must be an object")
    kind = entry.get("type", entry.get("kind", "dots"))
    return Screen(
        kind=kind,
        cell=entry.get("cell", 8),
        angle=entry.get("angle_degrees", entry.get("angle", entry.get("angle", 15.0))),
        levels=entry.get("levels", 32),
    )
