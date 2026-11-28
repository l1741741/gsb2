"""Local focus measurement.

Sharpness is measured on luma with a root-mean-square Laplacian response in
a small window.  Per photo:

* ``energy``     = |4-neighbour Laplacian| + 0.5 * |diagonal Laplacian|;
* ``contrast``   = sqrt(box-filtered energy^2) over the window (default 2);
* ``floor``      = low percentile of ``contrast`` (noise/grain baseline);
* ``score``      = contrast / floor;
* ``confidence`` = 0 at ~1.35x the floor, rising to 1 at ~4x.

Scores are absolute and normalised by the *photo's own* noise floor, not by
its local residual: a defocused photo has less fine residual than a sharp
one, so dividing by local residual would reward blur.  The RMS (rather than
mean-of-magnitude) window average is what keeps the comparison honest at
hard edges: a blurred edge spreads its response thinly, a sharp edge
concentrates it, and squaring before averaging amplifies that difference.

Score is dimensionless and comparable between photos with similar exposure;
confidence says whether there is enough local detail to trust the comparison
at all.
"""

from __future__ import annotations

from array import array

from .image import Image
from .ops import box_blur, clamp, percentile

DEFAULT_WINDOW = 2
MIN_FLOOR = 0.35


class FocusPlanes:
    __slots__ = ("score", "confidence", "contrast", "energy", "floor", "ridge_threshold")

    def __init__(self, score, confidence, contrast, energy, floor, ridge_threshold) -> None:
        self.score = score
        self.confidence = confidence
        self.contrast = contrast
        self.energy = energy
        self.floor = floor
        self.ridge_threshold = ridge_threshold

    def __repr__(self) -> str:
        return "<FocusPlanes floor=%.2f ridge=%.2f>" % (self.floor, self.ridge_threshold)


def luma_float(image: Image) -> array:
    r, g, b = image.r, image.g, image.b
    n = len(r)
    out = array("f", bytes(4 * n))
    for i in range(n):
        out[i] = (299.0 * r[i] + 587.0 * g[i] + 114.0 * b[i]) / 1000.0
    return out


def laplacian_energy(luma: array, width: int, height: int) -> array:
    """Absolute multi-directional second derivative response per pixel.

    Both the 4-neighbour Laplacian and its diagonal counterpart are summed:
    a one-pixel line running at 45 degrees produces a strong response in the
    diagonal term even when the axis-aligned term is weak.
    """
    n = width * height
    out = array("f", bytes(4 * n))
    if width < 3 or height < 3:
        return out
    for y in range(1, height - 1):
        base = y * width
        above = base - width
        below = base + width
        for x in range(1, width - 1):
            i = base + x
            axis = 4.0 * luma[i] - luma[i - 1] - luma[i + 1] - luma[above + x] - luma[below + x]
            diag = 4.0 * luma[i] - luma[above + x - 1] - luma[above + x + 1] \
                - luma[below + x - 1] - luma[below + x + 1]
            if axis < 0:
                axis = -axis
            if diag < 0:
                diag = -diag
            out[i] = axis + 0.5 * diag
    return out


def focus_planes(image: Image, *, window: int = DEFAULT_WINDOW, noise_scale: float = 1.0) -> FocusPlanes:
    width, height = image.width, image.height
    luma = luma_float(image)
    energy = laplacian_energy(luma, width, height)

    # Root-mean-square of the Laplacian over the window.  Unlike the mean of
    # the absolute response, squaring before averaging does not reward a
    # blurred step edge (whose response is spread thinly over many pixels);
    # a sharp edge concentrates energy and wins decisively.
    squared = array("f", (value * value for value in energy))
    mean_squared = box_blur(squared, width, height, window)
    contrast = array("f", (value ** 0.5 if value > 0.0 else 0.0 for value in mean_squared))

    # Robust noise floor: the low percentile of the smoothed Laplacian
    # response.  In a real photograph some area is flat, so this estimates
    # how much response sensor noise alone produces -- and it is measured in
    # the same units as ``contrast``, unlike the residual of a blur.
    floor = max(percentile(contrast, 0.20, stride=3) * noise_scale, MIN_FLOOR)

    n = width * height
    score = array("f", bytes(4 * n))
    confidence = array("f", bytes(4 * n))
    low = floor * 1.35
    high = floor * 4.0
    for i in range(n):
        c = contrast[i]
        score[i] = c / floor
        confidence[i] = clamp((c - low) / (high - low), 0.0, 1.0)

    # Ridges used later to protect thin lines during seam blending: a high
    # Laplacian response is a good proxy for a one- or two-pixel line.
    ridge_floor = max(percentile(energy, 0.85, stride=5), floor * 2.0)
    return FocusPlanes(score, confidence, contrast, energy, floor, ridge_floor)


def score_stack(images: list, *, window: int = DEFAULT_WINDOW, noise_scale: float = 1.0) -> list:
    """Score each photo; returns a list of FocusPlanes."""
    return [focus_planes(image, window=window, noise_scale=noise_scale) for image in images]
