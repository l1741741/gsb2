"""Tiled image pyramids for the offline report.

Each zoom level is a grid of 256x256 PNG tiles stored as base64 inside plain
JavaScript shard files (``window.__PD__``), so the report works from
``file://`` without fetch() and never embeds the full-resolution images.

Layers:
- ``appearance`` / ``alpha``: RGB tiles, red = metric value 0..255,
  green = threshold-exceeded flag (255), blue = coverage code (0 common,
  1 reference-only, 2 candidate-only).
- ``coverage``: RGBA tiles compositing the two placements over a checkerboard
  so transparent borders and offset-only regions are visible.
- ``ref`` / ``cand``: RGBA tiles of each source image composited the same way.
"""

from __future__ import annotations

import base64
import json
import os

from .pngio import Image, write_png
from .geometry import Rect

TILE_SIZE = 256
# Keep every shard small enough that parsing one shard stays cheap.
SHARD_TARGET_BYTES = 1_500_000


class TileGrid:
    """In-memory level-0 tiles plus pyramid construction and shard export."""

    def __init__(self, bounds: Rect, tile_size: int = TILE_SIZE):
        self.bounds = bounds
        self.tile_size = tile_size
        self.cols = (bounds.width + tile_size - 1) // tile_size
        self.rows = (bounds.height + tile_size - 1) // tile_size
        # layer -> level -> list[Image|None] in row-major tile order
        self._tiles: dict[str, dict[int, list]] = {}

    # ------------------------------------------------------------- level zero
    def put_level0(self, layer: str, tx: int, ty: int, image: Image) -> None:
        levels = self._tiles.setdefault(layer, {0: [None] * (self.cols * self.rows)})
        levels[0][ty * self.cols + tx] = image

    def get(self, layer: str, level: int, tx: int, ty: int):
        return self._tiles[layer][level][ty * self._level_cols(level) + tx]

    def layers(self) -> list[str]:
        return sorted(self._tiles)

    def _level_cols(self, level: int) -> int:
        return (self.cols + (1 << level) - 1) >> level

    def _level_rows(self, level: int) -> int:
        return (self.rows + (1 << level) - 1) >> level

    def level_count(self) -> int:
        level = 0
        while self._level_cols(level) > 1 or self._level_rows(level) > 1:
            level += 1
        return level + 1

    # --------------------------------------------------------------- pyramid
    def build_pyramid(self) -> None:
        """Downsample 2x per level (box average), keeping 256px tiles."""
        for layer, levels in list(self._tiles.items()):
            level = 0
            while True:
                cols = self._level_cols(level)
                rows = self._level_rows(level)
                if cols == 1 and rows == 1:
                    break
                src = levels[level]
                next_level = level + 1
                ncols, nrows = self._level_cols(next_level), self._level_rows(next_level)
                dst = [None] * (ncols * nrows)
                for nty in range(nrows):
                    for ntx in range(ncols):
                        quad = [
                            src[sy * cols + sx]
                            for sy in (nty * 2, nty * 2 + 1)
                            for sx in (ntx * 2, ntx * 2 + 1)
                            if sy < rows and sx < cols
                        ]
                        quad = [q for q in quad if q is not None]
                        if not quad:
                            continue
                        dst[nty * ncols + ntx] = _downsample_quad(quad)
                levels[next_level] = dst
                level = next_level

    # ---------------------------------------------------------------- export
    def write_shards(self, out_dir: str) -> dict:
        """Write per-layer/level JS shards; return a manifest for the viewer."""
        tiles_dir = os.path.join(out_dir, "tiles")
        os.makedirs(tiles_dir, exist_ok=True)
        manifest = {
            "bounds": self.bounds.as_dict(),
            "tile_size": self.tile_size,
            "levels": {},
        }
        for layer, levels in self._tiles.items():
            manifest["levels"][layer] = {}
            for level, tiles in levels.items():
                cols, rows = self._level_cols(level), self._level_rows(level)
                entries = []
                shard_index = 0
                shard_bytes = 0
                shard: list[tuple[int, str]] = []

                def flush() -> None:
                    nonlocal shard_index, shard_bytes, shard
                    if not shard:
                        return
                    name = f"{layer}_{level}_{shard_index}.js"
                    path = os.path.join(tiles_dir, name)
                    with open(path, "w", encoding="utf-8") as fh:
                        fh.write("window.__PD__.addShard(")
                        fh.write(json.dumps([layer, level, shard]))
                        fh.write(");\n")
                    entries.append(
                        {
                            "file": f"tiles/{name}",
                            "tiles": [idx for idx, _ in shard],
                            "bytes": shard_bytes,
                        }
                    )
                    shard_index += 1
                    shard = []
                    shard_bytes = 0

                for idx, tile in enumerate(tiles):
                    if tile is None:
                        continue
                    tmp_path = os.path.join(tiles_dir, f".tmp-{layer}-{level}-{idx}.png")
                    write_png(tmp_path, tile)
                    with open(tmp_path, "rb") as fh:
                        b64 = base64.b64encode(fh.read()).decode("ascii")
                    os.remove(tmp_path)
                    payload = b64.encode("ascii")
                    if shard and shard_bytes + len(payload) > SHARD_TARGET_BYTES:
                        flush()
                    shard.append((idx, b64))
                    shard_bytes += len(payload)
                flush()
                manifest["levels"][layer][str(level)] = {
                    "cols": cols,
                    "rows": rows,
                    "shards": entries,
                }
        return manifest


def _downsample_quad(tiles: list[Image]) -> Image:
    """Box-average up to four adjacent level-N tiles into one level-(N+1) tile.

    ``tiles`` follows quadrant order top-left, top-right, bottom-left,
    bottom-right; missing quadrants (right/bottom canvas edge) are omitted.
    """
    channels = tiles[0].channels
    half = TILE_SIZE // 2
    positions = [(0, 0), (1, 0), (0, 1), (1, 1)]
    quadrants = list(zip(tiles, positions[: len(tiles)]))
    out = Image(half, half, channels, bytearray(half * half * channels))
    for y in range(half):
        for x in range(half):
            di = (y * half + x) * channels
            acc = [0] * channels
            count = 0
            for tile, (qx, qy) in quadrants:
                bx = x * 2 - qx * TILE_SIZE
                by = y * 2 - qy * TILE_SIZE
                if not (0 <= bx < tile.width and 0 <= by < tile.height):
                    continue
                si = (by * tile.width + bx) * channels
                for c in range(channels):
                    acc[c] += tile.data[si + c]
                count += 1
            if count:
                for c in range(channels):
                    out.data[di + c] = acc[c] // count
    return out


# ------------------------------------------------------------- tile rendering
def checker_rgba(x: int, y: int, size: int = 16) -> tuple[int, int, int, int]:
    if ((x // size) + (y // size)) % 2:
        return (204, 204, 204, 255)
    return (245, 245, 245, 255)


def render_metric_tile(
    tile: Rect,
    appearance: list[int],
    alpha: list[int],
    coverage_codes: list[int],
    thresholds: tuple[int, int],
    mode: str,
) -> Image:
    """Encode one diff tile as RGB (see module docstring)."""
    at, alpha_t = thresholds
    img = Image(tile.width, tile.height, 3, bytearray(tile.width * tile.height * 3))
    values = appearance if mode == "appearance" else alpha
    threshold = at if mode == "appearance" else alpha_t
    for i, value in enumerate(values):
        code = coverage_codes[i]
        p = i * 3
        img.data[p] = value
        img.data[p + 1] = 255 if (code == 0 and value >= threshold) else 0
        img.data[p + 2] = code
    return img


def render_coverage_tile(
    tile: Rect,
    coverage_codes: list[int],
) -> Image:
    """RGBA tile: green where only A covers, red where only B covers."""
    img = Image(tile.width, tile.height, 4, bytearray(tile.width * tile.height * 4))
    for i, code in enumerate(coverage_codes):
        p = i * 4
        if code == 1:  # reference-only: green tint
            img.data[p : p + 4] = bytes((46, 160, 67, 160))
        elif code == 2:  # candidate-only: red tint
            img.data[p : p + 4] = bytes((215, 58, 46, 160))
        else:
            img.data[p : p + 4] = bytes((0, 0, 0, 0))
    return img


def render_source_tile(
    tile: Rect,
    rgba_image,
    placement,
) -> Image:
    """RGBA tile of one source over checkerboard, transparent where absent."""
    img = Image(tile.width, tile.height, 4, bytearray(tile.width * tile.height * 4))
    w = rgba_image.width
    data = rgba_image.data
    for ty in range(tile.height):
        cy = tile.y + ty
        for tx in range(tile.width):
            cx = tile.x + tx
            di = (ty * tile.width + tx) * 4
            bg = checker_rgba(cx, cy)
            if not placement.contains(cx, cy):
                img.data[di : di + 4] = bg
                continue
            px, py = cx - placement.ox, cy - placement.oy
            si = (py * w + px) * 4
            r, g, b, a = data[si], data[si + 1], data[si + 2], data[si + 3]
            inv = 255 - a
            img.data[di] = (r * a + bg[0] * inv) // 255
            img.data[di + 1] = (g * a + bg[1] * inv) // 255
            img.data[di + 2] = (b * a + bg[2] * inv) // 255
            img.data[di + 3] = 255
    return img
