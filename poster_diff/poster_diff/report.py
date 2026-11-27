"""Build the offline HTML report directory from two PNG files."""

from __future__ import annotations

import csv
import hashlib
import json
import os
from datetime import datetime, timezone

from .engine import CompareResult, compare
from .geometry import CanvasGeometry, DiffConfig, PlacedImage
from .pngio import Image, read_png, write_png
from .tiles import (
    TILE_SIZE,
    TileGrid,
    render_coverage_tile,
    render_metric_tile,
    render_source_tile,
)


def _file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def downscale(image: Image, max_dim: int) -> Image:
    """Nearest-neighbor downscale so the largest side is <= max_dim."""
    longest = max(image.width, image.height)
    if longest <= max_dim:
        return image.copy()
    step = longest / max_dim
    out_w = max(1, round(image.width / step))
    out_h = max(1, round(image.height / step))
    c = image.channels
    out = Image(out_w, out_h, c, bytearray(out_w * out_h * c))
    src = image.data
    for oy in range(out_h):
        sy = min(image.height - 1, int(oy * step))
        for ox in range(out_w):
            sx = min(image.width - 1, int(ox * step))
            si = (sy * image.width + sx) * c
            di = (oy * out_w + ox) * c
            out.data[di : di + c] = src[si : si + c]
    return out


def _write_thumbnail(path: str, rgba: Image, background, max_dim: int) -> str:
    small = downscale(rgba, max_dim)
    flat = small.composite_on(background)
    write_png(path, flat)
    return path


def build_report(
    reference_path: str,
    candidate_path: str,
    out_dir: str,
    config: DiffConfig,
    title: str | None = None,
) -> CompareResult:
    """Compute the comparison and write every report artifact under out_dir."""
    os.makedirs(out_dir, exist_ok=True)
    img_a = read_png(reference_path).to_rgba()
    img_b = read_png(candidate_path).to_rgba()

    place_a = PlacedImage(img_a.width, img_a.height, 0, 0)
    place_b = PlacedImage(
        img_b.width, img_b.height, config.offset_x, config.offset_y
    )
    geometry = CanvasGeometry(place_a, place_b)
    canvas = geometry.bounds

    grid = TileGrid(canvas, TILE_SIZE)

    def sink(tile, appearance, alpha, coverage_codes):
        tx = (tile.x - canvas.x) // TILE_SIZE
        ty = (tile.y - canvas.y) // TILE_SIZE
        grid.put_level0(
            "appearance",
            tx,
            ty,
            render_metric_tile(
                tile,
                appearance,
                alpha,
                coverage_codes,
                (config.appearance_threshold, config.alpha_threshold),
                "appearance",
            ),
        )
        grid.put_level0(
            "alpha",
            tx,
            ty,
            render_metric_tile(
                tile,
                appearance,
                alpha,
                coverage_codes,
                (config.appearance_threshold, config.alpha_threshold),
                "alpha",
            ),
        )
        grid.put_level0("coverage", tx, ty, render_coverage_tile(tile, coverage_codes))
        grid.put_level0(
            "ref", tx, ty, render_source_tile(tile, img_a, place_a)
        )
        grid.put_level0(
            "cand", tx, ty, render_source_tile(tile, img_b, place_b)
        )

    result = compare(img_a, img_b, geometry, config, tile_sink=sink)
    grid.build_pyramid()
    tile_manifest = grid.write_shards(out_dir)

    # Small overview thumbnails (composited) — never the full-resolution data.
    assets_dir = os.path.join(out_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)
    _write_thumbnail(
        os.path.join(assets_dir, "ref_overview.png"), img_a, config.background, 512
    )
    _write_thumbnail(
        os.path.join(assets_dir, "cand_overview.png"), img_b, config.background, 512
    )

    stats = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "title": title or os.path.basename(out_dir.rstrip(os.sep)),
        "inputs": {
            "reference": {
                "path": os.path.abspath(reference_path),
                "width": img_a.width,
                "height": img_a.height,
                "sha256": _file_sha256(reference_path),
            },
            "candidate": {
                "path": os.path.abspath(candidate_path),
                "width": img_b.width,
                "height": img_b.height,
                "sha256": _file_sha256(candidate_path),
            },
        },
        "config": config.as_dict(),
        "geometry": {
            "canvas": canvas.as_dict(),
            "reference_placement": place_a.rect.as_dict(),
            "candidate_placement": place_b.rect.as_dict(),
            "common_rect": result.common_rect.as_dict(),
        },
        "counts": result.counts,
        "diff_blocks": [b.as_dict() for b in result.blocks],
        "coverage_blocks": [b.as_dict() for b in result.coverage_blocks],
        "tiles": tile_manifest,
        "reproduce": _reproduction_command(reference_path, candidate_path, out_dir, config),
    }

    stats_path = os.path.join(out_dir, "stats.json")
    with open(stats_path, "w", encoding="utf-8") as fh:
        json.dump(stats, fh, ensure_ascii=False, indent=2)

    _write_csv(os.path.join(out_dir, "diff_blocks.csv"), result)

    # The viewer reads this single JS file (works from file:// without fetch).
    with open(os.path.join(out_dir, "report_data.js"), "w", encoding="utf-8") as fh:
        fh.write("window.__PD_REPORT__ = ")
        json.dump(stats, fh, ensure_ascii=False)
        fh.write(";\n")

    _write_html_shell(out_dir)
    return result


def _reproduction_command(reference_path, candidate_path, out_dir, config: DiffConfig) -> str:
    parts = [
        "python3 -m poster_diff",
        f"--reference {reference_path!r}".replace("'", '"'),
        f"--candidate {candidate_path!r}".replace("'", '"'),
        f"--output {out_dir!r}".replace("'", '"'),
        f"--offset-x {config.offset_x}",
        f"--offset-y {config.offset_y}",
        f"--appearance-threshold {config.appearance_threshold}",
        f"--alpha-threshold {config.alpha_threshold}",
        f"--merge-gap {config.merge_gap}",
        f"--connectivity {config.connectivity}",
        f"--min-block-area {config.min_block_area}",
        f"--background '#{config.background[0]:02x}{config.background[1]:02x}{config.background[2]:02x}'",
        f"--tile-size {config.tile_size}",
    ]
    return " ".join(parts)


def _write_csv(path: str, result: CompareResult) -> None:
    with open(path, "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            [
                "block_id",
                "kind",
                "x",
                "y",
                "width",
                "height",
                "area",
                "peak_appearance",
                "peak_alpha",
            ]
        )
        for block in result.blocks:
            r = block.rect
            writer.writerow(
                [
                    block.block_id,
                    block.kind,
                    r.x,
                    r.y,
                    r.width,
                    r.height,
                    block.area,
                    block.peak_appearance,
                    block.peak_alpha,
                ]
            )
        for block in result.coverage_blocks:
            r = block.rect
            writer.writerow(
                [
                    block.block_id,
                    block.kind,
                    r.x,
                    r.y,
                    r.width,
                    r.height,
                    block.area,
                    "",
                    "",
                ]
            )


def _write_html_shell(out_dir: str) -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(here, "viewer", "index.html"), "r", encoding="utf-8") as fh:
        html = fh.read()
    with open(os.path.join(out_dir, "index.html"), "w", encoding="utf-8") as fh:
        fh.write(html)
    js_dir = os.path.join(out_dir, "viewer")
    os.makedirs(js_dir, exist_ok=True)
    for name in ("app.js", "styles.css"):
        with open(os.path.join(here, "viewer", name), "r", encoding="utf-8") as src:
            with open(os.path.join(js_dir, name), "w", encoding="utf-8") as dst:
                dst.write(src.read())
