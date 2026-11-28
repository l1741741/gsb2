"""Seam treatment between neighbouring source photos.

A hard label map produces visible steps wherever the focus choice changes.
This module turns labels into soft weights and blends the photos, with two
safeguards:

* **Edge preservation** -- mixing is suppressed where the two photos
  genuinely disagree (an object line, a moved part).  The protection mask is
  derived from the owner photo's own Laplacian ridge response, so an easy
  to miss one-pixel line stays with a single photo instead of being averaged
  into a ghost.
* **Bounded seam width** -- the blend radius is configurable per run
  (``seam_radius``), and the editor can preview a narrow strip on demand.

The renderer never invents values: every output pixel is a weighted average
of pixels that were actually recorded, weights are normalised, and pixels
no photo covered stay black with ``FLAG_UNCOVERED`` in the review list.
"""

from __future__ import annotations

from array import array

from .image import Image
from .ops import box_blur, clamp

from .select import FLAG_UNCOVERED, UNCOVERED


def ridge_protection(focus, labels: array, width: int, height: int, *, strength: float = 1.0) -> array:
    """0..255 protection where the owning photo has a thin bright/dark edge."""
    n = width * height
    out = array("B", bytes(n))
    if strength <= 0 or not focus:
        return out
    for p in range(n):
        owner = labels[p]
        if owner == UNCOVERED:
            continue
        planes = focus[owner]
        energy = planes.energy[p]
        limit = planes.ridge_threshold
        if energy <= 0.0 or limit <= 0.0:
            continue
        ratio = energy / limit
        if ratio >= 1.0:
            value = 255.0 * (ratio - 1.0) / 2.0 + 128.0
            out[p] = int(clamp(value * strength, 0, 255))
        elif ratio >= 0.6:
            out[p] = int(clamp(255.0 * (ratio - 0.6) / 0.8 * strength, 0, 255))
    # Grow protection by one pixel along the ridge, then soften it a little
    # so it surrounds the line rather than drawing another hard border.
    grown = array("B", bytes(n))
    for y in range(height):
        base = y * width
        for x in range(width):
            p = base + x
            value = out[p]
            if value >= 128:
                grown[p] = value
                if x > 0 and grown[p - 1] < value:
                    grown[p - 1] = max(grown[p - 1], value // 2)
                if x + 1 < width and grown[p + 1] < value:
                    grown[p + 1] = max(grown[p + 1], value // 2)
                if y > 0 and grown[p - width] < value:
                    grown[p - width] = max(grown[p - width], value // 2)
                if y + 1 < height and grown[p + width] < value:
                    grown[p + width] = max(grown[p + width], value // 2)
    if not any(grown):
        return grown
    softened = box_blur(array("f", (float(v) for v in grown)), width, height, 1)
    return array("B", (int(clamp(v, 0, 255)) for v in softened))


def label_weights(labels: array, count: int, width: int, height: int, radius: int) -> list:
    """One 0..1 float plane per photo: the filtered indicator of its label."""
    n = width * height
    if radius <= 0:
        planes = []
        for k in range(count):
            plane = array("f", bytes(4 * n))
            for p in range(n):
                if labels[p] == k:
                    plane[p] = 1.0
            planes.append(plane)
        return planes
    planes = []
    for k in range(count):
        mask = array("B", bytes(n))
        for p in range(n):
            if labels[p] == k:
                mask[p] = 255
        blurred = box_blur(array("f", (float(v) for v in mask)), width, height, radius)
        plane = array("f", bytes(4 * n))
        for p in range(n):
            plane[p] = blurred[p] / 255.0
        planes.append(plane)
    return planes


def merge_labels(
    labels: array,
    images: list,
    focus,
    width: int,
    height: int,
    *,
    seam_radius: int = 2,
    protect_edges: bool = True,
) -> Image:
    """Blend all photos according to the label map.

    Every pixel is a normalised weighted average of the same canvas position
    from the source photos, so the operation is local and deterministic.
    """
    count = len(images)
    n = width * height
    weights = label_weights(labels, count, width, height, seam_radius)
    protection = ridge_protection(focus, labels, width, height) if protect_edges else array("B", bytes(n))

    if protect_edges:
        for p in range(n):
            protect = protection[p] / 255.0
            if protect <= 0.0:
                continue
            owner = labels[p]
            if owner == UNCOVERED:
                continue
            for k in range(count):
                if k == owner:
                    weights[k][p] = 1.0 - (1.0 - weights[k][p]) * protect
                else:
                    weights[k][p] *= 1.0 - protect

    r = array("B", bytes(n))
    g = array("B", bytes(n))
    b = array("B", bytes(n))
    for p in range(n):
        total = 0.0
        value_r = 0.0
        value_g = 0.0
        value_b = 0.0
        for k in range(count):
            w = weights[k][p]
            if w <= 0.0:
                continue
            image = images[k]
            value_r += image.r[p] * w
            value_g += image.g[p] * w
            value_b += image.b[p] * w
            total += w
        if total <= 1e-9:
            if labels[p] != UNCOVERED:
                # Weight collapse can only happen through protection on a
                # heavily mixed pixel; fall back to the owner photo.
                owner = labels[p]
                if owner >= 0:
                    r[p], g[p], b[p] = images[owner].r[p], images[owner].g[p], images[owner].b[p]
            continue
        r[p] = int(value_r / total + 0.5)
        g[p] = int(value_g / total + 0.5)
        b[p] = int(value_b / total + 0.5)
    return Image(width, height, r, g, b, name="focus-stack")


def seam_conflict_plane(
    images: list,
    labels: array,
    width: int,
    height: int,
    *,
    difference_threshold: float = 26.0,
) -> array:
    """255 where a seam mixes photos that disagree visibly in luma.

    These pixels are listed for review: a moved object that spans a focus
    transition can still smear even with edge protection.
    """
    n = width * height
    count = len(images)
    out = array("B", bytes(n))
    if count < 2:
        return out
    lumas = []
    for image in images:
        lumas.append(array(
            "f",
            (float((299 * image.r[i] + 587 * image.g[i] + 114 * image.b[i]) // 1000) for i in range(n)),
        ))
    for y in range(height):
        base = y * width
        for x in range(width):
            p = base + x
            own = labels[p]
            if own == UNCOVERED:
                continue
            other = -1
            if x > 0 and labels[p - 1] not in (own, UNCOVERED):
                other = labels[p - 1]
            elif x + 1 < width and labels[p + 1] not in (own, UNCOVERED):
                other = labels[p + 1]
            elif y > 0 and labels[p - width] not in (own, UNCOVERED):
                other = labels[p - width]
            elif y + 1 < height and labels[p + width] not in (own, UNCOVERED):
                other = labels[p + width]
            if other < 0:
                continue
            if abs(lumas[own][p] - lumas[other][p]) >= difference_threshold:
                out[p] = 255
    return out
