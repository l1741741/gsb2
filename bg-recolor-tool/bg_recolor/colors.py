"""颜色解析 / 距离等纯函数。"""

from __future__ import annotations

import re
from typing import Tuple

RGB = Tuple[int, int, int]

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")


class ColorConfigError(ValueError):
    """颜色 / 参数配置不合法。"""


def parse_color(value, default_alpha: int = 255) -> Tuple[int, int, int, int]:
    """把 ``#rgb`` / ``#rrggbb`` / ``#rrggbbaa`` / ``[r,g,b]`` 解析成 RGBA。"""
    if value is None:
        raise ColorConfigError("颜色为空")
    if isinstance(value, (list, tuple)):
        if len(value) == 3:
            r, g, b = value
            a = default_alpha
        elif len(value) == 4:
            r, g, b, a = value
        else:
            raise ColorConfigError("颜色数组长度应为 3 或 4: %r" % (value,))
        out = []
        for v in (r, g, b, a):
            if isinstance(v, bool):
                raise ColorConfigError("颜色分量不能是布尔值: %r" % (value,))
            iv = int(round(float(v)))
            if not 0 <= iv <= 255:
                raise ColorConfigError("颜色分量超出 0..255: %r" % (value,))
            out.append(iv)
        return tuple(out)  # type: ignore[return-value]

    s = str(value).strip()
    m = _HEX_RE.match(s)
    if not m:
        # 也允许 "r,g,b"
        parts = [p.strip() for p in s.split(",")]
        if 3 <= len(parts) <= 4 and all(re.fullmatch(r"-?\d+(\.\d+)?", p) for p in parts):
            return parse_color([float(p) for p in parts], default_alpha)
        raise ColorConfigError("无法解析颜色 %r（支持 #rrggbb / r,g,b / [r,g,b]）" % value)
    token = m.group(1)
    if len(token) == 3:
        r, g, b = (int(ch * 2, 16) for ch in token)
        a = default_alpha
    elif len(token) == 6:
        r = int(token[0:2], 16)
        g = int(token[2:4], 16)
        b = int(token[4:6], 16)
        a = default_alpha
    else:
        r = int(token[0:2], 16)
        g = int(token[2:4], 16)
        b = int(token[4:6], 16)
        a = int(token[6:8], 16)
    return r, g, b, a


def rgb_hex(color) -> str:
    r, g, b = parse_color(color)[:3]
    return "#%02X%02X%02X" % (r, g, b)


def color_distance_sq(r1: int, g1: int, b1: int,
                      r2: int, g2: int, b2: int, metric: str = "redmean") -> float:
    """颜色距离平方。metric: ``rgb`` / ``redmean`` / ``max``。"""
    dr = r1 - r2
    dg = g1 - g2
    db = b1 - b2
    if metric == "rgb":
        return float(dr * dr + dg * dg + db * db)
    if metric == "max":
        return float(max(abs(dr), abs(dg), abs(db)) ** 2)
    if metric == "redmean":
        rmean = (r1 + r2) * 0.5
        return ((2.0 + rmean / 256.0) * dr * dr
                + 4.0 * dg * dg
                + (2.0 + (255.0 - rmean) / 256.0) * db * db)
    raise ColorConfigError("未知颜色距离 metric=%r（支持 rgb / redmean / max）" % metric)


def color_distance(r1, g1, b1, r2, g2, b2, metric: str = "redmean") -> float:
    return color_distance_sq(r1, g1, b1, r2, g2, b2, metric) ** 0.5


def composite_pixel(c: int, a: int, bg: int) -> int:
    """单通道 straight-alpha 合成到不透明底色，最近整数取整。"""
    return (a * c + (255 - a) * bg + 127) // 255
