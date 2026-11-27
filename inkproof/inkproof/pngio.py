"""Dependency-free PNG reading and writing.

The tool deliberately has no third-party dependencies.  This module implements
the subset of PNG that matters for spot-colour proofing well enough to read
normal RGBA artwork (8/16-bit, interlaced or not, palette or direct colour)
and to write byte-for-byte deterministic RGBA8 and grayscale8 files.

Writing never embeds timestamps or other volatile metadata, which is what
makes ``inkproof run --check`` able to compare regenerated files exactly.
"""

from __future__ import annotations

import os
import re
import struct
import tempfile
import zlib
from dataclasses import dataclass, field

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
_VALID_DEPTHS = {
    0: {1, 2, 4, 8, 16},
    2: {8, 16},
    3: {1, 2, 4, 8},
    4: {8, 16},
    6: {8, 16},
}
_COLOR_TYPE_NAMES = {
    0: "grayscale",
    2: "rgb",
    3: "palette",
    4: "grayscale+alpha",
    6: "rgba",
}
_ADAM7 = (
    (0, 0, 8, 8),
    (4, 0, 8, 8),
    (0, 4, 4, 8),
    (2, 0, 4, 4),
    (0, 2, 2, 4),
    (1, 0, 2, 2),
    (0, 1, 1, 2),
)


class PNGError(ValueError):
    """Raised when a PNG file is malformed or uses an unsupported feature."""


@dataclass
class Image:
    """An 8-bit straight-alpha RGBA image with a flat bytearray payload."""

    width: int
    height: int
    data: bytearray
    color_type: int = 6
    bit_depth: int = 8

    def __post_init__(self) -> None:
        if self.width <= 0 or self.height <= 0:
            raise ValueError("image dimensions must be positive")
        expected = self.width * self.height * 4
        if len(self.data) != expected:
            raise ValueError(
                f"RGBA payload has {len(self.data)} bytes, expected {expected}"
            )

    def pixel(self, x: int, y: int) -> tuple[int, int, int, int]:
        index = (y * self.width + x) * 4
        return (
            self.data[index],
            self.data[index + 1],
            self.data[index + 2],
            self.data[index + 3],
        )

    def set_pixel(self, x: int, y: int, rgba: tuple[int, int, int, int]) -> None:
        index = (y * self.width + x) * 4
        self.data[index : index + 4] = bytes(rgba)

    def crop(self, x: int, y: int, width: int, height: int) -> "Image":
        if x < 0 or y < 0 or width <= 0 or height <= 0:
            raise ValueError("crop rectangle must be positive and inside the image")
        if x + width > self.width or y + height > self.height:
            raise ValueError("crop rectangle must be inside the image")
        out = bytearray(width * height * 4)
        row_bytes = width * 4
        for row in range(height):
            src = ((y + row) * self.width + x) * 4
            dst = row * row_bytes
            out[dst : dst + row_bytes] = self.data[src : src + row_bytes]
        return Image(width, height, out)


@dataclass(frozen=True)
class _Chunk:
    kind: bytes
    data: bytes


def _iter_chunks(blob: bytes) -> list[_Chunk]:
    if not blob.startswith(PNG_SIGNATURE):
        raise PNGError("not a PNG file (bad signature)")
    chunks: list[_Chunk] = []
    position = len(PNG_SIGNATURE)
    while position < len(blob):
        if position + 8 > len(blob):
            raise PNGError("truncated PNG chunk header")
        length, kind = struct.unpack(">I4s", blob[position : position + 8])
        end = position + 8 + length
        if end + 4 > len(blob):
            raise PNGError(f"truncated PNG chunk {kind!r}")
        payload = blob[position + 8 : end]
        expected_crc = struct.unpack(">I", blob[end : end + 4])[0]
        actual_crc = zlib.crc32(kind + payload) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise PNGError(f"CRC mismatch in PNG chunk {kind!r}")
        chunks.append(_Chunk(kind, payload))
        position = end + 4
        if kind == b"IEND":
            break
    else:
        raise PNGError("PNG file has no IEND chunk")
    return chunks


def _parse_ihdr(data: bytes) -> tuple[int, int, int, int, int, int]:
    if len(data) != 13:
        raise PNGError("IHDR chunk must be 13 bytes")
    width, height, depth, color_type, compression, filter_method, interlace = (
        struct.unpack(">IIBBBBB", data)
    )
    if width <= 0 or height <= 0:
        raise PNGError("PNG width and height must be positive")
    if color_type not in _CHANNELS:
        raise PNGError(f"unsupported PNG colour type {color_type}")
    if depth not in _VALID_DEPTHS[color_type]:
        raise PNGError(
            f"unsupported bit depth {depth} for PNG colour type {color_type}"
        )
    if compression != 0 or filter_method != 0:
        raise PNGError("unsupported PNG compression or filter method")
    if interlace not in (0, 1):
        raise PNGError(f"unsupported PNG interlace method {interlace}")
    return width, height, depth, color_type, interlace, 0


def _pass_size(size: int, start: int, step: int) -> int:
    if size <= start:
        return 0
    return (size - start + step - 1) // step


def _unfilter_pass(
    raw: bytes,
    offset: int,
    row_bytes: int,
    rows: int,
    bpp: int,
) -> tuple[bytearray, int]:
    out = bytearray(row_bytes * rows)
    previous = bytearray(row_bytes)
    for row_index in range(rows):
        if offset + 1 + row_bytes > len(raw):
            raise PNGError("PNG image data ended while reading a scanline")
        filter_type = raw[offset]
        offset += 1
        row = bytearray(raw[offset : offset + row_bytes])
        offset += row_bytes
        if filter_type == 0:
            pass
        elif filter_type == 1:  # Sub
            for index in range(row_bytes):
                left = row[index - bpp] if index >= bpp else 0
                row[index] = (row[index] + left) & 0xFF
        elif filter_type == 2:  # Up
            for index in range(row_bytes):
                row[index] = (row[index] + previous[index]) & 0xFF
        elif filter_type == 3:  # Average
            for index in range(row_bytes):
                left = row[index - bpp] if index >= bpp else 0
                row[index] = (row[index] + ((left + previous[index]) >> 1)) & 0xFF
        elif filter_type == 4:  # Paeth
            for index in range(row_bytes):
                left = row[index - bpp] if index >= bpp else 0
                up = previous[index]
                upper_left = previous[index - bpp] if index >= bpp else 0
                estimate = left + up - upper_left
                pa = abs(estimate - left)
                pb = abs(estimate - up)
                pc = abs(estimate - upper_left)
                if pa <= pb and pa <= pc:
                    predictor = left
                elif pb <= pc:
                    predictor = up
                else:
                    predictor = upper_left
                row[index] = (row[index] + predictor) & 0xFF
        else:
            raise PNGError(f"unsupported PNG filter type {filter_type}")
        start = row_index * row_bytes
        out[start : start + row_bytes] = row
        previous = row
    return out, offset


def _row_samples(row: bytes, width: int, channels: int, depth: int) -> list[int]:
    """Return raw sample values for one scanline."""
    count = width * channels
    if depth == 8:
        return list(row[:count])
    if depth == 16:
        return [
            (row[index * 2] << 8) | row[index * 2 + 1]
            for index in range(count)
        ]
    samples: list[int] = []
    bit_offset = 0
    mask = (1 << depth) - 1
    for _ in range(count):
        byte_index = bit_offset // 8
        shift = 8 - depth - (bit_offset % 8)
        samples.append((row[byte_index] >> shift) & mask)
        bit_offset += depth
    return samples


def _to_8bit(value: int, depth: int) -> int:
    if depth == 8:
        return value
    if depth == 16:
        return value // 257
    return value * 255 // ((1 << depth) - 1)


def decode_png_bytes(blob: bytes) -> Image:
    chunks = _iter_chunks(blob)
    if not chunks or chunks[0].kind != b"IHDR":
        raise PNGError("PNG must start with an IHDR chunk")
    width, height, depth, color_type, interlace, _ = _parse_ihdr(chunks[0].data)

    palette: list[tuple[int, int, int]] = []
    transparency: bytes | None = None
    key_gray: int | None = None
    key_rgb: tuple[int, int, int] | None = None
    idat_parts: list[bytes] = []
    seen_iend = False

    known_critical = {b"IHDR", b"PLTE", b"IDAT", b"IEND"}
    for index, chunk in enumerate(chunks):
        if index == 0:
            continue
        if chunk.kind == b"IEND":
            seen_iend = True
            break
        if chunk.kind == b"PLTE":
            if len(chunk.data) % 3 != 0 or not 3 <= len(chunk.data) <= 768:
                raise PNGError("invalid PLTE chunk length")
            palette = [
                (
                    chunk.data[index],
                    chunk.data[index + 1],
                    chunk.data[index + 2],
                )
                for index in range(0, len(chunk.data), 3)
            ]
        elif chunk.kind == b"tRNS":
            transparency = chunk.data
        elif chunk.kind == b"IDAT":
            idat_parts.append(chunk.data)
        elif chunk.kind[0:1].isupper() and chunk.kind not in known_critical:
            raise PNGError(f"unsupported critical PNG chunk {chunk.kind!r}")

    if not seen_iend:
        raise PNGError("PNG file has no IEND chunk")
    if not idat_parts:
        raise PNGError("PNG file has no IDAT data")

    if color_type == 3:
        if not palette:
            raise PNGError("palette PNG has no PLTE chunk")
        if transparency is not None and len(transparency) > len(palette):
            raise PNGError("tRNS chunk has more entries than the palette")
    else:
        if color_type == 0 and transparency is not None:
            if len(transparency) != 2:
                raise PNGError("grayscale tRNS chunk must be 2 bytes")
            key_gray = struct.unpack(">H", transparency)[0]
        elif color_type == 2 and transparency is not None:
            if len(transparency) != 6:
                raise PNGError("RGB tRNS chunk must be 6 bytes")
            key_rgb = struct.unpack(">HHH", transparency)

    try:
        raw = zlib.decompress(b"".join(idat_parts))
    except zlib.error as error:
        raise PNGError(f"cannot decompress PNG image data: {error}") from error

    channels = _CHANNELS[color_type]
    output = Image(width, height, bytearray(width * height * 4), color_type, depth)
    alpha_from_key = transparency is not None and color_type in (0, 2)

    def store(x: int, y: int, samples: list[int], sample_index: int) -> None:
        target = (y * width + x) * 4
        if color_type == 0:
            gray = samples[sample_index]
            if key_gray is not None and gray == key_gray:
                output.data[target : target + 4] = bytes((0, 0, 0, 0))
                return
            value = _to_8bit(gray, depth)
            output.data[target : target + 4] = bytes((value, value, value, 255))
        elif color_type == 2:
            red, green, blue = (
                samples[sample_index],
                samples[sample_index + 1],
                samples[sample_index + 2],
            )
            if key_rgb is not None and (red, green, blue) == key_rgb:
                output.data[target : target + 4] = bytes((0, 0, 0, 0))
                return
            output.data[target : target + 4] = bytes(
                (
                    _to_8bit(red, depth),
                    _to_8bit(green, depth),
                    _to_8bit(blue, depth),
                    255,
                )
            )
        elif color_type == 3:
            entry = samples[sample_index]
            if entry >= len(palette):
                raise PNGError(f"palette index {entry} is outside the PLTE chunk")
            red, green, blue = palette[entry]
            alpha = 255
            if transparency is not None and entry < len(transparency):
                alpha = transparency[entry]
            output.data[target : target + 4] = bytes((red, green, blue, alpha))
        elif color_type == 4:
            gray = samples[sample_index]
            alpha = samples[sample_index + 1]
            value = _to_8bit(gray, depth)
            output.data[target : target + 4] = bytes(
                (value, value, value, _to_8bit(alpha, depth))
            )
        else:
            red, green, blue, alpha = (
                samples[sample_index],
                samples[sample_index + 1],
                samples[sample_index + 2],
                samples[sample_index + 3],
            )
            output.data[target : target + 4] = bytes(
                (
                    _to_8bit(red, depth),
                    _to_8bit(green, depth),
                    _to_8bit(blue, depth),
                    _to_8bit(alpha, depth),
                )
            )

    if interlace == 1:
        offset = 0
        for x_start, y_start, x_step, y_step in _ADAM7:
            pass_width = _pass_size(width, x_start, x_step)
            pass_height = _pass_size(height, y_start, y_step)
            if pass_width == 0 or pass_height == 0:
                continue
            row_bytes = (pass_width * channels * depth + 7) // 8
            bpp = max(1, (channels * depth + 7) // 8)
            rows, offset = _unfilter_pass(
                raw, offset, row_bytes, pass_height, bpp
            )
            for row in range(pass_height):
                samples = _row_samples(
                    rows[row * row_bytes : (row + 1) * row_bytes],
                    pass_width,
                    channels,
                    depth,
                )
                y = y_start + row * y_step
                for column in range(pass_width):
                    x = x_start + column * x_step
                    store(x, y, samples, column * channels)
    else:
        row_bytes = (width * channels * depth + 7) // 8
        bpp = max(1, (channels * depth + 7) // 8)
        rows, _ = _unfilter_pass(raw, 0, row_bytes, height, bpp)
        for row in range(height):
            samples = _row_samples(
                rows[row * row_bytes : (row + 1) * row_bytes],
                width,
                channels,
                depth,
            )
            for column in range(width):
                store(column, row, samples, column * channels)

    return output


def read_png(path: str | os.PathLike[str]) -> Image:
    try:
        with open(path, "rb") as handle:
            blob = handle.read()
    except OSError as error:
        raise PNGError(f"cannot read PNG {path}: {error}") from error
    try:
        return decode_png_bytes(blob)
    except PNGError as error:
        raise PNGError(f"{path}: {error}") from error


def _chunk(kind: bytes, payload: bytes) -> bytes:
    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def _encode(width: int, height: int, color_type: int, data: bytes, bpp: int) -> bytes:
    row_bytes = width * bpp
    filtered = bytearray()
    for row in range(height):
        filtered.append(0)  # None filter; deterministic and simple
        start = row * row_bytes
        filtered.extend(data[start : start + row_bytes])
    compressed = zlib.compress(bytes(filtered), 9)
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return (
        PNG_SIGNATURE
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", compressed)
        + _chunk(b"IEND", b"")
    )


def encode_rgba_png(image: Image) -> bytes:
    if len(image.data) != image.width * image.height * 4:
        raise ValueError("RGBA payload length does not match dimensions")
    return _encode(image.width, image.height, 6, bytes(image.data), 4)


def encode_gray8_png(width: int, height: int, data: bytes) -> bytes:
    if len(data) != width * height:
        raise ValueError("grayscale payload length does not match dimensions")
    return _encode(width, height, 0, bytes(data), 1)


def write_bytes_atomic(path: str | os.PathLike[str], payload: bytes) -> None:
    """Write bytes through a temporary file so a crash cannot truncate output."""
    path = os.fspath(path)
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".inkproof-", dir=directory)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def write_png(path: str | os.PathLike[str], image: Image) -> None:
    write_bytes_atomic(path, encode_rgba_png(image))


def write_gray_png(
    path: str | os.PathLike[str], width: int, height: int, data: bytes
) -> None:
    write_bytes_atomic(path, encode_gray8_png(width, height, data))


def read_gray8(path: str | os.PathLike[str]) -> tuple[int, int, bytearray]:
    """Read the 8-bit grayscale plate files written by this tool."""
    image = read_png(path)
    if image.color_type != 0 or image.bit_depth != 8:
        raise PNGError(
            f"{path}: expected an 8-bit grayscale PNG, got "
            f"{_COLOR_TYPE_NAMES.get(image.color_type, image.color_type)}"
            f"/{image.bit_depth}-bit"
        )
    gray = bytearray(image.width * image.height)
    for index in range(len(gray)):
        gray[index] = image.data[index * 4]
    return image.width, image.height, gray


_HEX_COLOUR = re.compile(r"#(?:[0-9a-fA-F]{3}){1,2}")


def parse_hex_colour(value: str) -> tuple[int, int, int]:
    if not isinstance(value, str) or not _HEX_COLOUR.fullmatch(value.strip()):
        raise ValueError(f"invalid hex colour {value!r}; expected #RGB or #RRGGBB")
    text = value.strip()[1:]
    if len(text) == 3:
        return tuple(int(character * 2, 16) for character in text)  # type: ignore[return-value]
    return (int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16))
