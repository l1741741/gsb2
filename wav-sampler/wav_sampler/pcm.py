"""PCM 整数样本与 WAVE 容器处理。

只支持未压缩 PCM (格式码 1)。采样位深支持 8/16/24/32 bit。
注意: Python 3.13 起标准库 audioop 已被移除, 因此这里自行实现
整数 PCM 与有符号归一化整数之间的转换。

约定:
- 内部以「每通道有符号整数」表示样本。
- 8 bit WAV 是无符号 (偏置 128), 其余位深均为有符号小端。
"""

from __future__ import annotations

import struct
import wave

SUPPORTED_SAMPLE_WIDTHS = (1, 2, 3, 4)
WAVE_FORMAT_PCM = 1


class PcmError(ValueError):
    """WAV 文件不是受支持的 PCM 数据。"""


def max_amplitude(sample_width: int) -> int:
    """给定字节宽度对应的满量程正振幅。"""
    if sample_width not in SUPPORTED_SAMPLE_WIDTHS:
        raise PcmError(f"unsupported sample width: {sample_width} bytes")
    return (1 << (8 * sample_width - 1)) - 1


def min_amplitude(sample_width: int) -> int:
    return -(1 << (8 * sample_width - 1))


def decode_bytes(raw: bytes, sample_width: int) -> list[int]:
    """把交织 PCM 字节解码为有符号整数样本列表 (含全部声道)。"""
    if sample_width == 1:
        # 8 bit PCM: 无符号, 中点 128
        return [b - 128 for b in raw]
    if sample_width == 2:
        return list(struct.unpack("<" + "h" * (len(raw) // 2), raw))
    if sample_width == 4:
        return list(struct.unpack("<" + "i" * (len(raw) // 4), raw))
    if sample_width == 3:
        out: list[int] = []
        for i in range(0, len(raw), 3):
            b0, b1, b2 = raw[i], raw[i + 1], raw[i + 2]
            value = b0 | (b1 << 8) | (b2 << 16)
            if value & 0x800000:
                value -= 1 << 24
            out.append(value)
        return out
    raise PcmError(f"unsupported sample width: {sample_width} bytes")


def encode_samples(samples: list[int], sample_width: int) -> bytes:
    """把有符号整数样本列表编码为交织 PCM 字节。"""
    if sample_width == 1:
        return bytes(_clamp(v, sample_width) + 128 for v in samples)
    if sample_width == 2:
        return struct.pack("<" + "h" * len(samples), *(_clamp(v, 2) for v in samples))
    if sample_width == 4:
        return struct.pack("<" + "i" * len(samples), *(_clamp(v, 4) for v in samples))
    if sample_width == 3:
        out = bytearray()
        for value in samples:
            value = _clamp(value, 3)
            if value < 0:
                value += 1 << 24
            out.append(value & 0xFF)
            out.append((value >> 8) & 0xFF)
            out.append((value >> 16) & 0xFF)
        return bytes(out)
    raise PcmError(f"unsupported sample width: {sample_width} bytes")


def _clamp(value: int, sample_width: int) -> int:
    lo = min_amplitude(sample_width)
    hi = max_amplitude(sample_width)
    if value < lo:
        return lo
    if value > hi:
        return hi
    return value


def silence_sample(sample_width: int) -> int:
    """该位深下的静音原始字节值 (逐字节填充用)。"""
    return 0x80 if sample_width == 1 else 0


def open_wave(path: str) -> wave.Wave_read:
    """打开 WAV 并校验为受支持的 PCM。"""
    try:
        wf = wave.open(path, "rb")
    except (wave.Error, EOFError, FileNotFoundError, OSError) as exc:
        raise PcmError(f"无法打开 WAV 文件 {path}: {exc}") from exc
    if wf.getcomptype() != "NONE":
        wf.close()
        raise PcmError(f"{path}: 仅支持未压缩 PCM, 实际压缩类型 {wf.getcomptype()!r}")
    if wf.getsampwidth() not in SUPPORTED_SAMPLE_WIDTHS:
        width = wf.getsampwidth()
        wf.close()
        raise PcmError(f"{path}: 不支持的采样位深 {width * 8} bit")
    return wf


def make_writer(
    path: str,
    *,
    channels: int,
    sample_width: int,
    frame_rate: int,
) -> wave.Wave_write:
    wf = wave.open(path, "wb")
    wf.setnchannels(channels)
    wf.setsampwidth(sample_width)
    wf.setframerate(frame_rate)
    return wf
