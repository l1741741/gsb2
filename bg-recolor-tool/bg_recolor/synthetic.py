"""生成用于检验保护 / 连通 / 透明边缘行为的确定性合成图与示例配置。

``synthetic_scene.png``（以及 batch/inputs 下的变体）刻意包含：

1. **同色产品块 P**：产品内部、与背景完全同色，但被产品色包围 → 与图边断开，
   连通模式下应被记为 disconnected_similar（琥珀），不被修改；
2. **同色产品块 Q**：同样与背景断开，但落在保护区域内 → 必须被保护（蓝色），
   调大容差 / 过渡也不能侵入；
3. **同色块 R + 1px 细窄连通桥**：R 通过一条仅 1 像素高的同色“细窄连通边”
   穿过产品连到外部背景 → edge/seeds 连通时桥和 R 都应被替换；
4. **对角接触块 S**：只通过一个角点与背景对角相接 → 4 邻接下断开，
   8 邻接下连通，用来区分邻接规则；
5. **透明阴影**：黑色、alpha 径向渐变（真 alpha 通道，不是画在白底上）；
6. **透明反光**：低 alpha 白色椭圆；
7. **全透明洞**：alpha=0 且 RGB 故意为脏颜色，验证外观统计将其排除；
8. **接近背景的半透明“污染边缘”**：边缘像素存的是与旧背景混合后的颜色 +
   部分 alpha，用来检查深浅底上的边缘变化。

整张图无随机数，所有“判别像素”的位置都在 tests 中直接断言。
"""

from __future__ import annotations

import json
import os
from typing import List, Tuple

from .pngcodec import ImageData, write_png

W, H = 480, 360

# 关键几何（测试与配置共用，避免魔法数字漂移）
GEOM = {
    "size": (W, H),
    "sample_points": [[18, 18], [462, 338]],
    "product_xyxy": [110, 60, 370, 300],
    "block_p_xyxy": [140, 120, 216, 182],   # 断开同色块
    "block_q_xyxy": [264, 120, 340, 182],   # 保护区同色块
    "protect_q_xyxy": [258, 114, 346, 188],
    "block_r_xyxy": [150, 214, 212, 266],   # 细桥连接块
    "corridor_y": 239,
    "corridor_x": [212, 373],              # 半开区间 [212,373)
    "block_s_xyxy": [111, 61, 132, 82],     # 仅对角接触
    "corner_pixel": [110, 60],
    "transparent_hole": [424, 42, 15],      # cx, cy, r
    "fringe_x": 370,
    "fringe_y_range": [120, 200],
}

VARIANTS = {
    0: {
        "bg": (238, 236, 228),
        "product": (34, 96, 106),
        "header": (24, 70, 80),
        "target": "#2F6FDB",
    },
    1: {
        "bg": (226, 232, 238),
        "product": (74, 88, 128),
        "header": (52, 64, 98),
        "target": "#0E7C66",
    },
}


def fill_rect(img: ImageData, x0: int, y0: int, x1: int, y1: int,
              rgb: Tuple[int, int, int]):
    """不透明硬边矩形（合成图里的判别几何都要求精确像素，不做 alpha 混合）。"""
    x0 = max(0, int(x0))
    y0 = max(0, int(y0))
    x1 = min(img.width, int(x1))
    y1 = min(img.height, int(y1))
    r, g, b = rgb
    for y in range(y0, y1):
        base = y * img.width
        for x in range(x0, x1):
            i = (base + x) * 4
            img.rgba[i] = r
            img.rgba[i + 1] = g
            img.rgba[i + 2] = b
            img.rgba[i + 3] = 255


def set_straight(img: ImageData, x: int, y: int,
                 r: int, g: int, b: int, a: int):
    if 0 <= x < img.width and 0 <= y < img.height:
        i = (y * img.width + x) * 4
        img.rgba[i] = r
        img.rgba[i + 1] = g
        img.rgba[i + 2] = b
        img.rgba[i + 3] = a


def ellipse_straight_gradient(img: ImageData, cx: int, cy: int,
                              rx: int, ry: int, rgb, max_alpha: int,
                              power: float = 1.4):
    """写入 straight-alpha 径向渐变椭圆（会替换目标像素的 RGBA）。"""
    r, g, b = rgb
    for y in range(max(0, cy - ry), min(img.height, cy + ry + 1)):
        for x in range(max(0, cx - rx), min(img.width, cx + rx + 1)):
            q = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
            if q <= 1.0:
                a = int(round(max_alpha * max(0.0, 1.0 - q) ** power))
                set_straight(img, x, y, r, g, b, a)


def generate_scene(variant: int = 0) -> ImageData:
    cfg = VARIANTS[variant]
    bg = cfg["bg"]
    product = cfg["product"]
    header = cfg["header"]
    img = ImageData(W, H, bytearray([0, 0, 0, 0]) * (W * H))

    # 1) 不透明背景
    fill_rect(img, 0, 0, W, H, bg)

    # 2) 透明反光（左下，低 alpha 白色）
    ellipse_straight_gradient(img, 72, 330, 48, 12, (255, 255, 255), 70, 1.6)

    # 3) 透明阴影（产品下方；先画，产品实体会盖住重叠部分）
    ellipse_straight_gradient(img, 242, 306, 142, 20, (26, 30, 38), 125, 1.3)

    # 4) 产品主体 + 顶部色带
    x0, y0, x1, y1 = GEOM["product_xyxy"]
    fill_rect(img, x0, y0, x1, y1, product)
    fill_rect(img, x0, y0, x1, 98, header)
    # 一些不透明内部细节（刻意选与背景距离很大的颜色，避免干扰判别域）
    fill_rect(img, 130, 72, 232, 84, (118, 196, 205))
    fill_rect(img, 130, 196, 250, 204, tuple(min(255, c + 28) for c in product))
    fill_rect(img, 130, 276, 300, 284, tuple(max(0, c - 18) for c in product))

    # 5) 三个同色判别块 P / Q / R + 对角块 S，全部精确背景色、不透明
    for key in ("block_p_xyxy", "block_q_xyxy", "block_r_xyxy", "block_s_xyxy"):
        fill_rect(img, *GEOM[key], bg)

    # 6) 1px 细窄连通桥 R -> 外部背景
    cx0, cx1 = GEOM["corridor_x"]
    cy = GEOM["corridor_y"]
    fill_rect(img, cx0, cy, cx1, cy + 1, bg)

    # 7) 对角接触：产品左上角像素也改成背景色，S 仅与它对角相邻
    set_straight(img, *GEOM["corner_pixel"], bg[0], bg[1], bg[2], 255)

    # 8) 右侧半透明、被旧背景污染的边缘带（straight RGBA）
    fx = GEOM["fringe_x"]
    fy0, fy1 = GEOM["fringe_y_range"]
    for y in range(fy0, fy1):
        # 轻微 alpha 起伏，模拟抗锯齿
        a = 120 + (y % 5) * 8
        set_straight(img, fx, y, 158, 178, 176, min(190, a))
    # 边缘带外侧再来一列更淡的
    for y in range(fy0 + 6, fy1 - 6):
        set_straight(img, fx + 1, y, 200, 210, 208, 90)

    # 9) 全透明洞，RGB 故意给脏颜色，验证统计排除 alpha=0
    hx, hy, hr = GEOM["transparent_hole"]
    for y in range(hy - hr - 1, hy + hr + 2):
        for x in range(hx - hr - 1, hx + hr + 2):
            if (x - hx) ** 2 + (y - hy) ** 2 <= hr * hr:
                set_straight(img, x, y, 255, 0, 255, 0)

    return img


def write_scene_png(path: str, variant: int = 0) -> str:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    write_png(path, generate_scene(variant))
    return path


CLEAN_CONFIG = {
    "output_dir": "out-example",
    "defaults": {
        "metric": "redmean",
        "tolerance": 90,
        "feather": 36,
        "connectivity": "edge",
        "neighborhood": 4,
        "target_color": "#2F6FDB",
    },
    "images": [
        {
            "id": "synthetic_scene",
            "path": "synthetic_scene.png",
            "sample_points": GEOM["sample_points"],
            "protect": [
                {"type": "rect", "xyxy": GEOM["protect_q_xyxy"]},
            ],
            "note": "同色产品块 P 应被记录为断开区域；Q 被保护；R 经 1px 细桥连通被替换",
        },
        {
            "id": "synthetic_scene_global",
            "path": "synthetic_scene.png",
            "sample_points": GEOM["sample_points"],
            "connectivity": "off",
            "target_color": "#7A3FF0",
            "protect": [
                {"type": "rect", "xyxy": GEOM["protect_q_xyxy"]},
            ],
            "note": "全局模式：所有相似色都替换，仅保护区 Q 存活",
        },
    ],
}


def batch_config() -> dict:
    return {
        "output_dir": "output",
        "defaults": {
            "metric": "redmean",
            "tolerance": 90,
            "feather": 36,
            "neighborhood": 4,
        },
        "images": [
            {
                "id": "scene_a_edge",
                "path": "inputs/scene_a.png",
                "sample_points": [[18, 18]],
                "connectivity": "edge",
                "target_color": VARIANTS[0]["target"],
                "protect": [{"type": "rect", "xyxy": GEOM["protect_q_xyxy"]}],
            },
            {
                "id": "scene_b_seeds",
                "path": "inputs/scene_b.png",
                "sample_points": [[18, 18]],
                "connectivity": "seeds",
                "seeds": [[18, 18]],
                "target_color": VARIANTS[1]["target"],
                "protect": [{"type": "rect", "xyxy": GEOM["protect_q_xyxy"]}],
            },
            {
                "id": "corrupt_file",
                "path": "inputs/corrupt.png",
                "sample_points": [[4, 4]],
            },
            {
                "id": "bad_sample_oob",
                "path": "inputs/scene_a.png",
                "sample_points": [[9999, 18]],
            },
            {
                "id": "bad_sample_transparent",
                "path": "inputs/scene_b.png",
                "sample_points": [GEOM["transparent_hole"][:2]],
            },
        ],
    }


def generate_all(target_dir: str) -> List[str]:
    """在 target_dir 下生成全部合成图与配置，返回写入路径列表。"""
    written = []
    os.makedirs(target_dir, exist_ok=True)

    scene_path = os.path.join(target_dir, "synthetic_scene.png")
    write_scene_png(scene_path, 0)
    written.append(scene_path)

    cfg_path = os.path.join(target_dir, "config.example.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(CLEAN_CONFIG, f, ensure_ascii=False, indent=2)
    written.append(cfg_path)

    inputs_dir = os.path.join(target_dir, "batch", "inputs")
    for name, variant in (("scene_a.png", 0), ("scene_b.png", 1)):
        p = os.path.join(inputs_dir, name)
        write_scene_png(p, variant)
        written.append(p)

    corrupt_path = os.path.join(inputs_dir, "corrupt.png")
    os.makedirs(inputs_dir, exist_ok=True)
    with open(corrupt_path, "wb") as f:
        f.write(b"this is deliberately NOT a png file\n")
        f.write(bytes(range(256)) * 4)
    written.append(corrupt_path)

    bcfg_path = os.path.join(target_dir, "batch", "batch_config.json")
    os.makedirs(os.path.dirname(bcfg_path), exist_ok=True)
    with open(bcfg_path, "w", encoding="utf-8") as f:
        json.dump(batch_config(), f, ensure_ascii=False, indent=2)
    written.append(bcfg_path)
    return written
