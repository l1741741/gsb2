"""彩色叠图与可调热值范围预览。

叠图 = 可见光底图 + 有效覆盖区内的伪彩热图（按 alpha 混合）。
热值范围 (vmin, vmax) 仅决定伪彩归一化，改变它只会重新渲染预览，
对齐后的 16 位图由独立流程写出、不受影响——两个流程不共享可变数据。
"""

from __future__ import annotations

import numpy as np

from .colormap import colorize
from .warp import WarpResult


def blend_overlay(
    visible: np.ndarray,
    result: WarpResult,
    *,
    vmin: float | None = None,
    vmax: float | None = None,
    alpha: float = 0.5,
    palette: str = "iron",
) -> np.ndarray:
    """生成 (H, W, 3) uint8 叠图。

    - 画布尺寸与可见光图一致；
    - 有效覆盖区按 ``alpha`` 混合伪彩热图，范围外保持可见光原样；
    - ``alpha`` 限制在 [0, 1]；``vmin/vmax`` 不改变任何热值。
    """
    if visible.ndim != 3 or visible.shape[2] != 3:
        raise ValueError("visible 必须是 (H, W, 3) uint8 RGB 数组")
    if visible.shape[:2] != result.aligned.shape:
        raise ValueError(
            f"可见光 {visible.shape[:2]} 与对齐热图 {result.aligned.shape} 尺寸不一致"
        )
    if not 0.0 <= alpha <= 1.0:
        raise ValueError(f"alpha 必须在 [0,1]，得到 {alpha}")

    heat_rgb = colorize(
        result.aligned, result.mask, vmin=vmin, vmax=vmax, palette=palette
    )
    base = visible.astype(np.float64)
    heat = heat_rgb.astype(np.float64)
    weight = (result.mask.astype(np.float64) * alpha)[..., None]
    blended = base * (1.0 - weight) + heat * weight
    # 范围外 weight=0，数学上即可见光原值；统一裁剪转 uint8
    return np.clip(blended, 0.0, 255.0).astype(np.uint8)


def render_preview_only(
    result: WarpResult,
    *,
    vmin: float | None = None,
    vmax: float | None = None,
    palette: str = "iron",
) -> np.ndarray:
    """只渲染伪彩预览（黑底），用于不叠可见光时核对热值范围效果。"""
    return colorize(
        result.aligned, result.mask, vmin=vmin, vmax=vmax, palette=palette
    )


def effective_value_range(result: WarpResult) -> tuple[float, float]:
    """返回有效覆盖区内实际热值的 (min, max)，供 CLI 展示与默认范围。"""
    values = result.aligned[result.mask]
    if values.size == 0:
        raise ValueError("有效覆盖区为空")
    return float(values.min()), float(values.max())
