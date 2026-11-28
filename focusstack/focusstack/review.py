"""Review region extraction and overlay rendering.

The review output has two parts:

* ``review.json`` -- a machine-readable list of connected regions that need a
  human look, grouped by primary reason, with the canvas bounding box, area,
  owning photos and local confidence.  Manual overrides are listed too, so a
  reviewer can confirm the hand edits survived a rerun.
* ``review-overlay.png`` -- the composite tinted by reason, with numbered
  boxes matching the JSON ids.

Reasons and colours follow ``select.REASON_NAMES``; the legend is written
into the JSON so the overlay stays interpretable without this docstring.
"""

from __future__ import annotations

import json
from array import array

from .image import Image
from .select import (
    FLAG_LOW_CONF,
    FLAG_LOW_CONF_DIVERGENT,
    FLAG_MANUAL,
    FLAG_MANUAL_PARTIAL,
    FLAG_SEAM_CONFLICT,
    FLAG_TIE,
    FLAG_UNCOVERED,
    REASON_NAMES,
    UNCOVERED,
)

COLORS = {
    FLAG_SEAM_CONFLICT: (255, 30, 220),
    FLAG_MANUAL_PARTIAL: (90, 255, 150),
    FLAG_TIE: (255, 150, 20),
    FLAG_LOW_CONF: (235, 60, 45),
    FLAG_LOW_CONF_DIVERGENT: (255, 105, 40),
    FLAG_UNCOVERED: (30, 150, 255),
    FLAG_MANUAL: (20, 220, 120),
}

PRIORITY = {
    FLAG_SEAM_CONFLICT: 1,
    FLAG_MANUAL_PARTIAL: 2,
    FLAG_TIE: 3,
    FLAG_LOW_CONF_DIVERGENT: 4,
    FLAG_LOW_CONF: 5,
    FLAG_UNCOVERED: 6,
}

REASON_TEXT = {
    FLAG_SEAM_CONFLICT: "photos disagree visibly across this seam; check for a moved part or a halo",
    FLAG_MANUAL_PARTIAL: "a partially transparent manual override; confirm it blends as intended",
    FLAG_TIE: "top photos are nearly equal but visibly different; selection is deterministic, verify it",
    FLAG_LOW_CONF_DIVERGENT: "flat area where photos differ visibly; selection kept the reference, compare sources",
    FLAG_LOW_CONF: "flat/low-contrast area; selection kept the reference photo for stability",
    FLAG_UNCOVERED: "no photo recorded this canvas pixel",
}

REVIEW_MASK = (FLAG_SEAM_CONFLICT | FLAG_MANUAL_PARTIAL | FLAG_TIE | FLAG_LOW_CONF
               | FLAG_LOW_CONF_DIVERGENT | FLAG_UNCOVERED)
REGION_FLAGS = (FLAG_SEAM_CONFLICT, FLAG_MANUAL_PARTIAL, FLAG_TIE, FLAG_LOW_CONF_DIVERGENT,
                FLAG_LOW_CONF, FLAG_UNCOVERED)


def _primary_map(flags: array) -> array:
    n = len(flags)
    primary = array("B", bytes(n))
    for p in range(n):
        bits = flags[p] & REVIEW_MASK
        for flag in REGION_FLAGS:
            if bits & flag:
                primary[p] = flag
                break
    return primary


def connected_regions(primary: array, width: int, height: int, *, min_area: int = 1) -> list:
    """4-connected components of the primary-reason map.

    Returns dicts with ``bbox``, ``area``, ``reason``, ``members`` (counts by
    owner label) and ``confidence_sum``-free placeholders that callers fill.
    """
    n = width * height
    visited = bytearray(n)
    regions = []
    for start in range(n):
        reason = primary[start]
        if not reason or visited[start]:
            continue
        stack = [start]
        visited[start] = 1
        area = 0
        left, top, right, bottom = width, height, -1, -1
        while stack:
            p = stack.pop()
            area += 1
            x = p % width
            y = p // width
            if x < left:
                left = x
            if x > right:
                right = x
            if y < top:
                top = y
            if y > bottom:
                bottom = y
            if x > 0:
                q = p - 1
                if not visited[q] and primary[q] == reason:
                    visited[q] = 1
                    stack.append(q)
            if x + 1 < width:
                q = p + 1
                if not visited[q] and primary[q] == reason:
                    visited[q] = 1
                    stack.append(q)
            if y > 0:
                q = p - width
                if not visited[q] and primary[q] == reason:
                    visited[q] = 1
                    stack.append(q)
            if y + 1 < height:
                q = p + width
                if not visited[q] and primary[q] == reason:
                    visited[q] = 1
                    stack.append(q)
        if area < min_area:
            continue
        regions.append({
            "reason": reason,
            "area": area,
            "bbox": (left, top, right - left + 1, bottom - top + 1),
        })
    return regions


def build_regions(
    flags: array,
    labels: array,
    focus,
    width: int,
    height: int,
    *,
    window: tuple | None = None,
    min_area: int = 4,
    max_regions: int = 400,
) -> tuple:
    """Return (regions, truncated_count, flagged_area).

    Regions always come from the full canvas.  When ``window`` is given their
    bboxes and areas are clipped to it, but ids stay tied to the full run so a
    block review list refers to the same entries as the full list.
    """
    if window is None:
        window = (0, 0, width, height)
    wx, wy, ww, wh = window
    primary = _primary_map(flags)
    raw = connected_regions(primary, width, height, min_area=min_area)

    left_limit = wx
    top_limit = wy
    right_limit = wx + ww
    bottom_limit = wy + wh

    regions = []
    for item in raw:
        reason = item["reason"]
        bx, by, bw, bh = item["bbox"]
        x0 = max(bx, left_limit)
        y0 = max(by, top_limit)
        x1 = min(bx + bw, right_limit)
        y1 = min(by + bh, bottom_limit)
        if x1 <= x0 or y1 <= y0:
            continue
        # Recompute the clipped area by scanning only the clipped bbox.
        area = 0
        members = {}
        confidence_sum = 0.0
        confidence_count = 0
        best_score_max = -1.0
        for y in range(y0, y1):
            base = y * width
            for x in range(x0, x1):
                p = base + x
                if primary[p] != reason:
                    continue
                area += 1
                owner = labels[p]
                if owner != UNCOVERED and owner >= 0:
                    members[owner] = members.get(owner, 0) + 1
                    if focus and owner < len(focus):
                        confidence_sum += focus[owner].confidence[p]
                        confidence_count += 1
                        s = focus[owner].score[p]
                        if s > best_score_max:
                            best_score_max = s
        if area < min_area:
            continue
        regions.append({
            "reason": reason,
            "priority": PRIORITY[reason],
            "bbox": [x0, y0, x1 - x0, y1 - y0],
            "area": area,
            "members": members,
            "confidence": round(confidence_sum / confidence_count, 4) if confidence_count else 0.0,
        })

    regions.sort(key=lambda r: (r["priority"], -r["area"]))
    reported = regions[:max_regions]
    truncated = max(0, len(regions) - len(reported))

    result = []
    for index, region in enumerate(reported, start=1):
        bits = region["reason"]
        # Secondary reasons: look at the flags of the region's own pixels.
        secondary = set()
        bx, by, bw, bh = region["bbox"]
        for y in range(by, by + bh):
            base = y * width
            for x in range(bx, bx + bw):
                p = base + x
                if primary[p] != bits:
                    continue
                extra = flags[p] & REVIEW_MASK
                for flag in REGION_FLAGS:
                    if extra & flag and flag != bits:
                        secondary.add(flag)
        result.append({
            "id": "r%03d" % index,
            "reason": REASON_NAMES[bits],
            "secondary_reasons": [REASON_NAMES[f] for f in REGION_FLAGS if f in secondary],
            "priority": region["priority"],
            "bbox": region["bbox"],
            "area": region["area"],
            "owner_photos": {str(k): v for k, v in sorted(region["members"].items())},
            "mean_owner_confidence": region["confidence"],
            "guidance": REASON_TEXT[bits],
        })

    flagged_area = sum(1 for value in primary if value)
    return result, truncated, flagged_area


_GLYPHS = {
    "0": ("111", "101", "101", "101", "111"),
    "1": ("010", "110", "010", "010", "111"),
    "2": ("111", "001", "111", "100", "111"),
    "3": ("111", "001", "111", "001", "111"),
    "4": ("101", "101", "111", "001", "001"),
    "5": ("111", "100", "111", "001", "111"),
    "6": ("111", "100", "111", "101", "111"),
    "7": ("111", "001", "001", "001", "001"),
    "8": ("111", "101", "111", "101", "111"),
    "9": ("111", "101", "111", "001", "111"),
    "r": ("000", "000", "110", "101", "110"),
}


def _draw_text(plane, width, height, x, y, text, color=(255, 255, 255), scale=1,
               background=None) -> None:
    """Draw digits using a 3x5 bitmap font with an optional backing chip."""
    char_width = 4 * scale
    if background is not None:
        chip_w = len(text) * char_width + 2
        chip_h = 5 * scale + 2
        for py in range(y - 1, y + chip_h):
            if py < 0 or py >= height:
                continue
            for px in range(x - 1, x + chip_w):
                if px < 0 or px >= width:
                    continue
                index = py * width + px
                plane[0][index], plane[1][index], plane[2][index] = background
    cursor = x
    for char in text:
        pattern = _GLYPHS.get(char)
        if pattern is None:
            cursor += char_width
            continue
        for row, line in enumerate(pattern):
            for col, bit in enumerate(line):
                if bit != "1":
                    continue
                for sy in range(scale):
                    py = y + row * scale + sy
                    if py < 0 or py >= height:
                        continue
                    for sx in range(scale):
                        px = cursor + col * scale + sx
                        if px < 0 or px >= width:
                            continue
                        index = py * width + px
                        plane[0][index], plane[1][index], plane[2][index] = color
        cursor += char_width


# Ordinary low-confidence areas are a normal property of every stack, not a
# defect.  They are always in the JSON list and get a numbered box, but their
# pixels are not tinted: tinting them would cover most of a typical frame and
# mask the few high-priority regions a reviewer must actually inspect.
LIGHT_DIM = {
    FLAG_LOW_CONF: 0.0,
}


def render_overlay(composite: Image, flags: array, regions: list, *, dim: float = 0.45) -> Image:
    """Composite tinted per reason with boxed region ids."""
    width, height = composite.width, composite.height
    n = width * height
    r = array("B", bytes(n))
    g = array("B", bytes(n))
    b = array("B", bytes(n))
    for p in range(n):
        bits = flags[p] & REVIEW_MASK
        tint = None
        for flag in REGION_FLAGS:
            if bits & flag:
                tint = COLORS[flag]
                break
        if tint is None:
            r[p] = composite.r[p]
            g[p] = composite.g[p]
            b[p] = composite.b[p]
        else:
            strength = LIGHT_DIM.get(next(f for f in REGION_FLAGS if bits & f), dim)
            if strength <= 0.0:
                r[p] = composite.r[p]
                g[p] = composite.g[p]
                b[p] = composite.b[p]
            else:
                r[p] = int(composite.r[p] * (1 - strength) + tint[0] * strength)
                g[p] = int(composite.g[p] * (1 - strength) + tint[1] * strength)
                b[p] = int(composite.b[p] * (1 - strength) + tint[2] * strength)

    # Draw boxes for every region, then place id chips with simple collision
    # avoidance so a cluster of tiny regions does not turn into unreadable
    # overlapping text.  Box outlines still make every region visible.
    occupied = []

    def _chip_free(x, y, w, h):
        for ox, oy, ow, oh in occupied:
            if x < ox + ow and x + w > ox and y < oy + oh and y + h > oy:
                return False
        return True

    for region in regions:
        x, y, w, h = region["bbox"]
        number = region["id"].lstrip("r")
        x1 = x + w - 1
        y1 = y + h - 1
        for px in range(max(0, x), min(width, x + w)):
            if 0 <= y < height:
                index = y * width + px
                r[index], g[index], b[index] = 255, 255, 255
            if 0 <= y1 < height:
                index = y1 * width + px
                r[index], g[index], b[index] = 255, 255, 255
        for py in range(max(0, y), min(height, y + h)):
            if 0 <= x < width:
                index = py * width + x
                r[index], g[index], b[index] = 255, 255, 255
            if 0 <= x1 < width:
                index = py * width + x1
                r[index], g[index], b[index] = 255, 255, 255

        if region["area"] < 12:
            # Tiny regions are boxed but unnamed; their ids stay in review.json.
            continue
        chip_w = len(number) * 8 + 4
        chip_h = 12
        candidates = [
            (x + 1, y + 1),
            (x + 1, y1 - chip_h),
            (x1 - chip_w, y + 1),
            (x1 - chip_w, y1 - chip_h),
            (x + w + 2, y),
            (x - chip_w - 2, y),
            (x + w // 2 - chip_w // 2, y - chip_h - 1),
        ]
        placed = False
        for cx, cy in candidates:
            if 0 <= cx < width - chip_w and 0 <= cy < height - chip_h and _chip_free(cx, cy, chip_w, chip_h):
                _draw_text((r, g, b), width, height, cx, cy, number,
                           color=(255, 255, 255), scale=2, background=(0, 0, 0))
                occupied.append((cx, cy, chip_w, chip_h))
                placed = True
                break
    return Image(width, height, r, g, b, name="review-overlay")


def legend() -> list:
    return [
        {"reason": REASON_NAMES[flag], "rgb": list(COLORS[flag]), "guidance": REASON_TEXT[flag]}
        for flag in REGION_FLAGS
    ]

