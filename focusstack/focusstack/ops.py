"""Numeric helpers shared by the focus stacker.

Everything operates on ``array('f')`` or ``array('B')`` planes.  Pure-Python
loops are used because the tool intentionally avoids third-party packages;
the loops are kept tight (locally bound names, no per-pixel objects).
"""

from __future__ import annotations

from array import array


def box_blur(src: array, width: int, height: int, radius: int) -> array:
    """Separable box blur of a float plane with clamped borders."""
    if radius <= 0:
        return array("f", src)
    n = width * height
    kernel = 2 * radius + 1
    temp = array("f", bytes(4 * n))
    out = array("f", bytes(4 * n))
    for y in range(height):
        base = y * width
        total = 0.0
        for i in range(-radius, radius + 1):
            total += src[base + (0 if i < 0 else (width - 1 if i >= width else i))]
        for x in range(width):
            temp[base + x] = total / kernel
            left = x - radius
            right = x + radius + 1
            total -= src[base + (0 if left < 0 else (width - 1 if left >= width else left))]
            total += src[base + (0 if right >= width else right)]
    for x in range(width):
        total = 0.0
        for i in range(-radius, radius + 1):
            total += temp[(0 if i < 0 else (height - 1 if i >= height else i)) * width + x]
        for y in range(height):
            out[y * width + x] = total / kernel
            up = y - radius
            down = y + radius + 1
            total -= temp[(0 if up < 0 else (height - 1 if up >= height else up)) * width + x]
            total += temp[(0 if down >= height else down) * width + x]
    return out


def percentile(values: array, fraction: float, stride: int = 1) -> float:
    """Exact percentile of a float array (used for thresholding).

    ``stride`` samples every n-th element first to keep large images cheap;
    thresholds are robust statistics, so the subsample is adequate.
    """
    if not values:
        return 0.0
    sampled = values[::stride] if stride > 1 else values
    if not sampled:
        sampled = values
    ordered = sorted(sampled)
    index = int(round((len(ordered) - 1) * fraction))
    return ordered[max(0, min(len(ordered) - 1, index))]


def clamp(value: float, low: float, high: float) -> float:
    if value < low:
        return low
    if value > high:
        return high
    return value
