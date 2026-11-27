"""Deterministic rectangle packing (MaxRects, best short-side fit).

Items are placed across a fixed number of fixed-size pages. Each item may
optionally be rotated 90 degrees. Placement is fully deterministic so that
the same inputs produce the same pages and coordinates regardless of input
order. A post-pass verifies that no two placed rectangles overlap.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    w: int
    h: int


@dataclass
class PackItem:
    item_id: str
    width: int
    height: int
    rotatable: bool = True


@dataclass
class Placement:
    item_id: str
    page: int
    x: int
    y: int
    width: int  # placed width (after rotation if any)
    height: int
    rotated: bool


@dataclass
class Rejection:
    item_id: str
    width: int
    height: int
    reason: str


@dataclass
class PackResult:
    page_width: int
    page_height: int
    max_pages: int
    placements: list[Placement] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)

    @property
    def pages_used(self) -> int:
        if not self.placements:
            return 0
        return max(p.page for p in self.placements) + 1


def _fits(w: int, h: int, free: Rect) -> bool:
    return w <= free.w and h <= free.h


def _split_free_rect(free: Rect, placed: Rect) -> list[Rect]:
    """MaxRects split: produce up to 4 rectangles of the uncovered area."""
    # No overlap: keep the free rect untouched.
    if (
        placed.x >= free.x + free.w
        or placed.x + placed.w <= free.x
        or placed.y >= free.y + free.h
        or placed.y + placed.h <= free.y
    ):
        return [free]
    pieces: list[Rect] = []
    if placed.x > free.x:  # left strip
        pieces.append(Rect(free.x, free.y, placed.x - free.x, free.h))
    if placed.x + placed.w < free.x + free.w:  # right strip
        nx = placed.x + placed.w
        pieces.append(Rect(nx, free.y, free.x + free.w - nx, free.h))
    if placed.y > free.y:  # top strip
        pieces.append(Rect(free.x, free.y, free.w, placed.y - free.y))
    if placed.y + placed.h < free.y + free.h:  # bottom strip
        ny = placed.y + placed.h
        pieces.append(Rect(free.x, ny, free.w, free.y + free.h - ny))
    return pieces


def _remove_contained(rects: list[Rect]) -> None:
    """Drop rectangles fully contained in another free rect, in place."""
    keep: list[Rect] = []
    for i, a in enumerate(rects):
        contained = False
        for j, b in enumerate(rects):
            if i == j:
                continue
            if (
                b.x <= a.x
                and b.y <= a.y
                and b.x + b.w >= a.x + a.w
                and b.y + b.h >= a.y + a.h
            ):
                contained = True
                break
        if not contained:
            keep.append(a)
    rects[:] = keep


def _find_best(
    item: PackItem, free_rects: list[Rect]
) -> tuple[int, int, int, bool] | None:
    """Best Short Side Fit with optional 90-degree rotation.

    Returns (x, y, score, rotated) or None when the item fits nowhere.
    Ties (and the whole algorithm) are broken deterministically by position.
    """
    best: tuple[int, int, int, bool] | None = None
    candidates = [(item.width, item.height, False)]
    if item.rotatable and item.width != item.height:
        candidates.append((item.height, item.width, True))
    for w, h, rotated in candidates:
        for free in free_rects:
            if not _fits(w, h, free):
                continue
            # Top-left placement inside this free rect.
            x, y = free.x, free.y
            leftover_w = free.w - w
            leftover_h = free.h - h
            short_side = min(leftover_w, leftover_h)
            long_side = max(leftover_w, leftover_h)
            # Lower short-side leftover is better; then long side, then
            # canonical orientation, then top-left coordinates.
            score = (short_side, long_side)
            if best is None or (score, rotated, x, y) < (
                best[2],
                best[3],
                best[0],
                best[1],
            ):
                best = (x, y, score, rotated)
    if best is None:
        return None
    return best


def rectangles_overlap(a: Rect, b: Rect) -> bool:
    return not (
        a.x + a.w <= b.x
        or b.x + b.w <= a.x
        or a.y + a.h <= b.y
        or b.y + b.h <= a.y
    )


def verify_no_overlap(placements: list[Placement]) -> None:
    """Raise AssertionError if any two placed rects on the same page overlap."""
    by_page: dict[int, list[Placement]] = {}
    for p in placements:
        by_page.setdefault(p.page, []).append(p)
    for page, rects in by_page.items():
        for i in range(len(rects)):
            a = Rect(rects[i].x, rects[i].y, rects[i].width, rects[i].height)
            for j in range(i + 1, len(rects)):
                b = Rect(rects[j].x, rects[j].y, rects[j].width, rects[j].height)
                if rectangles_overlap(a, b):
                    raise AssertionError(
                        f"internal error: {rects[i].item_id} and "
                        f"{rects[j].item_id} overlap on page {page}"
                    )


def pack(
    items: list[PackItem],
    page_width: int,
    page_height: int,
    max_pages: int,
) -> PackResult:
    """Pack items into at most `max_pages` pages of page_width x page_height."""
    if page_width <= 0 or page_height <= 0 or max_pages <= 0:
        raise ValueError("page dimensions and page count must be positive")

    result = PackResult(page_width, page_height, max_pages)

    # Reject items that can never fit, even alone on an empty page.
    viable: list[PackItem] = []
    for item in items:
        fits_normal = item.width <= page_width and item.height <= page_height
        fits_rotated = (
            item.rotatable and item.height <= page_width and item.width <= page_height
        )
        if not (fits_normal or fits_rotated):
            orient = (
                "rotation allowed but neither orientation fits"
                if item.rotatable
                else "image not rotatable"
            )
            result.rejected.append(
                Rejection(
                    item.item_id,
                    item.width,
                    item.height,
                    f"oversized: content {item.width}x{item.height} exceeds page "
                    f"{page_width}x{page_height} ({orient})",
                )
            )
        else:
            viable.append(item)

    # Deterministic order independent of input order: largest area first,
    # then longest side, then id. Input order never affects placement.
    viable.sort(key=lambda it: (-(it.width * it.height), -max(it.width, it.height), it.item_id))

    pages_free: list[list[Rect]] = [
        [Rect(0, 0, page_width, page_height)] for _ in range(max_pages)
    ]

    for item in viable:
        chosen: tuple[int, int, int, bool] | None = None
        chosen_page = -1
        chosen_score: tuple[int, int] | None = None
        # Fill lower-numbered pages first; among pages pick the tightest fit.
        for page_index in range(max_pages):
            found = _find_best(item, pages_free[page_index])
            if found is None:
                continue
            score = found[2]
            if chosen is None or score < chosen_score:
                chosen = found
                chosen_page = page_index
                chosen_score = score
        if chosen is None:
            result.rejected.append(
                Rejection(
                    item.item_id,
                    item.width,
                    item.height,
                    f"no space: {item.width}x{item.height} cannot fit in the "
                    f"remaining free area of the {max_pages} page(s); "
                    f"increase page size or page count",
                )
            )
            continue

        x, y, _, rotated = chosen
        placed_w = item.height if rotated else item.width
        placed_h = item.width if rotated else item.height
        placed = Rect(x, y, placed_w, placed_h)
        result.placements.append(
            Placement(item.item_id, chosen_page, x, y, placed_w, placed_h, rotated)
        )

        # Update free rectangles on the chosen page (MaxRects).
        free_rects = pages_free[chosen_page]
        updated: list[Rect] = []
        for free in free_rects:
            updated.extend(_split_free_rect(free, placed))
        _remove_contained(updated)
        pages_free[chosen_page] = updated

    verify_no_overlap(result.placements)
    result.rejected.sort(key=lambda r: r.item_id)
    return result
