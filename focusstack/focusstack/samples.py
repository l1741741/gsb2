"""Deterministic sample-stack generator.

Produces a small photographic stack that exercises every behaviour the tool
supports:

* **near layer** -- thin bright wires, a ring and fine text-like ticks;
* **mid layer** -- a flat card with a low-contrast drawing (low-confidence
  focus areas);
* **far layer** -- diagonal edges and a large soft circle;
* **moved part** -- a fastener that sits at different positions in two shots,
  which must surface as seam conflicts and be fixable with a manual override.

Each photo is rendered from the same vector scene with a per-layer blur that
depends on that photo's focus distance, then quantised to 8-bit with a
deterministic noise seed.  No randomness is taken from the clock, so repeated
generation is byte-identical.

The generated directory also contains ``edits.json`` (a ready-made manual
override over the moved part) and ``README.md`` with the exact commands.
"""

from __future__ import annotations

import json
import math
from array import array
from pathlib import Path

from .image import Image
from .ops import box_blur
from .pngio import write_png

SUPERSAMPLE = 3
WIDTH = 360
HEIGHT = 270

# Depth in arbitrary units; focus distances per photo are chosen so that
# different layers are sharp in different photos.
NEAR = 0.0
MID = 1.0
FAR = 2.0


class Layer:
    """A binary coverage mask plus colour, at supersample resolution."""

    __slots__ = ("coverage", "color", "depth", "name")

    def __init__(self, coverage, color, depth, name) -> None:
        self.coverage = coverage
        self.color = color
        self.depth = depth
        self.name = name


class SceneCanvas:
    def __init__(self, width: int, height: int, supersample: int) -> None:
        self.ss = supersample
        self.width = width
        self.height = height
        self.w = width * supersample
        self.h = height * supersample
        self.layers = []

    # ---- shape rasterisers (all in final-pixel coordinates) ----
    def new_layer(self, color, depth, name) -> Layer:
        layer = Layer(bytearray(self.w * self.h), color, depth, name)
        self.layers.append(layer)
        return layer

    def _plot_line(self, layer, x, y, coverage=1.0):
        ix = int(x)
        iy = int(y)
        if 0 <= ix < self.w and 0 <= iy < self.h:
            index = iy * self.w + ix
            value = int(255 * coverage)
            if layer.coverage[index] < value:
                layer.coverage[index] = value

    def line(self, layer, x0, y0, x1, y1, width=1.0) -> None:
        x0 *= self.ss
        y0 *= self.ss
        x1 *= self.ss
        y1 *= self.ss
        radius = width * self.ss / 2.0
        steps = int(max(abs(x1 - x0), abs(y1 - y0)) * 2 + 2)
        for step in range(steps + 1):
            t = step / steps
            px = x0 + (x1 - x0) * t
            py = y0 + (y1 - y0) * t
            reach = int(radius) + 1
            for oy in range(-reach, reach + 1):
                for ox in range(-reach, reach + 1):
                    distance = (ox * ox + oy * oy) ** 0.5
                    if distance <= radius + 0.5:
                        self._plot_line(layer, px + ox, py + oy,
                                        min(1.0, (radius + 0.5 - distance)))

    def filled_ellipse(self, layer, cx, cy, rx, ry) -> None:
        cx *= self.ss
        cy *= self.ss
        rx *= self.ss
        ry *= self.ss
        left = max(0, int(cx - rx - 1))
        right = min(self.w - 1, int(cx + rx + 1))
        top = max(0, int(cy - ry - 1))
        bottom = min(self.h - 1, int(cy + ry + 1))
        for py in range(top, bottom + 1):
            for px in range(left, right + 1):
                dx = (px + 0.5 - cx) / rx
                dy = (py + 0.5 - cy) / ry
                d2 = dx * dx + dy * dy
                if d2 > 1.0:
                    continue
                index = py * self.w + px
                layer.coverage[index] = 255

    def ring(self, layer, cx, cy, radius, thickness=1.0) -> None:
        steps = int(2 * math.pi * radius * self.ss) + 12
        for step in range(steps):
            angle = 2 * math.pi * step / steps
            x = cx + radius * math.cos(angle)
            y = cy + radius * math.sin(angle)
            self._disc(layer, x, y, thickness)

    def _disc(self, layer, cx, cy, radius) -> None:
        cx *= self.ss
        cy *= self.ss
        rr = radius * self.ss
        reach = int(rr) + 1
        for oy in range(-reach, reach + 1):
            for ox in range(-reach, reach + 1):
                if (ox * ox + oy * oy) ** 0.5 <= rr:
                    self._plot_line(layer, cx + ox, cy + oy)

    def filled_polygon(self, layer, points) -> None:
        pts = [(x * self.ss, y * self.ss) for x, y in points]
        left = max(0, int(min(p[0] for p in pts)))
        right = min(self.w - 1, int(max(p[0] for p in pts)))
        top = max(0, int(min(p[1] for p in pts)))
        bottom = min(self.h - 1, int(max(p[1] for p in pts)))
        for py in range(top, bottom + 1):
            for px in range(left, right + 1):
                if _point_in_polygon(px + 0.5, py + 0.5, pts):
                    layer.coverage[py * self.w + px] = 255

    def rect(self, layer, x, y, w, h) -> None:
        x0 = max(0, int(round(x * self.ss)))
        y0 = max(0, int(round(y * self.ss)))
        x1 = min(self.w, int(round((x + w) * self.ss)))
        y1 = min(self.h, int(round((y + h) * self.ss)))
        row = bytearray([255]) * max(0, x1 - x0)
        for py in range(y0, y1):
            layer.coverage[py * self.w + x0:py * self.w + x1] = row

    def diagonal_split(self, layer, x_at_top, x_at_bottom, below=True) -> None:
        """Fill the side of a slanted edge; a cheap 'tilted object' test."""
        for py in range(self.h):
            t = py / (self.h - 1)
            edge = (x_at_top + (x_at_bottom - x_at_top) * t) * self.ss
            start = int(edge)
            if below:
                if start >= self.w:
                    continue
                end = self.w
            else:
                end = min(self.w, max(0, start))
                start = 0
            if end <= start:
                continue
            row = bytearray([255]) * (end - start)
            layer.coverage[py * self.w + start:py * self.w + end] = row

    # ---- downsample + blur + composite ----
    def _layer_gray(self, layer) -> "array":
        return array("f", (float(v) for v in layer.coverage))

    def render(self, focus: float, *, blur_scale: float, noise_seed: int) -> Image:
        w, h, ss = self.width, self.height, self.ss
        n = w * h
        out_r = [0.0] * n
        out_g = [0.0] * n
        out_b = [0.0] * n
        background = (238.0, 236.0, 231.0)
        for i in range(n):
            out_r[i], out_g[i], out_b[i] = background

        # Far-to-near compositing so near shapes sit on top.
        ordered = sorted(self.layers, key=lambda layer: -layer.depth)
        for layer in ordered:
            defocus = abs(layer.depth - focus)
            radius = int(round(defocus * blur_scale))
            plane = self._layer_gray(layer)
            if radius > 0:
                for _ in range(2):
                    plane = box_blur(plane, self.w, self.h, radius)
            # Box-downsample by ss.
            small = array("f", bytes(4 * n))
            for y in range(h):
                src = (y * ss) * self.w
                dst = y * w
                for x in range(w):
                    total = 0.0
                    for sy in range(ss):
                        base = src + sy * self.w + x * ss
                        for sx in range(ss):
                            total += plane[base + sx]
                    small[dst + x] = total / (ss * ss)
            cr, cg, cb = layer.color
            for i in range(n):
                alpha = small[i] / 255.0
                if alpha <= 0.0:
                    continue
                out_r[i] = out_r[i] * (1 - alpha) + cr * alpha
                out_g[i] = out_g[i] * (1 - alpha) + cg * alpha
                out_b[i] = out_b[i] * (1 - alpha) + cb * alpha

        # Deterministic sensor noise: a small LCG walk per channel.
        state = noise_seed & 0xFFFFFFFF
        channels = []
        for base in (out_r, out_g, out_b):
            values = []
            for value in base:
                state = (1103515245 * state + 12345) & 0x7FFFFFFF
                delta = (state >> 16) % 7 - 3
                v = int(value + 0.5) + delta
                values.append(0 if v < 0 else (255 if v > 255 else v))
            channels.append(values)
        return Image(w, h, array("B", channels[0]), array("B", channels[1]),
                     array("B", channels[2]), name="sample")


def _point_in_polygon(x, y, points) -> bool:
    inside = False
    n = len(points)
    j = n - 1
    for i in range(n):
        xi, yi = points[i]
        xj, yj = points[j]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def build_scene(moved_dx: int = 0) -> SceneCanvas:
    canvas = SceneCanvas(WIDTH, HEIGHT, SUPERSAMPLE)

    # Far layer: a slanted edge, a large soft circle and two simple shapes.
    # Fine diagonal hatching inside the wedge is what identifies the far
    # photo as the sharp one.
    far = canvas.new_layer((92, 108, 126), FAR, "far")
    canvas.diagonal_split(far, x_at_top=250, x_at_bottom=210, below=True)
    canvas.filled_ellipse(far, cx=310, cy=70, rx=46, ry=38)
    canvas.line(far, x0=40, y0=225, x1=210, y1=248, width=2)
    canvas.filled_polygon(far, [(20, 120), (120, 96), (150, 150), (46, 176)])

    # Mid layer: a flat card with a darker drawing whose contrast is only
    # a few levels above sensor noise, so focus scores there are weak and
    # the selector should fall back to the reference rather than flip.
    mid_card = canvas.new_layer((206, 198, 180), MID, "mid-card")
    canvas.rect(mid_card, 26, 34, 128, 62)
    mid_ink = canvas.new_layer((176, 168, 150), MID + 0.05, "mid-ink")
    canvas.line(mid_ink, x0=36, y0=52, x1=140, y1=72, width=1)
    canvas.line(mid_ink, x0=36, y0=76, x1=140, y1=56, width=1)
    canvas.filled_ellipse(mid_ink, cx=64, cy=84, rx=9, ry=6)
    # A slightly higher-contrast tick row near the card's top edge; enough
    # detail that the sharp mid photo wins there, but still subtle.
    for index in range(10):
        x = 32 + index * 11
        canvas.line(mid_ink, x0=x, y0=38, x1=x, y1=46, width=1)

    # Near layer: thin wires, rings, a tick row and a simple dark shape.
    near = canvas.new_layer((30, 34, 38), NEAR, "near")
    canvas.line(near, x0=18, y0=18, x1=330, y1=94, width=2)
    canvas.line(near, x0=18, y0=30, x1=200, y1=200, width=1)
    canvas.ring(near, cx=250, cy=190, radius=42, thickness=1)
    canvas.ring(near, cx=250, cy=190, radius=18, thickness=2)
    for index in range(8):
        x = 288 + index * 7
        canvas.line(near, x0=x, y0=156, x1=x, y1=170, width=1)
    canvas.filled_ellipse(near, cx=322, cy=238, rx=14, ry=9)
    # A slanted near edge crossing the card, so a moving part can straddle
    # a focus transition.
    canvas.filled_polygon(near, [(158, 190), (196, 182), (200, 206), (166, 214)])

    # Moved part: same depth as the near layer, different position in the
    # second shot.  Rendered as its own layer so it can move independently.
    mover = canvas.new_layer((156, 54, 44), NEAR, "mover")
    canvas.filled_ellipse(mover, cx=150 + moved_dx, cy=186, rx=16, ry=13)
    canvas.line(mover, x0=150 + moved_dx, y0=186, x1=150 + moved_dx, y1=206, width=2)
    return canvas


def generate_samples(out_dir, *, seed: int = 20261128) -> dict:
    """Write sample photos, an edit file and a README; return metadata."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    base_scene = build_scene(moved_dx=0)
    moved_scene = build_scene(moved_dx=7)

    photos = [
        ("01-near.png", base_scene.render(NEAR, blur_scale=2.2, noise_seed=seed + 1)),
        ("02-mid.png", base_scene.render(MID, blur_scale=2.2, noise_seed=seed + 2)),
        ("03-far.png", base_scene.render(FAR, blur_scale=2.2, noise_seed=seed + 3)),
        ("04-near-moved.png", moved_scene.render(NEAR, blur_scale=2.2, noise_seed=seed + 4)),
    ]
    for name, image in photos:
        image.name = name
        write_png(out_dir / name, image)

    edit_document = {
        "version": 1,
        "edits": [
            {
                "id": "moved-part",
                "image": 1,
                "note": "near-sharp shot has the fastener in its original place; keep it from 02-mid.png",
                "enabled": True,
                "shapes": [{
                    "kind": "ellipse",
                    "cx": 157, "cy": 196, "rx": 26, "ry": 28,
                    "strength": 1.0,
                }],
            }
        ],
    }
    (out_dir / "edits.json").write_text(
        json.dumps(edit_document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    readme = f"""# Focus stack samples

Generated by `python3 -m focusstack samples --out .`.  Four same-size PNGs
({WIDTH}x{HEIGHT}) share one canvas; the near, mid and far layers are sharp in
different shots, and `04-near-moved.png` has the red fastener shifted 7 px.

Run the default stack:

    python3 -m focusstack stack --out ./result \\
        --reference 0 01-near.png 02-mid.png 03-far.png 04-near-moved.png

Then open `result/review.json`.  It should list:

* `low_confidence` regions on the flat card (low-contrast drawing);
* `seam_conflict` regions around the moved fastener;
* `ambiguous_near_tie` regions where near shots see the same detail.

Fix the moved part with the supplied override and rerun:

    python3 -m focusstack stack --out ./result-edited --edits ./edits.json \\
        --reference 0 01-near.png 02-mid.png 03-far.png 04-near-moved.png

`manual_edits` in the new `review.json` must report the painted area for
`moved-part`, and the fastener should come entirely from photo 1.

Draw a new region interactively (needs a Python with tkinter):

    python3 -m focusstack editor --edits ./edits.json \\
        01-near.png 02-mid.png 03-far.png 04-near-moved.png

Export only the fastener block and compare with the full result:

    python3 -m focusstack stack --out ./result-block --window 110,160,90,80 \\
        --edits ./edits.json --coverage keep \\
        01-near.png 02-mid.png 03-far.png 04-near-moved.png
"""
    (out_dir / "README.md").write_text(readme, encoding="utf-8")
    return {
        "directory": str(out_dir),
        "photos": [name for name, _ in photos],
        "width": WIDTH,
        "height": HEIGHT,
        "edits": "edits.json",
    }
