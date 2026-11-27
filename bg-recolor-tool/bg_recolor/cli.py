"""命令行接口：

* ``python3 -m bg_recolor batch <config.json> [--out DIR] [--only ID]``
* ``python3 -m bg_recolor process IMAGE --sample x,y ... --target '#2F6FDB'``
* ``python3 -m bg_recolor make-fixtures [--dir examples]``
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict, List, Optional

from . import __version__
from .pipeline import run_batch
from .synthetic import generate_all


def _parse_xy(text: str):
    parts = text.split(",")
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("坐标格式应为 x,y，得到 %r" % text)
    try:
        return [float(parts[0]), float(parts[1])]
    except ValueError:
        raise argparse.ArgumentTypeError("坐标必须是数字: %r" % text)


def _parse_rect(text: str):
    parts = text.split(",")
    if len(parts) != 4:
        raise argparse.ArgumentTypeError("矩形格式应为 x0,y0,x1,y1")
    try:
        return {"type": "rect", "xyxy": [float(v) for v in parts]}
    except ValueError:
        raise argparse.ArgumentTypeError("矩形坐标必须是数字")


def _parse_poly(text: str):
    points = []
    for pair in text.split(";"):
        bits = pair.split(",")
        if len(bits) != 2:
            raise argparse.ArgumentTypeError("多边形格式 x,y;x,y;...")
        points.append([float(bits[0]), float(bits[1])])
    return {"type": "polygon", "points": points}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="bg_recolor",
        description="本地批量 PNG 背景换色 + 影响范围回看工具（核心零第三方依赖）")
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("batch", help="按 JSON 配置批量处理")
    b.add_argument("config", help="批量配置 JSON 路径")
    b.add_argument("--out", help="覆盖配置中的 output_dir")
    b.add_argument("--only", help="只处理指定 id（调试用）")

    p = sub.add_parser("process", help="处理单张图片")
    p.add_argument("image", help="PNG 路径")
    p.add_argument("--sample", action="append", type=_parse_xy, default=[],
                   help="背景取色点 x,y，可重复；seeds 模式下默认兼作种子")
    p.add_argument("--seed", action="append", type=_parse_xy, default=[],
                   help="额外连通种子点 x,y，可重复")
    p.add_argument("--protect-rect", action="append", type=_parse_rect, default=[],
                   help="保护矩形 x0,y0,x1,y1，可重复")
    p.add_argument("--protect-poly", action="append", type=_parse_poly, default=[],
                   help="保护多边形 x,y;x,y;...，可重复")
    p.add_argument("--target", default="#2E6FDB", help="新背景色，如 #2F6FDB")
    p.add_argument("--background-color", default=None,
                   help="显式指定背景色（不取色时）")
    p.add_argument("--tolerance", type=float, default=60.0)
    p.add_argument("--feather", type=float, default=24.0)
    p.add_argument("--metric", choices=["redmean", "rgb", "max"], default="redmean")
    p.add_argument("--connectivity",
                   choices=["edge", "seeds", "edge_or_seeds", "off"],
                   default="edge")
    p.add_argument("--neighborhood", type=int, choices=[4, 8], default=4)
    p.add_argument("--sample-radius", type=int, default=2)
    p.add_argument("--strict-seed", action="store_true",
                   help="种子未落在相似掩码内时直接判该图无效并隔离")
    p.add_argument("--out", default="bg_recolor_output")
    p.add_argument("--id", default=None)

    f = sub.add_parser("make-fixtures", help="生成合成验证图与示例配置")
    f.add_argument("--dir", default="examples", help="输出目录（默认 examples）")
    return parser


def _print_batch_summary(batch: Dict) -> None:
    s = batch["summary"]
    print("")
    print("=" * 68)
    print("批处理完成：共 %d 张，成功 %d，隔离/失败 %d"
          % (s["total"], s["ok"], s["error"]))
    print("报告：%s" % os.path.join(batch["output_dir"], "report.html"))
    print("      %s" % os.path.join(batch["output_dir"], "report.md"))
    for it in batch["items"]:
        if it.get("status") == "ok":
            c = it["counts"]
            print("  ✅ %-28s 变化 %7d px | 断开同色域 %d | 保护相似 %d px"
                  % (it["id"], c["changed_pixels_exact"],
                     c["disconnected_component_count"],
                     c["protected_similar_pixels"]))
        else:
            err = it.get("error", {})
            print("  ❌ %-28s [%s] %s"
                  % (it["id"], err.get("reason_code"), err.get("message")))
    print("=" * 68)


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "make-fixtures":
        paths = generate_all(args.dir)
        print("已生成 %d 个文件到 %s：" % (len(paths), args.dir))
        for p in paths:
            print("  -", p)
        return 0

    if args.command == "batch":
        if not os.path.isfile(args.config):
            print("配置文件不存在: %s" % args.config, file=sys.stderr)
            return 1
        try:
            batch = run_batch(args.config, output_override=args.out, only=args.only)
        except (ValueError, json.JSONDecodeError) as exc:
            print("配置无法加载: %s" % exc, file=sys.stderr)
            return 1
        _print_batch_summary(batch)
        return 0 if batch["summary"]["error"] == 0 else 2

    if args.command == "process":
        image_abs = os.path.abspath(args.image)
        if not os.path.isfile(image_abs):
            print("图片不存在: %s" % image_abs, file=sys.stderr)
            return 1
        protect = list(args.protect_rect) + list(args.protect_poly)
        item = {
            "id": args.id,
            "path": image_abs,
            "sample_points": args.sample or None,
            "seeds": args.seed or None,
            "protect": protect,
            "target_color": args.target,
            "background_color": args.background_color,
            "tolerance": args.tolerance,
            "feather": args.feather,
            "metric": args.metric,
            "connectivity": args.connectivity,
            "neighborhood": args.neighborhood,
            "sample_radius": args.sample_radius,
            "strict_seed": args.strict_seed,
        }
        if not args.sample and not args.background_color:
            print("至少需要一个 --sample x,y 或 --background-color", file=sys.stderr)
            return 1
        # 单图模式：路径给绝对路径，base_dir=/ 即可；输出目录按 cwd 解析
        cfg = {"output_dir": args.out, "images": [item],
               "_config_dir": os.getcwd()}
        batch = run_batch(config_dict=cfg)
        _print_batch_summary(batch)
        return 0 if batch["summary"]["error"] == 0 else 2

    parser.error("未知命令")
    return 1  # pragma: no cover


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
