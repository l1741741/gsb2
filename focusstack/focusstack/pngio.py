"""Dependency-free PNG reader/writer for the focus stacker.

Only the parts needed by this tool are implemented:

* non-interlaced 8/16-bit PNG images of colour types 0, 2, 3, 4 and 6;
* palette expansion including optional tRNS transparency;
* deterministic 8-bit RGB/RGBA output.

The decoder validates chunk CRCs and rejects data whose size does not match
the IHDR dimensions.  It is deliberately strict: silently accepting a
malformed image would make focus-stack results irreproducible.
"""

from __future__ import annotations

import struct
import zlib
from array import array
from pathlib import Path

from .image import Image

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
_VALID_DEPTHS = {
    0: (1, 2, 4, 8, 16),
    2: (8, 16),
    3: (1, 2, 4, 8),
    4: (8, 16),
    6: (8, 16),
}


class PngError(ValueError):
    """Raised for unsupported or corrupt PNG input."""


def _parse_chunks(blob: bytes) -> list:
    chunks = []
    pos = 0
    total = len(blob)
    if blob[:8] != PNG_SIGNATURE:
        raise PngError("not a PNG file (bad signature)")
    pos = 8
    while pos < total:
        if pos + 8 > total:
            raise PngError("truncated PNG chunk header")
        length, kind = struct.unpack(">I4s", blob[pos:pos + 8])
        pos += 8
        if pos + length + 4 > total:
            raise PngError("truncated PNG chunk %s" % kind.decode("ascii", "replace"))
        data = blob[pos:pos + length]
        pos += length
        crc = struct.unpack(">I", blob[pos:pos + 4])[0]
        pos += 4
        if (zlib.crc32(kind + data) & 0xFFFFFFFF) != crc:
            raise PngError("PNG chunk CRC mismatch in %s" % kind.decode("ascii", "replace"))
        chunks.append((kind, data))
        if kind == b"IEND":
            break
    return chunks


def _chunks_of_type(chunks: list, kind: bytes) -> list:
    return [data for chunk_kind, data in chunks if chunk_kind == kind]


def _unfilter(raw: bytes, width: int, height: int, channels: int, bit_depth: int) -> bytes:
    """Reverse PNG scanline filtering; returns tightly packed sample bytes."""
    bytes_per_pixel = max(1, channels * bit_depth // 8)
    row_bytes = (width * channels * bit_depth + 7) // 8
    expected = height * (row_bytes + 1)
    if len(raw) < expected:
        raise PngError("decompressed image data is %d bytes, expected %d" % (len(raw), expected))
    out = bytearray(height * row_bytes)
    previous = bytearray(row_bytes)
    pos = 0
    for y in range(height):
        filter_type = raw[pos]
        pos += 1
        scan = raw[pos:pos + row_bytes]
        pos += row_bytes
        current = bytearray(scan)
        if filter_type == 0:
            pass
        elif filter_type == 1:
            for i in range(bytes_per_pixel, row_bytes):
                current[i] = (current[i] + current[i - bytes_per_pixel]) & 0xFF
        elif filter_type == 2:
            for i in range(row_bytes):
                current[i] = (current[i] + previous[i]) & 0xFF
        elif filter_type == 3:
            for i in range(row_bytes):
                left = current[i - bytes_per_pixel] if i >= bytes_per_pixel else 0
                current[i] = (current[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif filter_type == 4:
            bpp = bytes_per_pixel
            for i in range(row_bytes):
                left = current[i - bpp] if i >= bpp else 0
                above = previous[i]
                upper_left = previous[i - bpp] if i >= bpp else 0
                p = left + above - upper_left
                pa = abs(p - left)
                pb = abs(p - above)
                pc = abs(p - upper_left)
                if pa <= pb and pa <= pc:
                    predictor = left
                elif pb <= pc:
                    predictor = above
                else:
                    predictor = upper_left
                current[i] = (current[i] + predictor) & 0xFF
        else:
            raise PngError("unsupported PNG filter type %d" % filter_type)
        out[y * row_bytes:(y + 1) * row_bytes] = current
        previous = current
    return bytes(out)


def _unpack_sub_byte(raw: bytes, bit_depth: int, count: int) -> list:
    if bit_depth == 8:
        return list(raw[:count])
    values = []
    per_byte = 8 // bit_depth
    mask = (1 << bit_depth) - 1
    for byte in raw:
        shift = 8 - bit_depth
        for _ in range(per_byte):
            values.append((byte >> shift) & mask)
            shift -= bit_depth
    return values[:count]


def _as_array(samples, count: int) -> array:
    if isinstance(samples, array):
        return samples
    return array("B", samples[:count])


def _decode(blob: bytes, name: str = "") -> Image:
    chunks = _parse_chunks(blob)
    ihdr = _chunks_of_type(chunks, b"IHDR")
    if len(ihdr) != 1 or len(ihdr[0]) != 13:
        raise PngError("PNG must contain exactly one 13-byte IHDR chunk")
    width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
        ">IIBBBBB", ihdr[0]
    )
    if width == 0 or height == 0 or width > 100000 or height > 100000:
        raise PngError("PNG dimensions out of range")
    if color_type not in _CHANNELS:
        raise PngError("unsupported PNG colour type %d" % color_type)
    if bit_depth not in _VALID_DEPTHS[color_type]:
        raise PngError("unsupported PNG bit depth %d for colour type %d" % (bit_depth, color_type))
    if compression != 0 or filter_method != 0:
        raise PngError("unsupported PNG compression/filter method")
    if interlace != 0:
        raise PngError("interlaced PNG files are not supported")
    idat = _chunks_of_type(chunks, b"IDAT")
    if not idat:
        raise PngError("PNG has no IDAT chunk")
    try:
        raw = zlib.decompress(b"".join(idat))
    except zlib.error as exc:
        raise PngError("failed to decompress PNG image data: %s" % exc) from exc

    channels = _CHANNELS[color_type]
    count = width * height
    unfiltered = _unfilter(raw, width, height, channels, bit_depth)

    palette = None
    transparency = b""
    if color_type == 3:
        plte = _chunks_of_type(chunks, b"PLTE")
        if len(plte) != 1 or len(plte[0]) % 3 or not plte[0]:
            raise PngError("palette PNG has a missing or malformed PLTE chunk")
        palette = [tuple(plte[0][i:i + 3]) for i in range(0, len(plte[0]), 3)]
        trns = _chunks_of_type(chunks, b"tRNS")
        transparency = trns[0] if trns else b""

    if bit_depth == 16:
        # Keep the most significant byte; source_bit_depth records the original.
        sample_bytes = unfiltered[0::2]
    elif bit_depth == 8:
        sample_bytes = unfiltered
    else:
        sample_bytes = _unpack_sub_byte(unfiltered, bit_depth, count * channels)

    needed = count * channels
    if len(sample_bytes) < needed:
        raise PngError("PNG sample count %d does not match dimensions" % len(sample_bytes))

    if color_type in (0, 4):
        gray = _as_array(sample_bytes[0::channels], count)
        if bit_depth < 8:
            # PNG scales low-bit-depth grayscale samples to the full range;
            # palette indices (handled below) are never scaled.
            scale = 255 // ((1 << bit_depth) - 1)
            gray = array("B", (value * scale for value in gray))
        r = g = b = gray
    elif color_type == 2:
        r = _as_array(sample_bytes[0::3], count)
        g = _as_array(sample_bytes[1::3], count)
        b = _as_array(sample_bytes[2::3], count)
    elif color_type == 6:
        r = _as_array(sample_bytes[0::4], count)
        g = _as_array(sample_bytes[1::4], count)
        b = _as_array(sample_bytes[2::4], count)
    else:
        indices = sample_bytes if isinstance(sample_bytes, list) else list(sample_bytes)
        n = len(palette)
        r = array("B", bytes(count))
        g = array("B", bytes(count))
        b = array("B", bytes(count))
        for i, index in enumerate(indices):
            if index >= n:
                raise PngError("palette index %d outside PLTE" % index)
            r[i], g[i], b[i] = palette[index]

    if color_type in (4, 6):
        a = _as_array(sample_bytes[channels - 1::channels], count)
    elif color_type == 3 and transparency:
        table = list(transparency)
        a = array("B", (table[idx] if idx < len(table) else 255 for idx in sample_bytes))
    else:
        a = None

    return Image(
        width,
        height,
        array("B", r),
        array("B", g),
        array("B", b),
        a,
        name=name,
        source_bit_depth=bit_depth,
        had_palette=color_type == 3,
    )


def read_png(path) -> Image:
    path = Path(path)
    try:
        blob = path.read_bytes()
    except OSError as exc:
        raise PngError("cannot read %s: %s" % (path, exc)) from exc
    return _decode(blob, name=str(path))


def _chunk(kind: bytes, data: bytes) -> bytes:
    return (struct.pack(">I4s", len(data), kind) + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))


def encode_png(image: Image) -> bytes:
    """Encode an Image as 8-bit RGB or RGBA PNG bytes."""
    width, height = image.width, image.height
    has_alpha = image.a is not None
    channels = 4 if has_alpha else 3
    color_type = 6 if has_alpha else 2
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    planes = [image.r, image.g, image.b]
    if has_alpha:
        planes.append(image.a)
    rows = []
    for y in range(height):
        row = bytearray(width * channels)
        offset = y * width
        for c, plane in enumerate(planes):
            row[c::channels] = plane[offset:offset + width]
        rows.append(row)
    filtered = bytearray()
    bpp = channels
    row_bytes = width * channels
    for y, current in enumerate(rows):
        previous = rows[y - 1] if y else None
        filtered.append(4)  # Paeth, deterministic
        for i in range(row_bytes):
            left = current[i - bpp] if i >= bpp else 0
            above = previous[i] if previous is not None else 0
            upper_left = previous[i - bpp] if previous is not None and i >= bpp else 0
            p = left + above - upper_left
            pa = abs(p - left)
            pb = abs(p - above)
            pc = abs(p - upper_left)
            if pa <= pb and pa <= pc:
                predictor = left
            elif pb <= pc:
                predictor = above
            else:
                predictor = upper_left
            filtered.append((current[i] - predictor) & 0xFF)
    compressed = zlib.compress(bytes(filtered), 6)
    return b"".join([
        PNG_SIGNATURE,
        _chunk(b"IHDR", ihdr),
        _chunk(b"IDAT", compressed),
        _chunk(b"IEND", b""),
    ])


def write_png(path, image: Image) -> None:
    Path(path).write_bytes(encode_png(image))
