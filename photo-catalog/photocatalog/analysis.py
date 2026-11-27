"""Pixel-level analysis helpers: resampling, colour statistics, hashes."""

from __future__ import annotations

from dataclasses import dataclass

from .imaging.image import Image


def to_grey(img: Image) -> list[int]:
    """Return a row-major list of 8-bit luminance values."""
    px = img.pixels
    ch = img.channels
    n = img.width * img.height
    if ch == 1:
        return list(px[:n])
    out = [0] * n
    if ch == 3:
        for i in range(n):
            o = i * 3
            out[i] = (px[o] * 299 + px[o + 1] * 587 + px[o + 2] * 114) // 1000
        return out
    for i in range(n):
        o = i * 4
        out[i] = (px[o] * 299 + px[o + 1] * 587 + px[o + 2] * 114) // 1000
    return out


def resize_grey(width: int, height: int, grey: list[int],
                new_w: int, new_h: int) -> list[int]:
    """Area-average a greyscale image down to ``new_w`` x ``new_h``.

    Averaging (rather than nearest neighbour) keeps comparisons stable when
    one copy of a photo is a different size or has been differently compressed.
    """
    if new_w <= 0 or new_h <= 0:
        raise ValueError("target dimensions must be positive")
    if width == new_w and height == new_h:
        return list(grey)
    out = [0] * (new_w * new_h)
    # Precompute source spans per axis so the loop below stays cheap.
    x_spans = []
    for x in range(new_w):
        x0 = (x * width) // new_w
        x1 = max(x0 + 1, ((x + 1) * width) // new_w)
        x_spans.append((x0, min(x1, width)))
    y_spans = []
    for y in range(new_h):
        y0 = (y * height) // new_h
        y1 = max(y0 + 1, ((y + 1) * height) // new_h)
        y_spans.append((y0, min(y1, height)))
    for y in range(new_h):
        y0, y1 = y_spans[y]
        out_row = y * new_w
        span_h = y1 - y0
        for x in range(new_w):
            x0, x1 = x_spans[x]
            total = 0
            span_w = x1 - x0
            for sy in range(y0, y1):
                base = sy * width
                for sx in range(x0, x1):
                    total += grey[base + sx]
            out[out_row + x] = total // (span_w * span_h)
    return out


def resize_rgb(img: Image, new_w: int, new_h: int) -> Image:
    """Area-average an RGB(A) image; alpha is dropped."""
    greyish = img.to_rgb() if img.channels != 3 else img
    px = greyish.pixels
    channels = 3
    out = bytearray(new_w * new_h * channels)
    x_spans = []
    for x in range(new_w):
        x0 = (x * img.width) // new_w
        x1 = max(x0 + 1, ((x + 1) * img.width) // new_w)
        x_spans.append((x0, min(x1, img.width)))
    y_spans = []
    for y in range(new_h):
        y0 = (y * img.height) // new_h
        y1 = max(y0 + 1, ((y + 1) * img.height) // new_h)
        y_spans.append((y0, min(y1, img.height)))
    for y in range(new_h):
        y0, y1 = y_spans[y]
        span_h = y1 - y0
        for x in range(new_w):
            x0, x1 = x_spans[x]
            span_w = x1 - x0
            count = span_w * span_h
            r = g = b = 0
            for sy in range(y0, y1):
                base = sy * img.width
                for sx in range(x0, x1):
                    o = (base + sx) * 3
                    r += px[o]
                    g += px[o + 1]
                    b += px[o + 2]
            o = (y * new_w + x) * 3
            out[o] = r // count
            out[o + 1] = g // count
            out[o + 2] = b // count
    return Image(new_w, new_h, bytes(out), 3, img.format, "RGB")


@dataclass(slots=True)
class Signature:
    """Compact descriptor used for candidate search.

    ``dhash`` / ``phash`` are 64-bit perceptual hashes computed on a square
    aspect-normalised version image so different crops still line up roughly.
    ``mean_rgb`` describes overall colour; ``grid_rgb`` is a 4x4 colour layout
    used to tell "same colours, different photo" apart from "same photo".
    """

    dhash: int
    phash: int
    mean_rgb: tuple[float, float, float]
    grid_rgb: tuple[tuple[int, int, int], ...]
    grey_std: float
    #: 16x16 greyscale thumbnail (aspect-normalised) for structural checks.
    thumb: tuple[int, ...]


def _dhash(grey: list[int], width: int, height: int, size: int = 8) -> int:
    small = resize_grey(width, height, grey, size + 1, size)
    value = 0
    for y in range(size):
        for x in range(size):
            left = small[y * (size + 1) + x]
            right = small[y * (size + 1) + x + 1]
            value = (value << 1) | (1 if left < right else 0)
    return value


def _phash(grey: list[int], width: int, height: int, size: int = 32) -> int:
    """DCT-based hash: signs of the 8x8 lowest frequencies."""
    small = resize_grey(width, height, grey, size, size)
    basis = _dct_basis(size)
    # 2D DCT, but only the 8x8 lowest frequencies are needed.
    rows = []
    for vy in range(8):
        row_basis = basis[vy]
        for y in range(size):
            acc = 0.0
            offset = y * size
            for x in range(size):
                acc += row_basis[x] * small[offset + x]
            rows.append(acc)
    value = 0
    coeffs = []
    for vy in range(8):
        for vx in range(8):
            acc = 0.0
            base = vy * size
            row_basis = basis[vx]
            for y in range(size):
                acc += row_basis[y] * rows[base + y]
            coeffs.append(acc)
    del coeffs[0]  # DC term is brightness, not structure
    med = sorted(coeffs)[len(coeffs) // 2]
    for c in coeffs:
        value = (value << 1) | (1 if c > med else 0)
    return value


_DCT_BASIS_CACHE: dict[int, list[list[float]]] = {}


def _dct_basis(size: int) -> list[list[float]]:
    import math
    table = _DCT_BASIS_CACHE.get(size)
    if table is None:
        table = []
        for u in range(8):
            cu = math.sqrt(1.0 / size) if u == 0 else math.sqrt(2.0 / size)
            table.append([cu * math.cos((2 * x + 1) * u * math.pi / (2 * size))
                          for x in range(size)])
        _DCT_BASIS_CACHE[size] = table
    return table


def build_signature(img: Image) -> Signature:
    rgb = img.to_rgb()
    w, h = rgb.width, rgb.height
    grey = to_grey(rgb)

    # Colour statistics on the full image.
    px = rgb.pixels
    n = w * h
    sr = sg = sb = 0
    for i in range(0, n * 3, 3):
        sr += px[i]
        sg += px[i + 1]
        sb += px[i + 2]
    mean_rgb = (sr / n, sg / n, sb / n)

    # Grey standard deviation: plain copies have similar contrast.
    mean_g = sum(grey) / n
    var = sum((v - mean_g) ** 2 for v in grey) / n
    grey_std = var ** 0.5

    # 4x4 colour layout from the aspect-normalised thumbnail.
    aspect = w / h if h else 1.0
    if aspect >= 1.0:
        tw, th = 64, max(1, int(round(64 / aspect)))
    else:
        tw, th = max(1, int(round(64 * aspect))), 64
    thumb_img = resize_rgb(rgb, tw, th)
    grid = _grid_colours(thumb_img.pixels, tw, th, 4, 4)
    grey_thumb = resize_grey(w, h, grey, 16, 16)

    return Signature(
        dhash=_dhash(grey, w, h),
        phash=_phash(grey, w, h),
        mean_rgb=mean_rgb,
        grid_rgb=tuple(grid),
        grey_std=grey_std,
        thumb=tuple(grey_thumb),
    )


def _grid_colours(px: bytes, w: int, h: int, cols: int, rows: int) -> list[tuple[int, int, int]]:
    cells = []
    for gy in range(rows):
        y0 = (gy * h) // rows
        y1 = max(y0 + 1, ((gy + 1) * h) // rows)
        for gx in range(cols):
            x0 = (gx * w) // cols
            x1 = max(x0 + 1, ((gx + 1) * w) // cols)
            r = g = b = 0
            count = 0
            for y in range(y0, y1):
                base = (y * w + x0) * 3
                for x in range(x1 - x0):
                    o = base + x * 3
                    r += px[o]
                    g += px[o + 1]
                    b += px[o + 2]
                    count += 1
            if count:
                cells.append((r // count, g // count, b // count))
            else:
                cells.append((0, 0, 0))
    return cells


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()
