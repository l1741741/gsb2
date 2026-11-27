"""Canvas geometry, placement and comparison configuration."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class DiffKind(str, Enum):
    """What the change block is made of."""

    APPEARANCE = "appearance"  # visible color/alpha-caused color difference
    ALPHA = "alpha"  # alpha channel difference
    BOTH = "both"  # both metrics exceeded their threshold in the block


class CoverageKind(str, Enum):
    """Regions covered by only one of the two images."""

    REFERENCE_ONLY = "reference_only"  # A covers, B does not
    CANDIDATE_ONLY = "candidate_only"  # B covers, A does not


@dataclass(frozen=True)
class Rect:
    """Axis-aligned rectangle in reference-image canvas coordinates."""

    x: int
    y: int
    width: int
    height: int

    @property
    def x2(self) -> int:
        return self.x + self.width

    @property
    def y2(self) -> int:
        return self.y + self.height

    @property
    def area(self) -> int:
        return self.width * self.height

    def as_dict(self) -> dict:
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}

    def intersects(self, other: "Rect") -> bool:
        return self.x < other.x2 and other.x < self.x2 and self.y < other.y2 and other.y < self.y2


@dataclass(frozen=True)
class PlacedImage:
    """An image placed on the shared canvas (the canvas uses A's origin)."""

    width: int
    height: int
    ox: int  # canvas x of the image's left edge
    oy: int  # canvas y of the image's top edge

    @property
    def rect(self) -> Rect:
        return Rect(self.ox, self.oy, self.width, self.height)

    @property
    def x2(self) -> int:
        return self.ox + self.width

    @property
    def y2(self) -> int:
        return self.oy + self.height

    def contains(self, x: int, y: int) -> bool:
        return self.ox <= x < self.ox + self.width and self.oy <= y < self.oy + self.height


@dataclass(frozen=True)
class CanvasGeometry:
    """The union canvas plus both placements, all in reference (A) coordinates."""

    reference: PlacedImage
    candidate: PlacedImage

    @property
    def bounds(self) -> Rect:
        x1 = min(self.reference.ox, self.candidate.ox)
        y1 = min(self.reference.oy, self.candidate.oy)
        x2 = max(self.reference.x2, self.candidate.x2)
        y2 = max(self.reference.y2, self.candidate.y2)
        return Rect(x1, y1, x2 - x1, y2 - y1)

    @property
    def common_rect(self) -> Rect:
        """Intersection of the two placements (may be empty)."""
        x1 = max(self.reference.ox, self.candidate.ox)
        y1 = max(self.reference.oy, self.candidate.oy)
        x2 = min(self.reference.x2, self.candidate.x2)
        y2 = min(self.reference.y2, self.candidate.y2)
        if x2 <= x1 or y2 <= y1:
            return Rect(0, 0, 0, 0)
        return Rect(x1, y1, x2 - x1, y2 - y1)

    def coverage(self, x: int, y: int) -> str:
        """Return 'common', 'reference_only', 'candidate_only' or 'outside'."""
        in_a = self.reference.contains(x, y)
        in_b = self.candidate.contains(x, y)
        if in_a and in_b:
            return "common"
        if in_a:
            return "reference_only"
        if in_b:
            return "candidate_only"
        return "outside"

    def tile_bounds(self, tile_size: int) -> list[Rect]:
        """Canvas-aligned tile rectangles covering the whole canvas."""
        bounds = self.bounds
        tiles = []
        for ty in range(bounds.y, bounds.y2, tile_size):
            for tx in range(bounds.x, bounds.x2, tile_size):
                r = Rect(
                    tx,
                    ty,
                    min(tile_size, bounds.x2 - tx),
                    min(tile_size, bounds.y2 - ty),
                )
                tiles.append(r)
        return tiles


@dataclass
class DiffConfig:
    """All tunable comparison parameters (also serialized into stats.json)."""

    offset_x: int = 0
    offset_y: int = 0
    # Metric thresholds, 0..255 scale.
    appearance_threshold: int = 16
    alpha_threshold: int = 16
    # Merge changed pixels whose bounding boxes are within this many pixels.
    merge_gap: int = 2
    connectivity: int = 8  # 4 or 8 neighbor connectivity for labeling
    min_block_area: int = 1
    # Background used to flatten semi-transparent pixels for appearance diffs.
    background: tuple[int, int, int] = (255, 255, 255)
    tile_size: int = 512

    def __post_init__(self) -> None:
        if self.connectivity not in (4, 8):
            raise ValueError("connectivity must be 4 or 8")
        if not 0 <= self.appearance_threshold <= 255:
            raise ValueError("appearance_threshold must be in 0..255")
        if not 0 <= self.alpha_threshold <= 255:
            raise ValueError("alpha_threshold must be in 0..255")
        if self.merge_gap < 0:
            raise ValueError("merge_gap must be >= 0")
        if self.tile_size <= 0:
            raise ValueError("tile_size must be positive")
        if len(self.background) != 3 or any(not 0 <= c <= 255 for c in self.background):
            raise ValueError("background must be an (r, g, b) tuple of 0..255")

    def as_dict(self) -> dict:
        return {
            "offset_x": self.offset_x,
            "offset_y": self.offset_y,
            "appearance_threshold": self.appearance_threshold,
            "alpha_threshold": self.alpha_threshold,
            "merge_gap": self.merge_gap,
            "connectivity": self.connectivity,
            "min_block_area": self.min_block_area,
            "background": list(self.background),
            "tile_size": self.tile_size,
        }


def parse_color(text: str) -> tuple[int, int, int]:
    """Parse '#rrggbb' / 'rrggbb' / 'r,g,b' into an (r, g, b) tuple."""
    text = text.strip()
    if text.startswith("#"):
        text = text[1:]
    if "," in text:
        parts = [p.strip() for p in text.split(",")]
        if len(parts) != 3:
            raise ValueError(f"invalid color {text!r}, expected r,g,b")
        rgb = tuple(int(p) for p in parts)
    else:
        if len(text) != 6:
            raise ValueError(f"invalid color {text!r}, expected #rrggbb")
        rgb = tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))
    if any(not 0 <= c <= 255 for c in rgb):
        raise ValueError("color channels must be in 0..255")
    return rgb  # type: ignore[return-value]
