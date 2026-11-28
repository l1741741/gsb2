"""图像读写：普通 PNG 与 16 位灰度 PNG。

关键约束：16 位红外 PNG 读出后必须保持原始 uint16 热值，
任何伪彩色、阈值调整只作用于预览副本，绝不回写对齐结果。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None  # 工具面向本地大图，关闭解压炸弹告警


class ImageLoadError(ValueError):
    """图像无法读取或位深/模式不符合约定。"""


def load_thermal(path: str | Path) -> np.ndarray:
    """读取 16 位单通道灰度 PNG，返回 dtype=uint16 的二维数组。

    兼容真正的 16 位 PNG（PIL 模式 ``I;16``/``I``）以及 8 位灰度
    （会按原值提升为 uint16，不做拉伸）。RGB 图不允许当作热图输入。
    """
    path = Path(path)
    try:
        with Image.open(path) as im:
            im.load()
            mode = im.mode
            if mode == "I;16":
                arr = np.array(im, dtype=np.uint16)
            elif mode == "I":
                raw = np.array(im)
                if raw.size and (raw.min() < 0 or raw.max() > 65535):
                    raise ImageLoadError(
                        f"{path} 是 32 位整数图（模式 I）且含超出 16 位无符号范围的值 "
                        f"[{int(raw.min())}, {int(raw.max())}]，无法无损当作 16 位热图；"
                        "请先确认导出的是 16 位灰度 PNG"
                    )
                arr = raw.astype(np.uint16)
            elif mode == "L":
                arr = np.array(im, dtype=np.uint16)
            elif mode in ("RGB", "RGBA", "P"):
                raise ImageLoadError(
                    f"{path} 是彩色/调色板图像（模式 {mode}），"
                    "热图必须是 16 位单通道灰度 PNG"
                )
            else:
                raise ImageLoadError(f"{path} 图像模式 {mode} 不受支持")
    except ImageLoadError:
        raise
    except Exception as exc:  # Pillow 内部各类解码错误统一包装
        raise ImageLoadError(f"无法读取热图 {path}: {exc}") from exc
    if arr.ndim != 2:
        raise ImageLoadError(f"{path} 不是单通道灰度图，shape={arr.shape}")
    return arr


def load_visible(path: str | Path) -> np.ndarray:
    """读取可见光 PNG，返回 dtype=uint8 的 RGB 三维数组 (H, W, 3)。

    灰度图会广播为三通道；RGBA 的透明区按黑底合成。
    """
    path = Path(path)
    try:
        with Image.open(path) as im:
            im.load()
            if im.mode == "RGBA":
                background = Image.new("RGB", im.size, (0, 0, 0))
                background.paste(im, mask=im.split()[3])
                im = background
            elif im.mode != "RGB":
                im = im.convert("RGB")
            arr = np.array(im, dtype=np.uint8)
    except Exception as exc:
        raise ImageLoadError(f"无法读取可见光图 {path}: {exc}") from exc
    if arr.ndim != 3 or arr.shape[2] != 3:
        raise ImageLoadError(f"{path} 转换 RGB 失败，shape={arr.shape}")
    return arr


def save_thermal_uint16(path: str | Path, arr: np.ndarray) -> None:
    """把 uint16 二维数组保存为 16 位灰度 PNG（无损、原值写出）。"""
    if arr.dtype != np.uint16 or arr.ndim != 2:
        raise ValueError(f"save_thermal_uint16 需要 uint16 二维数组，得到 {arr.dtype} {arr.shape}")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Pillow 13 起 fromarray 不再接受显式 "I;16" 模式；
    # 不传 mode 时 uint16 数组会自动以 I;16 编码为真 16 位 PNG
    Image.fromarray(arr).save(path, format="PNG")


def save_mask_uint8(path: str | Path, mask: np.ndarray) -> None:
    """把布尔掩模保存为 8 位灰度 PNG：有效=255，范围外=0。"""
    if mask.dtype != bool or mask.ndim != 2:
        raise ValueError(f"save_mask_uint8 需要 bool 二维数组，得到 {mask.dtype} {mask.shape}")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray((mask.astype(np.uint8) * 255), mode="L").save(path, format="PNG")


def save_rgb(path: str | Path, arr: np.ndarray) -> None:
    """保存 RGB uint8 图像为 PNG。"""
    if arr.dtype != np.uint8 or arr.ndim != 3 or arr.shape[2] != 3:
        raise ValueError(f"save_rgb 需要 (H,W,3) uint8 数组，得到 {arr.dtype} {arr.shape}")
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(arr, mode="RGB").save(path, format="PNG")
