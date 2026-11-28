"""对应点表的读写与坐标约定。

点表为 UTF-8 文本，逗号或制表符分隔，``#`` 开头为注释，空行忽略。
固定五列，可选第六列::

    label, vis_x, vis_y, ir_x, ir_y[, use]

坐标约定（两张图一致）：

- 单位是**像素**，原点在图像左上角；
- ``x`` 沿列方向向右增大，``y`` 沿行方向向下增大；
- 允许小数（亚像素点），不允许缺失或非数字；
- ``vis_*`` 是可见光（参考图）上的坐标，``ir_*`` 是红外热图上的坐标，
  两行必须描述同一个物理位置。

可选 ``use`` 列取值：``fit``/``1``/``yes`` 表示参与拟合（默认），
``holdout``/``0``/``no`` 表示只用于独立偏差检查、不参与拟合。
"""

from __future__ import annotations

import csv
import dataclasses
import math
from pathlib import Path

_FIT_TOKENS = {"fit", "1", "yes", "true", "y"}
_HOLDOUT_TOKENS = {"holdout", "0", "no", "false", "n", "check", "test"}


class PointTableError(ValueError):
    """点表内容无法解析或坐标不合法。"""


@dataclasses.dataclass(frozen=True)
class Correspondence:
    """一对对应点。

    ``vis`` 为可见光图上的 (x, y)，``ir`` 为红外图上的 (x, y)，
    坐标单位均为像素（左上角原点）。
    """

    label: str
    vis: tuple[float, float]
    ir: tuple[float, float]
    use: str = "fit"  # "fit" 或 "holdout"

    def as_row(self) -> list[str]:
        return [
            self.label,
            _fmt(self.vis[0]),
            _fmt(self.vis[1]),
            _fmt(self.ir[0]),
            _fmt(self.ir[1]),
            self.use,
        ]


def _fmt(value: float) -> str:
    """整数坐标不带小数点，其余保留必要精度。"""
    if value == int(value):
        return str(int(value))
    return f"{value:.6f}".rstrip("0").rstrip(".")


def _parse_float(token: str, lineno: int, col: str) -> float:
    token = token.strip()
    if token == "":
        raise PointTableError(f"第 {lineno} 行 {col} 列为空，坐标必须是数字")
    try:
        value = float(token)
    except ValueError as exc:
        raise PointTableError(
            f"第 {lineno} 行 {col} 列不是数字: {token!r}"
        ) from exc
    if not math.isfinite(value):
        raise PointTableError(f"第 {lineno} 行 {col} 列必须是有限数值，得到 {token!r}")
    return value


def _parse_use(token: str | None, lineno: int) -> str:
    if token is None or token.strip() == "":
        return "fit"
    normalized = token.strip().lower()
    if normalized in _FIT_TOKENS:
        return "fit"
    if normalized in _HOLDOUT_TOKENS:
        return "holdout"
    raise PointTableError(
        f"第 {lineno} 行 use 列无法识别: {token!r}，"
        f"允许 fit/holdout（或 1/0、yes/no）"
    )


def load_points(path: str | Path) -> list[Correspondence]:
    """从 CSV/TSV 文件读取对应点。

    文件名后缀为 ``.tsv`` 时按制表符分隔，否则按逗号分隔。
    """
    path = Path(path)
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    points: list[Correspondence] = []
    seen_labels: set[str] = set()
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        for lineno, raw in enumerate(fh, start=1):
            line = raw.strip()
            if line == "" or line.startswith("#"):
                continue
            fields = next(csv.reader([line], delimiter=delimiter, skipinitialspace=True))
            fields = [f.strip() for f in fields]
            if len(fields) < 5:
                raise PointTableError(
                    f"第 {lineno} 行只有 {len(fields)} 列，至少需要 "
                    "label, vis_x, vis_y, ir_x, ir_y 五列"
                )
            # 容忍带表头的点表（首列名为 label 即视为表头行）
            if fields[0].lower() == "label":
                continue
            label = fields[0]
            if label == "":
                raise PointTableError(f"第 {lineno} 行 label 不能为空")
            if label.lower() in seen_labels:
                raise PointTableError(f"第 {lineno} 行 label 重复: {label!r}")
            vis = (
                _parse_float(fields[1], lineno, "vis_x"),
                _parse_float(fields[2], lineno, "vis_y"),
            )
            ir = (
                _parse_float(fields[3], lineno, "ir_x"),
                _parse_float(fields[4], lineno, "ir_y"),
            )
            use = _parse_use(fields[5] if len(fields) > 5 else None, lineno)
            points.append(Correspondence(label=label, vis=vis, ir=ir, use=use))
            seen_labels.add(label.lower())
    if not points:
        raise PointTableError(f"点表 {path} 中没有任何有效数据行")
    return points


def save_points(path: str | Path, points: list[Correspondence]) -> None:
    """把对应点写回 CSV（带表头注释，便于人工核对坐标约定）。"""
    path = Path(path)
    delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
    with path.open("w", encoding="utf-8", newline="") as fh:
        fh.write(
            "# 坐标单位像素；原点左上角；x 向右、y 向下；允许小数\n"
            "# 列: label, vis_x, vis_y, ir_x, ir_y, use "
            "(fit=参与拟合, holdout=仅检查)\n"
        )
        writer = csv.writer(fh, delimiter=delimiter, lineterminator="\n")
        writer.writerow(["label", "vis_x", "vis_y", "ir_x", "ir_y", "use"])
        for point in points:
            writer.writerow(point.as_row())


def split_points(
    points: list[Correspondence],
) -> tuple[list[Correspondence], list[Correspondence]]:
    """按 ``use`` 列拆成 (拟合点, 独立检查点)。"""
    fit = [p for p in points if p.use == "fit"]
    holdout = [p for p in points if p.use == "holdout"]
    return fit, holdout


def find_duplicate_pixels(
    points: list[Correspondence], tol: float = 1e-9
) -> list[str]:
    """找出在同一侧坐标完全重合的点（两侧都检查），返回问题描述列表。"""
    problems: list[str] = []
    for side_name, key in (("可见光", "vis"), ("红外", "ir")):
        seen: dict[tuple[float, float], str] = {}
        for point in points:
            xy = getattr(point, key)
            for prev_xy, prev_label in seen.items():
                if (
                    abs(xy[0] - prev_xy[0]) <= tol
                    and abs(xy[1] - prev_xy[1]) <= tol
                ):
                    problems.append(
                        f"{side_name}侧点 {prev_label!r} 与 {point.label!r} 坐标重合"
                    )
                    break
            seen[xy] = point.label
    return problems
