"""自生成棋盘/角标合成样例，用于在没有真实相机数据时验证整条链路。

生成一对「同物件、不同镜头画面范围」的合成图：

- 可见光图：带编号角标的棋盘格；
- 红外图：同一棋盘经已知仿射变换（旋转 + 缩放 + 轻微倾斜 + 平移）后，
  写入 16 位热值（按格点温度场生成，保留真实零值区域）；
- 点表：角标真值对应点，含 fit 与 holdout 两组，
  holdout 点不参与拟合，专门用于独立偏差检查。

内置三种场景：

- ``normal``    正常配对，留出 holdout 点；
- ``no-overlap`` 把变换平移到画面外，模拟两图无重叠（配准应明确报错）；
- ``bad-point``  一个控制点的红外坐标被人为拧偏（配准应报坏点，
  加 --drop-outliers 后可恢复并通过 holdout 检查）。
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

import numpy as np

from .imaging import save_rgb, save_thermal_uint16
from .points import Correspondence, save_points

VIS_W, VIS_H = 640, 480
# 红外传感器分辨率低于可见光，但视场经配准后能覆盖棋盘主体约一半画面
IR_W, IR_H = 560, 420
GRID_COLS, GRID_ROWS = 8, 6  # 内部角标 7x5


@dataclasses.dataclass
class SampleSpec:
    """一个合成样例的全部产物路径与真值信息。"""

    out_dir: Path
    visible_png: Path
    thermal_png: Path
    points_csv: Path
    scenario: str
    ground_truth_matrix: np.ndarray
    ground_truth_translation: np.ndarray
    holdout_labels: list[str]
    notes: str


def _corner_grid() -> np.ndarray:
    """在可见光画布上生成均匀分布的内部角标坐标 (N, 2) = (x, y)。"""
    margin_x, margin_y = 90, 70
    xs = np.linspace(margin_x, VIS_W - margin_x, GRID_COLS - 1)
    ys = np.linspace(margin_y, VIS_H - margin_y, GRID_ROWS - 1)
    grid = np.array([(x, y) for y in ys for x in xs], dtype=np.float64)
    return grid


def _ground_truth_transform(scenario: str) -> tuple[np.ndarray, np.ndarray]:
    """构造 vis -> ir 的真值仿射：缩放 + 旋转 + 轻微倾斜 + 平移。

    红外分辨率（320x240）小于可见光（640x480），用较大缩放比让红外
    视场仍能覆盖棋盘主体，同时画面范围明显小于可见光，模拟镜头差异。
    """
    angle = np.deg2rad(12.0)
    scale = 0.55
    tilt = np.array([[1.0, 0.03], [-0.02, 1.0]])  # 轻微剪切倾斜
    rotation = np.array(
        [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]
    )
    matrix = scale * rotation @ tilt
    if scenario == "no-overlap":
        # 整体平移到红外画布之外
        translation = np.array([IR_W + 400.0, IR_H + 300.0])
    else:
        # 让棋盘中心大致落在红外画布中心
        center_vis = np.array([VIS_W / 2.0, VIS_H / 2.0])
        center_ir = np.array([IR_W / 2.0, IR_H / 2.0])
        translation = center_ir - matrix @ center_vis
    return matrix, translation


def _draw_visible(corners: np.ndarray) -> np.ndarray:
    """渲染带角标编号的可见光棋盘 RGB 图。"""
    img = np.full((VIS_H, VIS_W, 3), 235, dtype=np.uint8)
    cell = 46
    x0 = int(corners[:, 0].min()) - cell // 2
    y0 = int(corners[:, 1].min()) - cell // 2
    # 棋盘方块
    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            if (row + col) % 2 == 0:
                x = x0 + col * cell
                y = y0 + row * cell
                img[max(y, 0) : y + cell, max(x, 0) : x + cell] = (40, 44, 52)
    # 角标：白底深色十字 + 外圈，肉眼和程序都容易定位
    for idx, (x, y) in enumerate(corners):
        xi, yi = int(round(x)), int(round(y))
        img[yi - 6 : yi + 7, xi - 2 : xi + 3] = (200, 60, 60)
        img[yi - 2 : yi + 3, xi - 6 : xi + 7] = (200, 60, 60)
        img[yi - 8 : yi + 9, xi - 8 : xi - 6] = (20, 20, 20)
        img[yi - 8 : yi + 9, xi + 7 : xi + 9] = (20, 20, 20)
        # 编号写在角标右上方（用 3x5 点阵，避免依赖字体）
        _draw_digit(img, idx % 10, xi + 10, yi - 12)
    return img


_DIGITS = {
    0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
    1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
    2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
    3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
    4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
    5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
    6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
    7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
    8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
    9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
}


def _draw_digit(img: np.ndarray, digit: int, ox: int, oy: int) -> None:
    pattern = _DIGITS[digit]
    for row, line in enumerate(pattern):
        for col, char in enumerate(line):
            if char == "1":
                y, x = oy + row, ox + col
                if 0 <= y < img.shape[0] and 0 <= x < img.shape[1]:
                    img[y, x] = (20, 20, 20)


def _draw_thermal(corners_ir: np.ndarray, scenario: str) -> np.ndarray:
    """在红外画布上渲染 16 位热图。

    整个传感器视场铺满平滑温度场（保证叠图能看到完整红外画面范围），
    棋盘方块用温差叠加，角标画成高温十字；另保留一条真实零值带，
    用于验证「有效零值」与「范围外哨兵」可区分。
    """
    # 基础温度场：横向 2600~3600 渐变 + 纵向小幅起伏，全部为有效热值
    gx = np.linspace(2600.0, 3600.0, IR_W, dtype=np.float64)
    gy = np.linspace(0.0, 250.0, IR_H, dtype=np.float64)
    thermal = (gx[None, :] + gy[:, None]).astype(np.uint16)

    # 格宽由红外侧角标实际间距推出，保证与可见光棋盘几何一致
    spacing_x = float(np.median(np.diff(np.unique(corners_ir[:, 0]))))
    spacing_y = float(np.median(np.diff(np.unique(corners_ir[:, 1]))))
    cell = max(int(round(max(spacing_x, spacing_y))), 2)
    x0 = int(corners_ir[:, 0].min()) - cell // 2
    y0 = int(corners_ir[:, 1].min()) - cell // 2
    for row in range(GRID_ROWS):
        for col in range(GRID_COLS):
            if (row + col) % 2 == 0:
                x = x0 + col * cell
                y = y0 + row * cell
                # 深色格降温 700，形成可辨识的棋盘温差
                y_lo, y_hi = max(y, 0), min(y + cell, IR_H)
                x_lo, x_hi = max(x, 0), min(x + cell, IR_W)
                if y_hi > y_lo and x_hi > x_lo:
                    block = thermal[y_lo:y_hi, x_lo:x_hi].astype(np.int32) - 700
                    thermal[y_lo:y_hi, x_lo:x_hi] = np.maximum(block, 1).astype(np.uint16)
    # 角标点画成高温十字
    for x, y in corners_ir:
        xi, yi = int(round(x)), int(round(y))
        if 0 <= yi < IR_H and 0 <= xi < IR_W:
            thermal[max(yi - 2, 0) : yi + 3, max(xi - 1, 0) : xi + 2] = 5200
            thermal[max(yi - 1, 0) : yi + 2, max(xi - 2, 0) : xi + 3] = 5200
    # 底部一条真实零值带（在传感器视场内、掩模为 True 的有效零值）
    thermal[IR_H - 12 :, :] = 0
    return thermal


def _make_points(
    corners_vis: np.ndarray,
    corners_ir: np.ndarray,
    scenario: str,
) -> list[Correspondence]:
    points: list[Correspondence] = []
    n = len(corners_vis)
    # 固定 4 个角标作为 holdout（四角位置），其余参与拟合
    holdout_idx = {0, GRID_COLS - 2, n - (GRID_COLS - 1), n - 1}
    bad_idx = 1  # bad-point 场景拧偏第二个点
    for idx, ((vx, vy), (ix, iy)) in enumerate(zip(corners_vis, corners_ir)):
        use = "holdout" if idx in holdout_idx else "fit"
        ir_x, ir_y = float(ix), float(iy)
        if scenario == "bad-point" and idx == bad_idx:
            # 人为误点：红外侧横向偏移 35 像素
            ir_x += 35.0
        points.append(
            Correspondence(
                label=f"C{idx:02d}",
                vis=(float(vx), float(vy)),
                ir=(ir_x, ir_y),
                use=use,
            )
        )
    return points


def generate_sample(out_dir: str | Path, scenario: str = "normal") -> SampleSpec:
    """生成一整套合成样例并落盘，返回产物路径与真值。"""
    if scenario not in {"normal", "no-overlap", "bad-point"}:
        raise ValueError(f"未知场景 {scenario!r}")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    corners_vis = _corner_grid()
    matrix, translation = _ground_truth_transform(scenario)
    corners_ir = corners_vis @ matrix.T + translation
    # no-overlap 场景下红外图内没有任何内容，仍写出全零热图以模拟无信号
    thermal = _draw_thermal(corners_ir, scenario)
    visible = _draw_visible(corners_vis)
    points = _make_points(corners_vis, corners_ir, scenario)

    visible_png = out_dir / f"visible_{scenario}.png"
    thermal_png = out_dir / f"thermal_{scenario}.png"
    points_csv = out_dir / f"points_{scenario}.csv"
    save_rgb(visible_png, visible)
    save_thermal_uint16(thermal_png, thermal)
    save_points(points_csv, points)

    holdout_labels = [p.label for p in points if p.use == "holdout"]
    notes = {
        "normal": "正常配对；holdout 角标不参与拟合，用于独立偏差检查",
        "no-overlap": "红外画面被平移到画布外，配准应报完全无重叠",
        "bad-point": "C01 的红外坐标被人为拧偏 35px，应被残差诊断识别",
    }[scenario]
    return SampleSpec(
        out_dir=out_dir,
        visible_png=visible_png,
        thermal_png=thermal_png,
        points_csv=points_csv,
        scenario=scenario,
        ground_truth_matrix=matrix,
        ground_truth_translation=translation,
        holdout_labels=holdout_labels,
        notes=notes,
    )
