"""命令行入口: 生成各方案 PNG、命中范围图与统计报告。

用法:
    python -m color_proof.cli input.png palettes.json out_dir/ [--only s1,s2]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .config import load_config
from .engine import ProofResult, apply_scheme
from .pngio import Image, read_png, write_png

# 命中范围可视化时, 各规则循环使用的标记色(高饱和、彼此区分度高)
MARKER_COLORS = (
    (230, 25, 75),
    (60, 180, 75),
    (0, 130, 200),
    (245, 130, 48),
    (145, 30, 180),
    (70, 240, 240),
    (240, 50, 230),
    (210, 245, 60),
    (250, 190, 190),
    (0, 128, 128),
)


def build_hitmap(
    image: Image,
    result: ProofResult,
    rule_order: tuple[str, ...],
) -> Image:
    """命中范围图: 未命中像素 RGB 压暗到 25%, 命中像素按获胜规则染标记色;
    多规则重叠的像素染白色。alpha 通道全程保留, 软边轮廓同样可见。"""
    color_of = {rid: MARKER_COLORS[idx % len(MARKER_COLORS)]
                for idx, rid in enumerate(rule_order)}
    rgba = bytearray(image.rgba)
    n = image.width * image.height
    for i in range(n):
        rid = result.winner[i]
        if rid is None:
            rgba[i * 4] //= 4
            rgba[i * 4 + 1] //= 4
            rgba[i * 4 + 2] //= 4
            continue
        m = (255, 255, 255) if i in result.overlap_indexes else color_of[rid]
        rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2] = m
    return Image(width=image.width, height=image.height, rgba=rgba)


def _result_to_dict(result: ProofResult, rule_order: tuple[str, ...]) -> dict:
    return {
        "fully_transparent_excluded": result.fully_transparent,
        "protected_pixels": result.protected_pixels,
        "unchanged_pixels": result.unchanged,
        "rules": [
            result.stats[rid].as_dict()
            for rid in rule_order if rid in result.stats
        ],
        "hit_bbox": {
            rid: dict(zip(("x0", "y0", "x1", "y1"), bbox))
            for rid, bbox in sorted(result.hit_bbox.items())
        },
        "overlaps_sample": [
            {
                "pixel_index": idx,
                "x": idx % result.image.width,
                "y": idx // result.image.width,
                "candidate_rules": ids,
                "winner": ids[0],
            }
            for idx, ids in result.overlaps
        ],
        "overlap_note": "overlaps_sample 为采样(默认上限 20), contested 计数为全量",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="本地 RGBA PNG 配色试样工具: 按配色 JSON 输出各方案、命中范围与统计"
    )
    parser.add_argument("input_png", help="原始 RGBA/RGB PNG 路径")
    parser.add_argument("palettes_json", help="配色规则 JSON 路径")
    parser.add_argument("out_dir", help="输出目录(自动创建)")
    parser.add_argument("--only", default="", help="只生成指定方案, 逗号分隔 id")
    parser.add_argument(
        "--overlap-limit", type=int, default=20,
        help="重叠明细采样上限(全量 contested 计数不受影响), 默认 20",
    )
    args = parser.parse_args(argv)

    config = load_config(args.palettes_json)
    image = read_png(args.input_png)
    os.makedirs(args.out_dir, exist_ok=True)

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    unknown = only - set(config.schemes)
    if unknown:
        parser.error(f"--only 中的方案不存在: {sorted(unknown)}")

    report = {"input": os.path.abspath(args.input_png), "schemes": {}}
    lines = [f"输入: {args.input_png} ({image.width}x{image.height})"]

    for sid, scheme in config.schemes.items():
        if only and sid not in only:
            continue
        result = apply_scheme(
            image, scheme.rules, config.matte,
            protected_regions=config.protected,
            overlap_limit=args.overlap_limit,
        )
        result.scheme_id = sid
        rule_order = tuple(r.id for r in scheme.rules)

        out_png = os.path.join(args.out_dir, f"{sid}.png")
        write_png(out_png, result.image)

        hitmap = build_hitmap(image, result, rule_order)
        hitmap_path = os.path.join(args.out_dir, f"{sid}_hitmap.png")
        write_png(hitmap_path, hitmap)

        stats = _result_to_dict(result, rule_order)
        stats["output"] = os.path.abspath(out_png)
        stats["hitmap"] = os.path.abspath(hitmap_path)
        report["schemes"][sid] = stats

        lines.append("")
        lines.append(f"方案 {sid} ({scheme.name}) -> {out_png}")
        for rid in rule_order:
            st = result.stats[rid]
            lines.append(
                f"  {rid:<16} 替换 {st.matched:>6} px | 被抢 {st.contested:>4} px"
                f" | 原色范围 {st.min_rgb}..{st.max_rgb}"
            )
        lines.append(
            f"  未命中 {result.unchanged} | 保护区 {result.protected_pixels}"
            f" | 全透明(不计) {result.fully_transparent}"
            f" | 重叠像素 {len(result.overlap_indexes)}"
        )

    stats_path = os.path.join(args.out_dir, "stats.json")
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    lines.append("")
    lines.append(f"统计报告: {stats_path}")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())
