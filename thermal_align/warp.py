"""热图重采样与有效覆盖掩模。

输出画布与可见光参考图同尺寸（同坐标系，便于直接叠图）。
对画布每个像素，用拟合模型的逆变换映射回红外图，落在红外图
整数像素格点内才取值，且采用**最近邻**采样——不插值、不做任何
数值平均，保证对齐图中每个有效像素都是热图原值。

范围外（红外画面没覆盖到的画布区域）处理：

- 掩模记为 False，并以 8 位 PNG（0/255）单独交付；
- 16 位图对应位置写入哨兵值（默认 65535）。哨兵只占位、不是热值，
  与真实采集到的 0 值严格区分：掩模为 True 的 0 才是有效零值。
"""

from __future__ import annotations

import dataclasses

import numpy as np

from .geometry import AffineModel

DEFAULT_SENTINEL = np.uint16(65535)


class WarpError(ValueError):
    """重采样无法完成（例如完全无重叠）。"""


@dataclasses.dataclass
class WarpResult:
    """重采样产物。

    - ``aligned``  uint16 二维数组，与可见光同尺寸，范围外为哨兵值；
    - ``mask``     bool 二维数组，True=有效覆盖（红外原值），False=范围外；
    - ``sentinel`` 实际使用的哨兵值；
    - ``coverage`` 有效像素占比。
    """

    aligned: np.ndarray
    mask: np.ndarray
    sentinel: np.uint16
    coverage: float


def choose_sentinel(thermal: np.ndarray, requested: int | None = None) -> np.uint16:
    """选择不会与真实热值冲突的哨兵值。

    用户指定时若该值已出现在热图中则报错（避免歧义）；
    未指定时默认 65535，被占用则依次尝试 65534、65533……直到找到空闲值；
    若 16 位值域被占满（极端情况）则报错。
    """
    present = np.unique(thermal)
    if requested is not None:
        sentinel = np.uint16(requested)
        if np.isin(sentinel, present):
            raise WarpError(
                f"指定哨兵值 {int(sentinel)} 在热图中真实存在，"
                "无法用来标记范围外；请换一个未出现的值或交回自动选择"
            )
        return sentinel
    for candidate in range(65535, -1, -1):
        if not np.isin(np.uint16(candidate), present):
            return np.uint16(candidate)
    raise WarpError("热图占满了全部 65536 个 16 位取值，无法选出哨兵值")


def coverage_mask(
    model: AffineModel,
    vis_shape: tuple[int, int],
    ir_shape: tuple[int, int],
) -> np.ndarray:
    """计算 vis 画布上哪些像素能在红外图内取到原值，返回 bool 掩模。"""
    height, width = vis_shape
    ir_h, ir_w = ir_shape
    # 输出画布像素中心坐标
    ys, xs = np.meshgrid(
        np.arange(height, dtype=np.float64),
        np.arange(width, dtype=np.float64),
        indexing="ij",
    )
    vis_xy = np.stack([xs, ys], axis=-1).reshape(-1, 2)
    ir_xy = model.apply_inverse(vis_xy)
    ir_x = ir_xy[:, 0]
    ir_y = ir_xy[:, 1]
    # 最近邻格点：像素中心在 [0, W-1] 整数上，半像素内的映射才归属该像素
    inside = (
        (ir_x >= -0.5)
        & (ir_x <= ir_w - 0.5)
        & (ir_y >= -0.5)
        & (ir_y <= ir_h - 0.5)
    )
    return inside.reshape(height, width)


def warp_thermal(
    thermal: np.ndarray,
    model: AffineModel,
    vis_shape: tuple[int, int],
    *,
    sentinel: int | None = None,
) -> WarpResult:
    """把红外热图按模型对齐到可见光画布（最近邻、保原值）。"""
    if thermal.dtype != np.uint16 or thermal.ndim != 2:
        raise WarpError(f"热图必须是 uint16 二维数组，得到 {thermal.dtype} {thermal.shape}")
    fill_value = choose_sentinel(thermal, sentinel)
    height, width = vis_shape
    mask = coverage_mask(model, vis_shape, thermal.shape)

    aligned = np.full((height, width), fill_value, dtype=np.uint16)
    if not mask.any():
        raise WarpError(
            "红外图经变换后与可见光画布完全无重叠（有效覆盖为 0）。"
            "通常是控制点填反了 vis/ir 两列、点错图，或两图根本不是同一物件；"
            "请核对点表坐标与列顺序后重试"
        )

    ys, xs = np.meshgrid(
        np.arange(height, dtype=np.float64),
        np.arange(width, dtype=np.float64),
        indexing="ij",
    )
    vis_xy = np.stack([xs, ys], axis=-1).reshape(-1, 2)
    ir_xy = model.apply_inverse(vis_xy)
    # 最近邻索引，仅对掩模内像素取值
    ix = np.rint(ir_xy[:, 0]).astype(np.int64)
    iy = np.rint(ir_xy[:, 1]).astype(np.int64)
    flat_mask = mask.reshape(-1)
    valid_ix = np.clip(ix[flat_mask], 0, thermal.shape[1] - 1)
    valid_iy = np.clip(iy[flat_mask], 0, thermal.shape[0] - 1)
    aligned.reshape(-1)[flat_mask] = thermal[valid_iy, valid_ix]

    return WarpResult(
        aligned=aligned,
        mask=mask,
        sentinel=fill_value,
        coverage=float(mask.mean()),
    )


def count_effective_zeros(result: WarpResult) -> int:
    """统计有效覆盖区内的真实零值个数（用于证明零值与范围外未混淆）。"""
    return int(np.count_nonzero(result.aligned[result.mask] == 0))


def count_outside(result: WarpResult) -> int:
    """范围外像素个数。"""
    return int(np.count_nonzero(~result.mask))
