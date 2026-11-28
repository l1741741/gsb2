"""仅供预览使用的伪彩色映射。

所有函数都接收热值数组并返回新的 uint8 RGB 数组，
**不会修改输入的 uint16 热值**。内置一个类似铁红（iron）的调色板，
避免引入 matplotlib 依赖。
"""

from __future__ import annotations

import numpy as np

# 256 级铁红调色板控制点（黑 -> 紫 -> 红 -> 橙 -> 黄 -> 白）
_STOPS = np.array(
    [
        [0, 0, 0],
        [76, 0, 89],
        [150, 0, 66],
        [204, 31, 0],
        [237, 104, 0],
        [251, 181, 0],
        [255, 237, 160],
        [255, 255, 255],
    ],
    dtype=np.float64,
)


def iron_palette() -> np.ndarray:
    """返回 (256, 3) uint8 铁红调色板。"""
    x_stops = np.linspace(0.0, 1.0, len(_STOPS))
    x = np.linspace(0.0, 1.0, 256)
    channels = []
    for channel in range(3):
        channels.append(np.interp(x, x_stops, _STOPS[:, channel]))
    return np.stack(channels, axis=1).astype(np.uint8)


PALETTES = {
    "iron": iron_palette,
}


def normalize_for_display(
    thermal: np.ndarray,
    mask: np.ndarray,
    vmin: float | None = None,
    vmax: float | None = None,
) -> np.ndarray:
    """把有效覆盖区内的热值线性归一化到 0~255，范围外为 0。

    - ``vmin``/``vmax`` 为 None 时取有效区热值的最小/最大值；
    - 只读取 ``thermal``，不修改它；范围外不参与统计、不产生颜色；
    - 区间反转或过窄时抛出 ValueError，防止静默生成全平预览。
    """
    if thermal.shape != mask.shape:
        raise ValueError("thermal 与 mask 形状不一致")
    values = thermal[mask].astype(np.float64)
    if values.size == 0:
        raise ValueError("有效覆盖区为空，无法生成预览")
    lo = float(np.min(values)) if vmin is None else float(vmin)
    hi = float(np.max(values)) if vmax is None else float(vmax)
    if hi <= lo:
        raise ValueError(
            f"热值显示范围无效：vmin={lo}, vmax={hi}，必须满足 vmax > vmin"
        )
    scaled = np.zeros(thermal.shape, dtype=np.float64)
    scaled[mask] = np.clip((thermal[mask].astype(np.float64) - lo) / (hi - lo), 0.0, 1.0)
    return (scaled * 255.0).astype(np.uint8)


def colorize(
    thermal: np.ndarray,
    mask: np.ndarray,
    vmin: float | None = None,
    vmax: float | None = None,
    palette: str = "iron",
) -> np.ndarray:
    """热值 -> (H, W, 3) uint8 伪彩色，范围外为黑色（叠加时由 alpha 隐藏）。"""
    if palette not in PALETTES:
        raise KeyError(f"未知调色板 {palette!r}，可选: {sorted(PALETTES)}")
    indices = normalize_for_display(thermal, mask, vmin, vmax)
    lut = PALETTES[palette]()
    rgb = lut[indices]
    rgb[~mask] = 0
    return rgb
