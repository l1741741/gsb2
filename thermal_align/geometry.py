"""二维仿射变换拟合与几何诊断。

变换模型为 6 参数仿射（覆盖平移、旋转、各向同性/异性缩放和轻微倾斜）::

    [ir_x]   [a b] [vis_x]   [tx]
    [ir_y] = [c d] [vis_y] + [ty]

即 ``ir = M @ vis + t``。拟合方向取「可见光 -> 红外」，重采样时再求逆，
使输出图与可见光参考图同尺寸、同坐标系。

设计原则：点太少、近乎共线、条件数过大或残差异常时抛出
:class:`RegistrationError` 并带可读诊断，绝不静默产出错位结果。
"""

from __future__ import annotations

import dataclasses
import math
from typing import Iterable

import numpy as np

from .points import Correspondence


class RegistrationError(ValueError):
    """配准无法可靠完成（点数不足、共线、病态或坏控制点）。"""


# 经验阈值，均在 fit_affine 中按数据规模自适应，这里给默认值
MIN_POINTS = 3
COLLINEAR_AREA_EPS = 1e-9
CONDITION_WARN = 1e6
CONDITION_FAIL = 1e10
DETERMINANT_EPS = 1e-9
# 坏控制点判定采用自适应阈值，避免固定像素下限在高冗余点集上误报：
# threshold = max(动态下限, median + REL_FACTOR * MAD*1.4826)。
# 动态下限随冗余点数 sqrt 缩放——点越多，最小二乘越能把单点偏差摊薄，
# 固定 2px 会把这种分摊误判成一批坏点。
OUTLIER_REL_FACTOR = 3.0
OUTLIER_FLOOR_BASE_PX = 2.0
# 残差占总误差平方和超过该比例的点，视为「单点主导」的强坏点证据
OUTLIER_ENERGY_SHARE = 0.25


@dataclasses.dataclass
class AffineModel:
    """拟合得到的仿射模型。

    ``matrix`` 为 2x2 线性部分 M，``translation`` 为 (tx, ty)，
    正向映射 vis -> ir：``ir = M @ vis + t``。
    """

    matrix: np.ndarray
    translation: np.ndarray
    condition_number: float
    residuals: np.ndarray  # 每个拟合点的重投影误差（像素），顺序同输入
    labels: list[str]
    dropped: list[str] = dataclasses.field(default_factory=list)

    @property
    def determinant(self) -> float:
        return float(np.linalg.det(self.matrix))

    def apply(self, vis_xy: np.ndarray) -> np.ndarray:
        """vis 坐标 (..., 2) -> ir 坐标。"""
        return vis_xy @ self.matrix.T + self.translation

    def apply_inverse(self, ir_xy: np.ndarray) -> np.ndarray:
        """ir 坐标 -> vis 坐标（重采样时使用）。

        正向为 ``ir = M @ vis + t``，反解为 ``vis = M^{-1} @ (ir - t)``。
        """
        inv = np.linalg.inv(self.matrix)
        return (ir_xy - self.translation) @ inv.T


@dataclasses.dataclass
class FitReport:
    """拟合诊断报告，供 CLI 与测试展示。"""

    n_fit: int
    condition_number: float
    determinant: float
    rms_residual: float
    max_residual: float
    max_residual_label: str
    per_point: list[tuple[str, float]]
    dropped: list[str]
    warnings: list[str]


def _design_matrix(points: Iterable[Correspondence]) -> tuple[np.ndarray, np.ndarray]:
    pts = list(points)
    vis = np.array([p.vis for p in pts], dtype=np.float64)
    ir = np.array([p.ir for p in pts], dtype=np.float64)
    # 每行 [vis_x, vis_y, 1]，一次最小二乘解出两行仿射参数
    design = np.column_stack([vis, np.ones(len(pts))])
    return design, ir


def _triangle_areas(xy: np.ndarray) -> np.ndarray:
    """返回所有三点组合的 |有向面积|，用于共线判断。"""
    n = len(xy)
    areas = []
    for i in range(n):
        for j in range(i + 1, n):
            for k in range(j + 1, n):
                cross = (
                    (xy[j, 0] - xy[i, 0]) * (xy[k, 1] - xy[i, 1])
                    - (xy[j, 1] - xy[i, 1]) * (xy[k, 0] - xy[i, 0])
                )
                areas.append(abs(cross) * 0.5)
    return np.array(areas, dtype=np.float64)


def _lstsq(design: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, float]:
    """SVD 最小二乘，返回 (参数矩阵 3x2, 设计矩阵条件数)。"""
    # 对非平移列做中心化，避免 [x,y,1] 量纲混合放大条件数
    params, _, _, _ = np.linalg.lstsq(design, target, rcond=None)
    # lstsq 的奇异值对应未中心化矩阵；诊断条件数改在中心化设计上计算
    center = design[:, :2].mean(axis=0)
    centered = design[:, :2] - center
    singular_centered = np.linalg.svd(centered, compute_uv=False)
    condition = float(singular_centered[0] / singular_centered[-1])
    return params, condition


def _build_model(
    points: list[Correspondence],
    dropped: list[str] | None = None,
) -> AffineModel:
    design, ir = _design_matrix(points)
    params, condition = _lstsq(design, ir)
    matrix = params[:2, :].T  # 2x2
    translation = params[2, :]
    predicted = design @ params
    residuals = np.linalg.norm(predicted - ir, axis=1)
    det = float(np.linalg.det(matrix))
    if not math.isfinite(det) or abs(det) < DETERMINANT_EPS:
        raise RegistrationError(
            f"拟合矩阵退化（行列式={det:.3e}），控制点几乎共线或存在重合点，"
            "无法建立可逆仿射变换；请增加分布在画面不同位置、不共线的对应点"
        )
    if condition >= CONDITION_FAIL:
        raise RegistrationError(
            f"控制点几何条件数 {condition:.3e} 过大（>= {CONDITION_FAIL:.0e}），"
            "点位过于集中或近乎共线，仿射参数不可靠；请让控制点散开覆盖画面"
        )
    return AffineModel(
        matrix=matrix,
        translation=translation,
        condition_number=condition,
        residuals=residuals,
        labels=[p.label for p in points],
        dropped=list(dropped or []),
    )


def _flag_outliers(residuals: np.ndarray, labels: list[str]) -> list[int]:
    if len(residuals) < MIN_POINTS + 1:
        return []
    n = len(residuals)
    redundancy = max(n - MIN_POINTS, 1)  # 超出最小 3 点的冗余个数
    # 动态下限：冗余越多，单点偏差被摊得越薄，下限按 sqrt 抬高
    floor = OUTLIER_FLOOR_BASE_PX * np.sqrt(redundancy)
    median = float(np.median(residuals))
    mad = float(np.median(np.abs(residuals - median)))
    sigma = 1.4826 * mad
    # 自适应统计阈值：完美点集用动态下限；有噪声时随离散度放大
    stat_threshold = max(floor, median + OUTLIER_REL_FACTOR * sigma)
    # 能量份额阈值：单个点独占足够大残差能量，是「单点拧偏」的强证据
    energy = residuals**2
    total_energy = float(energy.sum())
    energy_threshold_idx = (
        int(np.argmax(energy))
        if total_energy > 0.0
        and float(energy.max()) / total_energy > OUTLIER_ENERGY_SHARE
        and float(residuals.max()) > OUTLIER_FLOOR_BASE_PX
        else -1
    )
    flagged = {
        i for i, r in enumerate(residuals) if r > stat_threshold
    }
    if energy_threshold_idx >= 0:
        flagged.add(energy_threshold_idx)
    flagged = sorted(flagged)
    # 至少保留 3 个点才能重拟合：若剔除过多，只保留残差最大的
    # （且确实超基础下限的）若干个，使剩余点数不低于 MIN_POINTS
    if n - len(flagged) < MIN_POINTS:
        order = np.argsort(residuals)[::-1]
        budget = n - MIN_POINTS
        flagged = [
            int(i) for i in order
            if residuals[i] > OUTLIER_FLOOR_BASE_PX
        ][:budget]
    return flagged


def fit_affine(
    points: list[Correspondence],
    *,
    drop_outliers: bool = False,
) -> AffineModel:
    """用拟合点拟合 vis -> ir 仿射模型并做完整诊断。

    ``drop_outliers`` 为 True 时，首轮拟合发现的坏控制点会被剔除后重拟合
    （至少保留 3 个点）；为 False（默认）时遇到坏点直接报错，
    错误信息列出每个可疑点及其残差。
    """
    fit_points = [p for p in points if p.use == "fit"]
    if len(fit_points) < MIN_POINTS:
        raise RegistrationError(
            f"仿射变换至少需要 {MIN_POINTS} 个不共线的拟合点，"
            f"当前只有 {len(fit_points)} 个（use=fit）；"
            "holdout 点不参与拟合"
        )

    # 重合点会让设计矩阵出现重复行
    from .points import find_duplicate_pixels

    duplicates = find_duplicate_pixels(fit_points)
    if duplicates:
        raise RegistrationError("；".join(duplicates) + "；请修正后重试")

    # 显式共线检查（两侧都查），给出比条件数更直白的诊断
    for side_name, key in (("可见光", "vis"), ("红外", "ir")):
        xy = np.array([getattr(p, key) for p in fit_points])
        areas = _triangle_areas(xy)
        # 用点云尺度归一化，避免高分辨率图上绝对面积阈值失真
        scale = float(np.linalg.norm(xy.max(axis=0) - xy.min(axis=0)))
        normalized = areas / max(scale * scale, 1e-12)
        if normalized.size and normalized.max() < COLLINEAR_AREA_EPS:
            raise RegistrationError(
                f"{side_name}侧 {len(fit_points)} 个控制点近乎共线"
                f"（最大归一化三角形面积 {normalized.max():.2e}），"
                "无法确定二维仿射；请选取不在同一直线上的点"
            )

    model = _build_model(fit_points)
    outlier_idx = _flag_outliers(model.residuals, model.labels)

    if outlier_idx:
        details = ", ".join(
            f"{model.labels[i]} 残差 {model.residuals[i]:.2f}px" for i in outlier_idx
        )
        if not drop_outliers:
            raise RegistrationError(
                f"检测到 {len(outlier_idx)} 个疑似误点（重投影残差显著偏大）：{details}。"
                "请核对这些对应点是否点错位置；确认要自动剔除可加 --drop-outliers"
            )
        keep_idx = [i for i in range(len(fit_points)) if i not in outlier_idx]
        if len(keep_idx) < MIN_POINTS:
            raise RegistrationError(
                f"剔除坏点后只剩 {len(keep_idx)} 个控制点，少于 {MIN_POINTS} 个，"
                f"无法重拟合；可疑点：{details}"
            )
        dropped = [fit_points[i].label for i in outlier_idx]
        model = _build_model([fit_points[i] for i in keep_idx], dropped=dropped)
        # 重拟合后再查一次，防止剩余点仍有异常
        second_round = _flag_outliers(model.residuals, model.labels)
        if second_round:
            details2 = ", ".join(
                f"{model.labels[i]} 残差 {model.residuals[i]:.2f}px"
                for i in second_round
            )
            raise RegistrationError(
                f"剔除首轮坏点后仍存在异常点：{details2}；请人工核对点表"
            )
    return model


def build_report(model: AffineModel) -> FitReport:
    """从模型生成可读诊断报告。"""
    rms = float(np.sqrt(np.mean(model.residuals**2)))
    max_i = int(np.argmax(model.residuals))
    warnings: list[str] = []
    if model.condition_number >= CONDITION_WARN:
        warnings.append(
            f"条件数 {model.condition_number:.2e} 偏高，控制点分布偏集中，"
            "外推到画面边缘时误差可能放大"
        )
    det = model.determinant
    if det < 0:
        warnings.append("仿射行列式为负，红外与可见光坐标可能存在镜像翻转，请核对点位")
    per_point = [
        (label, float(res))
        for label, res in zip(model.labels, model.residuals, strict=True)
    ]
    return FitReport(
        n_fit=len(model.labels),
        condition_number=model.condition_number,
        determinant=det,
        rms_residual=rms,
        max_residual=float(model.residuals[max_i]),
        max_residual_label=model.labels[max_i],
        per_point=per_point,
        dropped=list(model.dropped),
        warnings=warnings,
    )


def holdout_errors(
    model: AffineModel, points: list[Correspondence]
) -> list[tuple[str, float, tuple[float, float], tuple[float, float]]]:
    """对未参与拟合的点计算独立偏差。

    返回 ``(label, 偏差像素, 红外实测坐标, 模型预测红外坐标)`` 列表。
    偏差定义：把 holdout 点的可见光坐标代入模型，与该点人工填写的红外坐标比较。
    """
    result = []
    for point in points:
        if point.use != "holdout":
            continue
        vis = np.array(point.vis, dtype=np.float64)
        predicted = model.apply(vis)
        actual = np.array(point.ir, dtype=np.float64)
        error = float(np.linalg.norm(predicted - actual))
        result.append(
            (
                point.label,
                error,
                (float(actual[0]), float(actual[1])),
                (float(predicted[0]), float(predicted[1])),
            )
        )
    return result


def coverage_ratio(
    model: AffineModel,
    vis_shape: tuple[int, int],
    ir_shape: tuple[int, int],
) -> float:
    """估算红外图经变换后落在可见光画布内的有效像素比例（0~1）。"""
    from .warp import coverage_mask

    mask = coverage_mask(model, vis_shape, ir_shape)
    return float(mask.mean())
