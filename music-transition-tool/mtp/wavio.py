"""最小 WAV 读写器，只用标准库。

读取：PCM 8-bit(unsigned) / 16 / 24 / 32-bit signed，单声道或多声道。
内部统一用 [-1, 1] 的 float64（Python float）array('d')，按声道存放。
写出：16-bit signed PCM。16-bit 素材在单位增益区间经 /32768 -> *32768
的 2 的幂往返后保持整数不变，因此无重叠切换段可以和源 WAV 逐采样一致。
"""

from __future__ import annotations

import sys
import wave
from array import array
from dataclasses import dataclass


@dataclass
class WavData:
    sample_rate: int
    channels: list  # list[array('d')]，每个元素一条声道
    raw_sample_width: int = 2

    @property
    def n_frames(self) -> int:
        return len(self.channels[0]) if self.channels else 0

    @property
    def n_channels(self) -> int:
        return len(self.channels)


def _bytes_to_int_samples(raw: bytes, width: int) -> array:
    """把小端 PCM 字节流转成本机有符号整数 array('i')。"""
    if width == 2:
        vals = array("h")
        vals.frombytes(raw)
        if sys.byteorder != "little":
            vals.byteswap()
        return vals
    if width == 4:
        vals = array("i")
        vals.frombytes(raw)
        if sys.byteorder != "little":
            vals.byteswap()
        return vals
    if width == 1:
        # 8-bit WAV 是无符号的
        return array("i", ((b - 128) * 256 for b in raw))
    if width == 3:
        vals = array("i")
        n = len(raw) // 3
        for i in range(n):
            j = i * 3
            v = raw[j] | (raw[j + 1] << 8) | (raw[j + 2] << 16)
            if v & 0x800000:
                v -= 1 << 24
            vals.append(v)
        return vals
    raise ValueError("不支持的采样位宽: %d 字节" % width)


def read_wav(path: str) -> WavData:
    try:
        wf = wave.open(path, "rb")
    except wave.Error as exc:
        raise ValueError("无法读取 WAV %s: %s" % (path, exc)) from exc
    try:
        nch = wf.getnchannels()
        width = wf.getsampwidth()
        sr = wf.getframerate()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)
    finally:
        wf.close()

    ints = _bytes_to_int_samples(raw, width)
    # 归一化分母按位宽取 2^(8*width-1)
    scale = float(1 << (8 * width - 1)) if width != 1 else 32768.0
    channels = []
    for c in range(nch):
        mono = array("d")
        # 扩展切片在 array 上可用，且这是 C 层拷贝；再逐个归一化
        sub = ints[c::nch]
        mono = array("d", (v / scale for v in sub))
        channels.append(mono)
    return WavData(sample_rate=sr, channels=channels, raw_sample_width=width)


def quantize_int16(channels: list, out_gain: float = 1.0):
    """float 声道 -> int16 array('h') 声道。

    返回 (int_channels, peak, clipped_frames)。clipped_frames 按“有任意
    声道被钳位的帧”计数。
    """
    out = []
    peak = 0.0
    clipped_frames = 0
    n = len(channels[0]) if channels else 0
    for i in range(n):
        frame_clipped = False
        int_ch = []
        for ch in channels:
            x = ch[i] * out_gain
            ax = abs(x)
            if ax > peak:
                peak = ax
            y = int(x * 32768.0 + (0.5 if x * 32768.0 >= 0 else -0.5))
            if y > 32767:
                y = 32767
                frame_clipped = True
            elif y < -32768:
                y = -32768
                frame_clipped = True
            int_ch.append(y)
        if frame_clipped:
            clipped_frames += 1
        for c, y in enumerate(int_ch):
            if len(out) <= c:
                out.append(array("h"))
            out[c].append(y)
    return out, peak, clipped_frames


def write_wav_int16(path: str, channels: list, sample_rate: int, out_gain: float = 1.0):
    int_channels, peak, clipped = quantize_int16(channels, out_gain)
    nch = len(int_channels)
    n = len(int_channels[0]) if int_channels else 0
    interleaved = array("h")
    for i in range(n):
        for c in range(nch):
            interleaved.append(int_channels[c][i])
    if sys.byteorder != "little":
        interleaved.byteswap()
    wf = wave.open(path, "wb")
    try:
        wf.setnchannels(nch)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(interleaved.tobytes())
    finally:
        wf.close()
    return {"peak_amplitude": peak, "clipped_frames": clipped, "frames": n}


def wav_info(path: str) -> dict:
    wf = wave.open(path, "rb")
    try:
        return {
            "channels": wf.getnchannels(),
            "sample_width_bytes": wf.getsampwidth(),
            "sample_rate": wf.getframerate(),
            "frames": wf.getnframes(),
        }
    finally:
        wf.close()
