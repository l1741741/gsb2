"""Minimal, dependency-free PCM WAV reader/writer.

Only the RIFF/WAVE formats the tool can losslessly round-trip are supported:

* 16-bit signed PCM  (fmt tag 1)
* 24-bit signed PCM  (fmt tag 1)
* 32-bit signed PCM  (fmt tag 1)
* 32-bit float       (fmt tag 3)

The reader keeps the raw interleaved samples as integer "code units" so that
every sample round-trips bit-exactly. 24-bit values are stored as Python ints
in ``[-8388608, 8388607]``; 32-bit float values are stored as Python floats.
Nothing is ever converted through a lossy intermediate representation.
"""

from __future__ import annotations

import hashlib
import struct
from dataclasses import dataclass

from .errors import WavError

# fmt chunk tags
FORMAT_PCM = 1
FORMAT_IEEE_FLOAT = 3

# (bits per sample, format tag) -> (codec name, integer/float flag)
SUPPORTED_FORMATS = {
    (16, FORMAT_PCM): "pcm_s16le",
    (24, FORMAT_PCM): "pcm_s24le",
    (32, FORMAT_PCM): "pcm_s32le",
    (32, FORMAT_IEEE_FLOAT): "pcm_f32le",
}

_MAX_SAMPLES = 64_000_000  # guard against absurd allocations from a hostile header


@dataclass(frozen=True)
class Audio:
    """Decoded PCM audio.

    ``samples`` is a flat, interleaved list of code units. ``sample(t, c)``
    returns the value for frame ``t`` and channel ``c``. For integer formats
    the values are ints in the format's natural range; for float formats they
    are floats.
    """

    channels: int
    sample_rate: int
    codec: str
    samples: list
    source_sha256: str = ""
    source_path: str = ""

    @property
    def frames(self) -> int:
        return len(self.samples) // self.channels

    @property
    def is_float(self) -> bool:
        return self.codec == "pcm_f32le"

    def clone(self) -> "Audio":
        return Audio(
            channels=self.channels,
            sample_rate=self.sample_rate,
            codec=self.codec,
            samples=list(self.samples),
            source_sha256=self.source_sha256,
            source_path=self.source_path,
        )

    def channel_values(self, channel: int, start: int, stop: int) -> list:
        """Return the values of ``channel`` for frames ``[start, stop)``."""
        ch = self.channels
        base = start * ch + channel
        return self.samples[base: base + (stop - start) * ch: ch]

    def code_unit_scale(self) -> float:
        """Full-scale magnitude of one code unit, used to normalise thresholds."""
        if self.is_float:
            return 1.0
        return 2 ** (_bits(self.codec) - 1)

    def normalize(self, value) -> float:
        """Convert a code unit to a float in roughly [-1, 1]."""
        return float(value) / self.code_unit_scale()


_SAMPLE_CODE = {
    "pcm_s16le": "h",
    "pcm_s32le": "i",
    "pcm_f32le": "f",
}


def read_wav(path: str) -> Audio:
    """Read a PCM WAV file and return :class:`Audio`."""
    try:
        with open(path, "rb") as handle:
            data = handle.read()
    except OSError as exc:
        raise WavError(f"cannot open {path!r}: {exc}") from exc

    if len(data) < 12:
        raise WavError(f"{path!r} is too small to be a WAV file")
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise WavError(f"{path!r} is not a RIFF/WAVE file")

    fmt = None
    payload = None
    data_chunk_found = False
    offset = 12
    while offset + 8 <= len(data):
        chunk_id = data[offset: offset + 4]
        chunk_size = struct.unpack_from("<I", data, offset + 4)[0]
        body_start = offset + 8
        body_end = body_start + chunk_size
        if body_end > len(data):
            raise WavError(f"{path!r} has a truncated {chunk_id!r} chunk")
        body = data[body_start:body_end]
        if chunk_id == b"fmt ":
            if fmt is None:
                fmt = _parse_fmt(body, path)
        elif chunk_id == b"data":
            if payload is None:
                payload = body
                data_chunk_found = True
        # Unknown chunks are skipped; RIFF chunks are word aligned.
        offset = body_end + (chunk_size & 1)

    if fmt is None:
        raise WavError(f"{path!r} has no fmt chunk")
    if not data_chunk_found:
        raise WavError(f"{path!r} has no data chunk")

    channels, sample_rate, codec, block_align = fmt
    if block_align != channels * _bytes_per_sample(codec):
        raise WavError(
            f"{path!r} has an inconsistent block align "
            f"({block_align} != {channels} * {_bytes_per_sample(codec)})"
        )
    if len(payload) % block_align != 0:
        raise WavError(
            f"{path!r} data length {len(payload)} is not a multiple of "
            f"block align {block_align}"
        )
    frame_count = len(payload) // block_align
    if frame_count * channels > _MAX_SAMPLES:
        raise WavError(f"{path!r} declares too many samples")

    samples = _decode_samples(payload, codec)

    digest = hashlib.sha256(data).hexdigest()
    return Audio(
        channels=channels,
        sample_rate=sample_rate,
        codec=codec,
        samples=samples,
        source_sha256=digest,
        source_path=path,
    )


def write_wav(path: str, audio: Audio) -> None:
    """Write ``audio`` to ``path`` as a canonical PCM WAV file.

    The header layout is fixed (RIFF/WAVE, ``fmt `` 16 bytes for PCM or 18
    bytes with the ``cbSize`` extension for float, then ``data``) so that
    byte-for-byte determinism is achievable. The number of frames, the sample
    rate and the channel layout are taken from ``audio`` unchanged.
    """
    payload = _encode_samples(audio.samples, audio.codec)
    fmt_tag = FORMAT_IEEE_FLOAT if audio.is_float else FORMAT_PCM
    bits = _bits(codec=audio.codec)
    block_align = audio.channels * _bytes_per_sample(audio.codec)

    if audio.is_float:
        # Float WAVs carry an 18-byte fmt chunk: the 16-byte core plus a
        # cbSize field of 0. The payload has no extra bytes.
        fmt_chunk = (
            struct.pack(
                "<HHIIHH",
                fmt_tag,
                audio.channels,
                audio.sample_rate,
                audio.sample_rate * block_align,
                block_align,
                bits,
            )
            + struct.pack("<H", 0)
        )
    else:
        fmt_chunk = struct.pack(
            "<HHIIHH",
            fmt_tag,
            audio.channels,
            audio.sample_rate,
            audio.sample_rate * block_align,
            block_align,
            bits,
        )

    riff_payload = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt_chunk)) + fmt_chunk
    riff_payload += b"data" + struct.pack("<I", len(payload)) + payload

    try:
        with open(path, "wb") as handle:
            handle.write(b"RIFF")
            handle.write(struct.pack("<I", len(riff_payload)))
            handle.write(riff_payload)
    except OSError as exc:
        raise WavError(f"cannot write {path!r}: {exc}") from exc


def _parse_fmt(body: bytes, path: str):
    if len(body) < 16:
        raise WavError(f"{path!r} has a short fmt chunk")
    fmt_tag, channels, sample_rate, _byte_rate, block_align, bits = struct.unpack_from(
        "<HHIIHH", body, 0
    )
    if fmt_tag == 0xFFFE:  # WAVE_FORMAT_EXTENSIBLE: real format lives in the sub-format
        if len(body) < 40:
            raise WavError(f"{path!r} has a short extensible fmt chunk")
        sub_tag = struct.unpack_from("<H", body, 24)[0]
        fmt_tag = sub_tag
    codec = SUPPORTED_FORMATS.get((bits, fmt_tag))
    if codec is None:
        hint = _extensible_hint(bits, fmt_tag)
        raise WavError(
            f"{path!r} uses an unsupported sample format ({bits}-bit, "
            f"format tag {fmt_tag}){hint}; supported formats are "
            "16/24/32-bit signed PCM and 32-bit float"
        )
    if channels < 1:
        raise WavError(f"{path!r} declares {channels} channels")
    if sample_rate < 1:
        raise WavError(f"{path!r} declares sample rate {sample_rate}")
    return channels, sample_rate, codec, block_align


def _extensible_hint(bits: int, tag: int) -> str:
    if (bits, tag) in ((64, FORMAT_IEEE_FLOAT),):
        return " (64-bit float is not supported)"
    return ""


_CODEC_BITS = {
    "pcm_s16le": 16,
    "pcm_s24le": 24,
    "pcm_s32le": 32,
    "pcm_f32le": 32,
}


def _bits(codec: str) -> int:
    return _CODEC_BITS[codec]


def _bytes_per_sample(codec: str) -> int:
    return _CODEC_BITS[codec] // 8


def _decode_samples(payload: bytes, codec: str) -> list:
    if codec == "pcm_s24le":
        count = len(payload) // 3
        raw = bytearray(count * 4)
        raw[0::4] = payload[0::3]  # least significant byte
        raw[1::4] = payload[1::3]
        raw[2::4] = payload[2::3]  # most significant byte
        values = list(struct.unpack(f"<{count}i", bytes(raw)))
        # Sign extend the 24-bit magnitude into a signed value.
        return [v - 0x1000000 if v >= 0x800000 else v for v in values]
    count = len(payload) // _bytes_per_sample(codec)
    return list(struct.unpack(f"<{count}{_SAMPLE_CODE[codec]}", payload))


def _encode_samples(samples: list, codec: str) -> bytes:
    if codec == "pcm_s24le":
        count = len(samples)
        unsigned = [(int(s) & 0xFFFFFF) for s in samples]
        raw = struct.pack(f"<{count}I", *unsigned)
        out = bytearray(count * 3)
        out[0::3] = raw[0::4]
        out[1::3] = raw[1::4]
        out[2::3] = raw[2::4]
        return bytes(out)
    count = len(samples)
    if codec == "pcm_f32le":
        values = [float(s) for s in samples]
    else:
        values = [int(s) for s in samples]
    return struct.pack(f"<{count}{_SAMPLE_CODE[codec]}", *values)
