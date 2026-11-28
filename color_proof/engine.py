"""替色引擎: 在原始图上一次性评估全部规则, 再做确定性裁决。

确定性保证
----------
1. 所有规则都对 *原始像素* 计算距离, 上一条规则的替换结果绝不参与下一条匹配;
2. 一像素命中多条规则时, 取 priority 最大者; 同优先级按规则 id 字典序,
   结果与 JSON 里规则的排列顺序无关;
3. 替换保留原 alpha, 仅改 RGB; 软边像素在直色空间换色后用同一 matte 重新合成,
   透明边不会露出旧背景色;
4. alpha=0 的像素不参与匹配与任何统计。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .color_math import distance2, matte, unmatte
from .config import Rule, build_protection_mask
from .pngio import Image


@dataclass
class RuleStats:
    rule_id: str
    matched: int = 0          # 命中且最终由本规则替换的像素数
    contested: int = 0        # 命中但被更高优先级(或 id 序)规则抢走的像素数
    # 被本规则替换像素在 *原图直色空间* 的范围, 便于人工核对容差圈
    min_rgb: tuple[int, int, int] | None = None
    max_rgb: tuple[int, int, int] | None = None

    def as_dict(self) -> dict:
        return {
            "rule_id": self.rule_id,
            "matched": self.matched,
            "contested": self.contested,
            "source_range": {
                "min": list(self.min_rgb) if self.min_rgb else None,
                "max": list(self.max_rgb) if self.max_rgb else None,
            },
        }


@dataclass
class ProofResult:
    scheme_id: str
    image: Image
    stats: dict[str, RuleStats]
    unchanged: int                 # 未被任何规则命中的不透明/半透明像素
    fully_transparent: int         # alpha=0 像素数(不纳入统计)
    protected_pixels: int          # 落在保护区内、不参与匹配的像素数
    # 每个像素最终由哪条规则处理; None 表示未命中/透明/受保护
    winner: list[str | None] = field(default_factory=list)
    overlap_indexes: set[int] = field(default_factory=set)
    # 每个像素最终由哪条规则处理: b"..." 定长字节数组, 未命中为 b""
    # 同时提供命中范围(坐标包围盒)便于输出
    hit_bbox: dict[str, tuple[int, int, int, int]] = field(default_factory=dict)
    # 重叠明细: (像素索引, 命中规则 id 列表) 只在发生重叠时记录, 带采样上限
    overlaps: list[tuple[int, list[str]]] = field(default_factory=list)


def _update_bbox(bbox, width: int, index: int) -> tuple[int, int, int, int]:
    x, y = index % width, index // width
    if bbox is None:
        return (x, y, x, y)
    x0, y0, x1, y1 = bbox
    return (min(x0, x), min(y0, y), max(x1, x), max(y1, y))


def apply_scheme(
    image: Image,
    rules: tuple[Rule, ...],
    matte_rgb: tuple[int, int, int] | None,
    protected_regions=(),
    overlap_limit: int = 20,
) -> ProofResult:
    """对一张原图应用一个方案, 返回替色结果图与统计。

    引擎内部按 (-priority, id) 重排规则, 调用方传入的排列顺序不影响结果。
    """
    width, height = image.width, image.height
    n = width * height
    src = image.rgba

    # 裁决序只认 (-priority, id), 与传入顺序无关; config 层已排过一次,
    # 这里再排一次保证直接调用引擎的库使用者也得到确定结果。
    rules = tuple(sorted(rules, key=lambda r: (-r.priority, r.id)))

    protection = (
        build_protection_mask(protected_regions, width, height)
        if protected_regions
        else bytearray(n)
    )
    protected_count = sum(protection)

    # 预算每个非透明像素的直色(unmatte 只做一次, 全部规则共享这份原始取样)
    straight = [None] * n  # type: list[tuple[int, int, int] | None]
    for i in range(n):
        a = src[i * 4 + 3]
        if a == 0:
            continue
        straight[i] = unmatte(
            src[i * 4], src[i * 4 + 1], src[i * 4 + 2], a, matte_rgb
        ).rgb

    stats = {r.id: RuleStats(r.id) for r in rules}
    winner: list[str | None] = [None] * n
    winner_target: list[tuple[int, int, int] | None] = [None] * n
    fully_transparent = 0
    overlaps: list[tuple[int, list[str]]] = []
    overlap_indexes: set[int] = set()

    # 逐规则、对全部原始像素评估。规则之间不共享中间结果, 杜绝链式污染。
    for rule in rules:
        tol_sq = rule.tolerance_sq
        source = rule.source
        metric = rule.metric
        for i in range(n):
            rgb = straight[i]
            if rgb is None or protection[i]:
                continue
            if distance2(rgb, source, metric) <= tol_sq:
                cur = winner[i]
                if cur is None:
                    winner[i] = rule.id
                    winner_target[i] = rule.target
                else:
                    # 已命中过: rules 按 (-priority, id) 排序, 先到者即赢家,
                    # 后来者只计入 contested, 结果与规则排列顺序无关。
                    overlap_indexes.add(i)
                    if len(overlaps) < overlap_limit:
                        recorded = next(
                            (ov for ov in overlaps if ov[0] == i), None
                        )
                        if recorded is None:
                            overlaps.append((i, [cur, rule.id]))
                        else:
                            recorded[1].append(rule.id)
                    stats[rule.id].contested += 1

    # 汇总赢家统计 + 命中范围
    hit_bbox: dict[str, tuple[int, int, int, int]] = {}
    unchanged = 0
    for i in range(n):
        if straight[i] is None:
            fully_transparent += 1
            continue
        rid = winner[i]
        if rid is None:
            if not protection[i]:
                unchanged += 1
            continue
        st = stats[rid]
        st.matched += 1
        rgb = straight[i]
        assert rgb is not None
        if st.min_rgb is None:
            st.min_rgb = rgb
            st.max_rgb = rgb
        else:
            st.min_rgb = tuple(min(a, b) for a, b in zip(st.min_rgb, rgb))  # type: ignore[assignment]
            st.max_rgb = tuple(max(a, b) for a, b in zip(st.max_rgb, rgb))  # type: ignore[assignment]
        hit_bbox[rid] = _update_bbox(hit_bbox.get(rid), width, i)

    # 生成输出: 只改 RGB, alpha 原样保留; 软边重新 matte
    out = bytearray(src)  # 完整拷贝, 透明像素与未命中像素字节不变
    for i in range(n):
        rid = winner[i]
        if rid is None:
            continue
        a = src[i * 4 + 3]
        target = winner_target[i]
        assert target is not None
        new_rgb = matte(target[0], target[1], target[2], a, matte_rgb)
        out[i * 4] = new_rgb[0]
        out[i * 4 + 1] = new_rgb[1]
        out[i * 4 + 2] = new_rgb[2]
        # alpha 通道不动

    return ProofResult(
        scheme_id="",
        image=Image(width=width, height=height, rgba=out),
        stats=stats,
        unchanged=unchanged,
        fully_transparent=fully_transparent,
        protected_pixels=protected_count,
        winner=winner,
        overlap_indexes=overlap_indexes,
        hit_bbox=hit_bbox,
        overlaps=overlaps,
    )
