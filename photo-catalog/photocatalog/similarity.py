"""Similarity scoring and relationship classification.

The rules this module enforces:

* **A candidate pair is a proposal, never an automatic merge.**  Each pair
  carries a score, a list of human-readable reasons, and the corresponding
  region(s), so a person can accept or reject it.
* **Similarity is not transitive.**  If A resembles B and B resembles C but A
  and C differ clearly, the three are reported as a chain with the weak link
  called out — never collapsed into one group.  Grouping uses mutual strong
  links only.
* **Look-alikes must be separable.**  Two different photos in the same place
  share background statistics and can produce nearly identical global hashes.
  The discriminator is a *difference map* on the aligned region: true copies
  differ by a broad, smooth colour/scale shift, while different photos differ
  in one concentrated area (the subject).

Scoring combines cheap global features with a local verification pass that
finds the best alignment of the smaller image inside the larger, which is how a
copy with trimmed borders is still recognised.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .analysis import Signature, hamming, resize_grey, to_grey
from .imaging.image import Image

# Working resolution for the alignment search and difference map.  Small enough
# to keep pure-Python cost low, large enough to preserve the subject.
WORK_LONG = 96
TILES_X = 8
TILES_Y = 6


@dataclass(slots=True)
class PairEvidence:
    """Everything the scoring pipeline knows about one candidate pair."""

    a: str
    b: str
    score: float = 0.0
    same_photo: float = 0.0
    #: 0..1 practical suitability for merging into one archive entry.
    merge_fit: float = 0.0
    reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    size_a: tuple[int, int] = (0, 0)
    size_b: tuple[int, int] = (0, 0)
    aspect_delta: float = 0.0
    phash_distance: int = 0
    dhash_distance: int = 0
    colour_distance: float = 0.0
    structure: float = 0.0
    #: Best match of the smaller image inside the larger.
    region_correlation: float = 0.0
    region_mae: float | None = None
    #: Fraction of tiles whose error is clearly above the median.
    region_outlier_fraction: float = 0.0
    #: Largest tile error minus the median tile error.
    region_excess: float = 0.0
    #: Residual after removing a global tone fit (median/max tile error).
    residual_median: float = 0.0
    residual_max: float = 0.0
    #: Max residual over smooth (non-edge) regions.  This is the sharpest
    #: separator between a copy and two different photos: resampling noise
    #: lives on edges, while a changed subject alters smooth areas too.
    residual_flat: float = 0.0
    #: Maximum residual accepted for a copy, widened for heavy resampling.
    residual_gate: float = 0.0
    crop: tuple[float, float, float, float] | None = None
    #: Full alignment result, kept for report rendering.
    region: "RegionMatch | None" = None
    relation: str = "candidate"


def aspect(w: int, h: int) -> float:
    return (w / h) if h else 1.0


def aspect_similarity(a: tuple[int, int], b: tuple[int, int]) -> float:
    ra, rb = aspect(*a), aspect(*b)
    if ra <= 0 or rb <= 0:
        return 0.0
    return min(ra, rb) / max(ra, rb)


def colour_distance(sa: Signature, sb: Signature) -> float:
    total = 0.0
    for (r1, g1, b1), (r2, g2, b2) in zip(sa.grid_rgb, sb.grid_rgb):
        total += abs(r1 - r2) + abs(g1 - g2) + abs(b1 - b2)
    return total / (len(sa.grid_rgb) * 3 * 255.0)


def structure_similarity(sa: Signature, sb: Signature) -> float:
    """Pearson correlation of the 16x16 grey thumbnails, rescaled to 0..1."""
    ta, tb = sa.thumb, sb.thumb
    n = len(ta)
    ma = sum(ta) / n
    mb = sum(tb) / n
    cov = sum((ta[i] - ma) * (tb[i] - mb) for i in range(n))
    va = sum((v - ma) ** 2 for v in ta) ** 0.5
    vb = sum((v - mb) ** 2 for v in tb) ** 0.5
    if va < 1e-6 or vb < 1e-6:
        return 1.0 if va < 1e-6 and vb < 1e-6 else 0.0
    corr = cov / (va * vb)
    # Keep the sign: anti-correlated thumbnails (inverted images) are not similar.
    return max(0.0, min(1.0, corr))


@dataclass(slots=True)
class RegionMatch:
    correlation: float
    mae: float
    crop: tuple[float, float, float, float]
    #: Scale of the smaller image's pixels relative to the larger image's.
    scale: float
    tile_errors: tuple[float, ...]

    @property
    def median_error(self) -> float:
        return sorted(self.tile_errors)[len(self.tile_errors) // 2]

    @property
    def max_error(self) -> float:
        return max(self.tile_errors)

    @property
    def outlier_fraction(self) -> float:
        errs = sorted(self.tile_errors)
        med = errs[len(errs) // 2]
        threshold = max(18.0, med + 15.0)
        return sum(1 for e in errs if e > threshold) / len(errs)

    @property
    def excess(self) -> float:
        return self.max_error - self.median_error


def _box_blur(grey: list[int], w: int, h: int, radius: int) -> list[int]:
    if radius <= 0:
        return grey
    tmp = [0] * (w * h)
    for y in range(h):
        row = y * w
        for x in range(w):
            total = 0
            count = 0
            for dx in range(-radius, radius + 1):
                xx = x + dx
                if 0 <= xx < w:
                    total += grey[row + xx]
                    count += 1
            tmp[row + x] = total // count
    out = [0] * (w * h)
    for y in range(h):
        for x in range(w):
            total = 0
            count = 0
            for dy in range(-radius, radius + 1):
                yy = y + dy
                if 0 <= yy < h:
                    total += tmp[yy * w + x]
                    count += 1
            out[y * w + x] = total // count
    return out


def _prepare(img: Image, w: int, h: int, blur: int) -> list[int]:
    return _box_blur(resize_grey(img.width, img.height, to_grey(img), w, h), w, h, blur)


def _corr(a: list[int], b: list[int]) -> float:
    n = len(a)
    ma = sum(a) / n
    mb = sum(b) / n
    cov = 0.0
    va = 0.0
    vb = 0.0
    for i in range(n):
        da = a[i] - ma
        db = b[i] - mb
        cov += da * db
        va += da * da
        vb += db * db
    if va < 1e-6 or vb < 1e-6:
        return 0.0
    return cov / (va * vb) ** 0.5


def _window(big: list[int], bw: int, x: int, y: int, w: int, h: int) -> list[int]:
    out = []
    for row in range(y, y + h):
        out.extend(big[row * bw + x:row * bw + x + w])
    return out


def _tile_errors(a: list[int], b: list[int], w: int, h: int) -> tuple[float, ...]:
    """Mean absolute error per tile of the difference map."""
    tw = max(1, w // TILES_X)
    th = max(1, h // TILES_Y)
    errors = []
    for ty in range(TILES_Y):
        y0 = ty * th
        y1 = h if ty == TILES_Y - 1 else (ty + 1) * th
        if y1 <= y0:
            continue
        for tx in range(TILES_X):
            x0 = tx * tw
            x1 = w if tx == TILES_X - 1 else (tx + 1) * tw
            if x1 <= x0:
                continue
            total = 0
            count = 0
            for y in range(y0, y1):
                base = y * w
                for x in range(x0, x1):
                    total += abs(a[base + x] - b[base + x])
                    count += 1
            if count:
                errors.append(total / count)
    return tuple(errors)


def affine_residual(a: "Image", b: "Image", match: RegionMatch,
                    *, grid: int = 64) -> tuple[float, float, float] | None:
    """Compare the aligned region after removing a global brightness/contrast shift.

    A copy that was resized or re-graded differs from the original by a broad,
    smooth tone shift; fitting ``y = k*x + c`` removes that and leaves almost
    nothing.  Two different photos in the same place still differ in one
    concentrated place (the subject), which survives the fit.

    Resampling also blurs high-gradient edges, which shows up as residual
    concentrated *on* edges.  To avoid mistaking that for a different photo the
    return value includes a third statistic measured only over smooth regions:
    a genuine subject change alters smooth areas too, while resampling noise
    lives on edges.

    Returns ``(median_tile_error, max_tile_error, flat_region_max_error)`` on
    the residual, or ``None`` when the region has too little structure.
    """
    big, small = (a, b) if a.width * a.height >= b.width * b.height else (b, a)
    crop = match.crop
    bw, bh = big.width, big.height
    x0 = int(crop[0] * bw)
    y0 = int(crop[1] * bh)
    x1 = max(x0 + 1, int(crop[2] * bw))
    y1 = max(y0 + 1, int(crop[3] * bh))
    gb = to_grey(big)
    gs = to_grey(small)
    win = []
    for y in range(y0, y1):
        win.extend(gb[y * bw + x0:y * bw + x1])
    ww, wh = x1 - x0, y1 - y0
    gw = grid
    gh = max(6, int(round(grid * wh / ww)))
    A = resize_grey(ww, wh, win, gw, gh)
    B = resize_grey(small.width, small.height, gs, gw, gh)
    n = len(A)
    mean_a = sum(A) / n
    mean_b = sum(B) / n
    var_a = sum((v - mean_a) ** 2 for v in A)
    if var_a < 1e-6:
        return None
    cov = sum((A[i] - mean_a) * (B[i] - mean_b) for i in range(n))
    k = cov / var_a
    c = mean_b - k * mean_a
    residual = [abs(B[i] - (k * A[i] + c)) for i in range(n)]

    # Smooth regions: lower half of the gradient map of A, lightly blurred.
    blurred = _box_blur(A, gw, gh, 1)
    gradient = [0.0] * n
    for y in range(gh):
        base = y * gw
        next_row = min(gh - 1, y + 1) * gw
        for x in range(gw):
            i = base + x
            dx = abs(blurred[i] - blurred[base + min(gw - 1, x + 1)])
            dy = abs(blurred[i] - blurred[next_row + x])
            gradient[i] = dx + dy
    flat_count = max(1, n // 2)
    flat_indices = sorted(range(n), key=lambda i: gradient[i])[:flat_count]
    flat_max = max(residual[i] for i in flat_indices)

    tw = max(1, gw // TILES_X)
    th = max(1, gh // TILES_Y)
    tiles = []
    for ty in range(TILES_Y):
        ry0 = ty * th
        ry1 = gh if ty == TILES_Y - 1 else (ty + 1) * th
        for tx in range(TILES_X):
            rx0 = tx * tw
            rx1 = gw if tx == TILES_X - 1 else (tx + 1) * tw
            total = 0
            count = 0
            for y in range(ry0, ry1):
                row = y * gw
                for x in range(rx0, rx1):
                    total += residual[row + x]
                    count += 1
            if count:
                tiles.append(total / count)
    tiles.sort()
    return tiles[len(tiles) // 2], tiles[-1], flat_max


def find_region(img_a: Image, img_b: Image, *, work_long: int = WORK_LONG,
                search_margin: float = 0.22) -> RegionMatch | None:
    """Find the best placement of one image inside the other.

    Two families of hypothesis are tried:

    1. **Scaled whole frame** — both images resized to a common extent.  This
       matches a resize of the same photo.
    2. **Cropped window** — a window of the smaller image's aspect and relative
       size slid over the larger image at its own pixel scale.  This matches a
       copy whose borders were trimmed.

    Ties are broken by correlation, with a variance guard so a featureless
    window (open sky) cannot win on a fluke.
    """
    if img_a.width == 0 or img_a.height == 0 or img_b.width == 0 or img_b.height == 0:
        return None

    big, small = (img_a, img_b) if img_a.width * img_a.height >= img_b.width * img_b.height \
        else (img_b, img_a)
    bw, bh = big.width, big.height
    sw, sh = small.width, small.height

    # Working resolution: keep the larger image's aspect, long edge = work_long.
    if bw >= bh:
        ww = work_long
        wh = max(6, int(round(work_long * bh / bw)))
    else:
        wh = work_long
        ww = max(6, int(round(work_long * bw / bh)))
    scale_big = ww / bw
    blur = 1 if max(ww, wh) <= 96 else 2

    big_work = _prepare(big, ww, wh, blur)
    if not big_work:
        return None

    best: RegionMatch | None = None
    best_corr = -2.0

    # --- Hypothesis 1: both resized to the same extent ------------------
    small_full = _prepare(small, ww, wh, blur)
    corr = _corr(big_work, small_full)
    if corr > best_corr:
        tiles = _tile_errors(big_work, small_full, ww, wh)
        best_corr = corr
        best = RegionMatch(corr, sum(tiles) / len(tiles), (0.0, 0.0, 1.0, 1.0),
                           1.0, tiles)

    # --- Hypothesis 2: a bordered copy of the smaller image ---------------
    # The small image occupies a window in the big image whose size, expressed
    # in work pixels, is its own size scaled by the big image's work scale.
    base_w = max(4, int(round(sw * scale_big)))
    base_h = max(4, int(round(sh * scale_big)))
    # Tolerance for a copy that was also resized before the borders were cut.
    for factor in (1.0, 0.85, 0.7, 0.55):
        win_w = min(ww, max(4, int(round(base_w * factor))))
        win_h = min(wh, max(4, int(round(base_h * factor))))
        if win_w < 8 or win_h < 8:
            continue
        small_win = _prepare(small, win_w, win_h, blur)
        cand = _search_window(big_work, ww, wh, bw, small, small_win,
                              win_w, win_h, search_margin, factor)
        if cand is not None and cand.correlation > best_corr + 0.002:
            best_corr = cand.correlation
            best = cand

    return best


def _integral(arr: list[int], w: int, h: int) -> list[int]:
    """Summed-area table (one extra row and column of zeros)."""
    stride = w + 1
    table = [0] * (stride * (h + 1))
    for y in range(1, h + 1):
        row_sum = 0
        base = y * stride
        prev = base - stride
        for x in range(1, w + 1):
            row_sum += arr[(y - 1) * w + (x - 1)]
            table[base + x] = table[prev + x] + row_sum
    return table


def _window_sum(table: list[int], stride: int, x: int, y: int, w: int, h: int) -> int:
    return (table[(y + h) * stride + (x + w)]
            - table[y * stride + (x + w)]
            - table[(y + h) * stride + x]
            + table[y * stride + x])


def _search_window(big: list[int], bw: int, bh: int, big_width: int,
                   small: Image, small_win: list[int], win_w: int,
                   win_h: int, margin: float, factor: float) -> RegionMatch | None:
    n = win_w * win_h
    mean_s = sum(small_win) / n
    var_s = sum((v - mean_s) ** 2 for v in small_win)
    if var_s < 200.0:
        return None

    if win_w >= bw and win_h >= bh:
        x_range = range(0, 1)
        y_range = range(0, 1)
    else:
        x_lo, x_hi = 0, bw - win_w
        y_lo, y_hi = 0, bh - win_h
        cx, cy = (bw - win_w) // 2, (bh - win_h) // 2
        mx = min(int(round(bw * margin)) + win_w // 4, (x_hi - x_lo) // 2)
        my = min(int(round(bh * margin)) + win_h // 4, (y_hi - y_lo) // 2)
        x_lo, x_hi = max(x_lo, cx - mx), min(x_hi, cx + mx)
        y_lo, y_hi = max(y_lo, cy - my), min(y_hi, cy + my)
        x_range = range(x_lo, x_hi + 1)
        y_range = range(y_lo, y_hi + 1)

    sum_table = _integral(big, bw, bh)
    sq_table = _integral([v * v for v in big], bw, bh)
    stride = bw + 1

    # Covariance needs sum(big*small); compute that by direct correlation, but
    # only at candidate offsets found on a coarse grid (step 2) first, then
    # refine at step 1 around the best coarse hit.
    candidates = [(x, y) for y in y_range for x in x_range]
    coarse_step = 2 if len(candidates) > 900 else 1

    def corr_at(x: int, y: int) -> float:
        sw = _window_sum(sum_table, stride, x, y, win_w, win_h)
        sqw = _window_sum(sq_table, stride, x, y, win_w, win_h)
        var_w = sqw - sw * sw / n
        if var_w < 1e-6:
            return -2.0
        cov = 0.0
        for row in range(y, y + win_h):
            base = row * bw + x
            off = (row - y) * win_w
            for k in range(win_w):
                cov += big[base + k] * small_win[off + k]
        mean_w = sw / n
        return (cov - n * mean_w * mean_s) / ((var_w * var_s) ** 0.5)

    coarse_candidates = [c for c in candidates
                         if (c[0] - x_range.start) % coarse_step == 0
                         and (c[1] - y_range.start) % coarse_step == 0]
    best_corr = -2.0
    best_xy = (0, 0)
    for x, y in coarse_candidates:
        c = corr_at(x, y)
        if c > best_corr:
            best_corr = c
            best_xy = (x, y)

    # Local refine at full resolution around the coarse winner.
    if coarse_step > 1 and best_corr > -2.0:
        bx, by_ = best_xy
        for y in range(max(y_range.start, by_ - 2), min(y_range.stop, by_ + 3)):
            for x in range(max(x_range.start, bx - 2), min(x_range.stop, bx + 3)):
                c = corr_at(x, y)
                if c > best_corr:
                    best_corr = c
                    best_xy = (x, y)

    if best_corr <= -2.0:
        return None
    x, y = best_xy
    window = _window(big, bw, x, y, win_w, win_h)
    mean_w = sum(window) / len(window)
    if sum((v - mean_w) ** 2 for v in window) < 200.0:
        return None
    tiles = _tile_errors(window, small_win, win_w, win_h)
    scale = bw / max(1, big_width)
    crop = (
        round(x / bw, 4),
        round(y / bh, 4),
        round((x + win_w) / bw, 4),
        round((y + win_h) / bh, 4),
    )
    return RegionMatch(best_corr, sum(tiles) / len(tiles), crop, scale, tiles)
