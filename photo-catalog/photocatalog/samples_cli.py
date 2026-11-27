"""Build the bundled sample photo set.

Run as a module::

    python3 -m photocatalog.samples_cli --out samples

The set is small on purpose and is committed to the repository so the tool can
be demonstrated without any external download.
"""

from __future__ import annotations

import os
import shutil

from .imaging.image import Image
from .jpeg_encode import encode_jpeg
from .samples import _render


def _crop(img: Image, x0: int, y0: int, x1: int, y1: int) -> Image:
    w, h = x1 - x0, y1 - y0
    out = bytearray(w * h * 3)
    for y in range(h):
        src = ((y0 + y) * img.width + x0) * 3
        out[y * w * 3:(y + 1) * w * 3] = img.pixels[src:src + w * 3]
    return Image(w, h, bytes(out), 3, "png", "RGB")


def _resize(img: Image, w: int, h: int) -> Image:
    from .analysis import resize_rgb
    return resize_rgb(img, w, h)


def _grade(img: Image, *, add: tuple[int, int, int] = (0, 0, 0),
           multiply: tuple[float, float, float] = (1.0, 1.0, 1.0)) -> Image:
    out = bytearray(img.pixels)
    for i in range(0, len(out), 3):
        for c in range(3):
            out[i + c] = max(0, min(255, int(out[i + c] * multiply[c] + add[c])))
    return Image(img.width, img.height, bytes(out), 3, "png", "RGB")


def _save_png(img: Image, path: str) -> None:
    import struct
    import zlib

    def chunk(tag: bytes, body: bytes) -> bytes:
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))

    raw = bytearray()
    for y in range(img.height):
        raw.append(0)
        base = y * img.width * 3
        raw += img.pixels[base:base + img.width * 3]
    data = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", img.width, img.height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
            + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(data)


def build_sample_set(out_dir: str, *, size: int = 120, seed: int = 3) -> dict:
    """Write the sample files.  Returns a manifest describing each file."""
    os.makedirs(out_dir, exist_ok=True)
    # Clean previous output so stale files cannot confuse a rescan.
    for name in os.listdir(out_dir):
        path = os.path.join(out_dir, name)
        if os.path.isfile(path):
            os.remove(path)
        elif os.path.isdir(path):
            shutil.rmtree(path)

    w = size
    h = int(round(size * 0.75))
    day_walker = _render(w, h, seed, subject="walker")
    day_dog = _render(w, h, seed, subject="dog")
    dusk_bench = _render(w, h, seed + 5, subject="bench", time_of_day="dusk")
    # A wide panorama for the non-transitive chain: one frame shows the
    # whole scene (B); the other two are its left and right portions (A, C).
    chain_wide = _render(int(w * 2), h, seed + 11, subject="cart")

    manifest = []

    def add(relpath: str, kind: str, note: str) -> None:
        manifest.append({"file": relpath, "kind": kind, "note": note})

    # --- Originals -------------------------------------------------------
    orig_dir = _mkdir(out_dir, "originals")
    _save_png(day_walker, os.path.join(orig_dir, "walker_day.png"))
    add("originals/walker_day.png", "original",
        "Reference photo used for the resize/crop/colour variants.")

    encode_jpeg(day_walker, os.path.join(orig_dir, "walker_day.jpg"), quality=90)
    add("originals/walker_day.jpg", "original-jpeg",
        "Same scene encoded as a normal JPEG (a separate archive copy).")

    _save_png(day_dog, os.path.join(orig_dir, "dog_day.png"))
    add("originals/dog_day.png", "different-photo",
        "Different subject in the same location; must not merge with walker_day.")

    _save_png(dusk_bench, os.path.join(orig_dir, "bench_dusk.png"))
    add("originals/bench_dusk.png", "different-photo",
        "Different light and subject; shares only broad scenery statistics.")

    # --- True duplicates -------------------------------------------------
    dup_dir = _mkdir(out_dir, "duplicates")
    shutil.copyfile(os.path.join(out_dir, "originals", "walker_day.png"),
                    os.path.join(dup_dir, "walker_day_copy.png"))
    add("duplicates/walker_day_copy.png", "exact-duplicate",
        "Byte-for-byte copy of originals/walker_day.png.")

    shutil.copyfile(os.path.join(out_dir, "originals", "dog_day.png"),
                    os.path.join(dup_dir, "dog_day_copy.png"))
    add("duplicates/dog_day_copy.png", "exact-duplicate",
        "Byte-for-byte copy of originals/dog_day.png.")

    # --- Resize / crop / colour variants of the walker -------------------
    var_dir = _mkdir(out_dir, "variants")
    _save_png(_resize(day_walker, w * 2, h * 2), os.path.join(var_dir, "walker_large.png"))
    add("variants/walker_large.png", "resize",
        "2x upscale of walker_day; candidate for merging.")

    encode_jpeg(_resize(day_walker, w // 2, h // 2),
                os.path.join(var_dir, "walker_small.jpg"), quality=80)
    add("variants/walker_small.jpg", "resize",
        "Half-size JPEG of walker_day; candidate for merging.")

    _save_png(_crop(day_walker, 4, 3, w - 5, h - 4),
              os.path.join(var_dir, "walker_trimmed.png"))
    add("variants/walker_trimmed.png", "crop",
        "Border trimmed by a few pixels on each side.")

    _save_png(_grade(day_walker, add=(14, -6, 8)),
              os.path.join(var_dir, "walker_warm.png"))
    add("variants/walker_warm.png", "colour",
        "Slightly warmer colour grade; same photo.")

    _save_png(_grade(_crop(day_walker, 3, 2, w - 4, h - 3),
                     multiply=(0.92, 0.96, 1.06), add=(-4, 2, 6)),
              os.path.join(var_dir, "walker_trimmed_cool.png"))
    add("variants/walker_trimmed_cool.png", "crop+colour",
        "Trimmed and cooled slightly; still the same photo.")

    # --- The non-transitive chain ---------------------------------------
    # B is the panorama.  A is its left 60%, C its right 60%; A and C overlap
    # in the middle but show clearly different pictures.  A–B and B–C are
    # genuine crops, yet A–C is not the same photo: a naive transitive merge
    # would wrongly group all three.  The tool must surface this as a chain.
    chain_dir = _mkdir(out_dir, "chain")
    wide_w = chain_wide.width
    _save_png(chain_wide, os.path.join(chain_dir, "panorama_b.png"))
    add("chain/panorama_b.png", "chain-middle",
        "The whole scene.  Bridges the two crops below, but they differ from "
        "each other, so all three must not be merged by default.")

    _save_png(_crop(chain_wide, 0, 0, int(wide_w * 0.60), h),
              os.path.join(chain_dir, "left_a.png"))
    add("chain/left_a.png", "chain-start",
        "Left 60% of the panorama; a genuine crop of panorama_b.")

    _save_png(_crop(chain_wide, int(wide_w * 0.40), 0, wide_w, h),
              os.path.join(chain_dir, "right_c.png"))
    add("chain/right_c.png", "chain-end",
        "Right 60% of the panorama.  Resembles panorama_b like left_a does, "
        "but left_a and right_c are clearly different photographs.")

    # --- A deliberately broken file -------------------------------------
    bad_dir = _mkdir(out_dir, "broken")
    with open(os.path.join(bad_dir, "truncated.jpg"), "wb") as fh:
        fh.write(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
        fh.write(b"\x00\x00")  # ends mid-segment, no scan
    add("broken/truncated.jpg", "broken",
        "Truncated JPEG used to check that a bad file is reported, not fatal.")

    return {"dir": out_dir, "files": manifest}


def _mkdir(base: str, name: str) -> str:
    path = os.path.join(base, name)
    os.makedirs(path, exist_ok=True)
    return path


def main(argv: list[str] | None = None) -> int:
    import argparse
    parser = argparse.ArgumentParser(description="Generate the bundled sample photo set")
    parser.add_argument("--out", default="samples", help="output directory")
    parser.add_argument("--size", type=int, default=120, help="long edge in pixels")
    parser.add_argument("--seed", type=int, default=3, help="base random seed")
    args = parser.parse_args(argv)
    result = build_sample_set(args.out, size=args.size, seed=args.seed)
    print(f"wrote {len(result['files'])} files to {result['dir']}")
    for item in result["files"]:
        print(f"  {item['file']:34s} {item['kind']:16s} {item['note']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
