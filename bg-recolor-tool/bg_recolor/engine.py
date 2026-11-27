"""换色引擎：取色 -> 相似度/过渡 -> 连通域 -> 保护硬闸门 -> 分类与统计。

本模块不做任何文件 IO（除了通过 pngcodec 的可选便利函数），
输入输出都是 :class:`~bg_recolor.pngcodec.ImageData`，便于单测直接构造像素。
"""

from __future__ import annotations

from typing import Dict, List, Optional, Sequence, Tuple

from . import CAT_CHANGED, CAT_DISCONNECTED_SIMILAR, CAT_PROTECTED_SIMILAR
from .accel import apply_recolor, evaluate
from .colors import parse_color, rgb_hex
from .connectivity import connected_components, select_components
from .masks import parse_regions, validate_point
from .pngcodec import ImageData, read_png

DEFAULT_PARAMS: Dict = {
    "metric": "redmean",       # rgb / redmean / max
    "tolerance": 60.0,         # 相似范围（外边界，距离单位随 metric）
    "feather": 24.0,           # 过渡区间宽度（tolerance-feather 以内全替换）
    "connectivity": "edge",    # edge / seeds / edge_or_seeds / off(global)
    "neighborhood": 4,         # 4 / 8
    "sample_radius": 2,        # 取色点周围 patch 半径
    "sample_min_alpha": 200,   # 优先使用 alpha>=该值的像素取背景色
    "strict_seed": False,      # True 时种子不落在相似掩码内直接判无效
    "target_color": "#2E6FDB",
    "light_color": "#FFFFFF",
    "dark_color": "#1A1A1A",
}


class EngineConfigError(ValueError):
    """参数 / 区域配置非法。"""


class InvalidSampleError(Exception):
    """取色点无效（越界、patch 全透明、严格模式下种子未命中）。"""

    def __init__(self, message: str, reason_code: str = "invalid_sample_point"):
        super().__init__(message)
        self.reason_code = reason_code


def normalize_params(overrides: Optional[Dict] = None) -> Dict:
    p = dict(DEFAULT_PARAMS)
    if overrides:
        for k, v in overrides.items():
            if v is None:
                continue
            p[k] = v
    # 校验 / 收敛
    try:
        p["tolerance"] = max(0.0, float(p["tolerance"]))
        p["feather"] = max(0.0, float(p["feather"]))
        p["sample_radius"] = max(0, int(p["sample_radius"]))
        p["sample_min_alpha"] = min(255, max(0, int(p["sample_min_alpha"])))
        p["neighborhood"] = int(p["neighborhood"])
    except (TypeError, ValueError) as exc:
        raise EngineConfigError("参数类型非法: %s" % exc)
    if p["metric"] not in ("rgb", "redmean", "max"):
        raise EngineConfigError("未知 metric=%r" % p["metric"])
    if p["feather"] > p["tolerance"]:
        # 过渡区间不能宽过相似范围，收敛而不是让中心像素都无法全替换
        p["feather"] = p["tolerance"]
    parse_color(p["target_color"])  # 校验
    parse_color(p["light_color"])
    parse_color(p["dark_color"])
    p["connectivity"] = str(p["connectivity"]).lower()
    if p["connectivity"] not in ("edge", "seeds", "seed", "edge_or_seeds",
                                 "any", "off", "global", "all"):
        raise EngineConfigError("未知 connectivity=%r" % p["connectivity"])
    return p


def load_image(path: str) -> ImageData:
    return read_png(path)


# --------------------------------------------------------------------------- #
# 取色
# --------------------------------------------------------------------------- #

def sample_background(img: ImageData, points: Sequence, radius: int = 2,
                      min_alpha: int = 200):
    """对每个取色点的小邻域取通道中位数。

    返回 ``(bg_rgb, point_infos, resolved_points)``。
    邻域内完全没有可见像素（alpha>0）时抛 :class:`InvalidSampleError`。
    """
    w, h = img.width, img.height
    if not points:
        raise InvalidSampleError("没有提供任何背景取色点 sample_points")
    resolved: List[Tuple[int, int]] = []
    infos = []
    all_r: List[int] = []
    all_g: List[int] = []
    all_b: List[int] = []

    for raw in points:
        try:
            x, y = validate_point(raw, w, h, "背景取色点")
        except ValueError as exc:
            raise InvalidSampleError(str(exc), "invalid_sample_point")
        resolved.append((x, y))
        opaque_pool: List[Tuple[int, int, int]] = []
        visible_pool: List[Tuple[int, int, int]] = []
        for yy in range(max(0, y - radius), min(h, y + radius + 1)):
            for xx in range(max(0, x - radius), min(w, x + radius + 1)):
                i = (yy * w + xx) * 4
                a = img.rgba[i + 3]
                if a == 0:
                    continue
                rgb3 = (img.rgba[i], img.rgba[i + 1], img.rgba[i + 2])
                visible_pool.append(rgb3)
                if a >= min_alpha:
                    opaque_pool.append(rgb3)
        pool = opaque_pool if opaque_pool else visible_pool
        if not pool:
            raise InvalidSampleError(
                "取色点 (%d,%d) 周围 %dpx 邻域全部透明，无法取得背景色"
                % (x, y, radius),
                reason_code="invalid_sample_transparent")
        mr = _median([c[0] for c in pool])
        mg = _median([c[1] for c in pool])
        mb = _median([c[2] for c in pool])
        infos.append({
            "point": [x, y],
            "patch_radius": radius,
            "patch_pixels_used": len(pool),
            "patch_visible_pixels": len(visible_pool),
            "sampled_color": rgb_hex((mr, mg, mb)),
        })
        all_r.extend(c[0] for c in pool)
        all_g.extend(c[1] for c in pool)
        all_b.extend(c[2] for c in pool)

    bg = (_median(all_r), _median(all_g), _median(all_b))
    return bg, infos, resolved


def _median(values: Sequence[int]) -> int:
    vals = sorted(values)
    m = len(vals)
    if m % 2:
        return int(vals[m // 2])
    return int((vals[m // 2 - 1] + vals[m // 2]) // 2)


# --------------------------------------------------------------------------- #
# 分析
# --------------------------------------------------------------------------- #

def analyze(img: ImageData, params: Optional[Dict] = None,
             sample_points: Optional[Sequence] = None,
             protect_regions: Optional[Sequence] = None,
             seed_points: Optional[Sequence] = None,
             background_color=None) -> Dict:
    """对图片做完整分析，返回包含全部掩码 / 统计原料的 dict。"""
    p = normalize_params(params)
    w, h = img.width, img.height
    n = w * h
    warnings: List[str] = []

    # 背景色：显式指定优先，否则取色点
    point_infos: List[Dict] = []
    resolved_samples: List[Tuple[int, int]] = []
    if background_color is not None:
        bg4 = parse_color(background_color)
        bg = bg4[:3]
        if sample_points:
            # 仍然校验取色点合法性（无效点必须隔离），但不参与颜色
            _, point_infos, resolved_samples = sample_background(
                img, sample_points, p["sample_radius"], p["sample_min_alpha"])
            for info in point_infos:
                info["note"] = "已显式指定 background_color，取色点仅作校验/种子"
        else:
            point_infos = []
    else:
        if not sample_points:
            raise InvalidSampleError("必须提供 sample_points 或 background_color")
        bg, point_infos, resolved_samples = sample_background(
            img, sample_points, p["sample_radius"], p["sample_min_alpha"])

    # 保护区
    regions = parse_regions(protect_regions or [])
    protect_mask = bytearray(n)
    for r in regions:
        from .masks import rasterize_region
        rasterize_region(r, w, h, protect_mask)
    if regions and sum(protect_mask) == 0:
        warnings.append("所有保护区域光栅化后为空（可能完全位于画面之外）")

    # 种子（seeds 模式默认复用取色点）
    raw_seeds = seed_points if seed_points is not None else sample_points
    resolved_seeds: List[Tuple[int, int]] = []
    seed_indices: List[int] = []
    if raw_seeds:
        for s in raw_seeds:
            try:
                sx, sy = validate_point(s, w, h, "连通种子点")
            except ValueError as exc:
                raise InvalidSampleError(str(exc), "invalid_sample_point")
            resolved_seeds.append((sx, sy))
            seed_indices.append(sy * w + sx)

    # 相似度 + 过渡权重
    w_raw, similar = evaluate(
        img.rgba, bg, p["metric"], p["tolerance"], p["feather"])

    # 种子未落在相似掩码上：提示或严格报错
    missed_seeds = [[sx, sy] for (sx, sy), idx in
                    zip(resolved_seeds, seed_indices) if not similar[idx]]
    if missed_seeds:
        msg = ("以下种子点不在相似背景掩码内（容差过小或点到了产品）: %s"
               % missed_seeds)
        if p["strict_seed"] and p["connectivity"] in ("seeds", "seed"):
            raise InvalidSampleError(msg, reason_code="seed_not_in_similar")
        warnings.append(msg)

    # 连通域
    labels, comps = connected_components(
        similar, w, h, p["neighborhood"], seed_indices)
    selected_ids, ignored_ids = select_components(comps, p["connectivity"])

    selected_mask = bytearray(n)
    final_w = bytearray(n)
    category = bytearray(n)
    for i in range(n):
        cid = labels[i]
        is_selected = bool(cid and cid in selected_ids)
        if is_selected:
            selected_mask[i] = 1
        wv = w_raw[i] if is_selected else 0
        if protect_mask[i]:
            # 保护硬闸门：无论容差 / 过渡 / 连通如何，权重清零
            wv = 0
        final_w[i] = wv
        if wv > 0:
            category[i] = CAT_CHANGED
        elif protect_mask[i] and similar[i]:
            category[i] = CAT_PROTECTED_SIMILAR
        elif similar[i] and cid and cid not in selected_ids:
            category[i] = CAT_DISCONNECTED_SIMILAR

    disconnected_comps = [c for c in comps if c["id"] in set(ignored_ids)]
    selected_comps = [c for c in comps if c["id"] in selected_ids]

    return {
        "params": p,
        "width": w,
        "height": h,
        "background": list(bg),
        "background_hex": rgb_hex(bg),
        "sample_infos": point_infos,
        "sample_points": [[x, y] for x, y in resolved_samples],
        "seed_points": [[x, y] for x, y in resolved_seeds],
        "regions": regions,
        "protect_mask": protect_mask,
        "w_raw": w_raw,
        "similar": similar,
        "labels": labels,
        "components": comps,
        "selected_ids": sorted(selected_ids),
        "ignored_ids": sorted(ignored_ids),
        "selected_components": selected_comps,
        "disconnected_components": disconnected_comps,
        "selected_mask": selected_mask,
        "final_w": final_w,
        "category": category,
        "warnings": warnings,
    }


def render_recolor(img: ImageData, analysis: Dict,
                   target_color=None) -> ImageData:
    p = analysis["params"]
    target = parse_color(target_color or p["target_color"])[:3]
    out_rgba = apply_recolor(img.rgba, analysis["final_w"], target)
    return ImageData(img.width, img.height, out_rgba)


# --------------------------------------------------------------------------- #
# 统计
# --------------------------------------------------------------------------- #

def compute_counts(before: ImageData, after: ImageData, analysis: Dict) -> Dict:
    rgba0 = before.rgba
    rgba1 = after.rgba
    n = before.width * before.height
    final_w = analysis["final_w"]
    similar = analysis["similar"]
    protect = analysis["protect_mask"]
    category = analysis["category"]

    transparent = semi = opaque = 0
    changed = changed_semi = changed_opaque = 0
    affected_semi = affected_opaque = 0
    affected_weight = 0.0
    sum_r0 = sum_g0 = sum_b0 = 0
    sum_r1 = sum_g1 = sum_b1 = 0
    visible = 0
    protected_count = 0
    protected_similar = 0
    disconnected_pixels = 0
    changed_transparent_violations = 0

    for i in range(n):
        j = i * 4
        a = rgba0[j + 3]
        if a == 0:
            transparent += 1
            if rgba0[j:j + 4] != rgba1[j:j + 4]:
                changed_transparent_violations += 1
            continue
        visible += 1
        r0, g0, b0 = rgba0[j], rgba0[j + 1], rgba0[j + 2]
        sum_r0 += r0
        sum_g0 += g0
        sum_b0 += b0
        sum_r1 += rgba1[j]
        sum_g1 += rgba1[j + 1]
        sum_b1 += rgba1[j + 2]

        if a >= 255:
            opaque += 1
        else:
            semi += 1

        if protect[i]:
            protected_count += 1
            if similar[i]:
                protected_similar += 1
        if category[i] == CAT_DISCONNECTED_SIMILAR:
            disconnected_pixels += 1

        wv = final_w[i]
        if wv:
            affected_weight += wv / 255.0
            if a >= 255:
                affected_opaque += 1
            else:
                affected_semi += 1

        if rgba0[j:j + 4] != rgba1[j:j + 4]:
            changed += 1
            if a >= 255:
                changed_opaque += 1
            else:
                changed_semi += 1

    comps = analysis["components"]
    selected_ids = set(analysis["selected_ids"])
    disc = [c for c in comps if c["id"] not in selected_ids]

    counts = {
        "total_pixels": n,
        "visible_pixels": visible,
        "fully_transparent_pixels": transparent,
        "semitransparent_pixels": semi,
        "opaque_pixels": opaque,
        "similar_pixels": sum(similar),
        "selected_component_count": len(analysis["selected_ids"]),
        "similar_component_count": len(comps),
        "disconnected_component_count": len(disc),
        "disconnected_similar_pixels": disconnected_pixels,
        "protected_region_pixels": protected_count,
        "protected_similar_pixels": protected_similar,
        "affected_area_pixel_equiv": round(affected_weight, 2),
        "affected_pixels_weight_positive": affected_opaque + affected_semi,
        "affected_opaque_pixels": affected_opaque,
        "affected_semitransparent_pixels": affected_semi,
        "changed_pixels_exact": changed,
        "changed_opaque_pixels": changed_opaque,
        "changed_semitransparent_pixels": changed_semi,
        "changed_transparent_violations": changed_transparent_violations,
        "changed_ratio_of_visible": round(changed / visible, 6) if visible else 0.0,
        "mean_rgb_visible_before": [
            round(sum_r0 / visible, 2) if visible else 0,
            round(sum_g0 / visible, 2) if visible else 0,
            round(sum_b0 / visible, 2) if visible else 0,
        ],
        "mean_rgb_visible_after": [
            round(sum_r1 / visible, 2) if visible else 0,
            round(sum_g1 / visible, 2) if visible else 0,
            round(sum_b1 / visible, 2) if visible else 0,
        ],
    }
    return counts


def compute_edge_metrics(comp_before: bytearray, comp_after: bytearray,
                         img: ImageData, analysis: Dict) -> Dict:
    """深浅底合成图上，半透明且接近背景的边缘带的平均色偏移。"""
    n = img.width * img.height
    total_d = 0.0
    count = 0
    max_d = 0.0
    for i in range(n):
        j4 = i * 4
        a = img.rgba[j4 + 3]
        if not (0 < a < 255 and analysis["similar"][i]):
            continue
        k = i * 3
        dr = comp_after[k] - comp_before[k]
        dg = comp_after[k + 1] - comp_before[k + 1]
        db = comp_after[k + 2] - comp_before[k + 2]
        d = (dr * dr + dg * dg + db * db) ** 0.5
        total_d += d
        count += 1
        if d > max_d:
            max_d = d
    return {
        "edge_band_pixels": count,
        "edge_mean_shift": round(total_d / count, 3) if count else 0.0,
        "edge_max_shift": round(max_d, 3),
    }
