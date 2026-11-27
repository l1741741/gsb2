"""Generate a synthetic poster pair for trying out poster_diff.

The two PNGs share most of their content but the candidate contains the kinds
of changes pre-press review cares about:
- a small mis-colored glyph-like edit near an edge (easy to miss in overview),
- an alpha-only soft shadow change,
- a fully transparent border whose *hidden* RGB differs (must be ignored),
- a global integer offset so single-sided coverage strips appear.

Run:  python3 demo/make_sample.py [output_dir] [--width 1200] [--height 1600]
The script only uses the standard library and poster_diff itself.
"""

from __future__ import annotations

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from poster_diff.pngio import Image, write_png  # noqa: E402


def _disk(img: Image, cx: int, cy: int, radius: int,
          color: tuple[int, int, int, int]) -> None:
    r2 = radius * radius
    x0, x1 = max(0, cx - radius), min(img.width, cx + radius + 1)
    y0, y1 = max(0, cy - radius), min(img.height, cy + radius + 1)
    r, g, b, a = color
    for y in range(y0, y1):
        for x in range(x0, x1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
                i = (y * img.width + x) * 4
                if a == 255:
                    img.data[i:i + 4] = bytes((r, g, b, a))
                else:
                    ia = img.data[i + 3]
                    if ia == 0:
                        img.data[i:i + 4] = bytes((r, g, b, a))
                    else:
                        for k, v in enumerate((r, g, b)):
                            img.data[i + k] = (
                                v * a + img.data[i + k] * (255 - a)
                            ) // 255
                        img.data[i + 3] = max(ia, a)


def _rect(img: Image, x: int, y: int, w: int, h: int,
          color: tuple[int, int, int, int]) -> None:
    for py in range(max(0, y), min(img.height, y + h)):
        for px in range(max(0, x), min(img.width, x + w)):
            i = (py * img.width + px) * 4
            r, g, b, a = color
            if a == 255 or img.data[i + 3] == 0:
                img.data[i:i + 4] = bytes(color)
            else:
                ia = img.data[i + 3]
                for k, v in enumerate((r, g, b)):
                    img.data[i + k] = (
                        v * a + img.data[i + k] * (255 - a)
                    ) // 255
                img.data[i + 3] = max(ia, a)


def _gradient_base(width: int, height: int) -> Image:
    img = Image(width, height, 4, bytearray(width * height * 4))
    for y in range(height):
        for x in range(width):
            i = (y * width + x) * 4
            img.data[i] = 30 + int(40 * (x / width))
            img.data[i + 1] = 60 + int(80 * (y / height))
            img.data[i + 2] = 120 + int(100 * math.sin(x * 0.01))
            img.data[i + 3] = 255
    return img


def make_pair(width: int, height: int, out_dir: str) -> tuple[str, str]:
    os.makedirs(out_dir, exist_ok=True)
    ref = _gradient_base(width, height)
    cand = _gradient_base(width, height)

    # Shared decorative elements.
    for img in (ref, cand):
        _disk(img, width // 2, height // 3, min(width, height) // 6,
              (230, 180, 60, 255))
        _rect(img, width // 4, int(height * 0.62), width // 2, height // 8,
              (245, 245, 245, 255))
        # Soft alpha shadow (a low-alpha disk).
        _disk(img, width // 3, int(height * 0.8), min(width, height) // 10,
              (0, 0, 0, 70))

    # Candidate edit 1: small edge glyph recoloring (visual appearance change).
    _rect(cand, 12, 18, 10, 26, (220, 40, 40, 255))
    _rect(cand, 26, 18, 10, 26, (40, 180, 90, 255))

    # Candidate edit 2: stronger shadow (alpha-only-ish change).
    _disk(cand, width // 3, int(height * 0.8), min(width, height) // 10,
          (0, 0, 0, 60))

    # Transparent border on both: transparent, but stored RGB differs wildly.
    border = max(8, min(width, height) // 80)
    for img, hidden in ((ref, (1, 2, 3)), (cand, (250, 251, 252))):
        for y in range(height):
            for x in range(width):
                if x < border or y < border or x >= width - border or y >= height - border:
                    i = (y * width + x) * 4
                    img.data[i:i + 4] = bytes((hidden[0], hidden[1], hidden[2], 0))

    ref_path = os.path.join(out_dir, "poster_a.png")
    cand_path = os.path.join(out_dir, "poster_b.png")
    write_png(ref_path, ref)
    write_png(cand_path, cand)
    return ref_path, cand_path


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("out_dir", nargs="?", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "demo", "sample"))
    p.add_argument("--width", type=int, default=900)
    p.add_argument("--height", type=int, default=1200)
    args = p.parse_args()
    ref_path, cand_path = make_pair(args.width, args.height, args.out_dir)
    print(f"wrote {ref_path}")
    print(f"wrote {cand_path}")
    print("compare with:")
    print(
        "  python3 -m poster_diff -r "
        f"{ref_path} -c {cand_path} "
        f"-o {os.path.join(args.out_dir, 'report')} --offset-x 6 --offset-y 4"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
