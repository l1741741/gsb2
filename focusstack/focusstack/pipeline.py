"""Pipeline orchestration: photos -> aligned focus planes -> labels -> composite.

Order of operations is fixed so results are reproducible:

1. Read every photo and check identical dimensions.
2. Compute a canvas as the union of every shifted photo (integer offsets)
   and place each photo on it, with a coverage mask per photo.
3. Measure focus per placed photo (absolute score + confidence).
4. Select a source per pixel, apply manual overrides from the edit document,
   then remove isolated one-pixel labels.
5. Mark seam conflicts (visibly disagreeing photos on both sides of a seam).
6. Blend with edge-protecting weights.

All measurements and the label map run on the full canvas.  An export window
only selects what is written (and clipped by the coverage mode), which is
what guarantees a block's selection matches the full result at the same
coordinates.
"""

from __future__ import annotations

import json
from array import array
from pathlib import Path

from .align import (OffsetPair, common_rect, parse_offset, place_image, placements,
                    resolve_window, union_rect)
from .edits import apply_edits
from .focus import score_stack
from .image import Image, ImageError
from .pngio import PngError, read_png, write_png
from .review import build_regions, legend, render_overlay
from .seam import merge_labels, seam_conflict_plane
from .select import (
    FLAG_SEAM_CONFLICT,
    UNCOVERED,
    boundary_mask,
    label_colors,
    remove_isolated,
    select_sources,
)


class StackError(ValueError):
    """Raised when a stack cannot be processed as configured."""


class StackResult:
    __slots__ = (
        "photos",
        "offsets",
        "reference",
        "width",
        "height",
        "shifted",
        "valid",
        "focus",
        "selection",
        "composite",
        "labels",
        "flags",
        "edit_records",
        "edit_document",
        "seam_radius",
        "remove_speckle",
        "min_review_area",
        "review_max_regions",
        "photo_size",
        "origin",
        "placements",
    )

    def __init__(self, **kwargs) -> None:
        for key, value in kwargs.items():
            setattr(self, key, value)

    @property
    def common(self) -> tuple:
        return common_rect(self.photo_size, self.offsets)

    @property
    def union(self) -> tuple:
        return union_rect(self.photo_size, self.offsets)


def _coverage_from_image(image: Image) -> array:
    n = image.width * image.height
    if image.a is None:
        return array("B", [255]) * n
    alpha = image.a
    mask = array("B", bytes(n))
    for i in range(n):
        if alpha[i] >= 8:
            mask[i] = 255
    return mask


def _place_mask(mask: array, size: tuple, placement: tuple, canvas: tuple) -> array:
    from .align import place_plane

    return place_plane(mask, size[0], size[1], canvas[0], canvas[1], placement[0], placement[1], 0)


def prepare_photos(paths) -> tuple:
    if not paths:
        raise StackError("no photos given")
    photos = []
    for path in paths:
        try:
            photos.append(read_png(path))
        except PngError as exc:
            raise StackError(str(exc)) from exc
    width, height = photos[0].width, photos[0].height
    for index, photo in enumerate(photos):
        if (photo.width, photo.height) != (width, height):
            raise StackError(
                "photo %d (%s) is %dx%d but photo 0 is %dx%d; a common size is required"
                % (index, photo.name or "?", photo.width, photo.height, width, height)
            )
    return photos, (width, height)


def resolve_offsets(photo_count: int, reference: int, offsets) -> list:
    """Validate offsets and rebase them so the reference photo sits at (0, 0).

    Users give one integer offset per photo in any common frame; choosing a
    different reference then simply re-expresses the same geometry in that
    photo's coordinate system (every offset has the reference's offset
    subtracted).  The reference photo always defines the canvas, so its
    normalised offset is (0, 0).
    """
    if not 0 <= reference < photo_count:
        raise StackError("reference index %d is outside 0..%d" % (reference, photo_count - 1))
    if offsets is None:
        normalised = [OffsetPair(0, 0) for _ in range(photo_count)]
    else:
        if isinstance(offsets, str):
            offsets = [parse_offset(part) for part in offsets.split(";") if part.strip()]
        if not isinstance(offsets, (list, tuple)):
            raise StackError("offsets must be a list of integer pairs")
        if len(offsets) == 1 and photo_count > 1:
            offsets = list(offsets) * photo_count
        if len(offsets) != photo_count:
            raise StackError("expected %d offsets, got %d" % (photo_count, len(offsets)))
        normalised = []
        for index, offset in enumerate(offsets):
            if isinstance(offset, str):
                offset = parse_offset(offset)
            elif isinstance(offset, (tuple, list)) and len(offset) == 2:
                try:
                    offset = OffsetPair(int(offset[0]), int(offset[1]))
                except (TypeError, ValueError) as exc:
                    raise StackError("offset %d must be a pair of integers" % index) from exc
            if not isinstance(offset, OffsetPair):
                raise StackError("offset %d must be a pair of integers" % index)
            normalised.append(offset)
    base = normalised[reference]
    return [OffsetPair(offset.dx - base.dx, offset.dy - base.dy) for offset in normalised]


def run_stack(
    paths,
    *,
    reference: int = 0,
    offsets=None,
    edits=None,
    window=None,
    coverage: str = "crop",
    seam_radius: int = 2,
    focus_window: int = 2,
    noise_scale: float = 1.0,
    confidence_threshold: float = 0.25,
    tie_fraction: float = 0.12,
    tie_visual_diff: float = 4.0,
    low_conf_visual_diff: float = 8.0,
    tie_flag_confidence: float = 0.5,
    remove_speckle: int = 1,
    seam_conflict_threshold: float = 26.0,
    protect_edges: bool = True,
    min_review_area: int = 4,
    review_max_regions: int = 400,
) -> tuple:
    """Run the full pipeline and return ``(StackResult, export_window)``."""
    photos, photo_size = prepare_photos(paths)
    photo_count = len(photos)
    if not 0 <= reference < photo_count:
        raise StackError("reference index %d is outside 0..%d" % (reference, photo_count - 1))
    offsets = resolve_offsets(photo_count, reference, offsets)

    try:
        (width, height), origin, placed = placements(photo_size, offsets)
    except ImageError as exc:
        raise StackError(str(exc)) from exc
    if window is None:
        window = (0, 0, width, height)
    try:
        export_window = resolve_window(photo_size, offsets, window, coverage)
    except ImageError as exc:
        raise StackError(str(exc)) from exc

    shifted = []
    valid = []
    for index, photo in enumerate(photos):
        shifted.append(place_image(photo, (width, height), placed[index], fill=(0, 0, 0, 0)))
        valid.append(_place_mask(_coverage_from_image(photo), photo_size, placed[index], (width, height)))

    focus = score_stack(shifted, window=focus_window, noise_scale=noise_scale)
    selection = select_sources(
        shifted,
        focus,
        valid,
        reference=reference,
        tie_fraction=tie_fraction,
        confidence_threshold=confidence_threshold,
        tie_visual_diff=tie_visual_diff,
        low_conf_visual_diff=low_conf_visual_diff,
        tie_flag_confidence=tie_flag_confidence,
    )
    flags = array("B", selection.flags)
    labels = array("h", selection.labels)

    edit_document = edits if edits is not None else {"version": 1, "edits": []}
    edit_records = apply_edits(
        edit_document, labels, flags, width, height, photo_valid=valid, report_window=export_window
    )

    if remove_speckle > 0:
        remove_isolated(labels, width, height, passes=remove_speckle)

    if photo_count >= 2:
        conflict = seam_conflict_plane(
            shifted, labels, width, height, difference_threshold=seam_conflict_threshold
        )
        for p in range(width * height):
            if conflict[p]:
                flags[p] |= FLAG_SEAM_CONFLICT

    composite = merge_labels(
        labels, shifted, focus, width, height, seam_radius=seam_radius, protect_edges=protect_edges
    )

    result = StackResult(
        photos=photos,
        offsets=offsets,
        reference=reference,
        photo_size=photo_size,
        origin=origin,
        placements=placed,
        width=width,
        height=height,
        shifted=shifted,
        valid=valid,
        focus=focus,
        selection=selection,
        composite=composite,
        labels=labels,
        flags=flags,
        edit_records=edit_records,
        edit_document=edit_document,
        seam_radius=seam_radius,
        remove_speckle=remove_speckle,
        min_review_area=min_review_area,
        review_max_regions=review_max_regions,
    )
    return result, export_window


def build_source_map(result: StackResult, window: tuple) -> Image:
    """Colour-coded used-source map cropped to ``window``."""
    x, y, w, h = window
    colors = label_colors(len(result.photos))
    n = w * h
    r = array("B", bytes(n))
    g = array("B", bytes(n))
    b = array("B", bytes(n))
    labels = result.labels
    sx = result.width
    for row in range(h):
        src_row = (y + row) * sx + x
        dst_row = row * w
        for col in range(w):
            label = labels[src_row + col]
            p = dst_row + col
            if label == UNCOVERED:
                r[p] = g[p] = b[p] = 25
            elif 0 <= label < len(colors):
                r[p], g[p], b[p] = colors[label]
    return Image(w, h, r, g, b, name="sources")


def build_source_photo_map(result: StackResult, window: tuple) -> Image:
    """Grayscale of the actual source pixels used, dark grey where unused."""
    x, y, w, h = window
    n = w * h
    r = array("B", bytes(n))
    g = array("B", bytes(n))
    b = array("B", bytes(n))
    labels = result.labels
    sx = result.width
    used = bytearray(n)
    for row in range(h):
        src_row = (y + row) * sx + x
        dst_row = row * w
        for col in range(w):
            label = labels[src_row + col]
            if 0 <= label < len(result.photos):
                used[dst_row + col] = 1
    for p in range(n):
        if not used[p]:
            r[p] = g[p] = b[p] = 40
    for k, photo in enumerate(result.shifted):
        for row in range(h):
            src_row = (y + row) * sx + x
            dst_row = row * w
            for col in range(w):
                if labels[src_row + col] != k:
                    continue
                src = src_row + col
                dst = dst_row + col
                value = photo.r[src]
                if photo.g[src] > value:
                    value = photo.g[src]
                if photo.b[src] > value:
                    value = photo.b[src]
                r[dst] = g[dst] = b[dst] = value
    return Image(w, h, r, g, b, name="sources-photo")


def build_boundary_map(result: StackResult, window: tuple) -> Image:
    """Seam lines over a dimmed composite."""
    x, y, w, h = window
    crop = result.composite.crop(x, y, w, h)
    lines = boundary_mask(result.labels, result.width, result.height)
    n = w * h
    r = array("B", (crop.r[p] // 2 for p in range(n)))
    g = array("B", (crop.g[p] // 2 for p in range(n)))
    b = array("B", (crop.b[p] // 2 for p in range(n)))
    for row in range(h):
        src_row = (y + row) * result.width + x
        dst_row = row * w
        for col in range(w):
            if lines[src_row + col]:
                r[dst_row + col] = 255
                g[dst_row + col] = 240
                b[dst_row + col] = 30
    return Image(w, h, r, g, b, name="seams")


def _export_composite(result: StackResult, window: tuple, coverage: str) -> Image:
    x, y, w, h = window
    crop = result.composite.crop(x, y, w, h)
    if coverage != "keep":
        return crop
    # Keep mode: uncovered pixels become a clear grey checkerboard instead
    # of pretending to be black content.
    n = w * h
    r = array("B", bytes(n))
    g = array("B", bytes(n))
    b = array("B", bytes(n))
    labels = result.labels
    sx = result.width
    for row in range(h):
        src_row = (y + row) * sx + x
        dst_row = row * w
        for col in range(w):
            p = dst_row + col
            if labels[src_row + col] == UNCOVERED:
                value = 118 if (((row // 8) + (col // 8)) & 1) else 96
                r[p] = g[p] = b[p] = value
            else:
                r[p] = crop.r[p]
                g[p] = crop.g[p]
                b[p] = crop.b[p]
    return Image(w, h, r, g, b, name="focus-stack")


def _usage_summary(result: StackResult, window: tuple) -> dict:
    x, y, w, h = window
    n = w * h
    counts = [0] * len(result.photos)
    uncovered = 0
    labels = result.labels
    sx = result.width
    for row in range(h):
        src_row = (y + row) * sx + x
        for col in range(w):
            label = labels[src_row + col]
            if label == UNCOVERED:
                uncovered += 1
            elif 0 <= label < len(counts):
                counts[label] += 1
    return {
        "window_pixels": n,
        "by_photo": {str(k): v for k, v in enumerate(counts)},
        "uncovered": uncovered,
        "share": {str(k): round(v / n, 4) for k, v in enumerate(counts)},
    }


def write_result(
    result: StackResult,
    export_window: tuple,
    out_dir,
    *,
    coverage: str = "crop",
    emit_masks: bool = False,
    source_kind: str = "labels",
    extra_meta: dict | None = None,
) -> dict:
    """Write composite, source map, seam map, overlay and review.json."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    x, y, w, h = export_window

    if source_kind == "labels":
        source_map = build_source_map(result, export_window)
    elif source_kind == "photos":
        source_map = build_source_photo_map(result, export_window)
    else:
        raise StackError("source_kind must be 'labels' or 'photos'")
    write_png(out_dir / "sources.png", source_map)

    write_png(out_dir / "composite.png", _export_composite(result, export_window, coverage))
    write_png(out_dir / "seams.png", build_boundary_map(result, export_window))

    regions, truncated, flagged_area = build_regions(
        result.flags, result.labels, result.focus, result.width, result.height,
        window=export_window, min_area=result.min_review_area, max_regions=result.review_max_regions,
    )
    overlay = render_overlay(result.composite, result.flags, regions).crop(x, y, w, h)
    write_png(out_dir / "review-overlay.png", overlay)

    colors = label_colors(len(result.photos))
    document = {
        "tool": "focusstack",
        "canvas": {"width": result.width, "height": result.height},
        "photo_size": {"width": result.photo_size[0], "height": result.photo_size[1]},
        "canvas_origin_in_common_frame": {"x": result.origin[0], "y": result.origin[1]},
        "photo_placements": [
            {"index": index, "x": p[0], "y": p[1], "width": p[2], "height": p[3]}
            for index, p in enumerate(result.placements)
        ],
        "export_window": {"x": x, "y": y, "width": w, "height": h},
        "coverage": coverage,
        "reference": result.reference,
        "photos": [
            {
                "index": index,
                "name": Path(photo.name).name if photo.name else "photo-%02d" % index,
                "offset": list(result.offsets[index].as_tuple()),
                "colour": list(colors[index]) if index < len(colors) else None,
            }
            for index, photo in enumerate(result.photos)
        ],
        "common_region": list(result.common),
        "union_region": list(result.union),
        "selection_parameters": {
            "seam_radius": result.seam_radius,
            "speckle_passes": result.remove_speckle,
            "confidence_threshold": result.selection.confidence_threshold,
            "tie_fraction": result.selection.tie_fraction,
        },
        "usage": _usage_summary(result, export_window),
        "reasons_legend": legend(),
        "regions_truncated": truncated,
        "flagged_pixel_area": flagged_area,
        "regions": regions,
        "manual_edits": list(result.edit_records),
        "source_map": {
            "file": "sources.png",
            "kind": source_kind,
            "note": (
                "pixel colour = photo colour from the photos list; dark grey = no photo recorded"
                if source_kind == "labels"
                else "brightness = the photo pixel used at that position; dark grey = unused"
            ),
        },
        "checklist": [
            "open composite.png at 100% and scan the regions list in priority order",
            "sources.png: confirm no one-pixel source islands on large flat areas",
            "seams.png: confirm object outlines are continuous, not doubled",
            "review-overlay.png: confirm each numbered box is a real defect or an accepted ambiguity",
            "after adding a manual override, rerun and confirm its in_window count is above zero",
        ],
    }
    if extra_meta:
        document.update(extra_meta)
    with open(out_dir / "review.json", "w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    if emit_masks:
        masks_dir = out_dir / "masks"
        masks_dir.mkdir(exist_ok=True)
        labels = result.labels
        n = w * h
        for index in range(len(result.photos)):
            plane = array("B", bytes(n))
            for row in range(h):
                src_row = (y + row) * result.width + x
                dst_row = row * w
                for col in range(w):
                    if labels[src_row + col] == index:
                        plane[dst_row + col] = 255
            write_png(masks_dir / ("source-%02d.png" % index),
                      Image(w, h, array("B", plane), array("B", plane), array("B", plane),
                            name="mask-%02d" % index))

    return document
