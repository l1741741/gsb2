"""WAV 读写（纯标准库）。

读取：支持 8/16/24/32-bit PCM，多声道自动混合为单声道，返回 -1.0~1.0 浮点样本。
写出：16-bit PCM 单声道。
"""

from __future__ import annotations

import struct
import wave
from array import array


def read_wav(path):
    """读取 WAV，返回 (samples, sample_rate)。samples 为 array('f') 单声道浮点。"""
    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        rate = wf.getframerate()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)

    if width == 1:
        ints = array("b", raw)  # 8-bit PCM 为无符号，下面单独处理
        ints = array("i", (b - 128 for b in raw))
        scale = 128.0
    elif width == 2:
        ints = array("h")
        ints.frombytes(raw)
        scale = 32768.0
    elif width == 3:
        ints = array("i", (0,) * (len(raw) // 3))
        for i in range(len(ints)):
            b = raw[3 * i : 3 * i + 3]
            v = int.from_bytes(b, "little", signed=False)
            if v >= 1 << 23:
                v -= 1 << 24
            ints[i] = v
        scale = float(1 << 23)
    elif width == 4:
        ints = array("i")
        ints.frombytes(raw)
        scale = float(1 << 31)
    else:
        raise ValueError(f"不支持的采样位宽: {width * 8} bit ({path})")

    if channels == 1:
        return array("f", (v / scale for v in ints)), rate

    # 多声道混合为单声道（各声道取平均）
    mono = array("f", (0.0,) * (len(ints) // channels))
    inv = 1.0 / (channels * scale)
    for i in range(len(mono)):
        acc = 0
        base = i * channels
        for c in range(channels):
            acc += ints[base + c]
        mono[i] = acc * inv
    return mono, rate


def write_wav(path, samples, rate):
    """写出 16-bit PCM 单声道 WAV。samples 为 -1.0~1.0 浮点序列，超界会被截断。"""
    pcm = array("h", (0,) * len(samples))
    for i, s in enumerate(samples):
        v = int(round(s * 32767.0))
        if v > 32767:
            v = 32767
        elif v < -32768:
            v = -32768
        pcm[i] = v
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(pcm.tobytes())
