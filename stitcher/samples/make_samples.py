"""生成演示样例：从同一张生成图上裁出扫描块。

三组样例（均裁自程序生成的"原画"，带轻微扫描噪声）：
  normal/   普通纹理，三块图成一个闭环，可干净拼合
  repeat/   重复纹理，两块图的对齐存在多个等分候选解
  conflict/ 三块图闭环矛盾（C 块模拟扫描纵向错位 2px）

运行: 在 stitcher/ 目录下  python -m samples.make_samples
"""

import json
import os
import random

from stitcher.pngio import Image, write_png

HERE = os.path.dirname(os.path.abspath(__file__))


# ---------- 基础绘图 ----------

def _put(img, x, y, r, g, b, a=255):
    if 0 <= x < img.w and 0 <= y < img.h:
        i = (y * img.w + x) * 4
        img.pix[i:i + 4] = bytes((r, g, b, a))


def _fill_rect(img, x0, y0, x1, y1, color):
    for y in range(max(0, y0), min(img.h, y1)):
        for x in range(max(0, x0), min(img.w, x1)):
            _put(img, x, y, *color)


def _fill_circle(img, cx, cy, rad, color):
    for y in range(cy - rad, cy + rad + 1):
        for x in range(cx - rad, cx + rad + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad:
                _put(img, x, y, *color)


def add_noise(img, seed, amp=2):
    rng = random.Random(seed)
    pix = img.pix
    for i in range(0, len(pix), 4):
        if pix[i + 3] == 0:
            continue
        for c in range(3):
            v = pix[i + c] + rng.randint(-amp, amp)
            pix[i + c] = 0 if v < 0 else (255 if v > 255 else v)


def rounded_corners(img, rad=10):
    """四角切成透明圆角，模拟扫描件不规则边缘。"""
    for cy, cx in ((rad, rad), (rad, img.w - rad - 1),
                   (img.h - rad - 1, rad), (img.h - rad - 1, img.w - rad - 1)):
        for y in range(img.h):
            for x in range(img.w):
                in_corner = ((cx < img.w // 2) == (x < img.w // 2)
                             and (cy < img.h // 2) == (y < img.h // 2))
                if in_corner and (x - cx) ** 2 + (y - cy) ** 2 > rad * rad \
                        and abs(x - cx) <= rad and abs(y - cy) <= rad:
                    img.pix[(y * img.w + x) * 4 + 3] = 0


# ---------- 原画生成 ----------

def gen_normal_source(w=640, h=480, seed=7):
    """渐变底 + 随机圆形/矩形色块 + 细噪声（普通插画纹理）。"""
    rng = random.Random(seed)
    img = Image(w, h)
    for y in range(h):
        for x in range(w):
            _put(img, x, y, 40 + x * 160 // w, 60 + y * 120 // h,
                 90 + (x + y) * 60 // (w + h))
    for _ in range(14):
        cx, cy = rng.randrange(w), rng.randrange(h)
        rad = rng.randrange(14, 46)
        color = (rng.randrange(60, 255), rng.randrange(60, 255),
                 rng.randrange(60, 255))
        _fill_circle(img, cx, cy, rad, color)
    for _ in range(8):
        x0, y0 = rng.randrange(w - 60), rng.randrange(h - 60)
        color = (rng.randrange(60, 255), rng.randrange(60, 255),
                 rng.randrange(60, 255))
        _fill_rect(img, x0, y0, x0 + rng.randrange(20, 60),
                   y0 + rng.randrange(20, 60), color)
    add_noise(img, seed + 1, amp=5)
    return img


def gen_repeat_source(w=624, h=336):
    """周期 48px 的重复纹样（重复纹理，对齐有多解）。"""
    period = 48
    img = Image(w, h)
    for y in range(h):
        for x in range(w):
            lx, ly = x % period, y % period
            base = 200 if (lx % 24) < 12 else 210
            r, g, b = base, base - 10, base - 20
            d = abs(lx - 24) + abs(ly - 24)
            if d < 12:
                r, g, b = 150, 60, 60
            elif d < 16:
                r, g, b = 60, 90, 150
            if (lx - 24) ** 2 + (ly - 24) ** 2 < 9:
                r, g, b = 240, 220, 90
            _put(img, x, y, r, g, b)
    return img


# ---------- 扫描块裁剪 ----------

def crop_tile(src, x, y, w, h, noise_seed=None, corners=True):
    tile = src.crop(x, y, x + w, y + h)
    if noise_seed is not None:
        add_noise(tile, noise_seed, amp=2)
    if corners:
        rounded_corners(tile, 10)
    return tile


def shear_vertical(tile, total=2):
    """模拟扫描纵向错位：第 x 列内容整体上移 s(x)，s 从 0 渐变到 total。"""
    w, h = tile.w, tile.h
    out = Image(w, h)
    for x in range(w):
        s = (x * total) // (w - 1)
        for y in range(h):
            sy = y + s
            if sy < h:
                o = (y * w + x) * 4
                i = (sy * w + x) * 4
                out.pix[o:o + 4] = tile.pix[i:i + 4]
    return out


# ---------- 样例组装 ----------

def _write_cfg(path, images, radius):
    cfg = {"images": images, "options": {"search_radius": radius,
                                         "checker": 16}}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def make_normal(src, out):
    """普通纹理三块闭环。真实位置: A(0,0) B(220,0) C(110,200)。"""
    os.makedirs(out, exist_ok=True)
    write_png(os.path.join(out, "tile_a.png"),
              crop_tile(src, 0, 0, 280, 260, noise_seed=11))
    write_png(os.path.join(out, "tile_b.png"),
              crop_tile(src, 220, 0, 280, 260, noise_seed=12))
    write_png(os.path.join(out, "tile_c.png"),
              crop_tile(src, 110, 200, 280, 260, noise_seed=13))
    _write_cfg(os.path.join(out, "stitch.json"), [
        {"file": "tile_a.png", "rough": [0, 0]},
        {"file": "tile_b.png", "rough": [223, -4]},
        {"file": "tile_c.png", "rough": [107, 203]},
    ], radius=12)


def make_repeat(src, out):
    """重复纹理两块。真实位置: A(0,0) B(250,0)；周期 48 -> 多解。"""
    os.makedirs(out, exist_ok=True)
    write_png(os.path.join(out, "tile_a.png"),
              crop_tile(src, 0, 0, 300, 300, noise_seed=21, corners=False))
    write_png(os.path.join(out, "tile_b.png"),
              crop_tile(src, 250, 0, 300, 300, noise_seed=22, corners=False))
    _write_cfg(os.path.join(out, "stitch.json"), [
        {"file": "tile_a.png", "rough": [0, 0]},
        {"file": "tile_b.png", "rough": [245, 2]},
    ], radius=60)


def make_conflict(src, out):
    """闭环矛盾：C 块带 2px 纵向扫描错位。真实位置同 normal。"""
    os.makedirs(out, exist_ok=True)
    tile_c = crop_tile(src, 110, 200, 280, 260, noise_seed=33, corners=False)
    tile_c = shear_vertical(tile_c, total=2)
    rounded_corners(tile_c, 10)
    write_png(os.path.join(out, "tile_a.png"),
              crop_tile(src, 0, 0, 280, 260, noise_seed=31))
    write_png(os.path.join(out, "tile_b.png"),
              crop_tile(src, 220, 0, 280, 260, noise_seed=32))
    write_png(os.path.join(out, "tile_c.png"), tile_c)
    _write_cfg(os.path.join(out, "stitch.json"), [
        {"file": "tile_a.png", "rough": [0, 0]},
        {"file": "tile_b.png", "rough": [221, -3]},
        {"file": "tile_c.png", "rough": [112, 198]},
    ], radius=12)


def main():
    normal_src = gen_normal_source()
    repeat_src = gen_repeat_source()
    write_png(os.path.join(HERE, "source_normal.png"), normal_src)
    write_png(os.path.join(HERE, "source_repeat.png"), repeat_src)
    make_normal(normal_src, os.path.join(HERE, "normal"))
    make_repeat(repeat_src, os.path.join(HERE, "repeat"))
    make_conflict(normal_src, os.path.join(HERE, "conflict"))
    print("样例已生成到 %s/{normal,repeat,conflict}/" % HERE)


if __name__ == "__main__":
    main()
