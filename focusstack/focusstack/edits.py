"""Persistent manual overrides ("draw a region, use one photo").

An edit file is plain JSON so it can live next to the photos and be reviewed
in any editor::

    {
      "version": 1,
      "edits": [
        {
          "id": "e1",
          "image": 2,
          "note": "moved screw, left plate",
          "enabled": true,
          "shapes": [
            {"kind": "rect", "x": 40, "y": 60, "width": 30, "height": 24},
            {"kind": "polygon", "points": [[70, 60], [95, 70], [88, 90]]},
            {"kind": "ellipse", "cx": 30, "cy": 40, "rx": 8, "ry": 5},
            {"kind": "brush", "points": [[10, 10], [12, 14], [20, 20]], "radius": 3}
          ]
        }
      ]
    }

Shapes use canvas coordinates (the reference photo's pixel grid); they are
stored, not re-rasterised per run, so reruns and block exports alike honour
the same geometry.  Every shape may also carry ``"strength"`` (0..1) for a
partially transparent override; the default is 1.0 (fully replace).
"""

from __future__ import annotations

import json
import math
from pathlib import Path


VALID_KINDS = ("rect", "ellipse", "polygon", "brush")


class EditError(ValueError):
    """Raised for malformed edit files or impossible overrides."""


def _finite(value, name):
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise EditError("%s must be numeric" % name) from exc
    if not math.isfinite(number):
        raise EditError("%s must be finite" % name)
    return number


def validate_edit(edit: dict, photo_count: int) -> dict:
    if not isinstance(edit, dict):
        raise EditError("each edit must be an object")
    image = edit.get("image")
    if not isinstance(image, int) or isinstance(image, bool):
        raise EditError("edit.image must be an integer photo index")
    if not 0 <= image < photo_count:
        raise EditError("edit.image %d is outside the photo range 0..%d" % (image, photo_count - 1))
    shapes = edit.get("shapes")
    if not isinstance(shapes, list) or not shapes:
        raise EditError("edit must contain a non-empty shapes list")
    cleaned = []
    for index, shape in enumerate(shapes):
        if not isinstance(shape, dict):
            raise EditError("shape %d must be an object" % index)
        kind = shape.get("kind")
        if kind not in VALID_KINDS:
            raise EditError("shape %d has unknown kind %r" % (index, kind))
        strength = _finite(shape.get("strength", 1.0), "shape.strength")
        if not 0.0 <= strength <= 1.0:
            raise EditError("shape.strength must be between 0 and 1")
        if kind == "rect":
            x = _finite(shape.get("x"), "rect.x")
            y = _finite(shape.get("y"), "rect.y")
            width = _finite(shape.get("width"), "rect.width")
            height = _finite(shape.get("height"), "rect.height")
            if width <= 0 or height <= 0:
                raise EditError("rect width and height must be positive")
            cleaned.append({"kind": "rect", "x": x, "y": y, "width": width, "height": height,
                            "strength": strength})
        elif kind == "ellipse":
            cx = _finite(shape.get("cx"), "ellipse.cx")
            cy = _finite(shape.get("cy"), "ellipse.cy")
            rx = _finite(shape.get("rx"), "ellipse.rx")
            ry = _finite(shape.get("ry"), "ellipse.ry")
            if rx <= 0 or ry <= 0:
                raise EditError("ellipse radii must be positive")
            cleaned.append({"kind": "ellipse", "cx": cx, "cy": cy, "rx": rx, "ry": ry,
                            "strength": strength})
        elif kind == "polygon":
            points = shape.get("points")
            if not isinstance(points, list) or len(points) < 3:
                raise EditError("polygon needs at least three points")
            cleaned_points = []
            for point in points:
                if not isinstance(point, (list, tuple)) or len(point) != 2:
                    raise EditError("polygon points must be [x, y] pairs")
                cleaned_points.append((_finite(point[0], "polygon x"), _finite(point[1], "polygon y")))
            cleaned.append({"kind": "polygon", "points": cleaned_points, "strength": strength})
        else:  # brush
            points = shape.get("points")
            if not isinstance(points, list) or not points:
                raise EditError("brush needs at least one point")
            cleaned_points = []
            for point in points:
                if not isinstance(point, (list, tuple)) or len(point) != 2:
                    raise EditError("brush points must be [x, y] pairs")
                cleaned_points.append((_finite(point[0], "brush x"), _finite(point[1], "brush y")))
            radius = _finite(shape.get("radius", 2), "brush.radius")
            if radius <= 0:
                raise EditError("brush radius must be positive")
            cleaned.append({"kind": "brush", "points": cleaned_points, "radius": radius,
                            "strength": strength})
    result = {
        "id": str(edit.get("id", "edit-%d" % image)),
        "image": image,
        "note": str(edit.get("note", "")),
        "enabled": bool(edit.get("enabled", True)),
        "shapes": cleaned,
    }
    return result


def validate_document(document: dict, photo_count: int) -> dict:
    if not isinstance(document, dict):
        raise EditError("edit document must be a JSON object")
    if document.get("version", 1) != 1:
        raise EditError("unsupported edit file version %r" % document.get("version"))
    edits = document.get("edits", [])
    if not isinstance(edits, list):
        raise EditError("edit document 'edits' must be a list")
    return {"version": 1, "edits": [validate_edit(edit, photo_count) for edit in edits]}


def empty_document() -> dict:
    return {"version": 1, "edits": []}


def load_edits(path, photo_count: int) -> dict:
    if path is None:
        return empty_document()
    path = Path(path)
    if not path.exists():
        return empty_document()
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise EditError("cannot read edit file %s: %s" % (path, exc)) from exc
    return validate_document(document, photo_count)


def save_edits(path, document: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _point_in_polygon(x: float, y: float, points) -> bool:
    inside = False
    n = len(points)
    j = n - 1
    for i in range(n):
        xi, yi = points[i]
        xj, yj = points[j]
        if (yi > y) != (yj > y):
            x_cross = (xj - xi) * (y - yi) / (yj - yi) + xi
            if x < x_cross:
                inside = not inside
        j = i
    return inside


def _distance_to_segment(px, py, ax, ay, bx, by) -> float:
    dx = bx - ax
    dy = by - ay
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-12:
        return math.hypot(px - ax, py - ay)
    t = ((px - ax) * dx + (py - ay) * dy) / length_sq
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def rasterise_shape(shape: dict, rect: tuple, width: int, height: int):
    """Rasterise one shape inside ``rect`` = (x0, y0, w, h).

    Returns (mask, bbox) where mask is a bytearray of rect.w * rect.h and
    bbox is (x0, y0, x1, y1) in canvas coordinates, or None when nothing was
    painted.
    """
    x0, y0, w, h = rect
    mask = bytearray(w * h)
    strength = int(round(shape.get("strength", 1.0) * 255))
    kind = shape["kind"]

    def paint(px, py, coverage=1.0):
        cx = px - x0
        cy = py - y0
        if 0 <= cx < w and 0 <= cy < h:
            value = int(round(strength * coverage))
            if value <= 0:
                return
            index = cy * w + cx
            if mask[index] < value:
                mask[index] = value

    touched = []
    if kind == "rect":
        left = int(math.floor(shape["x"]))
        top = int(math.floor(shape["y"]))
        right = int(math.ceil(shape["x"] + shape["width"])) - 1
        bottom = int(math.ceil(shape["y"] + shape["height"])) - 1
        for py in range(max(top, y0), min(bottom, y0 + h - 1) + 1):
            for px in range(max(left, x0), min(right, x0 + w - 1) + 1):
                paint(px, py)
        touched.append((left, top, right + 1, bottom + 1))
    elif kind == "ellipse":
        cx = shape["cx"]
        cy = shape["cy"]
        rx = shape["rx"]
        ry = shape["ry"]
        left = int(math.floor(cx - rx))
        right = int(math.ceil(cx + rx))
        top = int(math.floor(cy - ry))
        bottom = int(math.ceil(cy + ry))
        for py in range(max(top, y0), min(bottom, y0 + h - 1) + 1):
            dy = (py + 0.5 - cy) / ry
            if dy * dy > 1.0:
                continue
            span = rx * math.sqrt(max(0.0, 1.0 - dy * dy))
            start = max(int(math.floor(cx - span - 1)), x0)
            end = min(int(math.ceil(cx + span + 1)), x0 + w - 1)
            for px in range(start, end + 1):
                dx = (px + 0.5 - cx) / rx
                d = (dx * dx + dy * dy) ** 0.5
                if d > 1.0 + 0.5 / max(rx, ry):
                    continue
                # Soften only the outermost pixel of the outline.
                edge = (1.0 - d) * max(rx, ry)
                if edge < 0.0:
                    continue
                coverage = 1.0 if edge >= 0.75 else max(0.0, (edge + 0.25) / 1.0)
                paint(px, py, coverage)
        touched.append((left, top, right, bottom))
    elif kind == "polygon":
        points = shape["points"]
        left = int(math.floor(min(p[0] for p in points)))
        right = int(math.ceil(max(p[0] for p in points)))
        top = int(math.floor(min(p[1] for p in points)))
        bottom = int(math.ceil(max(p[1] for p in points)))
        for py in range(max(top, y0), min(bottom, y0 + h - 1) + 1):
            for px in range(max(left, x0), min(right, x0 + w - 1) + 1):
                if _point_in_polygon(px + 0.5, py + 0.5, points):
                    paint(px, py)
        touched.append((left, top, right, bottom))
    else:  # brush
        radius = shape["radius"]
        points = shape["points"]
        left = int(math.floor(min(p[0] for p in points) - radius))
        right = int(math.ceil(max(p[0] for p in points) + radius))
        top = int(math.floor(min(p[1] for p in points) - radius))
        bottom = int(math.ceil(max(p[1] for p in points) + radius))
        segments = list(zip(points, points[1:])) or [(points[0], points[0])]
        for py in range(max(top, y0), min(bottom, y0 + h - 1) + 1):
            for px in range(max(left, x0), min(right, x0 + w - 1) + 1):
                nearest = min(
                    _distance_to_segment(px + 0.5, py + 0.5, a[0], a[1], b[0], b[1])
                    for a, b in segments
                )
                if nearest <= radius:
                    coverage = 1.0 if nearest <= radius - 1.0 else (radius - nearest + 1.0) / 2.0
                    paint(px, py, coverage=coverage)
        touched.append((left, top, right, bottom))

    if not touched:
        return mask, None
    return mask, touched


def apply_edits(
    document: dict,
    labels,
    flags,
    width: int,
    height: int,
    *,
    photo_valid=None,
    report_window: tuple | None = None,
) -> list:
    """Apply enabled edits to ``labels``/``flags`` in place, full canvas.

    Overrides are rasterised on the full canvas every run, from the stored
    shape geometry, so a rerun -- or a block export -- produces exactly the
    same override pixels at the same coordinates.

    ``report_window`` = (x0, y0, w, h) only affects reporting: each record
    gains ``in_window``, the number of override pixels that fall inside the
    exported block.  Returns one record per edit.
    """
    from .select import FLAG_MANUAL, FLAG_MANUAL_PARTIAL

    report_window = (0, 0, width, height) if report_window is None else report_window
    rx0, ry0, rw, rh = report_window

    records = []
    for edit in document.get("edits", []):
        target = edit["image"]
        if not edit.get("enabled", True):
            records.append({
                "id": edit["id"], "image": target, "note": edit.get("note", ""),
                "enabled": False, "painted": 0, "in_window": 0,
                "bbox": None, "shapes": len(edit["shapes"]),
            })
            continue
        combined = bytearray(width * height)
        bboxes = []
        for shape in edit["shapes"]:
            mask, touched = rasterise_shape(shape, (0, 0, width, height), width, height)
            if touched is None:
                continue
            bboxes.extend(touched)
            for i in range(width * height):
                if mask[i] > combined[i]:
                    combined[i] = mask[i]

        painted = 0
        in_window = 0
        skipped_uncovered = 0
        for p in range(width * height):
            strength = combined[p]
            if not strength:
                continue
            if photo_valid is not None and not photo_valid[target][p]:
                skipped_uncovered += 1
                continue
            labels[p] = target
            if strength >= 128:
                flags[p] = FLAG_MANUAL
            else:
                flags[p] |= FLAG_MANUAL_PARTIAL
            painted += 1
            x = p % width
            y = p // width
            if rx0 <= x < rx0 + rw and ry0 <= y < ry0 + rh:
                in_window += 1

        records.append({
            "id": edit["id"],
            "image": target,
            "note": edit.get("note", ""),
            "enabled": True,
            "painted": painted,
            "in_window": in_window,
            "skipped_uncovered": skipped_uncovered,
            "bbox": _combined_bbox(bboxes),
            "shapes": len(edit["shapes"]),
        })
    return records


def _combined_bbox(boxes):
    if not boxes:
        return None
    left = min(b[0] for b in boxes)
    top = min(b[1] for b in boxes)
    right = max(b[2] for b in boxes)
    bottom = max(b[3] for b in boxes)
    if right <= left or bottom <= top:
        return None
    return (left, top, right - left, bottom - top)
