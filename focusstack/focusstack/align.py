"""Alignment helpers: integer offsets, placements and the shared canvas.

Each photo may declare an integer ``(dx, dy)`` offset in one common frame.
Choosing photo *i* as the reference subtracts its offset from all others, so
the reference sits at (0, 0) and defines the coordinate base.

The output canvas is the **union** of every shifted photo's footprint, not
merely the reference photo's frame.  That matters: if one photo is nudged
right and up, its content genuinely extends beyond the reference frame, and
the tool must either keep that area (``keep``) or crop to the region every
photo recorded (``crop``).  The union's bounding box may itself contain holes
where two diagonally offset photos leave a corner uncovered; ``error`` mode
detects those by unioning per-row intervals rather than trusting the box.

Canvas coordinates start at the union's top-left corner.  A photo with a
placement ``(px, py)`` covers ``px..px+W`` and ``py..py+H``.
"""

from __future__ import annotations

from array import array

from .image import Image, ImageError


class OffsetPair:
    __slots__ = ("dx", "dy")

    def __init__(self, dx: int, dy: int) -> None:
        if not isinstance(dx, int) or not isinstance(dy, int):
            raise TypeError("offsets must be integers")
        self.dx = dx
        self.dy = dy

    def __repr__(self) -> str:
        return "OffsetPair(%d, %d)" % (self.dx, self.dy)

    def as_tuple(self) -> tuple:
        return (self.dx, self.dy)

    def __eq__(self, other) -> bool:
        return isinstance(other, OffsetPair) and (self.dx, self.dy) == (other.dx, other.dy)

    def __hash__(self) -> int:
        return hash((self.dx, self.dy))


def parse_offset(text: str) -> OffsetPair:
    """Parse ``dx,dy`` or ``(dx, dy)`` into an OffsetPair."""
    cleaned = text.strip().replace("(", "").replace(")", "").replace(" ", "")
    parts = cleaned.split(",")
    if len(parts) != 2:
        raise ValueError("offset must be 'dx,dy', got %r" % text)
    try:
        return OffsetPair(int(parts[0]), int(parts[1]))
    except ValueError as exc:
        raise ValueError("offset components must be integers, got %r" % text) from exc


def placements(size: tuple, offsets: list) -> tuple:
    """Return ``(canvas_size, origin, placements)``.

    ``placements`` is a list of ``(px, py, width, height)`` in canvas
    coordinates; ``origin`` is the common-frame position of canvas (0, 0),
    useful for reporting.  Offsets may be negative: the canvas grows in that
    direction and every placement is shifted accordingly.
    """
    width, height = size
    if not offsets:
        raise ImageError("at least one offset is required")
    left = min(offset.dx for offset in offsets)
    top = min(offset.dy for offset in offsets)
    right = max(offset.dx + width for offset in offsets)
    bottom = max(offset.dy + height for offset in offsets)
    if right <= left or bottom <= top:
        raise ImageError("photos do not overlap")
    canvas = (right - left, bottom - top)
    placed = [(offset.dx - left, offset.dy - top, width, height) for offset in offsets]
    return canvas, (left, top), placed


def common_rect(size: tuple, offsets: list) -> tuple:
    """(x, y, width, height) intersection of every placement, in canvas coordinates."""
    _, _, placed = placements(size, offsets)
    left = max(px for px, py, w, h in placed)
    top = max(py for px, py, w, h in placed)
    right = min(px + w for px, py, w, h in placed)
    bottom = min(py + h for px, py, w, h in placed)
    if right <= left or bottom <= top:
        raise ImageError("photos do not overlap after applying the requested offsets")
    return (left, top, right - left, bottom - top)


def union_rect(size: tuple, offsets: list) -> tuple:
    """(x, y, width, height) bounding every pixel some photo recorded."""
    canvas, _, _ = placements(size, offsets)
    return (0, 0, canvas[0], canvas[1])


def placed_footprints(size: tuple, offsets: list) -> list:
    _, _, placed = placements(size, offsets)
    return [(px, py, px + w, py + h) for px, py, w, h in placed]


def window_coverage(size: tuple, offsets: list, window: tuple) -> tuple:
    """Whether every pixel of ``window`` was recorded by some photo.

    The union's bounding box can be fully rectangular while its corners are
    empty (two diagonally offset photos leave such a corner).  This walks
    each row and unions the covered x-intervals, so holes are detected.

    Returns ``(covered, missing_pixels)``.
    """
    x0, y0, ww, wh = window
    footprints = placed_footprints(size, offsets)
    missing = 0
    for y in range(y0, y0 + wh):
        intervals = sorted((fx0, fx1) for (fx0, fy0, fx1, fy1) in footprints
                           if fy0 <= y < fy1)
        cursor = x0
        for fx0, fx1 in intervals:
            if fx1 <= cursor:
                continue
            if fx0 > cursor:
                missing += min(fx0, x0 + ww) - cursor
            cursor = max(cursor, fx1)
            if cursor >= x0 + ww:
                break
        if cursor < x0 + ww:
            missing += x0 + ww - cursor
    return missing == 0, missing


def resolve_window(size: tuple, offsets: list, window: tuple, coverage: str) -> tuple:
    """Clip an export window (canvas coordinates) against the usable region.

    ``coverage``:
      * ``"crop"`` -- clip to the common region; never exports holes.
      * ``"keep"`` -- clip to the union; holes are marked in the output.
      * ``"error"`` -- require every window pixel to be recorded by a photo.
    """
    if coverage not in ("crop", "keep", "error"):
        raise ValueError("coverage mode must be 'crop', 'keep' or 'error'")
    wx, wy, ww, wh = window
    if ww <= 0 or wh <= 0:
        raise ImageError("export window must have positive size")
    canvas, _, _ = placements(size, offsets)
    if coverage == "crop":
        region = common_rect(size, offsets)
    else:
        region = (0, 0, canvas[0], canvas[1])
    x0 = max(wx, region[0])
    y0 = max(wy, region[1])
    x1 = min(wx + ww, region[0] + region[2])
    y1 = min(wy + wh, region[1] + region[3])
    if x1 <= x0 or y1 <= y0:
        raise ImageError("export window does not intersect the usable region")
    if coverage == "error":
        covered, missing = window_coverage(size, offsets, (wx, wy, ww, wh))
        if not covered:
            raise ImageError("export window reaches %d pixel(s) no photo recorded" % missing)
        return (wx, wy, ww, wh)
    return (x0, y0, x1 - x0, y1 - y0)


def place_plane(plane: array, src_w: int, src_h: int, dst_w: int, dst_h: int,
                px: int, py: int, fill=0) -> array:
    """Paste a plane into a larger canvas at ``(px, py)``; blanks use ``fill``."""
    out = array(plane.typecode, bytes(plane.itemsize * dst_w * dst_h))
    if fill:
        out[:] = array(plane.typecode, [fill]) * (dst_w * dst_h)
    x0 = max(0, px)
    x1 = min(dst_w, px + src_w)
    y0 = max(0, py)
    y1 = min(dst_h, py + src_h)
    if x1 <= x0 or y1 <= y0:
        return out
    run = x1 - x0
    for y in range(y0, y1):
        src_off = (y - py) * src_w + (x0 - px)
        dst_off = y * dst_w + x0
        out[dst_off:dst_off + run] = plane[src_off:src_off + run]
    return out


def place_image(image: Image, canvas_size: tuple, placement: tuple, fill=(0, 0, 0, 0),
                *, name: str | None = None) -> Image:
    """Return a canvas-sized image with ``image`` pasted at its placement."""
    canvas_w, canvas_h = canvas_size
    px, py, _, _ = placement
    return Image(
        canvas_w,
        canvas_h,
        place_plane(image.r, image.width, image.height, canvas_w, canvas_h, px, py, fill[0]),
        place_plane(image.g, image.width, image.height, canvas_w, canvas_h, px, py, fill[1]),
        place_plane(image.b, image.width, image.height, canvas_w, canvas_h, px, py, fill[2]),
        place_plane(image.a, image.width, image.height, canvas_w, canvas_h, px, py,
                    fill[3] if len(fill) > 3 else 255) if image.a is not None else None,
        name=image.name if name is None else name,
        source_bit_depth=image.source_bit_depth,
        had_palette=image.had_palette,
    )
