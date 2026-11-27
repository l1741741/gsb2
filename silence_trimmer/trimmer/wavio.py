"""PCM WAV reading and writing without third-party packages.

Samples are held in memory as interleaved double-precision floats normalized to
the range [-1.0, 1.0] (full scale). The original sample width, channel count,
sample rate and float/PCM kind are remembered so the output matches the input
format whenever possible.

Supported formats: 8/16/24/32-bit integer PCM and 32-bit IEEE float, matching
what the standard-library :mod:`wave` module can read and write.
"""

from __future__ import annotations

import array
import math
import os
import wave
from dataclasses import dataclass

# Mapping of sample width -> the array type used for that PCM width.
_PCM_ARRAY = {1: "b", 2: "h", 4: "i"}  # 24-bit has no native array type.


@dataclass
class WaveData:
    """Decoded WAV audio.

    Attributes:
        samples: interleaved float samples, length = frames * channels.
        sample_rate: frames per second.
        channels: number of interleaved channels.
        sampwidth: original sample width in bytes.
        is_float: True when the source was 32-bit IEEE float.
    """

    samples: array.array
    sample_rate: int
    channels: int
    sampwidth: int
    is_float: bool

    @property
    def frames(self) -> int:
        return len(self.samples) // self.channels

    @property
    def duration(self) -> float:
        return self.frames / self.sample_rate


def _decode_pcm(raw: bytes, sampwidth: int, channels: int) -> array.array:
    """Decode little-endian integer PCM bytes to normalized float samples."""
    out = array.array("d")
    if sampwidth == 1:
        # 8-bit PCM is unsigned, centred at 128.
        for byte in raw:
            out.append((byte - 128) / 128.0)
        return out

    if sampwidth == 2:
        vals = array.array("h")
        vals.frombytes(raw)
        for v in vals:
            out.append(v / 32768.0)
        return out

    if sampwidth == 3:
        # 24-bit little-endian signed, no native array type.
        n = len(raw) // 3
        for i in range(n):
            b0, b1, b2 = raw[i * 3], raw[i * 3 + 1], raw[i * 3 + 2]
            v = b0 | (b1 << 8) | (b2 << 16)
            if v & 0x800000:
                v -= 1 << 24
            out.append(v / 8388608.0)
        return out

    if sampwidth == 4:
        vals = array.array("i")
        vals.frombytes(raw)
        for v in vals:
            # Divide by 2**31; -2**31 simply saturates to -1.0.
            out.append(v / 2147483648.0)
        return out

    raise ValueError(f"unsupported PCM sample width: {sampwidth} bytes")


def _decode_float(raw: bytes) -> array.array:
    vals = array.array("f")
    vals.frombytes(raw)
    out = array.array("d", (float(v) for v in vals))
    return out


def read_wav(path: str) -> WaveData:
    """Read a WAV file into a :class:`WaveData`."""
    is_float = _peek_float_tag(path)
    if is_float:
        return _read_float_wav(path)

    with wave.open(path, "rb") as wf:
        channels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sample_rate = wf.getframerate()
        n_frames = wf.getnframes()
        comptype = wf.getcomptype()
        raw = wf.readframes(n_frames)

    if comptype != "NONE":
        raise ValueError(f"compressed WAV is not supported: {comptype}")
    samples = _decode_pcm(raw, sampwidth, channels)

    if len(samples) != n_frames * channels:
        raise ValueError("WAV frame count did not match the decoded sample count")
    return WaveData(samples, sample_rate, channels, sampwidth, False)


def _read_float_wav(path: str) -> WaveData:
    """Parse a 32-bit IEEE-float WAV directly (the wave module rejects tag 3)."""
    import struct

    with open(path, "rb") as fh:
        blob = fh.read()
    if blob[:4] != b"RIFF" or blob[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")

    offset = 12
    fmt_fields = None
    data = None
    while offset + 8 <= len(blob):
        chunk_id = blob[offset:offset + 4]
        (chunk_size,) = struct.unpack_from("<I", blob, offset + 4)
        body = offset + 8
        if chunk_id == b"fmt ":
            (tag, channels, sample_rate, _byte_rate, _block, bits) = struct.unpack_from(
                "<HHIIHH", blob, body
            )
            if tag != 3:
                raise ValueError(f"expected IEEE float tag (3), got {tag}")
            if bits != 32:
                raise ValueError("only 32-bit float WAV is supported")
            fmt_fields = (channels, sample_rate)
        elif chunk_id == b"data":
            data = blob[body:body + chunk_size]
        # Chunks are word-aligned (even sizes); pad byte follows odd sizes.
        offset = body + chunk_size + (chunk_size & 1)

    if fmt_fields is None or data is None:
        raise ValueError("float WAV is missing a fmt or data chunk")
    channels, sample_rate = fmt_fields
    samples = _decode_float(data)
    n_frames = len(samples) // channels
    return WaveData(samples, sample_rate, channels, 4, True)


def _peek_float_tag(path: str) -> bool:
    """Return True when the RIFF header declares WAVE_FORMAT_IEEE_FLOAT (3)."""
    try:
        with open(path, "rb") as fh:
            header = fh.read(36)
        if len(header) < 24 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            return False
        # fmt chunk: bytes 20..21 hold wFormatTag as a little-endian short.
        if header[12:16] != b"fmt ":
            return False
        tag = header[20] | (header[21] << 8)
        return tag == 3
    except OSError:
        return False


def _clamp(v: float) -> float:
    if v > 1.0:
        return 1.0
    if v < -1.0:
        return -1.0
    return v


def _encode_pcm(samples: array.array, sampwidth: int) -> bytes:
    """Encode normalized float samples to little-endian integer PCM bytes."""
    if sampwidth == 1:
        out = bytearray(len(samples))
        for i, v in enumerate(samples):
            q = int(round(_clamp(v) * 128.0)) + 128
            out[i] = 0 if q < 0 else (255 if q > 255 else q)
        return bytes(out)

    if sampwidth == 2:
        vals = array.array("h")
        for v in samples:
            q = int(round(_clamp(v) * 32768.0))
            vals.append(32767 if q > 32767 else (-32768 if q < -32768 else q))
        return vals.tobytes()

    if sampwidth == 3:
        out = bytearray(len(samples) * 3)
        for i, v in enumerate(samples):
            q = int(round(_clamp(v) * 8388608.0))
            if q > 8388607:
                q = 8388607
            elif q < -8388608:
                q = -8388608
            if q < 0:
                q += 1 << 24
            base = i * 3
            out[base] = q & 0xFF
            out[base + 1] = (q >> 8) & 0xFF
            out[base + 2] = (q >> 16) & 0xFF
        return bytes(out)

    if sampwidth == 4:
        vals = array.array("i")
        for v in samples:
            q = int(round(_clamp(v) * 2147483648.0))
            vals.append(2147483647 if q > 2147483647 else (-2147483648 if q < -2147483648 else q))
        return vals.tobytes()

    raise ValueError(f"unsupported PCM sample width: {sampwidth} bytes")


def _encode_float(samples: array.array) -> bytes:
    vals = array.array("f", (_clamp(v) for v in samples))
    return vals.tobytes()


def write_wav(path: str, audio: WaveData) -> None:
    """Write a :class:`WaveData` to ``path`` using its stored format.

    PCM widths go through the standard-library :mod:`wave` module; float WAVs
    need a ``WAVE_FORMAT_IEEE_FLOAT`` format tag that :mod:`wave` cannot emit,
    so they are assembled as RIFF bytes directly.

    The caller is responsible for atomic publication; this function only writes
    the file it is given.
    """
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)

    if audio.is_float:
        if audio.sampwidth != 4:
            raise ValueError("float WAV output requires a 4-byte sample width")
        _write_float_wav(path, audio)
        return

    raw = _encode_pcm(audio.samples, audio.sampwidth)
    with wave.open(path, "wb") as wf:
        wf.setnchannels(audio.channels)
        wf.setsampwidth(audio.sampwidth)
        wf.setframerate(audio.sample_rate)
        wf.writeframes(raw)


def _write_float_wav(path: str, audio: WaveData) -> None:
    """Emit a 32-bit IEEE-float WAV (format tag 3) without external libraries."""
    import struct

    raw = _encode_float(audio.samples)
    channels = audio.channels
    sample_rate = audio.sample_rate
    byte_rate = sample_rate * channels * 4
    block_align = channels * 4
    fmt_chunk = struct.pack(
        "<HHIIHH",
        3,  # wFormatTag = WAVE_FORMAT_IEEE_FLOAT
        channels,
        sample_rate,
        byte_rate,
        block_align,
        32,  # wBitsPerSample
    )
    data_size = len(raw)
    riff_size = 4 + (8 + len(fmt_chunk)) + (8 + data_size)
    with open(path, "wb") as fh:
        fh.write(b"RIFF")
        fh.write(struct.pack("<I", riff_size))
        fh.write(b"WAVE")
        fh.write(b"fmt ")
        fh.write(struct.pack("<I", len(fmt_chunk)))
        fh.write(fmt_chunk)
        fh.write(b"data")
        fh.write(struct.pack("<I", data_size))
        fh.write(raw)


def format_timestamp(seconds: float) -> str:
    """Render seconds as ``HH:MM:SS.mmm`` for reports."""
    if seconds < 0 or math.isnan(seconds):
        return "DELETED"
    total_ms = int(round(seconds * 1000.0))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"
