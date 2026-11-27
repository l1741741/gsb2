"""可视化产物：变化区域图（含图例）、深浅底预览、前后对比图。

纯标准库绘制（像素级）；若环境装有 Pillow，会再用其默认字体补上英文文字标注，
没有 Pillow 时输出同样完整，只是图例文字改由 HTML/Markdown 报告承载。
"""

from __future__ import annotations

from typing import List, Optional, Tuple

from . import CAT_CHANGED, CAT_DISCONNECTED_SIMILAR, CAT_PROTECTED_SIMILAR
from .accel import composite_over
from .colors import parse_color
from .pngcodec import ImageData

# 类别配色（变化图叠加色）
TINT_CHANGED = (235, 64, 52)       # 红：实际受影响
TINT_PROTECTED = (46, 117, 235)     # 蓝：相似但被保护区域拦下
TINT_ISOLATED = (245, 178, 26)      # 琥珀：相似但与边/种子不连通
COLOR_SAMPLE = (46, 204, 113)       # 绿：取色点
COLOR_SEED = (255, 140, 0)          # 橙：额外种子
COLOR_ZONE = (64, 224, 255)         # 青：保护区描边
NEUTRAL_MAP_BG = (128, 128, 128)

LEGEND_ITEMS = [
    (TINT_CHANGED, "CHANGED"),
    (TINT_PROTECTED, "PROTECTED-SIMILAR"),
    (TINT_ISOLATED, "ISOLATED-SIMILAR"),
    (COLOR_SAMPLE, "SAMPLE-POINT"),
    (COLOR_ZONE, "PROTECT-ZONE"),
]


# --------------------------------------------------------------------------- #
# 基础绘制原语（直接改 ImageData.rgba）
# --------------------------------------------------------------------------- #

def _set_opaque(img: ImageData, x: int, y: int, rgb, alpha: int = 255):
    if 0 <= x < img.width and 0 <= y < img.height:
        i = (y * img.width + x) * 4
        if alpha >= 255:
            img.rgba[i] = rgb[0]
            img.rgba[i + 1] = rgb[1]
            img.rgba[i + 2] = rgb[2]
            img.rgba[i + 3] = 255
        else:
            ia = 255 - alpha
            img.rgba[i] = (alpha * rgb[0] + ia * img.rgba[i] + 127) // 255
            img.rgba[i + 1] = (alpha * rgb[1] + ia * img.rgba[i + 1] + 127) // 255
            img.rgba[i + 2] = (alpha * rgb[2] + ia * img.rgba[i + 2] + 127) // 255
            img.rgba[i + 3] = 255


def fill_rect(img: ImageData, x0: int, y0: int, x1: int, y1: int, rgb,
              alpha: int = 255):
    x0 = max(0, x0)
    y0 = max(0, y0)
    x1 = min(img.width, x1)
    y1 = min(img.height, y1)
    for y in range(y0, y1):
        for x in range(x0, x1):
            _set_opaque(img, x, y, rgb, alpha)


def draw_line(img: ImageData, p0, p1, rgb, thickness: int = 1, alpha: int = 255):
    """Bresenham 直线，thickness>1 时用方形笔刷。"""
    x0, y0 = int(round(p0[0])), int(round(p0[1]))
    x1, y1 = int(round(p1[0])), int(round(p1[1]))
    dx = abs(x1 - x0)
    dy = -abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx + dy
    half = max(0, thickness // 2)
    while True:
        for oy in range(-half, half + 1):
            for ox in range(-half, half + 1):
                if thickness <= 1 or max(abs(ox), abs(oy)) <= half:
                    _set_opaque(img, x0 + ox, y0 + oy, rgb, alpha)
        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 >= dy:
            err += dy
            x0 += sx
        if e2 <= dx:
            err += dx
            y0 += sy


def draw_polyline(img: ImageData, points, rgb, thickness: int = 1, closed: bool = False):
    n = len(points)
    limit = n if closed else n - 1
    for i in range(limit):
        draw_line(img, points[i], points[(i + 1) % n], rgb, thickness)


def draw_circle_outline(img: ImageData, cx: int, cy: int, r: int, rgb,
                        thickness: int = 2):
    for y in range(cy - r - thickness, cy + r + thickness + 1):
        for x in range(cx - r - thickness, cx + r + thickness + 1):
            d2 = (x - cx) ** 2 + (y - cy) ** 2
            if (r - thickness) ** 2 <= d2 <= (r + thickness) ** 2:
                _set_opaque(img, x, y, rgb)


def draw_circle_filled(img: ImageData, cx: int, cy: int, r: int, rgb):
    for y in range(cy - r, cy + r + 1):
        for x in range(cx - r, cx + r + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                _set_opaque(img, x, y, rgb)


def draw_marker(img: ImageData, x: int, y: int, color=COLOR_SAMPLE):
    """绿点 + 白圈 + 十字，保证在深浅背景上都可见。"""
    draw_circle_filled(img, x, y, 6, (15, 15, 15))
    draw_circle_filled(img, x, y, 5, (255, 255, 255))
    draw_circle_filled(img, x, y, 3, color)
    draw_line(img, (x - 9, y), (x - 7, y), (255, 255, 255), 1)
    draw_line(img, (x + 7, y), (x + 9, y), (255, 255, 255), 1)
    draw_line(img, (x, y - 9), (x, y - 7), (255, 255, 255), 1)
    draw_line(img, (x, y + 7), (x, y + 9), (255, 255, 255), 1)


def draw_square_marker(img: ImageData, x: int, y: int, color=COLOR_SEED):
    fill_rect(img, x - 5, y - 5, x + 6, y + 6, (20, 20, 20))
    fill_rect(img, x - 4, y - 4, x + 5, y + 5, (255, 255, 255))
    fill_rect(img, x - 3, y - 3, x + 4, y + 4, color)


# --------------------------------------------------------------------------- #
# 变化区域图
# --------------------------------------------------------------------------- #

def _legend_layout(width: int):
    """纵向图例布局，保证任何图片宽度下文字都不会溢出。

    placement 内所有 y 坐标都相对于图例条顶部（绘制时再加原图高度 h）。
    返回 (placements, legend_height)。
    """
    chip = 13
    left = 14
    top = 10
    pitch = 23
    placements = []
    for row, (color, text) in enumerate(LEGEND_ITEMS):
        ytop = top + row * pitch
        placements.append({
            "color": color,
            "text": text,
            "chip": (left, ytop, left + chip, ytop + chip),
            "text_xy": (left + chip + 8, ytop - 2),
        })
    legend_h = top + len(LEGEND_ITEMS) * pitch + 8
    return placements, legend_h


def build_change_map(before: ImageData, analysis: dict) -> ImageData:
    w, h = before.width, before.height
    placements, legend_h = _legend_layout(w)
    img = ImageData(w, h + legend_h)

    # 底图：原图合成到中性灰，让半透明区域也有上下文
    base_rgb = composite_over(before.rgba, NEUTRAL_MAP_BG)
    for i in range(w * h):
        k = i * 3
        d = i * 4
        img.rgba[d] = base_rgb[k]
        img.rgba[d + 1] = base_rgb[k + 1]
        img.rgba[d + 2] = base_rgb[k + 2]
        img.rgba[d + 3] = 255

    category = analysis["category"]
    final_w = analysis["final_w"]
    for i in range(w * h):
        cat = category[i]
        if cat == CAT_CHANGED:
            strength = 0.30 + 0.55 * (final_w[i] / 255.0)
            tint = TINT_CHANGED
        elif cat == CAT_PROTECTED_SIMILAR:
            strength = 0.48
            tint = TINT_PROTECTED
        elif cat == CAT_DISCONNECTED_SIMILAR:
            strength = 0.52
            tint = TINT_ISOLATED
        else:
            continue
        d = i * 4
        img.rgba[d] = int(img.rgba[d] * (1 - strength) + tint[0] * strength)
        img.rgba[d + 1] = int(img.rgba[d + 1] * (1 - strength) + tint[1] * strength)
        img.rgba[d + 2] = int(img.rgba[d + 2] * (1 - strength) + tint[2] * strength)

    # 保护区青色描边
    from .masks import region_segments
    for r in analysis.get("regions", []):
        for a, b in region_segments(r):
            draw_line(img, a, b, COLOR_ZONE, thickness=2, alpha=235)

    # 取色点 / 种子
    for x, y in analysis.get("sample_points", []):
        draw_marker(img, x, y, COLOR_SAMPLE)
    sample_set = {tuple(p) for p in analysis.get("sample_points", [])}
    for x, y in analysis.get("seed_points", []):
        if (x, y) not in sample_set:
            draw_square_marker(img, x, y, COLOR_SEED)

    # 图例条
    fill_rect(img, 0, h, w, h + legend_h, (26, 28, 32), 255)
    labels = []
    for p in placements:
        x0, y0, x1, y1 = p["chip"]
        # chip 坐标是相对 legend 顶部的，平移 h
        fill_rect(img, x0, h + y0, x1, h + y1, p["color"])
        tx, ty = p["text_xy"]
        labels.append((p["text"], tx, h + ty + 2, (235, 238, 245)))
    annotate_labels(img, labels)
    return img


def annotate_labels(img: ImageData, labels) -> bool:
    """绘制文字标注。

    优先用 Pillow 默认字体（更平滑）；未安装 / 渲染失败时回退到内置 5x7
    位图字体（放大 2 倍），保证纯标准库环境下图例文字仍然可见。
    """
    if not labels:
        return True
    try:
        from PIL import Image, ImageDraw, ImageFont
        im = Image.frombytes("RGBA", (img.width, img.height), bytes(img.rgba))
        draw = ImageDraw.Draw(im)
        try:
            font = ImageFont.load_default(size=13)
        except TypeError:  # pragma: no cover - 老版本 Pillow
            font = ImageFont.load_default()
        for text, x, y, rgb in labels:
            draw.text((x, y), text, font=font, fill=(rgb[0], rgb[1], rgb[2], 255))
        img.rgba[:] = bytearray(im.tobytes())
        return True
    except Exception:
        try:
            from .mini_font import draw_text
            for text, x, y, rgb in labels:
                # Pillow 文字基线略偏下，位图字体从顶部画，y 微调 -1
                draw_text(img, text, x, max(0, y - 1), rgb, scale=2)
            return True
        except Exception:
            return False


# --------------------------------------------------------------------------- #
# 深浅底预览 & 2x2 对比图
# --------------------------------------------------------------------------- #

def flatten_preview(img: ImageData, backdrop) -> ImageData:
    bg = parse_color(backdrop)[:3]
    rgb = composite_over(img.rgba, bg)
    out = ImageData(img.width, img.height)
    for i in range(img.width * img.height):
        k = i * 3
        d = i * 4
        out.rgba[d] = rgb[k]
        out.rgba[d + 1] = rgb[k + 1]
        out.rgba[d + 2] = rgb[k + 2]
        out.rgba[d + 3] = 255
    return out


def _blit_rgb(dst: ImageData, src_rgb: bytearray, w: int, h: int, ox: int, oy: int):
    for y in range(h):
        src_row = y * w * 3
        dst_base = ((oy + y) * dst.width + ox) * 4
        for x in range(w):
            k = src_row + x * 3
            d = dst_base + x * 4
            dst.rgba[d] = src_rgb[k]
            dst.rgba[d + 1] = src_rgb[k + 1]
            dst.rgba[d + 2] = src_rgb[k + 2]
            dst.rgba[d + 3] = 255


def build_compare_sheet(before: ImageData, after: ImageData,
                        light=(255, 255, 255), dark=(26, 26, 26)) -> ImageData:
    w, h = before.width, before.height
    light = parse_color(light)[:3]
    dark = parse_color(dark)[:3]

    panels = [
        (composite_over(before.rgba, light), "BEFORE / LIGHT"),
        (composite_over(after.rgba, light), "AFTER / LIGHT"),
        (composite_over(before.rgba, dark), "BEFORE / DARK"),
        (composite_over(after.rgba, dark), "AFTER / DARK"),
    ]

    gap = 8
    left_margin = 52
    top_band = 26
    sheet_w = left_margin + 2 * w + 3 * gap
    sheet_h = top_band + 2 * h + 3 * gap
    sheet = ImageData(sheet_w, sheet_h)
    fill_rect(sheet, 0, 0, sheet_w, sheet_h, (236, 238, 242))

    positions = [
        (left_margin, top_band),
        (left_margin + w + gap, top_band),
        (left_margin, top_band + h + gap),
        (left_margin + w + gap, top_band + h + gap),
    ]
    labels = []
    for (rgb, title), (ox, oy) in zip(panels, positions):
        _blit_rgb(sheet, rgb, w, h, ox, oy)
        # 1px 深色描边
        for x in range(ox, ox + w):
            _set_opaque(sheet, x, oy, (30, 32, 38))
            _set_opaque(sheet, x, oy + h - 1, (30, 32, 38))
        for y in range(oy, oy + h):
            _set_opaque(sheet, ox, y, (30, 32, 38))
            _set_opaque(sheet, ox + w - 1, y, (30, 32, 38))
        labels.append((title, ox + 2, max(2, oy - 18), (35, 38, 45)))

    labels.append(("LIGHT", 8, top_band + h // 2 - 6, (70, 74, 84)))
    labels.append(("DARK", 10, top_band + h + gap + h // 2 - 6, (70, 74, 84)))
    annotate_labels(sheet, labels)
    return sheet
