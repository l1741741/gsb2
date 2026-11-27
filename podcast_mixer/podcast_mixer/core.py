"""核心混音逻辑：电平估计、平滑增益包络、混音、峰值处理。"""

from __future__ import annotations

import json
import math
from array import array

NEG_INF = float("-inf")


def db_to_lin(db):
    return 10.0 ** (db / 20.0)


def lin_to_db(x):
    if x <= 0.0:
        return NEG_INF
    return 20.0 * math.log10(x)


def load_markers(path):
    """读取说话标记 JSON。

    支持两种格式：
      [[start, end], ...]
      {"segments": [[start, end], ...]}
    返回按起点排序、去掉了非法区间的 [(start, end), ...]（秒）。
    """
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = data.get("segments", [])
    segs = []
    for item in data:
        s, e = float(item[0]), float(item[1])
        if e > s >= 0.0:
            segs.append((s, e))
    segs.sort()
    return segs


def merge_segments(segs, min_gap):
    """合并间距小于 min_gap 秒的相邻区间（允许区间互相重叠、允许短断点）。"""
    if not segs:
        return []
    merged = [list(segs[0])]
    for s, e in segs[1:]:
        last = merged[-1]
        if s - last[1] <= min_gap:
            last[1] = max(last[1], e)
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged]


def measure_speech_db(samples, segs, rate):
    """只在标记的说话区间内估计 RMS 电平（dBFS）。空白范围不参与，避免底噪拉低估计。"""
    total_sq = 0.0
    total_n = 0
    for s, e in segs:
        i0 = max(0, int(round(s * rate)))
        i1 = min(len(samples), int(round(e * rate)))
        for v in samples[i0:i1]:
            total_sq += v * v
        total_n += i1 - i0
    if total_n == 0 or total_sq == 0.0:
        return NEG_INF
    return lin_to_db(math.sqrt(total_sq / total_n))


def clamp_gain(requested_db, max_boost_db, max_cut_db):
    return max(-max_cut_db, min(max_boost_db, requested_db))


def build_gain_envelope(n, segs, rate, gain, ramp_s):
    """构造逐样本增益包络（array('f')，基准 1.0）。

    每个说话区间前 ramp_s 秒用升余弦从 1.0 升到 gain，区间结束后
    用降余弦落回 1.0，避免边缘跳变产生爆音。区间外的空白保持 1.0，
    不会被提升（底噪不跟着抬）。
    """
    env = array("f", [1.0]) * n
    ramp = max(1, int(round(ramp_s * rate)))
    full = array("f", [gain])
    for s, e in segs:
        i0 = max(0, int(round(s * rate)))
        i1 = min(n, int(round(e * rate)))
        if i1 <= i0:
            continue
        # 淡入：在区间开始之前完成，保证说话起点已是满增益
        fi0 = max(0, i0 - ramp)
        m = i0 - fi0
        if m > 0:
            for k in range(m):
                w = 0.5 - 0.5 * math.cos(math.pi * (k + 1) / m)
                env[fi0 + k] = 1.0 + (gain - 1.0) * w
        # 区间内满增益（切片批量赋值）
        env[i0:i1] = full * (i1 - i0)
        # 淡出：区间结束后回落
        fo1 = min(n, i1 + ramp)
        m = fo1 - i1
        if m > 0:
            for k in range(m):
                w = 0.5 + 0.5 * math.cos(math.pi * k / m)
                env[i1 + k] = 1.0 + (gain - 1.0) * w
    return env


def apply_envelope(samples, env):
    return array("f", (s * g for s, g in zip(samples, env)))


def scale(samples, factor):
    """整体乘一个固定增益（用于峰值下压）。"""
    return array("f", (s * factor for s in samples))


def pad_to(samples, n):
    """末尾补零到 n 个样本（较短音轨末尾补齐）。"""
    if len(samples) < n:
        samples = samples + array("f", [0.0]) * (n - len(samples))
    return samples


def mix(tracks, n):
    """等长叠加。"""
    out = array("f", [0.0]) * n
    for t in tracks:
        out = array("f", (a + b for a, b in zip(out, t)))
    return out


def peak_abs(samples):
    if not samples:
        return 0.0
    lo = min(samples)
    hi = max(samples)
    return max(hi, -lo)


def find_exceed_regions(samples, ceiling, rate, merge_gap_s=0.05, min_dur_s=0.001):
    """找出 |sample| > ceiling 的时间范围（合并邻近点），用于报告受影响位置。"""
    regions = []
    start = None
    last = None
    gap = int(merge_gap_s * rate)
    for i, v in enumerate(samples):
        if v > ceiling or v < -ceiling:
            if start is None:
                start = i
            elif i - last > gap:
                regions.append((start, last))
                start = i
            last = i
    if start is not None:
        regions.append((start, last))
    min_len = max(1, int(min_dur_s * rate))
    return [
        (s / rate, (e + 1) / rate) for s, e in regions if e - s + 1 >= min_len
    ]


def envelope_range_db(env):
    return lin_to_db(min(env)), lin_to_db(max(env))
