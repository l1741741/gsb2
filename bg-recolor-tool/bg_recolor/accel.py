"""像素热循环：纯 Python 参考实现 + 可选 numpy 向量化实现。

两条路径输出保持一致（允许 numpy 浮点取整带来的 ±1 权重差异，关键判定一致）。
设置环境变量 ``BG_RECOLOR_NO_NUMPY=1`` 可强制使用纯 Python 路径。
"""

from __future__ import annotations

import math
import os
from typing import Tuple

from .colors import color_distance_sq

try:  # pragma: no cover - 取决于运行环境
    import numpy as _np
except Exception:  # pragma: no cover
    _np = None


def numpy_available() -> bool:
    return _np is not None


def using_numpy() -> bool:
    return _np is not None and os.environ.get("BG_RECOLOR_NO_NUMPY", "") not in (
        "1", "true", "TRUE", "yes")


# --------------------------------------------------------------------------- #
# 相似度权重
# --------------------------------------------------------------------------- #

def evaluate(rgba: bytearray, bg: Tuple[int, int, int], metric: str,
             tolerance: float, feather: float):
    """返回 ``(w255, similar)``，长度均为像素数 n。

    * ``similar[i] == 1``：该可见像素与背景色距离 <= tolerance（用于连通域）
    * ``w255[i]``：0..255 的替换强度，含过渡区间；完全透明像素恒为 0
    """
    if using_numpy():
        try:
            return _evaluate_np(rgba, bg, metric, tolerance, feather)
        except Exception:
            # numpy 路径出任何意外都退回纯 Python，保证本地工具可用
            pass
    return _evaluate_py(rgba, bg, metric, tolerance, feather)


def _evaluate_py(rgba, bg, metric, tolerance, feather):
    n = len(rgba) // 4
    br, bgc, bb = bg
    t2 = tolerance * tolerance if metric != "max" else None
    inner = max(0.0, tolerance - max(0.0, feather))
    inner2 = inner * inner
    inv_f = 1.0 / feather if feather and feather > 0 else 0.0
    hard = not feather or feather <= 0
    w255 = bytearray(n)
    similar = bytearray(n)

    for i in range(n):
        j = i * 4
        a = rgba[j + 3]
        if a == 0:
            continue
        r = rgba[j]
        g = rgba[j + 1]
        b = rgba[j + 2]
        if a < 255:
            ia = 255 - a
            r = (a * r + ia * br + 127) // 255
            g = (a * g + ia * bgc + 127) // 255
            b = (a * b + ia * bb + 127) // 255
        d2 = color_distance_sq(r, g, b, br, bgc, bb, metric)
        if metric == "max":
            is_similar = math.sqrt(d2) <= tolerance if d2 >= 0 else False
            d = math.sqrt(d2)
        else:
            is_similar = d2 <= t2 + 1e-9
            d = math.sqrt(d2)
        if not is_similar:
            continue
        similar[i] = 1
        if hard:
            w255[i] = 255
        elif d2 <= inner2 + 1e-9:
            w255[i] = 255
        elif d < tolerance:
            w = (tolerance - d) * inv_f
            if w < 0:
                w = 0.0
            elif w > 1:
                w = 1.0
            w255[i] = int(w * 255 + 0.5)
        # d == tolerance 时权重为 0，但 similar 仍为 1（连通域需要）
    return w255, similar


def _evaluate_np(rgba, bg, metric, tolerance, feather):  # pragma: no cover - 加速路径
    arr = _np.frombuffer(bytes(rgba), dtype=_np.uint8).reshape(-1, 4)
    n = arr.shape[0]
    a = arr[:, 3].astype(_np.int32)
    alpha = a[:, None]
    ia = 255 - alpha
    rgb = arr[:, :3].astype(_np.int32)
    bgv = _np.array(bg, dtype=_np.int32)[None, :]

    visible = a > 0
    apparent = _np.floor((alpha * rgb + ia * bgv + 127) / 255.0).astype(_np.float64)
    # 不透明像素直接用原色（与纯 Python 分支一致；上面的整数式对 a=255 也恒等）
    dr = apparent[:, 0] - bg[0]
    dg = apparent[:, 1] - bg[1]
    db = apparent[:, 2] - bg[2]

    if metric == "rgb":
        d2 = dr * dr + dg * dg + db * db
        d = _np.sqrt(d2)
    elif metric == "max":
        d = _np.maximum(_np.abs(dr), _np.maximum(_np.abs(dg), _np.abs(db)))
        d2 = d * d
    else:
        rmean = (apparent[:, 0] + bg[0]) * 0.5
        d2 = ((2.0 + rmean / 256.0) * dr * dr
              + 4.0 * dg * dg
              + (2.0 + (255.0 - rmean) / 256.0) * db * db)
        d = _np.sqrt(_np.maximum(d2, 0))

    similar = (visible & (d <= tolerance + 1e-9)).astype(_np.uint8)
    inner = max(0.0, tolerance - max(0.0, feather))
    if not feather or feather <= 0:
        w = _np.where(d <= tolerance + 1e-9, 1.0, 0.0)
    else:
        w = _np.clip((tolerance - d) / feather, 0.0, 1.0)
        w = _np.where(d <= inner + 1e-9, 1.0, w)
        w = _np.where(d >= tolerance, 0.0, w)
    w = _np.where(visible, w, 0.0)
    w255 = _np.clip(_np.floor(w * 255.0 + 0.5), 0, 255).astype(_np.uint8)
    return bytearray(w255.tobytes()), bytearray(similar.tobytes())


# --------------------------------------------------------------------------- #
# 换色
# --------------------------------------------------------------------------- #

def apply_recolor(rgba: bytearray, w255: bytearray, target: Tuple[int, int, int]):
    """按整数权重混合 RGB；alpha 原样保留；alpha=0 像素逐字节不变。"""
    if using_numpy():
        try:
            return _apply_recolor_np(rgba, w255, target)
        except Exception:  # pragma: no cover
            pass
    n = len(rgba) // 4
    out = bytearray(rgba)  # 复制，未命中的像素天然保持原样
    tr, tg, tb = target
    for i in range(n):
        w = w255[i]
        if w == 0:
            continue
        j = i * 4
        if out[j + 3] == 0:
            # 双保险：完全透明像素绝不修改（权重层也已经是 0）
            continue
        if w == 255:
            out[j] = tr
            out[j + 1] = tg
            out[j + 2] = tb
            continue
        iw = 255 - w
        out[j] = (out[j] * iw + tr * w + 127) // 255
        out[j + 1] = (out[j + 1] * iw + tg * w + 127) // 255
        out[j + 2] = (out[j + 2] * iw + tb * w + 127) // 255
    return out


def _apply_recolor_np(rgba, w255, target):  # pragma: no cover - 加速路径
    arr = _np.frombuffer(bytes(rgba), dtype=_np.uint8).reshape(-1, 4).copy()
    w = _np.frombuffer(bytes(w255), dtype=_np.uint8).astype(_np.int32)[:, None]
    iw = 255 - w
    t = _np.array(target, dtype=_np.int32)[None, :]
    rgb = arr[:, :3].astype(_np.int32)
    blended = _np.floor((rgb * iw + _np.broadcast_to(t, rgb.shape) * w + 127) / 255.0)
    mask = (w[:, 0] > 0) & (arr[:, 3] > 0)
    arr[mask, :3] = _np.clip(blended[mask], 0, 255).astype(_np.uint8)
    # w==255 时上面的整数式已给出 target
    return bytearray(arr.tobytes())


# --------------------------------------------------------------------------- #
# 合成到纯色底
# --------------------------------------------------------------------------- #

def composite_over(rgba: bytearray, bg: Tuple[int, int, int]):
    """合成到不透明底色，返回 RGB bytearray（长度 n*3）。"""
    if using_numpy():
        try:
            return _composite_over_np(rgba, bg)
        except Exception:  # pragma: no cover
            pass
    n = len(rgba) // 4
    out = bytearray(n * 3)
    br, bgc, bb = bg
    for i in range(n):
        j = i * 4
        a = rgba[j + 3]
        k = i * 3
        if a == 255:
            out[k] = rgba[j]
            out[k + 1] = rgba[j + 1]
            out[k + 2] = rgba[j + 2]
        elif a == 0:
            out[k] = br
            out[k + 1] = bgc
            out[k + 2] = bb
        else:
            ia = 255 - a
            out[k] = (a * rgba[j] + ia * br + 127) // 255
            out[k + 1] = (a * rgba[j + 1] + ia * bgc + 127) // 255
            out[k + 2] = (a * rgba[j + 2] + ia * bb + 127) // 255
    return out


def _composite_over_np(rgba, bg):  # pragma: no cover - 加速路径
    arr = _np.frombuffer(bytes(rgba), dtype=_np.uint8).reshape(-1, 4)
    a = arr[:, 3].astype(_np.int32)[:, None]
    ia = 255 - a
    rgb = arr[:, :3].astype(_np.int32)
    bgv = _np.array(bg, dtype=_np.int32)[None, :]
    out = _np.floor((a * rgb + ia * bgv + 127) / 255.0)
    return bytearray(_np.clip(out, 0, 255).astype(_np.uint8).tobytes())
