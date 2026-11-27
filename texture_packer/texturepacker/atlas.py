"""Atlas build and restore pipeline.

Pipeline per source image:
  original RGBA -> trim transparent margin -> note source size / trim offset
  -> wrap in edge-extruded padding -> optionally rotate 90 CW -> place on page.

Everything needed to rebuild the exact original image (including the trimmed
transparent border and the anchor point) is recorded in the JSON metadata.
Fully transparent images are recorded explicitly but consume no atlas space.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

from .image import Image, rotate_point_90_cw
from .packer import PackItem, Placement, pack

METADATA_VERSION = 1
STATUS_PLACED = "placed"
STATUS_FULLY_TRANSPARENT = "fully_transparent"
STATUS_REJECTED = "rejected"


@dataclass
class SourceRecord:
    item_id: str
    source_path: str
    image: Image
    anchor: tuple[float, float] | None
    trim_bbox: tuple[int, int, int, int] | None  # (x0, y0, x1, y1) in source coords


def _load_anchors(path: str | None) -> dict[str, dict[str, float]]:
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or "images" not in data or not isinstance(data["images"], list):
        raise ValueError(
            "anchor file must be a JSON object with an 'images' array, "
            'e.g. {"images": [{"name": "a.png", "anchor": [10, 20]}]}'
        )
    anchors: dict[str, dict[str, float]] = {}
    for entry in data["images"]:
        if not isinstance(entry, dict) or "name" not in entry:
            raise ValueError("each anchor entry needs a 'name' field")
        anchors[entry["name"]] = entry
    return anchors


def _normalized_key(path_or_name: str) -> str:
    """Match anchor entries against file names regardless of path style."""
    return path_or_name.replace("\\", "/").strip("/").lower()


def _resolve_anchor(
    item_id: str,
    source_rel: str,
    anchors: dict[str, dict[str, float]],
    width: int,
    height: int,
) -> tuple[float, float] | None:
    entry = None
    for key in (source_rel, item_id):
        entry = anchors.get(key) or anchors.get(_normalized_key(key))
        if entry:
            break
    if entry is None:
        return None
    anchor = entry.get("anchor")
    if (
        not isinstance(anchor, list)
        or len(anchor) != 2
        or not all(isinstance(v, (int, float)) for v in anchor)
    ):
        raise ValueError(f"anchor for {item_id} must be [x, y] numbers")
    ax, ay = float(anchor[0]), float(anchor[1])
    if not (0 <= ax <= width and 0 <= ay <= height):
        raise ValueError(
            f"anchor ({ax}, {ay}) for {item_id} is outside its "
            f"{width}x{height} image"
        )
    return ax, ay


def discover_sources(input_dir: str) -> list[str]:
    """Return PNG paths under input_dir, sorted for deterministic processing."""
    paths: list[str] = []
    for root, _dirs, files in os.walk(input_dir):
        for name in files:
            if name.lower().endswith(".png"):
                paths.append(os.path.join(root, name))
    paths.sort()
    return paths


def load_sources(input_dir: str, anchors_path: str | None = None) -> list[SourceRecord]:
    anchors = _load_anchors(anchors_path)
    records: list[SourceRecord] = []
    for path in discover_sources(input_dir):
        item_id = os.path.relpath(path, input_dir).replace(os.sep, "/")
        image = Image.from_png(path)
        anchor = _resolve_anchor(
            item_id, item_id, anchors, image.width, image.height
        )
        bbox = image.alpha_bbox()
        records.append(
            SourceRecord(
                item_id=item_id,
                source_path=path,
                image=image,
                anchor=anchor,
                trim_bbox=bbox,
            )
        )
    return records


def build_atlas(
    records: list[SourceRecord],
    output_dir: str,
    page_width: int,
    page_height: int,
    max_pages: int,
    padding: int,
    allow_rotation: bool,
) -> dict[str, Any]:
    """Trim, pad, pack and render sources into atlas pages + metadata dict."""
    if padding < 0:
        raise ValueError("padding must be non-negative")
    os.makedirs(output_dir, exist_ok=True)

    # Stage every sprite: trimmed content + extruded padding.
    staged: dict[str, Image] = {}
    items: list[PackItem] = []
    sprite_meta: dict[str, dict[str, Any]] = {}

    for rec in records:
        meta: dict[str, Any] = {
            "name": rec.item_id,
            "source_size": {"w": rec.image.width, "h": rec.image.height},
            "anchor": (
                {"x": rec.anchor[0], "y": rec.anchor[1]}
                if rec.anchor is not None
                else None
            ),
        }
        if rec.trim_bbox is None:
            meta.update(
                {
                    "status": STATUS_FULLY_TRANSPARENT,
                    "trim_offset": None,
                    "trimmed_size": {"w": 0, "h": 0},
                    "padding": padding,
                    "frame": None,
                    "atlas_anchor": None,
                }
            )
            sprite_meta[rec.item_id] = meta
            continue

        x0, y0, x1, y1 = rec.trim_bbox
        trimmed = rec.image.crop(x0, y0, x1, y1)
        padded = trimmed.add_extruded_padding(padding)
        staged[rec.item_id] = padded
        items.append(
            PackItem(
                item_id=rec.item_id,
                width=padded.width,
                height=padded.height,
                rotatable=allow_rotation,
            )
        )

        # Anchor relative to the padded (pre-rotation) image top-left.
        padded_anchor = None
        if rec.anchor is not None:
            padded_anchor = (
                rec.anchor[0] - x0 + padding,
                rec.anchor[1] - y0 + padding,
            )

        meta.update(
            {
                "status": STATUS_PLACED,
                "trim_offset": {"x": x0, "y": y0},
                "trimmed_size": {"w": trimmed.width, "h": trimmed.height},
                "padding": padding,
                # `frame` is filled in once placement is known.
                "frame": None,
                "atlas_anchor": None,
                "_padded_anchor": padded_anchor,
            }
        )
        sprite_meta[rec.item_id] = meta

    result = pack(items, page_width, page_height, max_pages)
    rejected_ids = {r.item_id for r in result.rejected}

    pages: dict[int, Image] = {
        i: Image(page_width, page_height) for i in range(max_pages)
    }

    placement_by_id = {p.item_id: p for p in result.placements}
    for item_id, padded in staged.items():
        if item_id not in placement_by_id:
            continue  # rejected by the packer; metadata handled below
        placement = placement_by_id[item_id]
        sprite = padded.rotate_90_cw() if placement.rotated else padded
        pages[placement.page].blit(sprite, placement.x, placement.y)

        meta = sprite_meta[item_id]
        meta["frame"] = {
            "page": placement.page,
            "x": placement.x,
            "y": placement.y,
            "w": placement.width,
            "h": placement.height,
            "rotated90": placement.rotated,
        }
        # Where the anchor lands inside the atlas page (handy for the engine).
        if meta["_padded_anchor"] is not None:
            ax, ay = meta["_padded_anchor"]
            if placement.rotated:
                ax, ay = rotate_point_90_cw(ax, ay, padded.width, padded.height)
            meta["atlas_anchor"] = {
                "x": placement.x + ax,
                "y": placement.y + ay,
            }
        meta.pop("_padded_anchor", None)

    page_files: list[str] = []
    for page_index in range(result.pages_used):
        name = f"atlas_{page_index}.png"
        pages[page_index].save_png(os.path.join(output_dir, name))
        page_files.append(name)

    for rej in result.rejected:
        # Rejected entries keep the trim information gathered above so the
        # problem can be diagnosed without re-reading the source PNG.
        meta = sprite_meta.get(rej.item_id, {"name": rej.item_id})
        meta["status"] = STATUS_REJECTED
        meta["rejection_reason"] = rej.reason
        meta.pop("_padded_anchor", None)
        sprite_meta[rej.item_id] = meta

    # Sort by name: identical material -> identical metadata regardless of
    # filesystem iteration order.
    sprites = [sprite_meta[key] for key in sorted(sprite_meta)]

    metadata: dict[str, Any] = {
        "version": METADATA_VERSION,
        "settings": {
            "page_width": page_width,
            "page_height": page_height,
            "max_pages": max_pages,
            "pages_used": result.pages_used,
            "padding": padding,
            "padding_policy": "edge_extrude",
            "allow_rotation": allow_rotation,
        },
        "padding_policy": {
            "edge_extrude": (
                "each sprite frame contains the trimmed real content in its "
                "inner rect and `padding` px of clamp-to-edge edge replication "
                "on every side; the padding is bleed fill, not source content"
            )
        },
        "pages": page_files,
        "sprites": sprites,
        "rejected": [
            {
                "name": r.item_id,
                "width": r.width,
                "height": r.height,
                "reason": r.reason,
            }
            for r in result.rejected
        ],
    }
    with open(os.path.join(output_dir, "atlas.json"), "w", encoding="utf-8") as fh:
        json.dump(metadata, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return metadata


def restore_sprite(
    page_images: dict[int, Image], sprite_meta: dict[str, Any]
) -> Image | None:
    """Rebuild one source image (original size, transparency and anchor).

    Returns None for fully transparent images: their size lives in metadata
    and callers can materialize an empty canvas themselves.
    """
    status = sprite_meta["status"]
    src_w = sprite_meta["source_size"]["w"]
    src_h = sprite_meta["source_size"]["h"]

    if status == STATUS_FULLY_TRANSPARENT:
        return None
    if status != STATUS_PLACED:
        raise ValueError(
            f"sprite {sprite_meta['name']} was not placed (status={status}); "
            "it cannot be restored from the atlas"
        )

    frame = sprite_meta["frame"]
    page = page_images[frame["page"]]
    placed = page.crop(frame["x"], frame["y"], frame["x"] + frame["w"], frame["y"] + frame["h"])
    if frame["rotated90"]:
        placed = placed.rotate_90_ccw()

    padding = sprite_meta["padding"]
    tw = sprite_meta["trimmed_size"]["w"]
    th = sprite_meta["trimmed_size"]["h"]
    # Strip the extruded padding to recover the trimmed content exactly.
    trimmed = placed.crop(padding, padding, padding + tw, padding + th)

    out = Image(src_w, src_h)
    offset = sprite_meta["trim_offset"]
    out.blit(trimmed, offset["x"], offset["y"])
    return out


def restore_all(atlas_dir: str, output_dir: str) -> list[str]:
    """Restore every placed sprite from atlas.json + page PNGs."""
    with open(os.path.join(atlas_dir, "atlas.json"), "r", encoding="utf-8") as fh:
        metadata = json.load(fh)
    page_images = {
        i: Image.from_png(os.path.join(atlas_dir, name))
        for i, name in enumerate(metadata["pages"])
    }
    os.makedirs(output_dir, exist_ok=True)
    written: list[str] = []
    skipped: list[str] = []
    for sprite in metadata["sprites"]:
        if sprite["status"] == STATUS_REJECTED:
            # Nothing was baked for these; the rejection reason is in metadata.
            skipped.append(sprite["name"])
            continue
        restored = restore_sprite(page_images, sprite)
        target = os.path.join(output_dir, sprite["name"])
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        if restored is None:
            # Fully transparent: emit an empty canvas of the original size.
            restored = Image(
                sprite["source_size"]["w"], sprite["source_size"]["h"]
            )
        restored.save_png(target)
        written.append(target)
    return {"written": written, "skipped_rejected": skipped}
