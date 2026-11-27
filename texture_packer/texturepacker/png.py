"""Minimal PNG codec built only on the Python standard library.

Supports reading and writing 8-bit grayscale / grayscale+alpha / RGB / RGBA
images with any standard filter type and no interlacing. Interlaced or
bit-depth-16 PNGs are rejected with a clear error rather than silently
mis-decoded. The rest of the packer works exclusively in RGBA.
"""

from __future__ import annotations

import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Color type -> channels
_GRAY = 0
_GRAY_ALPHA = 4
_RGB = 2
_RGBA = 6


class PngError(Exception):
    """Raised for unsupported or malformed PNG input."""


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _unfilter(raw: bytes, width: int, height: int, channels: int, bit_depth: int) -> bytes:
    if bit_depth != 8:
        raise PngError(f"only 8-bit PNGs are supported (got bit depth {bit_depth})")
    stride = width * channels
    out = bytearray(stride * height)
    pos = 0
    prev_line = bytearray(stride)
    for y in range(height):
        filter_type = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        if filter_type == 0:  # None
            pass
        elif filter_type == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filter_type == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev_line[i]) & 0xFF
        elif filter_type == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev_line[i]) >> 1)) & 0xFF
        elif filter_type == 4:  # Paeth
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                up_left = prev_line[i - channels] if i >= channels else 0
                line[i] = (line[i] + _paeth(left, prev_line[i], up_left)) & 0xFF
        else:
            raise PngError(f"unknown PNG filter type {filter_type}")
        start = y * stride
        out[start : start + stride] = line
        prev_line = line
    return bytes(out)


def read_png(path: str) -> dict:
    """Read a PNG file. Returns {width, height, pixels (RGBA bytes)}."""
    with open(path, "rb") as fh:
        data = fh.read()
    if not data.startswith(PNG_SIGNATURE):
        raise PngError(f"{path}: not a PNG file")
    pos = len(PNG_SIGNATURE)
    width = height = bit_depth = color_type = None
    interlaced = False
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        chunk_type = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        # CRC at pos + 8 + length (4 bytes), validated below
        expected_crc, = struct.unpack(
            ">I", data[pos + 8 + length : pos + 12 + length]
        )
        actual_crc = zlib.crc32(chunk_type + chunk) & 0xFFFFFFFF
        if expected_crc != actual_crc:
            raise PngError(f"{path}: CRC mismatch in {chunk_type.decode('latin1')} chunk")
        if chunk_type == b"IHDR":
            (
                width,
                height,
                bit_depth,
                color_type,
                compression,
                filter_method,
                interlace,
            ) = struct.unpack(">IIBBBBB", chunk)
            if compression != 0 or filter_method != 0:
                raise PngError(f"{path}: unsupported compression/filter method")
            if interlace != 0:
                interlaced = True
        elif chunk_type == b"IDAT":
            idat.extend(chunk)
        elif chunk_type == b"IEND":
            break
        pos += 12 + length

    if width is None:
        raise PngError(f"{path}: missing IHDR chunk")
    if interlaced:
        raise PngError(f"{path}: interlaced PNGs are not supported")
    if color_type not in (_GRAY, _GRAY_ALPHA, _RGB, _RGBA):
        raise PngError(f"{path}: unsupported color type {color_type}")
    if bit_depth not in (8,):
        raise PngError(f"{path}: only 8-bit channels are supported (got {bit_depth})")

    channels = {_GRAY: 1, _GRAY_ALPHA: 2, _RGB: 3, _RGBA: 4}[color_type]
    raw = zlib.decompress(bytes(idat))
    pixels = _unfilter(raw, width, height, channels, bit_depth)

    # Expand to RGBA
    rgba = bytearray(width * height * 4)
    if color_type == _RGBA:
        rgba[:] = pixels
    elif color_type == _RGB:
        for i in range(width * height):
            rgba[i * 4 : i * 4 + 3] = pixels[i * 3 : i * 3 + 3]
            rgba[i * 4 + 3] = 255
    elif color_type == _GRAY:
        for i in range(width * height):
            v = pixels[i]
            rgba[i * 4 : i * 4 + 3] = bytes((v, v, v))
            rgba[i * 4 + 3] = 255
    else:  # grayscale + alpha
        for i in range(width * height):
            v, a = pixels[i * 2], pixels[i * 2 + 1]
            rgba[i * 4 : i * 4 + 3] = bytes((v, v, v))
            rgba[i * 4 + 3] = a
    return {"width": width, "height": height, "pixels": bytes(rgba)}


def write_png(path: str, width: int, height: int, pixels: bytes) -> None:
    """Write an RGBA byte buffer as an 8-bit non-interlaced PNG."""
    if len(pixels) != width * height * 4:
        raise PngError(
            f"pixel buffer length {len(pixels)} does not match {width}x{height} RGBA"
        )
    stride = width * 4
    raw = bytearray()
    # Filter 0 (None) per scanline: deterministic, fast enough for local tooling,
    # and zlib still compresses the repeated transparent rows well.
    for y in range(height):
        raw.append(0)
        raw.extend(pixels[y * stride : (y + 1) * stride])
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(chunk_type: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + chunk_type
            + payload
            + struct.pack(">I", zlib.crc32(chunk_type + payload) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, _RGBA, 0, 0, 0)
    with open(path, "wb") as fh:
        fh.write(PNG_SIGNATURE)
        fh.write(chunk(b"IHDR", ihdr))
        fh.write(chunk(b"IDAT", compressed))
        fh.write(chunk(b"IEND", b""))
