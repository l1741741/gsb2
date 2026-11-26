"""小节 / 拍 / 秒 / 采样之间的确定性换算。

约定：
- 小节和拍都是 1 起始："1.1" = 第 1 小节第 1 拍 = 采样 0。
- 位置也可以写成对象：{"bar": 3, "beat": 1.5}、{"beats": 10}、{"sample": 44100}。
- 纯数字按“从原点起的绝对拍数”解释（0 = 第一拍）。
所有非整数采样都用 half-up 四舍五入到最近整数采样，
并在报告中同时保留原始拍值与解析后的采样值。
"""

from __future__ import annotations

import math
import re

_BAR_BEAT_RE = re.compile(r"^\s*(\d+)\.(\d+(?:\.\d+)?)\s*$")


def nearest_sample(x: float) -> int:
    """half-up 取整，避免 Python 内建 round 的银行家舍入争议。"""
    return int(math.floor(x + 0.5))


def position_to_beats(value, beats_per_bar: int) -> float:
    """把计划里的位置表达统一成“从 1.1 起的拍偏移”。"""
    if isinstance(value, bool):
        raise ValueError("位置不能是布尔值: %r" % (value,))
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        m = _BAR_BEAT_RE.match(value)
        if not m:
            raise ValueError(
                "无法解析小节.拍位置 %r，应为如 \"2.1\"（第2小节第1拍）" % value
            )
        bar = int(m.group(1))
        beat = float(m.group(2))
        if bar < 1 or beat < 1:
            raise ValueError("小节与拍都从 1 开始: %r" % value)
        return (bar - 1) * beats_per_bar + (beat - 1)
    if isinstance(value, dict):
        if "sample" in value:
            # 采样形式没有“拍”中间量，调用方应优先走 resolve_position_sample
            raise _SamplePosition(int(value["sample"]))
        if "bar" in value:
            bar = int(value["bar"])
            beat = float(value.get("beat", 1))
            if bar < 1 or beat < 1:
                raise ValueError("小节与拍都从 1 开始: %r" % value)
            return (bar - 1) * beats_per_bar + (beat - 1)
        if "beats" in value:
            return float(value["beats"])
        raise ValueError("位置对象需要 bar/beat、beats 或 sample 字段: %r" % value)
    raise ValueError("不支持的位置类型: %r" % (value,))


class _SamplePosition(Exception):
    """内部控制流：位置直接给的是采样。"""

    def __init__(self, sample: int):
        self.sample = sample


def resolve_position_sample(value, bpm: float, beats_per_bar: int, sample_rate: int) -> int:
    """把任意位置表达解析成整数采样位置。"""
    if isinstance(value, dict) and "sample" in value:
        return int(value["sample"])
    try:
        beats = position_to_beats(value, beats_per_bar)
    except _SamplePosition as sp:
        return sp.sample
    return beats_to_samples(beats, bpm, sample_rate)


def beats_to_samples(beats: float, bpm: float, sample_rate: int) -> int:
    seconds = beats * 60.0 / bpm
    return nearest_sample(seconds * sample_rate)


def samples_to_beats(sample: int, bpm: float, sample_rate: int) -> float:
    return sample * bpm / (60.0 * sample_rate)


def samples_to_seconds(sample: int, sample_rate: int) -> float:
    return sample / float(sample_rate)


def seconds_to_samples(seconds: float, sample_rate: int) -> int:
    return nearest_sample(seconds * sample_rate)


def samples_to_timecode(sample: int, sample_rate: int) -> str:
    """SMPTE 风格的 HH:MM:SS.mmm（毫秒，不是真帧号）。"""
    total_ms = sample * 1000.0 / sample_rate
    sign = "-" if total_ms < 0 else ""
    total_ms = abs(total_ms)
    ms = int(round(total_ms))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, milli = divmod(rem, 1000)
    return "%s%02d:%02d:%02d.%03d" % (sign, h, m, s, milli)


def duration_to_samples(spec: dict, bpm: float, sample_rate: int, what: str = "时长") -> int:
    """转场/预卷时长支持 beats / samples / seconds 三种写法。"""
    keys = ("duration_beats", "beats", "duration_samples", "samples",
            "duration_seconds", "seconds")
    found = [k for k in keys if k in spec]
    if not found:
        raise ValueError("%s缺少时长字段（duration_beats/duration_samples/duration_seconds）" % what)
    k = found[0]
    v = spec[k]
    if "beat" in k:
        return beats_to_samples(float(v), bpm, sample_rate)
    if "second" in k:
        return seconds_to_samples(float(v), sample_rate)
    return int(v)
