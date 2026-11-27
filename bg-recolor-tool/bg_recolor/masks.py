"""保护区域（rect / polygon / ellipse）的解析、光栅化与轮廓线段。

坐标均为原图像素坐标。超出图像边界的区域会被裁剪并给出 warning，
但坐标类型错误 / 形状非法会抛 :class:`RegionConfigError`（上层记为 invalid_config）。
"""

from __future__ import annotations

import math
from typing import Dict, List, Tuple

from .colors import ColorConfigError, parse_color  # noqa: F401  (re-export 便利)

Point = Tuple[float, float]


class RegionConfigError(ValueError):
    """保护区域配置不合法。"""


def _as_number(v, ctx: str) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise RegionConfigError("%s 需要数字，得到 %r" % (ctx, v))
    f = float(v)
    if not math.isfinite(f):
        raise RegionConfigError("%s 不是有限数: %r" % (ctx, v))
    return f


def parse_region(obj) -> Dict:
    """把多种便捷写法统一成 ``{"type": ..., ...}``。

    支持：
    * ``[x0, y0, x1, y1]`` 裸四元组 → rect(xyxy)
    * ``{"type": "rect", "xyxy": [...]}`` / ``{"xywh": [...]}`` / x,y,width,height
    * ``{"type": "polygon", "points": [[x,y], ...]}``
    * ``{"type": "ellipse", "cx": .., "cy": .., "rx": .., "ry": ..}``
    """
    if isinstance(obj, (list, tuple)):
        if len(obj) == 4 and all(isinstance(v, (int, float)) for v in obj):
            x0, y0, x1, y1 = obj
            return {"type": "rect", "xyxy": (float(x0), float(y0), float(x1), float(y1))}
        raise RegionConfigError("裸数组保护区只支持 [x0,y0,x1,y1]: %r" % (obj,))

    if not isinstance(obj, dict):
        raise RegionConfigError("保护区配置必须是数组或对象: %r" % (obj,))

    rtype = str(obj.get("type", "rect")).lower()

    if rtype == "rect":
        if "xyxy" in obj:
            q = obj["xyxy"]
            if len(q) != 4:
                raise RegionConfigError("rect.xyxy 需要 4 个数")
            x0, y0, x1, y1 = (_as_number(v, "rect.xyxy") for v in q)
        elif "xywh" in obj:
            x, y, w, h = (_as_number(v, "rect.xywh[%d]" % i) for i, v in enumerate(obj["xywh"]))
            x0, y0, x1, y1 = x, y, x + w, y + h
        elif all(k in obj for k in ("x", "y", "width", "height")):
            x = _as_number(obj["x"], "rect.x")
            y = _as_number(obj["y"], "rect.y")
            w = _as_number(obj["width"], "rect.width")
            h = _as_number(obj["height"], "rect.height")
            x0, y0, x1, y1 = x, y, x + w, y + h
        elif all(k in obj for k in ("x0", "y0", "x1", "y1")):
            x0 = _as_number(obj["x0"], "rect.x0")
            y0 = _as_number(obj["y0"], "rect.y0")
            x1 = _as_number(obj["x1"], "rect.x1")
            y1 = _as_number(obj["y1"], "rect.y1")
        else:
            raise RegionConfigError(
                "rect 需要 xyxy / xywh 或 x,y,width,height: %r" % (obj,))
        if x1 < x0:
            x0, x1 = x1, x0
        if y1 < y0:
            y0, y1 = y1, y0
        return {"type": "rect", "xyxy": (x0, y0, x1, y1)}

    if rtype in ("ellipse", "circle"):
        if rtype == "circle":
            cx = _as_number(obj.get("cx", obj.get("x")), "circle.cx")
            cy = _as_number(obj.get("cy", obj.get("y")), "circle.cy")
            r = _as_number(obj.get("r", obj.get("radius")), "circle.r")
            if r < 0:
                raise RegionConfigError("circle 半径不能为负")
            return {"type": "ellipse", "cx": cx, "cy": cy, "rx": r, "ry": r}
        cx = _as_number(obj.get("cx"), "ellipse.cx")
        cy = _as_number(obj.get("cy"), "ellipse.cy")
        rx = _as_number(obj.get("rx", obj.get("radius_x")), "ellipse.rx")
        ry = _as_number(obj.get("ry", obj.get("radius_y")), "ellipse.ry")
        if rx < 0 or ry < 0:
            raise RegionConfigError("ellipse 半径不能为负")
        return {"type": "ellipse", "cx": cx, "cy": cy, "rx": rx, "ry": ry}

    if rtype in ("polygon", "poly"):
        pts = obj.get("points")
        if not isinstance(pts, (list, tuple)) or len(pts) < 3:
            raise RegionConfigError("polygon 至少需要 3 个点: %r" % (obj,))
        points: List[Point] = []
        for p in pts:
            if not isinstance(p, (list, tuple)) or len(p) != 2:
                raise RegionConfigError("polygon 点必须是 [x,y]: %r" % (p,))
            points.append((_as_number(p[0], "polygon.x"), _as_number(p[1], "polygon.y")))
        return {"type": "polygon", "points": points}

    raise RegionConfigError("不支持的保护区类型 %r（rect/polygon/ellipse）" % rtype)


def parse_regions(items) -> List[Dict]:
    if not items:
        return []
    if not isinstance(items, (list, tuple)):
        raise RegionConfigError("protect 必须是区域数组")
    return [parse_region(x) for x in items]


def _clamp_bbox(x0: float, y0: float, x1: float, y1: float,
                w: int, h: int):
    ix0 = max(0, int(math.floor(x0)))
    iy0 = max(0, int(math.floor(y0)))
    ix1 = min(w, int(math.ceil(x1)))
    iy1 = min(h, int(math.ceil(y1)))
    return ix0, iy0, ix1, iy1


def rasterize_region(region: Dict, w: int, h: int,
                     mask: bytearray = None) -> bytearray:
    """把单个区域写入 mask（并集，传入已有 mask 时直接 OR 进去）。"""
    if mask is None:
        mask = bytearray(w * h)
    rtype = region["type"]

    if rtype == "rect":
        x0, y0, x1, y1 = region["xyxy"]
        ix0, iy0, ix1, iy1 = _clamp_bbox(x0, y0, x1, y1, w, h)
        for y in range(iy0, iy1):
            base = y * w
            for x in range(ix0, ix1):
                mask[base + x] = 1
        return mask

    if rtype == "ellipse":
        cx, cy, rx, ry = region["cx"], region["cy"], region["rx"], region["ry"]
        if rx == 0 or ry == 0:
            return mask
        ix0, iy0, ix1, iy1 = _clamp_bbox(cx - rx, cy - ry, cx + rx, cy + ry, w, h)
        rx2 = rx * rx
        ry2 = ry * ry
        for y in range(iy0, iy1):
            dy = (y + 0.5) - cy
            for x in range(ix0, ix1):
                dx = (x + 0.5) - cx
                if (dx * dx) / rx2 + (dy * dy) / ry2 <= 1.0:
                    mask[y * w + x] = 1
        return mask

    # polygon：逐行扫描线 + 交点配对（even-odd）
    pts = region["points"]
    ys = [p[1] for p in pts]
    ix0, iy0, ix1, iy1 = _clamp_bbox(min(p[0] for p in pts), min(ys),
                                     max(p[0] for p in pts) + 1,
                                     max(ys) + 1, w, h)
    m = len(pts)
    for y in range(iy0, iy1):
        scan = y + 0.5
        xs: List[float] = []
        for i in range(m):
            ax, ay = pts[i]
            bx, by = pts[(i + 1) % m]
            if (ay <= scan < by) or (by <= scan < ay):
                if by == ay:
                    continue
                t = (scan - ay) / (by - ay)
                xs.append(ax + t * (bx - ax))
        xs.sort()
        for k in range(0, len(xs) - 1, 2):
            xa = max(0, int(math.ceil(xs[k] - 0.5)))
            xb = min(w, int(math.floor(xs[k + 1] - 0.5)) + 1)
            base = y * w
            for x in range(xa, xb):
                if 0 <= x < w:
                    mask[base + x] = 1
    return mask


def rasterize_all(regions: List[Dict], w: int, h: int) -> bytearray:
    mask = bytearray(w * h)
    for r in regions:
        rasterize_region(r, w, h, mask)
    return mask


def region_segments(region: Dict) -> List[Tuple[Point, Point]]:
    """返回区域轮廓线段（供变化图描边）。"""
    rtype = region["type"]
    if rtype == "rect":
        x0, y0, x1, y1 = region["xyxy"]
        p = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        return [(p[i], p[(i + 1) % 4]) for i in range(4)]
    if rtype == "polygon":
        p = region["points"]
        return [(p[i], p[(i + 1) % len(p)]) for i in range(len(p))]
    # ellipse 用 48 段折线逼近
    cx, cy, rx, ry = region["cx"], region["cy"], region["rx"], region["ry"]
    steps = 48
    p = [(cx + rx * math.cos(2 * math.pi * i / steps),
          cy + ry * math.sin(2 * math.pi * i / steps)) for i in range(steps)]
    return [(p[i], p[(i + 1) % steps]) for i in range(steps)]


def validate_point(point, w: int, h: int, name: str = "取色点") -> Tuple[int, int]:
    """校验点坐标，越界 / 类型错误抛 RegionConfigError（上层按 invalid_sample_point 隔离）。"""
    if not isinstance(point, (list, tuple)) or len(point) != 2:
        raise RegionConfigError("%s 必须是 [x, y]: %r" % (name, point))
    x, y = point
    if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) \
            or not isinstance(y, (int, float)):
        raise RegionConfigError("%s 坐标必须是数字: %r" % (name, point))
    if not math.isfinite(float(x)) or not math.isfinite(float(y)):
        raise RegionConfigError("%s 坐标不是有限数: %r" % (name, point))
    xi, yi = int(round(x)), int(round(y))
    if not (0 <= xi < w and 0 <= yi < h):
        raise RegionConfigError(
            "%s (%s, %s) 超出图片范围 %dx%d" % (name, x, y, w, h))
    return xi, yi
