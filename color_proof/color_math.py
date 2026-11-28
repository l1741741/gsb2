"""颜色解析与软透明边处理。

关键约定
--------
PNG 里存的 RGB 是「与 matte(默认白色背景)合成后的颜色」。直接在软边像素上
换色再按原 alpha 输出, 会在透明边露出旧背景色(典型的白/黑边)。
因此对 0 < alpha < 255 的像素先 *unmatte* 还原出直色, 匹配和替色都在直色上
做, 输出前再用同一个 matte 重新合成:

    straight = (matted - (1-a) * matte) / a          (a 归一化到 0..1)
    matted   = straight * a + (1-a) * matte

完全不透明 (a=255) 像素直色即原色; 完全透明 (a=0) 像素不参与统计与匹配。
"""

from __future__ import annotations

from dataclasses import dataclass

RGB = tuple[int, int, int]


class ColorSpecError(ValueError):
    """颜色/容差/距离度量等配置不合法。"""


def parse_color(value, field: str = "color") -> RGB:
    """解析 #RRGGBB / RRGGBB / [r,g,b] 为 0-255 整数三元组。"""
    if isinstance(value, (list, tuple)):
        parts = list(value)
    elif isinstance(value, str):
        s = value.strip().lstrip("#")
        if len(s) != 6:
            raise ColorSpecError(
                f"{field} 应为 #RRGGBB 六位十六进制, 得到 {value!r}"
            )
        try:
            parts = [int(s[i : i + 2], 16) for i in (0, 2, 4)]
        except ValueError as exc:
            raise ColorSpecError(f"{field} 含非十六进制字符: {value!r}") from exc
    else:
        raise ColorSpecError(f"{field} 类型应为字符串或数组, 得到 {type(value)!r}")
    if len(parts) != 3 or any(not isinstance(p, (int, float)) for p in parts):
        raise ColorSpecError(f"{field} 需要三个通道值, 得到 {value!r}")
    out = tuple(int(round(p)) for p in parts)
    if any(not 0 <= c <= 255 for c in out):
        raise ColorSpecError(f"{field} 通道必须落在 0..255, 得到 {value!r}")
    return out  # type: ignore[return-value]


def parse_matte(value) -> RGB | None:
    """matte=null 表示输入本就是直色 (premultiplied 工作流关闭)。"""
    if value is None:
        return None
    return parse_color(value, field="matte")


def distance2(a: RGB, b: RGB, metric: str) -> int:
    """返回按度量计算的 *平方/平方化* 距离 (调用方用容差平方比较, 避免开方)。

    - euclidean: 三通道差的平方和 (容差按欧氏半径解释)
    - chebyshev: 最大通道差 (容差按每通道上限解释), 返回 max_diff^2
    """
    dr, dg, db = a[0] - b[0], a[1] - b[1], a[2] - b[2]
    if metric == "euclidean":
        return dr * dr + dg * dg + db * db
    if metric == "chebyshev":
        # 容差按最大通道差解释, 直接比较即可, 不再平方
        return float(max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2])))
    raise ColorSpecError(f"未知距离度量 {metric!r}, 可选 euclidean / chebyshev")


def tolerance_sq(tolerance: float, metric: str) -> float:
    if not isinstance(tolerance, (int, float)) or tolerance < 0:
        raise ColorSpecError(f"容差必须为非负数, 得到 {tolerance!r}")
    if metric == "chebyshev":
        # distance2 在 chebyshev 下返回线性最大通道差, 阈值不平方
        return float(tolerance)
    return float(tolerance) ** 2


@dataclass(frozen=True)
class StraightPixel:
    """解 matte 后的直色及原 alpha。"""

    rgb: RGB
    alpha: int


def unmatte(r: int, g: int, b: int, a: int, matte: RGB | None) -> StraightPixel:
    if a == 255 or matte is None:
        return StraightPixel((r, g, b), a)
    if a == 0:
        # 完全透明: 颜色无意义, 原样返回, 由调用方排除
        return StraightPixel((r, g, b), 0)
    af = a / 255.0
    inv = 1.0 - af
    channels = []
    for c, m in zip((r, g, b), matte):
        straight = (c - inv * m) / af
        channels.append(_clamp8(round(straight)))
    return StraightPixel((channels[0], channels[1], channels[2]), a)


def matte(r: int, g: int, b: int, a: int, matte: RGB | None) -> RGB:
    """直色 + alpha 重新合成回 PNG 存储色。"""
    if a == 255 or matte is None:
        return (_clamp8(r), _clamp8(g), _clamp8(b))
    if a == 0:
        # 完全透明像素保持原存储字节, 不纳入任何规则
        return (r, g, b)
    af = a / 255.0
    inv = 1.0 - af
    return tuple(
        _clamp8(round(c * af + m * inv))
        for c, m in zip((r, g, b), matte)
    )  # type: ignore[return-value]


def _clamp8(v: float) -> int:
    return 0 if v < 0 else 255 if v > 255 else int(v)
