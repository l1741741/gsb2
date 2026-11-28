"""生成可运行样例: 一张 RGBA PNG + 一份配色 JSON。

样例特意覆盖三类难点:
1. 双色相近: 红区主体 #E8503A 与邻近色 #E05842, 两条规则容差圈交叠;
2. 半透明边: 两个圆形色块带 3px 的 alpha 渐变软边, 且按白 matte 预合成;
3. 规则重叠: warm-shadow 的容差同时罩住红色主体, 命中冲突由优先级裁决。

另含一块全透明但 RGB 非零的区域, 用于证明透明像素不参与颜色统计。

运行: python -m examples.make_sample        (从仓库根目录)
产物: examples/sample.png, examples/palettes.json
"""

from __future__ import annotations

import json
import os
import sys

# 允许直接 `python examples/make_sample.py` 运行: 把仓库根加入模块搜索路径
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from color_proof.pngio import Image, write_png

WIDTH, HEIGHT = 160, 120
MATTE = (255, 255, 255)

RED = (232, 80, 58)       # #E8503A
RED_NEAR = (224, 88, 66)  # #E05842 与 RED 欧氏距离约 13.9
BLUE = (60, 110, 200)     # #3C6EC8
# 只落在 warm-shadow(source #D86048, tol 40) 容差圈内、
# 但在 red-coat(source #E8503A, tol 25) 圈外的阴影色, 让低优先级规则也有胜出处
WARM_SHADOW = (210, 96, 72)  # #D26048
JUNK_RGB = (37, 38, 39)   # 全透明像素里故意放的"脏 RGB", 必须被统计忽略


def _coverage(x: float, y: float, cx: float, cy: float, radius: float) -> float:
    """返回 0..1 的覆盖率(alpha 比例), 核外 0、核内 1、边界 3px 线性过渡。"""
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    edge = 1.5
    if d <= radius - edge:
        return 1.0
    if d >= radius + edge:
        return 0.0
    return (radius + edge - d) / (2 * edge)


def _matted(rgb: tuple[int, int, int], alpha: int) -> tuple[int, int, int]:
    """直色 + alpha 按白 matte 预合成, 模拟常见绘图软件导出的 PNG 存储色。"""
    af = alpha / 255.0
    return tuple(
        min(255, max(0, round(c * af + m * (1 - af))))
        for c, m in zip(rgb, MATTE)
    )  # type: ignore[return-value]


def build_sample_image() -> Image:
    rgba = bytearray(WIDTH * HEIGHT * 4)

    def paint(cx, cy, radius, straight):
        for y in range(HEIGHT):
            for x in range(WIDTH):
                cov = _coverage(x + 0.5, y + 0.5, cx, cy, radius)
                if cov == 0.0:
                    continue
                alpha = round(cov * 255)
                r, g, b = _matted(straight, alpha)
                i = (y * WIDTH + x) * 4
                rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3] = r, g, b, alpha

    # 背景: 全透明 + 脏 RGB
    for i in range(WIDTH * HEIGHT):
        rgba[i * 4 : i * 4 + 3] = JUNK_RGB

    paint(45, 60, 35, RED)
    paint(115, 60, 30, BLUE)

    # 红圆内核里嵌一块相近色方块(双色相近试样), 位置在圆核内所以 alpha=255
    for y in range(40, 51):
        for x in range(20, 31):
            i = (y * WIDTH + x) * 4
            rgba[i], rgba[i + 1], rgba[i + 2] = RED_NEAR
            rgba[i + 3] = 255

    # 圆外的独立暖阴影方块: 只被 warm-shadow 命中(red-coat 圈外),
    # 与红圆主体上「warm-shadow 命中但被 red-coat 抢走」形成对照
    for y in range(100, 114):
        for x in range(8, 22):
            i = (y * WIDTH + x) * 4
            rgba[i], rgba[i + 1], rgba[i + 2] = WARM_SHADOW
            rgba[i + 3] = 255

    return Image(width=WIDTH, height=HEIGHT, rgba=rgba)


PALETTES = {
    "matte": "#FFFFFF",
    "default_metric": "euclidean",
    "rules": [
        {
            "id": "red-coat",
            "source": "#E8503A",
            "target": "#32AA5A",
            "tolerance": 25,
            "priority": 10,
        },
        {
            "id": "warm-shadow",
            "source": "#D86048",
            "target": "#B478FF",
            "tolerance": 40,
            "priority": 5,
        },
        {
            "id": "blue-coat",
            "source": "#3C6EC8",
            "target": "#F0C83C",
            "tolerance": 30,
            "priority": 8,
        },
        {
            # 独立开关演示: 池内禁用, 任何方案都不会命中
            "id": "disabled-demo",
            "source": "#123456",
            "target": "#000000",
            "tolerance": 0,
            "priority": 9,
            "enabled": False,
        },
    ],
    "protected": [
        # 蓝圆右下的一块身体: 落在里面的蓝像素必须原样保留
        {"type": "rect", "x0": 95, "y0": 70, "x1": 130, "y1": 100}
    ],
    "schemes": [
        {
            "id": "spring",
            "name": "春芽配色",
            "rule_refs": ["red-coat", "warm-shadow", "blue-coat"],
        },
        {
            "id": "autumn",
            "name": "秋实配色(蓝区关闭 + 红区改棕)",
            "rule_refs": [
                {"id": "blue-coat", "enabled": False},
                {"id": "red-coat", "target": "#8A5A2B"},
                "warm-shadow",
            ],
        },
        {
            # 与 spring 规则完全相同, 仅引用排列不同; 输出必须逐字节一致
            "id": "order-check-a",
            "name": "顺序自检 A",
            "rule_refs": ["blue-coat", "warm-shadow", "red-coat"],
        },
        {
            "id": "order-check-b",
            "name": "顺序自检 B",
            "rule_refs": ["warm-shadow", "red-coat", "blue-coat"],
        },
    ],
}


def main() -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    img_path = os.path.join(here, "sample.png")
    json_path = os.path.join(here, "palettes.json")
    write_png(img_path, build_sample_image())
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(PALETTES, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"已写出 {img_path}")
    print(f"已写出 {json_path}")


if __name__ == "__main__":
    main()
