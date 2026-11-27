"""Streaming, tile-based comparison engine.

The engine walks the shared canvas in tiles so that a change crossing a tile
border is still labeled as one component: two union-find labelers (one per
metric) only keep the previous label row in memory and merge labels while the
scan runs, so component identity is global across tiles.  Pixel values are
handed to a caller-supplied sink tile by tile; the report builder persists
them, tests can collect them in memory.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .geometry import CanvasGeometry, CoverageKind, DiffConfig, DiffKind, Rect


# --------------------------------------------------------------------- labeling
class _UnionFind:
    __slots__ = ("parent", "size")

    def __init__(self) -> None:
        self.parent = [0]
        self.size = [0]

    def add(self) -> int:
        idx = len(self.parent)
        self.parent.append(idx)
        self.size.append(1)
        return idx

    def find(self, x: int) -> int:
        parent = self.parent
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != x:
            parent[x], x = root, parent[x]
        return root

    def union(self, a: int, b: int) -> int:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return ra
        if self.size[ra] < self.size[rb]:
            ra, rb = rb, ra
        self.parent[rb] = ra
        self.size[ra] += self.size[rb]
        return ra


@dataclass
class LabelStat:
    """Mutable accumulator for one connected component."""

    x1: int
    y1: int
    x2: int  # exclusive
    y2: int  # exclusive
    count: int = 0
    peak_appearance: int = 0
    peak_alpha: int = 0
    has_appearance: bool = False
    has_alpha: bool = False
    coverage: str | None = None  # set for coverage labelers


class _RowLabeler:
    """8/4-connected component labeling with one label row in memory.

    Pixels may carry an integer ``label_class``; neighbors of different
    classes are never merged (used so reference-only and candidate-only
    coverage regions that merely touch stay separate components).
    """

    def __init__(self, connectivity: int = 8) -> None:
        self.uf = _UnionFind()
        self.stats: dict[int, LabelStat] = {}
        self._prev: list[int] = []
        self._cur: list[int] = []
        self._prev_cls: list[int] = []
        self._cur_cls: list[int] = []
        self._label_cls: dict[int, int] = {}
        self._connectivity = connectivity

    def start_row(self, width: int) -> None:
        self._prev = self._cur
        self._prev_cls = self._cur_cls
        self._cur = [0] * width
        self._cur_cls = [0] * width

    def label(self, x: int, y: int, label_class: int = 0) -> int:
        """Create/merge a label for an active pixel at (x, y)."""
        neighbors = []
        if x > 0 and self._cur[x - 1] and self._cur_cls[x - 1] == label_class:
            neighbors.append(self._cur[x - 1])
        if self._prev:
            if self._prev[x] and self._prev_cls[x] == label_class:
                neighbors.append(self._prev[x])
            if self._connectivity == 8:
                if x > 0 and self._prev[x - 1] and self._prev_cls[x - 1] == label_class:
                    neighbors.append(self._prev[x - 1])
                if (
                    x + 1 < len(self._prev)
                    and self._prev[x + 1]
                    and self._prev_cls[x + 1] == label_class
                ):
                    neighbors.append(self._prev[x + 1])
        if not neighbors:
            lab = self.uf.add()
            self.stats[lab] = LabelStat(x, y, x + 1, y + 1)
            self._label_cls[lab] = label_class
        else:
            lab = neighbors[0]
            for other in neighbors[1:]:
                lab = self.uf.union(lab, other)
        self._cur[x] = lab
        self._cur_cls[x] = label_class
        # Every active pixel extends the bounding box of its label's stat;
        # counts and peaks are maintained by the caller.
        stat = self.stats[lab]
        if x < stat.x1:
            stat.x1 = x
        if y < stat.y1:
            stat.y1 = y
        if x + 1 > stat.x2:
            stat.x2 = x + 1
        if y + 1 > stat.y2:
            stat.y2 = y + 1
        return lab

    def row_labels(self) -> list[int]:
        return self._cur

    def components(self) -> list[LabelStat]:
        """Aggregate per-root stats after the full scan."""
        roots: dict[int, LabelStat] = {}
        for label, stat in self.stats.items():
            root = self.uf.find(label)
            agg = roots.get(root)
            if agg is None:
                roots[root] = LabelStat(
                    stat.x1, stat.y1, stat.x2, stat.y2,
                    stat.count, stat.peak_appearance, stat.peak_alpha,
                    stat.has_appearance, stat.has_alpha, stat.coverage,
                )
                continue
            if stat.x1 < agg.x1:
                agg.x1 = stat.x1
            if stat.y1 < agg.y1:
                agg.y1 = stat.y1
            if stat.x2 > agg.x2:
                agg.x2 = stat.x2
            if stat.y2 > agg.y2:
                agg.y2 = stat.y2
            agg.count += stat.count
            if stat.peak_appearance > agg.peak_appearance:
                agg.peak_appearance = stat.peak_appearance
            if stat.peak_alpha > agg.peak_alpha:
                agg.peak_alpha = stat.peak_alpha
            agg.has_appearance = agg.has_appearance or stat.has_appearance
            agg.has_alpha = agg.has_alpha or stat.has_alpha
        return list(roots.values())


# ------------------------------------------------------------------------ blocks
@dataclass
class DiffBlock:
    block_id: str
    kind: str
    rect: Rect
    area: int
    peak_appearance: int
    peak_alpha: int

    def as_dict(self) -> dict:
        return {
            "id": self.block_id,
            "kind": self.kind,
            "rect": self.rect.as_dict(),
            "area": self.area,
            "peak_appearance": self.peak_appearance,
            "peak_alpha": self.peak_alpha,
        }


@dataclass
class CoverageBlock:
    block_id: str
    kind: str
    rect: Rect
    area: int

    def as_dict(self) -> dict:
        return {
            "id": self.block_id,
            "kind": self.kind,
            "rect": self.rect.as_dict(),
            "area": self.area,
        }


@dataclass
class CompareResult:
    blocks: list[DiffBlock]
    coverage_blocks: list[CoverageBlock]
    canvas: Rect
    common_rect: Rect
    counts: dict = field(default_factory=dict)


def _merge_by_gap(
    components: list[LabelStat], gap: int
) -> list[list[int]]:
    """Group components whose dilated bounding boxes (by gap) touch."""
    uf = _UnionFind()
    for _ in components:
        uf.add()
    n = len(components)
    order = sorted(range(n), key=lambda i: components[i].x1)
    for ai in range(n):
        i = order[ai]
        ci = components[i]
        for aj in range(ai + 1, n):
            j = order[aj]
            cj = components[j]
            # x1 is sorted; once the gap is exceeded no later candidate can
            # overlap ci horizontally, so stop scanning.
            if cj.x1 - gap > ci.x2:
                break
            if (
                ci.y1 - gap <= cj.y2
                and cj.y1 - gap <= ci.y2
            ):
                uf.union(i + 1, j + 1)
    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(uf.find(i + 1), []).append(i)
    return list(groups.values())


def _build_diff_blocks(
    appearance: _RowLabeler,
    alpha: _RowLabeler,
    config: DiffConfig,
) -> list[DiffBlock]:
    comps = appearance.components() + alpha.components()
    if not comps:
        return []

    groups = _merge_by_gap(comps, config.merge_gap) if config.merge_gap > 0 else [[i] for i in range(len(comps))]
    blocks: list[DiffBlock] = []
    for gi, group in enumerate(groups):
        members = [comps[i] for i in group]
        x1 = min(c.x1 for c in members)
        y1 = min(c.y1 for c in members)
        x2 = max(c.x2 for c in members)
        y2 = max(c.y2 for c in members)
        area = sum(c.count for c in members)
        if area < config.min_block_area:
            continue
        peak_a = max(c.peak_appearance for c in members)
        peak_al = max(c.peak_alpha for c in members)
        has_a = any(c.has_appearance for c in members)
        has_al = any(c.has_alpha for c in members)
        if has_a and has_al:
            kind = DiffKind.BOTH.value
        elif has_a:
            kind = DiffKind.APPEARANCE.value
        else:
            kind = DiffKind.ALPHA.value
        blocks.append(
            DiffBlock(
                block_id=f"d{gi:04d}",
                kind=kind,
                rect=Rect(x1, y1, x2 - x1, y2 - y1),
                area=area,
                peak_appearance=peak_a,
                peak_alpha=peak_al,
            )
        )
    blocks.sort(key=lambda b: (b.rect.y, b.rect.x))
    for i, block in enumerate(blocks):
        block.block_id = f"d{i:04d}"
    return blocks


def _build_coverage_blocks(
    labeler: _RowLabeler,
) -> list[CoverageBlock]:
    comps = labeler.components()
    comps.sort(key=lambda c: (c.y1, c.x1))
    out = []
    for i, c in enumerate(comps):
        kind = c.coverage or CoverageKind.REFERENCE_ONLY.value
        out.append(
            CoverageBlock(
                block_id=f"c{i:04d}",
                kind=kind,
                rect=Rect(c.x1, c.y1, c.x2 - c.x1, c.y2 - c.y1),
                area=c.count,
            )
        )
    return out


# ----------------------------------------------------------------------- engine
def compare(
    rgba_a,
    rgba_b,
    geometry: CanvasGeometry,
    config: DiffConfig,
    tile_sink=None,
) -> CompareResult:
    """Run the full comparison.

    rgba_a/rgba_b are RGBA8 :class:`~poster_diff.pngio.Image` objects.
    ``tile_sink(tile_rect, appearance_row_values, alpha_row_values,
    coverage_codes)`` is called once per processed tile (row-major), each
    value list is tile-local and laid out row by row.
    """
    canvas = geometry.bounds
    place_a, place_b = geometry.reference, geometry.candidate
    wa, ha = rgba_a.width, rgba_a.height
    wb, hb = rgba_b.width, rgba_b.height
    da, db = rgba_a.data, rgba_b.data
    bg_r, bg_g, bg_b = config.background
    at, al_t = config.appearance_threshold, config.alpha_threshold

    appearance = _RowLabeler(config.connectivity)
    alpha = _RowLabeler(config.connectivity)
    coverage = _RowLabeler(8)

    total_changed_a = total_changed_al = 0
    sum_appearance = sum_alpha = 0

    tiles = geometry.tile_bounds(config.tile_size)
    tiles_by_key = {
        (t.x, t.y): t for t in tiles
    }
    tile_size = config.tile_size
    # Per-tile sink buffers; labeling itself runs on full canvas rows so a
    # change crossing a tile border is one component, not two.
    buffers: dict[tuple[int, int], tuple[list, list, list]] = {}

    for cy in range(canvas.y, canvas.y2):
        gy = cy - canvas.y
        appearance.start_row(canvas.width)
        alpha.start_row(canvas.width)
        coverage.start_row(canvas.width)
        ap_label = appearance.label
        al_label = alpha.label
        cov_label = coverage.label
        ap_stats = appearance.stats
        al_stats = alpha.stats
        cov_stats = coverage.stats

        # Per-row coverage spans are at most: ref-only | common | cand-only.
        in_a_x0, in_a_x1 = place_a.ox, place_a.x2
        in_b_x0, in_b_x1 = place_b.ox, place_b.x2
        row_in_a = place_a.oy <= cy < place_a.y2
        row_in_b = place_b.oy <= cy < place_b.y2

        # Current tile row buffer bookkeeping.
        tile_iy = (cy - canvas.y) // tile_size
        tile_y = canvas.y + tile_iy * tile_size
        cur_tile_x = None
        sink_appearance = sink_alpha = sink_coverage = None

        def buffer_for(cx: int):
            nonlocal cur_tile_x, sink_appearance, sink_alpha, sink_coverage
            tx = canvas.x + ((cx - canvas.x) // tile_size) * tile_size
            if tx != cur_tile_x:
                cur_tile_x = tx
                key = (tx, tile_y)
                buf = buffers.get(key)
                if buf is None:
                    buf = ([], [], [])
                    buffers[key] = buf
                sink_appearance, sink_alpha, sink_coverage = buf
            return sink_appearance, sink_alpha, sink_coverage

        if row_in_a and row_in_b:
            # Split the row into coverage segments; the common span is the
            # hot path, the up to four flanking segments are single-sided.
            row_a = (cy - place_a.oy) * wa
            row_b = (cy - place_b.oy) * wb
            cuts = sorted({canvas.x, canvas.x2, in_a_x0, in_a_x1,
                           in_b_x0, in_b_x1})
            for seg0, seg1 in zip(cuts, cuts[1:]):
                x0 = max(canvas.x, seg0)
                x1 = min(canvas.x2, seg1)
                if x1 <= x0:
                    continue
                in_a_seg = in_a_x0 <= x0 and x1 <= in_a_x1
                in_b_seg = in_b_x0 <= x0 and x1 <= in_b_x1
                if in_a_seg and in_b_seg:
                    for cx in range(x0, x1):
                        gx = cx - canvas.x
                        sap, sal, scov = buffer_for(cx)
                        ia = (row_a + (cx - place_a.ox)) * 4
                        ib = (row_b + (cx - place_b.ox)) * 4
                        ar, ag, ab_c, aa = da[ia], da[ia + 1], da[ia + 2], da[ia + 3]
                        br, bg_c, bb, ba = db[ib], db[ib + 1], db[ib + 2], db[ib + 3]

                        alpha_diff = aa - ba
                        if alpha_diff < 0:
                            alpha_diff = -alpha_diff

                        # Fully transparent pixels hide their color: stored
                        # RGB is irrelevant once composited.
                        if aa == 0 and ba == 0:
                            appearance_diff = 0
                        else:
                            inv_a = 255 - aa
                            inv_b = 255 - ba
                            fa_r = (ar * aa + bg_r * inv_a) // 255
                            fa_g = (ag * aa + bg_g * inv_a) // 255
                            fa_b = (ab_c * aa + bg_b * inv_a) // 255
                            fb_r = (br * ba + bg_r * inv_b) // 255
                            fb_g = (bg_c * ba + bg_g * inv_b) // 255
                            fb_b = (bb * ba + bg_b * inv_b) // 255
                            d0 = fa_r - fb_r
                            if d0 < 0:
                                d0 = -d0
                            d1 = fa_g - fb_g
                            if d1 < 0:
                                d1 = -d1
                            d2 = fa_b - fb_b
                            if d2 < 0:
                                d2 = -d2
                            appearance_diff = d0
                            if d1 > appearance_diff:
                                appearance_diff = d1
                            if d2 > appearance_diff:
                                appearance_diff = d2

                        sap.append(appearance_diff)
                        sal.append(alpha_diff)
                        scov.append(0)
                        sum_appearance += appearance_diff
                        sum_alpha += alpha_diff

                        if appearance_diff >= at:
                            lab = ap_label(gx, gy)
                            st = ap_stats[lab]
                            st.count += 1
                            st.has_appearance = True
                            if appearance_diff > st.peak_appearance:
                                st.peak_appearance = appearance_diff
                            total_changed_a += 1
                        if alpha_diff >= al_t:
                            lab = al_label(gx, gy)
                            st = al_stats[lab]
                            st.count += 1
                            st.has_alpha = True
                            if alpha_diff > st.peak_alpha:
                                st.peak_alpha = alpha_diff
                            total_changed_al += 1
                else:
                    code = 1 if in_a_seg else 2 if in_b_seg else 0
                    if code == 0:
                        for cx in range(x0, x1):
                            sap, sal, scov = buffer_for(cx)
                            sap.append(0); sal.append(0); scov.append(0)
                        continue
                    kind = (
                        CoverageKind.REFERENCE_ONLY.value
                        if code == 1
                        else CoverageKind.CANDIDATE_ONLY.value
                    )
                    for cx in range(x0, x1):
                        gx = cx - canvas.x
                        sap, sal, scov = buffer_for(cx)
                        sap.append(0); sal.append(0); scov.append(code)
                        lab = cov_label(gx, gy, label_class=code)
                        st = cov_stats[lab]
                        st.count += 1
                        st.coverage = kind
        else:
            # Row covered by at most one image: every active pixel is a
            # single-sided coverage cell.
            for cx in range(canvas.x, canvas.x2):
                gx = cx - canvas.x
                sap, sal, scov = buffer_for(cx)
                code = 0
                if row_in_a and in_a_x0 <= cx < in_a_x1:
                    code = 1
                elif row_in_b and in_b_x0 <= cx < in_b_x1:
                    code = 2
                sap.append(0); sal.append(0); scov.append(code)
                if code:
                    lab = cov_label(gx, gy, label_class=code)
                    st = cov_stats[lab]
                    st.count += 1
                    st.coverage = (
                        CoverageKind.REFERENCE_ONLY.value
                        if code == 1
                        else CoverageKind.CANDIDATE_ONLY.value
                    )

        # Flush every tile whose bottom row was just scanned.
        for key in list(buffers.keys()):
            tile = tiles_by_key[key]
            if tile.y2 - 1 == cy:
                ap, alv, cov = buffers.pop(key)
                if tile_sink is not None:
                    tile_sink(tile, ap, alv, cov)

    blocks = _build_diff_blocks(appearance, alpha, config)
    coverage_blocks = _build_coverage_blocks(coverage)

    common = geometry.common_rect
    common_area = common.area
    counts = {
        "canvas_width": canvas.width,
        "canvas_height": canvas.height,
        "canvas_area": canvas.area,
        "common_area": common_area,
        "reference_only_area": sum(
            b.area for b in coverage_blocks if b.kind == CoverageKind.REFERENCE_ONLY.value
        ),
        "candidate_only_area": sum(
            b.area for b in coverage_blocks if b.kind == CoverageKind.CANDIDATE_ONLY.value
        ),
        "changed_appearance_pixels": total_changed_a,
        "changed_alpha_pixels": total_changed_al,
        "mean_appearance_diff": round(sum_appearance / common_area, 4) if common_area else 0.0,
        "mean_alpha_diff": round(sum_alpha / common_area, 4) if common_area else 0.0,
        "diff_block_count": len(blocks),
        "coverage_block_count": len(coverage_blocks),
    }
    return CompareResult(blocks, coverage_blocks, canvas, common, counts)
