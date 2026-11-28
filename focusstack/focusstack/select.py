"""Per-pixel source selection with stable, explainable behaviour.

Selection rules, in order:

1. Only photos that recorded the pixel (valid mask) are candidates.
2. If local confidence is below ``confidence_threshold``, every focus score
   is noise.  Instead of letting tiny fluctuations pick a winner, the
   reference photo is used when it covers the pixel (otherwise the lowest
   valid index).  Such pixels are flagged for review.
3. If the best score and the runner-up are within ``tie_fraction`` of each
   other, the pixel is ambiguous.  A deterministic choice -- the lowest
   index among the tied set -- is made, so reruns and block exports cannot
   flip sources.  When the tied photos also differ visibly in colour, the
   pixel is flagged; visually equal photos are merged silently.
4. Otherwise the sharpest candidate wins.

Everything here is a pure function of the inputs, and operates pixel by
pixel without neighbourhood state, which is exactly what keeps a cropped
export identical to the corresponding block of the full result.
"""

from __future__ import annotations

from array import array

FLAG_LOW_CONF = 1
FLAG_TIE = 2
FLAG_SEAM_CONFLICT = 4
FLAG_UNCOVERED = 8
FLAG_MANUAL = 16
FLAG_MANUAL_PARTIAL = 32
FLAG_LOW_CONF_DIVERGENT = 64

REASON_NAMES = {
    FLAG_LOW_CONF: "low_confidence",
    FLAG_LOW_CONF_DIVERGENT: "low_confidence_divergent",
    FLAG_TIE: "ambiguous_near_tie",
    FLAG_SEAM_CONFLICT: "seam_conflict",
    FLAG_UNCOVERED: "uncovered",
    FLAG_MANUAL: "manual_override",
    FLAG_MANUAL_PARTIAL: "manual_override_partial",
}


UNCOVERED = -1


class Selection:
    __slots__ = ("labels", "flags", "width", "height", "tie_fraction", "confidence_threshold",
                 "reference", "low_conf_visual_diff")

    def __init__(self, labels, flags, width, height, tie_fraction, confidence_threshold, reference,
                 low_conf_visual_diff=8.0) -> None:
        self.labels = labels
        self.flags = flags
        self.width = width
        self.height = height
        self.tie_fraction = tie_fraction
        self.confidence_threshold = confidence_threshold
        self.reference = reference
        self.low_conf_visual_diff = low_conf_visual_diff

    def __repr__(self) -> str:
        return "<Selection %dx%d ref=%d>" % (self.width, self.height, self.reference)


def _rgb_diff(images: list, a: int, b: int, index: int) -> float:
    pa = images[a]
    pb = images[b]
    return (abs(pa.r[index] - pb.r[index]) + abs(pa.g[index] - pb.g[index]) + abs(pa.b[index] - pb.b[index])) / 3.0


def select_sources(
    images: list,
    focus,
    valid: list,
    *,
    reference: int = 0,
    tie_fraction: float = 0.12,
    confidence_threshold: float = 0.25,
    tie_visual_diff: float = 8.0,
    low_conf_visual_diff: float = 8.0,
    tie_flag_confidence: float = 0.5,
) -> Selection:
    """Return a Selection for the shared canvas.

    ``images`` are shifted RGB images, ``focus`` a list of FocusPlanes and
    ``valid`` shifted 0/255 coverage masks.
    """
    if not images:
        raise ValueError("at least one photo is required")
    if not 0 <= reference < len(images):
        raise ValueError("reference index out of range")
    width, height = images[0].width, images[0].height
    n = width * height
    count = len(images)
    labels = array("h", [UNCOVERED]) * n
    flags = array("B", bytes(n))

    for p in range(n):
        best = -1.0
        best_index = -1
        second = -1.0
        max_conf = 0.0
        valid_count = 0
        for k in range(count):
            if not valid[k][p]:
                continue
            valid_count += 1
            s = focus[k].score[p]
            if s > best:
                second = best
                best = s
                best_index = k
            elif s > second:
                second = s
            c = focus[k].confidence[p]
            if c > max_conf:
                max_conf = c

        if valid_count == 0:
            flags[p] = FLAG_UNCOVERED
            continue
        if valid_count == 1:
            labels[p] = best_index
            continue
        if max_conf < confidence_threshold:
            # Flat, low-contrast pixel: all scores are noise.  Stay with the
            # reference when it covers this pixel to keep the result stable.
            chosen = reference if valid[reference][p] else best_index
            labels[p] = chosen
            # Flat areas are always listed so a retoucher can review them
            # from the checklist (requirement 5).  When the photos also
            # visibly differ there, the region is marked divergent, which
            # ranks it higher; when they agree, the arbitrary choice is
            # unobservable but still worth knowing about.
            differs = False
            for k in range(count):
                if k == chosen or not valid[k][p]:
                    continue
                if _rgb_diff(images, chosen, k, p) > low_conf_visual_diff:
                    differs = True
                    break
            flags[p] |= FLAG_LOW_CONF_DIVERGENT if differs else FLAG_LOW_CONF
            continue

        if best <= 0.0 or (best - second) <= best * tie_fraction:
            tie_limit = best * (1.0 - tie_fraction)
            chosen = -1
            for k in range(count):
                if valid[k][p] and focus[k].score[p] >= tie_limit:
                    chosen = k
                    break
            if chosen < 0:
                chosen = best_index
            labels[p] = chosen
            # Only ask for review when the scores were genuinely meaningful
            # and the photos visibly disagree: near the canvas edge the
            # measurement window is truncated, so it must not spam the list.
            if (max_conf >= tie_flag_confidence and chosen != best_index
                    and _rgb_diff(images, chosen, best_index, p) > tie_visual_diff):
                flags[p] |= FLAG_TIE
            continue

        labels[p] = best_index

    return Selection(labels, flags, width, height, tie_fraction, confidence_threshold, reference,
                    low_conf_visual_diff)


def remove_isolated(labels: array, width: int, height: int, passes: int = 1) -> int:
    """Replace pixels with no 8-neighbour carrying their own label.

    This removes one-pixel speckle caused by focus noise.  Genuinely thin
    structures keep their neighbours along the line, so they survive; the
    function never erodes a line by itself.
    """
    changed_total = 0
    for _ in range(max(0, passes)):
        current = array("h", labels)
        changed = 0
        for y in range(height):
            for x in range(width):
                p = y * width + x
                own = current[p]
                if own == UNCOVERED:
                    continue
                counts = {}
                same = 0
                for ny in (y - 1, y, y + 1):
                    if ny < 0 or ny >= height:
                        continue
                    base = ny * width
                    for nx in (x - 1, x, x + 1):
                        if nx < 0 or nx >= width or (nx == x and ny == y):
                            continue
                        label = current[base + nx]
                        if label == UNCOVERED:
                            continue
                        counts[label] = counts.get(label, 0) + 1
                        if label == own:
                            same += 1
                if same > 0 or not counts:
                    continue
                majority = max(counts.items(), key=lambda item: (item[1], -item[0]))[0]
                labels[p] = majority
                changed += 1
        changed_total += changed
        if changed == 0:
            break
    return changed_total


def boundary_mask(labels: array, width: int, height: int) -> array:
    """255 where a covered pixel touches a different-label covered pixel."""
    n = width * height
    out = array("B", bytes(n))
    for y in range(height):
        base = y * width
        for x in range(width):
            p = base + x
            label = labels[p]
            if label == UNCOVERED:
                continue
            if (
                (x > 0 and labels[p - 1] not in (UNCOVERED, label))
                or (x + 1 < width and labels[p + 1] not in (UNCOVERED, label))
                or (y > 0 and labels[p - width] not in (UNCOVERED, label))
                or (y + 1 < height and labels[p + width] not in (UNCOVERED, label))
            ):
                out[p] = 255
    return out


def label_colors(count: int) -> list:
    """Distinct, high-contrast RGB colours per photo index (for label maps)."""
    base = [
        (230, 70, 60),
        (60, 120, 230),
        (60, 190, 90),
        (240, 200, 40),
        (180, 90, 220),
        (40, 200, 210),
        (250, 140, 30),
        (210, 60, 150),
        (130, 200, 50),
        (90, 90, 240),
    ]
    colors = []
    for k in range(count):
        if k < len(base):
            colors.append(base[k])
        else:
            # Deterministic spread over the hue circle.
            hue = (k * 137) % 360
            colors.append(_hsv_to_rgb(hue / 360.0, 0.62, 0.88))
    return colors


def _hsv_to_rgb(h: float, s: float, v: float) -> tuple:
    if s <= 0:
        return (int(v * 255),) * 3
    h6 = h * 6.0
    i = int(h6)
    f = h6 - i
    p = v * (1 - s)
    q = v * (1 - s * f)
    t = v * (1 - s * (1 - f))
    i %= 6
    r, g, b = [
        (v, t, p),
        (q, v, p),
        (p, v, t),
        (p, q, v),
        (t, p, v),
        (v, p, q),
    ][i]
    return (int(r * 255), int(g * 255), int(b * 255))
