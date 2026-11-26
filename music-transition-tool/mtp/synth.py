"""生成测试/试听用的合成 WAV。

设计目标：
- 采样率 44100、BPM 120，因此 1 拍 = 22050 采样、1 小节 = 88200 采样，
  全部是整数，拍点可以逐采样核对，不存在换算舍入。
- 每个素材都是短循环（1~2 小节），拍点恰好落在配置的 beats 采样上。
- 三个 loop 素材有明显不同的声道特征：
    garden_stereo: 下拍标记只在左声道，琶音在右；
    market_stereo: 下拍标记只在右声道，拨弦在左；
    harbor_mono:   单声道，标记居中（导出时双声道相同）。
- 下拍带一个公开已知的 “chirp” 标记模板（marker_template），
  analyze 用匹配滤波检查它在成品中的实际落点。
"""

from __future__ import annotations

import math
import wave
from array import array
from pathlib import Path

from .wavio import write_wav_int16

SR = 44100
BPM = 120
BEAT = 60.0 / BPM * SR          # 22050.0
BEAT_FRAMES = 22050
EIGHTH_FRAMES = BEAT_FRAMES // 2
BAR_FRAMES = BEAT_FRAMES * 4    # 88200
MARKER_LEN = 256

PENTA = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25]
BASS_ROOTS = [65.41, 49.00, 55.00, 43.65]  # C2 G1 A1 F1


def _prn(i: int) -> float:
    """确定性伪随机 ±1 序列（整数 hash），自相关峰尖锐、和调性音乐相关性低。"""
    x = (i * 374761393 + 668265263) & 0xFFFFFFFF
    x = ((x ^ (x >> 13)) * 1274126177) & 0xFFFFFFFF
    x ^= x >> 16
    return 1.0 if (x & 1) else -1.0


def marker_sample(i: int) -> float:
    """下拍标记：256 采样宽频 PRN + 明亮啁啾，指数衰减。

    匹配滤波的处理增益约 10*log10(约150 有效采样) ≈ 22dB，
    即使同一点有底鼓/贝司、且处在交叉淡变中段也能被定位到唯一整数采样。
    """
    env = math.exp(-i / 170.0)
    prn = _prn(i)
    chirp = math.sin(2.0 * math.pi * 2640.0 * i / SR)
    return 0.46 * env * prn + 0.18 * env * chirp


def marker_template() -> array:
    return array("d", (marker_sample(i) for i in range(MARKER_LEN)))


def _noise(i: int) -> float:
    # 确定性整数 hash 噪声，比每采样 math.sin 快
    x = (i * 374761393 + 668265263) & 0xFFFFFFFF
    x = ((x ^ (x >> 13)) * 1274126177) & 0xFFFFFFFF
    x ^= x >> 16
    return ((x & 0xFFFF) / 32767.5) - 1.0


def _kick(q: int) -> float:
    if q >= 8000:
        return 0.0
    t = q / SR
    # 音高从 ~145Hz 滑到 ~48Hz
    phase = 2.0 * math.pi * (48.0 * t + 97.0 * 0.035 * (1.0 - math.exp(-t / 0.035)))
    return 0.52 * math.exp(-q / 1900.0) * math.sin(phase)


def _hat(q8: int) -> float:
    if q8 >= 1400:
        return 0.0
    return 0.13 * math.exp(-q8 / 180.0) * _noise(q8 * 7 + 13)


def _snare(q: int) -> float:
    if q >= 3200:
        return 0.0
    return 0.18 * math.exp(-q / 900.0) * _noise(q + 101)


def _arp(i: int):
    """返回 (亮度波形, ) 一个八分音符拨弦。"""
    note_idx = (i // EIGHTH_FRAMES) % len(PENTA)
    q = i % EIGHTH_FRAMES
    f = PENTA[note_idx]
    t = q / SR
    env = min(1.0, q / 40.0) * math.exp(-q / 2600.0)
    tone = math.sin(2 * math.pi * f * t) + 0.28 * math.sin(4 * math.pi * f * t)
    return 0.15 * env * tone


def _bass(i: int, bars: int) -> float:
    bi = i // BEAT_FRAMES
    q = i % BEAT_FRAMES
    bar = bi // 4
    root = BASS_ROOTS[bar % len(BASS_ROOTS)]
    # 每小节第 1、3 拍长音，其他拍短促跳跃
    f = root if bi % 4 in (0, 2) else root * 1.5
    env = min(1.0, q / 60.0) * math.exp(-q / (5200.0 if bi % 4 in (0, 2) else 1500.0))
    return 0.20 * env * math.sin(2 * math.pi * f * (q / SR))


def compose_loop(kind: str, bars: int) -> list:
    n = bars * BAR_FRAMES
    left = array("d", [0.0]) * n
    right = array("d", [0.0]) * n
    mono = kind == "harbor_mono"

    for i in range(n):
        bi = i // BEAT_FRAMES
        q = i - bi * BEAT_FRAMES
        q8 = i % EIGHTH_FRAMES

        kick = _kick(q)
        bass = _bass(i, bars)
        arp = _arp(i)
        hat = _hat(q8)
        snare = _snare(q) if bi % 4 in (1, 3) else 0.0

        if kind == "garden_stereo":
            # 鼓和贝斯居中；琶音明显偏右，hat 偏右
            left[i] += kick + bass + snare * 0.9 + hat * 0.35
            right[i] += kick + bass + snare + arp + hat
            if i < MARKER_LEN:
                left[i] += marker_sample(i)       # 下拍标记只在左
        elif kind == "market_stereo":
            # 琶音在左，hat 偏左；与 garden 相反
            left[i] += kick + bass + snare + arp + hat
            right[i] += kick + bass + snare * 0.9 + hat * 0.35
            if i < MARKER_LEN:
                right[i] += marker_sample(i)      # 下拍标记只在右
        elif kind == "harbor_mono":
            v = kick * 0.9 + bass * 0.8 + arp * 0.7 + hat * 0.7 + snare * 0.8
            if i < MARKER_LEN:
                v += marker_sample(i) * 0.9
            left[i] += v
        else:
            raise ValueError("未知合成素材类型: %r" % kind)

    if mono:
        return [left]
    return [left, right]


def compose_sting() -> list:
    """无循环的一次性上扬音效，长度正好 1 拍（22050 采样）。"""
    n = BEAT_FRAMES
    ch = array("d", [0.0]) * n
    for i in range(n):
        t = i / SR
        f = 300.0 + 900.0 * (i / n) ** 2
        env = min(1.0, i / 80.0) * math.exp(-(i / n) * 1.2)
        ch[i] = 0.4 * env * math.sin(2 * math.pi * f * t)
    return [ch, array("d", ch)]  # 双声道相同


def _autoscale(channels: list, ceiling: float = 0.92):
    peak = 0.0
    for ch in channels:
        for x in ch:
            ax = abs(x)
            if ax > peak:
                peak = ax
    gain = min(1.0, ceiling / peak) if peak > ceiling else 1.0
    if gain != 1.0:
        for c in range(len(channels)):
            ch = channels[c]
            for i in range(len(ch)):
                ch[i] *= gain
    return peak, gain


DEMO_FILES = {
    "garden_stereo.wav": ("garden_stereo", 2),
    "market_stereo.wav": ("market_stereo", 1),
    "harbor_mono.wav": ("harbor_mono", 1),
}


def generate_all(out_dir) -> dict:
    """写出全部样例 WAV，返回 {文件名: {frames, channels, beats}}。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    info = {}

    for filename, (kind, bars) in DEMO_FILES.items():
        channels = compose_loop(kind, bars)
        _autoscale(channels)
        path = out / filename
        stats = write_wav_int16(str(path), channels, SR)
        beats = [k * BEAT_FRAMES for k in range(bars * 4)]
        info[filename] = {
            "frames": bars * BAR_FRAMES,
            "channels": len(channels),
            "beats": beats,
            "loop": [0, bars * BAR_FRAMES],
            "write_stats": stats,
        }

    sting = compose_sting()
    _autoscale(sting)
    stats = write_wav_int16(str(out / "sting_oneshot.wav"), sting, SR)
    info["sting_oneshot.wav"] = {
        "frames": BEAT_FRAMES, "channels": 2, "beats": [0],
        "loop": None, "write_stats": stats,
    }
    return info
