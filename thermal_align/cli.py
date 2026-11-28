"""命令行入口。

子命令：

- ``align``    读入可见光/红外/点表，输出对齐 16 位图、覆盖掩模、彩色叠图与诊断
- ``preview``  仅按给定热值范围重渲染预览（不改动已对齐的 16 位图）
- ``sample``   生成棋盘/角标合成样例（normal / no-overlap / bad-point）
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path

import numpy as np

from . import __version__
from .colormap import PALETTES
from .geometry import (
    RegistrationError,
    build_report,
    coverage_ratio,
    fit_affine,
    holdout_errors,
)
from .imaging import (
    ImageLoadError,
    load_thermal,
    load_visible,
    save_mask_uint8,
    save_rgb,
    save_thermal_uint16,
)
from .overlay import blend_overlay, effective_value_range, render_preview_only
from .points import PointTableError, load_points, split_points
from .samplegen import generate_sample
from .warp import DEFAULT_SENTINEL, WarpError, count_effective_zeros, count_outside, warp_thermal


def _print_header(title: str) -> None:
    print(f"\n=== {title} ===")


def _print_report(report, holdout) -> None:
    print(f"拟合控制点 : {report.n_fit} 个")
    if report.dropped:
        print(f"自动剔除点 : {', '.join(report.dropped)}")
    print(f"条件数     : {report.condition_number:.3e}（越大控制点分布越差）")
    print(f"行列式     : {report.determinant:.6f}")
    print(
        f"拟合残差   : RMS={report.rms_residual:.4f}px, "
        f"最大={report.max_residual:.4f}px @ {report.max_residual_label}"
    )
    for label, residual in report.per_point:
        print(f"  - {label:>8s}: {residual:8.4f} px")
    for warning in report.warnings:
        print(f"[警告] {warning}")
    if holdout:
        print("独立检查点（未参与拟合）:")
        for label, error, actual, predicted in holdout:
            print(
                f"  - {label:>8s}: 偏差 {error:8.4f} px "
                f"(实测 ir=({actual[0]:.2f},{actual[1]:.2f}), "
                f"预测 ir=({predicted[0]:.2f},{predicted[1]:.2f}))"
            )
        worst = max(item[1] for item in holdout)
        print(f"holdout 最大偏差: {worst:.4f} px")
    else:
        print("独立检查点 : 无（可在点表 use 列标记 holdout 点做独立验证）")


def cmd_align(args: argparse.Namespace) -> int:
    try:
        points = load_points(args.points)
        visible = load_visible(args.visible)
        thermal = load_thermal(args.thermal)
    except (PointTableError, ImageLoadError, FileNotFoundError) as exc:
        print(f"[输入错误] {exc}", file=sys.stderr)
        return 2

    fit_points, holdout_points = split_points(points)
    print(
        f"读入 {len(points)} 个对应点（拟合 {len(fit_points)} / "
        f"独立检查 {len(holdout_points)}）"
    )
    print(
        f"可见光 {visible.shape[1]}x{visible.shape[0]} RGB；"
        f"红外 {thermal.shape[1]}x{thermal.shape[0]} uint16"
    )

    try:
        model = fit_affine(points, drop_outliers=args.drop_outliers)
        report = build_report(model)
        holdout = holdout_errors(model, holdout_points)
    except RegistrationError as exc:
        print(f"\n[配准失败] {exc}", file=sys.stderr)
        print("未生成任何输出文件——避免把错位结果当成交付物。", file=sys.stderr)
        return 3

    _print_header("拟合诊断")
    _print_report(report, holdout)

    try:
        result = warp_thermal(
            thermal, model, visible.shape[:2], sentinel=args.sentinel
        )
    except WarpError as exc:
        print(f"\n[叠图失败] {exc}", file=sys.stderr)
        return 4

    coverage = coverage_ratio(model, visible.shape[:2], thermal.shape)
    zeros = count_effective_zeros(result)
    outside = count_outside(result)
    vmin, vmax = effective_value_range(result)
    _print_header("覆盖与取值")
    print(f"有效覆盖率 : {coverage * 100:.2f}%")
    print(f"范围外像素 : {outside}（掩模=0，16 位图写哨兵 {int(result.sentinel)}）")
    print(f"有效零值   : {zeros} 个（掩模=1 的真实 0，与范围外严格区分）")
    print(f"有效热值域 : [{vmin}, {vmax}]")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = args.name
    aligned_path = out_dir / f"{stem}_aligned_uint16.png"
    mask_path = out_dir / f"{stem}_coverage_mask.png"
    overlay_path = out_dir / f"{stem}_overlay.png"
    preview_path = out_dir / f"{stem}_preview.png"
    meta_path = out_dir / f"{stem}_meta.json"

    save_thermal_uint16(aligned_path, result.aligned)
    save_mask_uint8(mask_path, result.mask)

    overlay = blend_overlay(
        visible,
        result,
        vmin=args.vmin,
        vmax=args.vmax,
        alpha=args.alpha,
        palette=args.palette,
    )
    save_rgb(overlay_path, overlay)
    preview = render_preview_only(
        result, vmin=args.vmin, vmax=args.vmax, palette=args.palette
    )
    save_rgb(preview_path, preview)

    meta = {
        "tool": "thermal_align",
        "version": __version__,
        "inputs": {
            "visible": str(args.visible),
            "thermal": str(args.thermal),
            "points": str(args.points),
        },
        "canvas": {"height": visible.shape[0], "width": visible.shape[1]},
        "transform_vis_to_ir": {
            "matrix": model.matrix.tolist(),
            "translation": model.translation.tolist(),
            "determinant": report.determinant,
            "condition_number": report.condition_number,
        },
        "fit": {
            "rms_residual_px": report.rms_residual,
            "max_residual_px": report.max_residual,
            "max_residual_label": report.max_residual_label,
            "dropped": report.dropped,
            "per_point_residual_px": dict(report.per_point),
        },
        "holdout": [
            {
                "label": label,
                "error_px": error,
                "ir_actual": actual,
                "ir_predicted": predicted,
            }
            for label, error, actual, predicted in holdout
        ],
        "coverage": {
            "ratio": result.coverage,
            "effective_zero_pixels": zeros,
            "outside_pixels": outside,
            "sentinel_value": int(result.sentinel),
            "note": "掩模 True 且值为 0 是有效零值；掩模 False 为范围外（哨兵占位）",
        },
        "display_only": {
            "vmin": args.vmin if args.vmin is not None else vmin,
            "vmax": args.vmax if args.vmax is not None else vmax,
            "alpha": args.alpha,
            "palette": args.palette,
            "note": "热值范围只影响预览/叠图配色，aligned uint16 保存的是原始热值",
        },
        "outputs": {
            "aligned_uint16": str(aligned_path),
            "coverage_mask": str(mask_path),
            "overlay": str(overlay_path),
            "preview": str(preview_path),
        },
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    _print_header("输出文件")
    for path in (aligned_path, mask_path, overlay_path, preview_path, meta_path):
        print(f"  {path}")
    print(
        "\n提示：预览热值范围可用 preview 子命令调整重渲染，"
        "对齐 16 位图不会被修改。"
    )
    return 0


def cmd_preview(args: argparse.Namespace) -> int:
    try:
        aligned = load_thermal(args.aligned)
        if args.points:
            load_points(args.points)  # 仅校验点表可读，渲染不依赖它
        visible = load_visible(args.visible) if args.visible else None
    except (PointTableError, ImageLoadError, FileNotFoundError) as exc:
        print(f"[输入错误] {exc}", file=sys.stderr)
        return 2

    # 哨兵值解析优先级：显式 --sentinel > meta.json 记录 > 默认 65535。
    # 这一步很关键：align 自动挑选的哨兵不一定是 65535，
    # 推断掩模时必须用真实哨兵，否则会把有效像素误判成范围外。
    meta_sentinel = None
    if args.meta is not None:
        try:
            meta_data = json.loads(Path(args.meta).read_text(encoding="utf-8"))
            meta_sentinel = int(meta_data["coverage"]["sentinel_value"])
        except (OSError, KeyError, ValueError) as exc:
            print(f"[输入错误] 无法从 meta 读取哨兵值: {exc}", file=sys.stderr)
            return 2
    if args.sentinel is not None:
        sentinel = int(args.sentinel)
    elif meta_sentinel is not None:
        sentinel = meta_sentinel
    else:
        sentinel = int(DEFAULT_SENTINEL)

    if args.mask is not None:
        from PIL import Image

        with Image.open(args.mask) as im:
            mask = np.array(im.convert("L"), dtype=np.uint8) > 127
    else:
        # 未提供掩模时，按哨兵值所在像素推断范围外
        mask = aligned != np.uint16(sentinel)

    if mask.shape != aligned.shape:
        print("[输入错误] 掩模与对齐图尺寸不一致", file=sys.stderr)
        return 2

    from .warp import WarpResult

    result = WarpResult(
        aligned=aligned,
        mask=mask,
        sentinel=np.uint16(sentinel),
        coverage=float(mask.mean()),
    )
    try:
        if visible is not None:
            image = blend_overlay(
                visible,
                result,
                vmin=args.vmin,
                vmax=args.vmax,
                alpha=args.alpha,
                palette=args.palette,
            )
        else:
            image = render_preview_only(
                result, vmin=args.vmin, vmax=args.vmax, palette=args.palette
            )
    except (ValueError, KeyError) as exc:
        print(f"[预览错误] {exc}", file=sys.stderr)
        return 4

    out_path = Path(args.output)
    save_rgb(out_path, image)
    vmin, vmax = effective_value_range(result)
    print(f"已渲染预览: {out_path}")
    print(
        f"显示范围 vmin={args.vmin if args.vmin is not None else vmin}, "
        f"vmax={args.vmax if args.vmax is not None else vmax}；"
        "对齐 16 位图未做任何修改"
    )
    return 0


def cmd_sample(args: argparse.Namespace) -> int:
    spec = generate_sample(args.out_dir, scenario=args.scenario)
    print(f"场景       : {spec.scenario}")
    print(f"说明       : {spec.notes}")
    print(f"可见光样例 : {spec.visible_png}")
    print(f"红外 16 位 : {spec.thermal_png}")
    print(f"对应点表   : {spec.points_csv}")
    print(f"holdout 点 : {', '.join(spec.holdout_labels)}（不参与拟合）")
    print("真值仿射矩阵 M (vis->ir):")
    print(spec.ground_truth_matrix)
    print("真值平移 t:", spec.ground_truth_translation)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="thermal-align",
        description="基于用户对应点的红外/可见光本地配准与叠图工具",
    )
    parser.add_argument("--version", action="version", version=__version__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_align = sub.add_parser("align", help="配准并导出对齐图/掩模/叠图")
    p_align.add_argument("--visible", required=True, type=Path, help="可见光 PNG 路径")
    p_align.add_argument("--thermal", required=True, type=Path, help="16 位灰度红外 PNG 路径")
    p_align.add_argument("--points", required=True, type=Path, help="对应点表 CSV/TSV 路径")
    p_align.add_argument("--out-dir", default="output", type=Path, help="输出目录")
    p_align.add_argument("--name", default="pair", help="输出文件名前缀")
    p_align.add_argument("--vmin", type=float, default=None, help="预览热值下限（仅影响显示）")
    p_align.add_argument("--vmax", type=float, default=None, help="预览热值上限（仅影响显示）")
    p_align.add_argument("--alpha", type=float, default=0.5, help="叠图热图透明度 0~1")
    p_align.add_argument("--palette", choices=sorted(PALETTES), default="iron")
    p_align.add_argument(
        "--sentinel", type=int, default=None,
        help="范围外哨兵值，默认自动挑选热图中未出现的 16 位值（优先 65535）",
    )
    p_align.add_argument(
        "--drop-outliers", action="store_true",
        help="自动剔除残差异常的坏控制点后重拟合（默认遇坏点直接失败）",
    )
    p_align.set_defaults(func=cmd_align)

    p_preview = sub.add_parser("preview", help="只调整热值范围重渲染预览，不改对齐图")
    p_preview.add_argument("--aligned", required=True, type=Path, help="已对齐的 16 位 PNG")
    p_preview.add_argument("--points", type=Path, default=None, help="可选：原对应点表（仅留档，不参与渲染）")
    p_preview.add_argument("--meta", type=Path, default=None, help="可选：align 产出的 meta.json，用于读取真实哨兵值")
    p_preview.add_argument("--mask", type=Path, default=None, help="覆盖掩模 PNG（缺省按哨兵值推断）")
    p_preview.add_argument("--visible", type=Path, default=None, help="可选：可见光底图")
    p_preview.add_argument("--output", required=True, type=Path, help="预览输出 PNG")
    p_preview.add_argument("--vmin", type=float, default=None)
    p_preview.add_argument("--vmax", type=float, default=None)
    p_preview.add_argument("--alpha", type=float, default=0.5)
    p_preview.add_argument("--palette", choices=sorted(PALETTES), default="iron")
    p_preview.add_argument("--sentinel", type=int, default=None)
    p_preview.set_defaults(func=cmd_preview)

    p_sample = sub.add_parser("sample", help="生成棋盘/角标合成样例")
    p_sample.add_argument("--out-dir", default=Path("sample_data"), type=Path)
    p_sample.add_argument(
        "--scenario",
        choices=["normal", "no-overlap", "bad-point"],
        default="normal",
    )
    p_sample.set_defaults(func=cmd_sample)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except KeyboardInterrupt:
        print("\n已中断", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
