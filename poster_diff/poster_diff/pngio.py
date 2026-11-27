"""Minimal dependency-free PNG codec (8-bit RGB / RGBA after decode).

Only the subset needed by the poster diff tool is implemented:
- color types 0 (gray), 2 (RGB), 3 (palette), 4 (gray+alpha), 6 (RGBA)
- bit depths 1/2/4/8/16 where the spec allows them
- no Adam7 interlacing (an explicit error is raised)

All decoded images are normalized to 8-bit samples.  zlib is used for
deflate/inflate, so the hot compression path still runs in C.
"""

from __future__ import annotations

import struct
import zlib

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class PngError(Exception):
    """Raised when a PNG cannot be decoded by this minimal codec."""


class Image:
    """A raster of 8-bit samples laid out as packed rows (top to bottom)."""

    __slots__ = ("width", "height", "channels", "data")

    def __init__(self, width: int, height: int, channels: int, data: bytearray):
        if channels not in (1, 2, 3, 4):
            raise ValueError("channels must be 1..4")
        expected = width * height * channels
        if len(data) != expected:
            raise ValueError(
                f"pixel data length {len(data)} != {expected} "
                f"for {width}x{height}x{channels}"
            )
        self.width = width
        self.height = height
        self.channels = channels
        self.data = data

    # ------------------------------------------------------------------ basic
    def pixel(self, x: int, y: int) -> tuple[int, ...]:
        i = (y * self.width + x) * self.channels
        return tuple(self.data[i : i + self.channels])

    def set_pixel(self, x: int, y: int, values: tuple[int, ...]) -> None:
        i = (y * self.width + x) * self.channels
        self.data[i : i + self.channels] = bytes(values)

    def row_view(self, y: int) -> memoryview:
        start = y * self.width * self.channels
        return memoryview(self.data)[start : start + self.width * self.channels]

    def copy(self) -> "Image":
        return Image(self.width, self.height, self.channels, bytearray(self.data))

    # -------------------------------------------------------------- conversion
    def to_rgba(self) -> "Image":
        """Return an RGBA8 image, expanding gray / RGB and filling alpha."""
        if self.channels == 4:
            return self.copy()
        src = self.data
        w, h, c = self.width, self.height, self.channels
        out = bytearray(w * h * 4)
        si = 0
        di = 0
        if c == 1:
            for _ in range(w * h):
                v = src[si]
                out[di : di + 4] = bytes((v, v, v, 255))
                si += 1
                di += 4
        elif c == 2:
            for _ in range(w * h):
                v = src[si]
                out[di : di + 4] = bytes((v, v, v, src[si + 1]))
                si += 2
                di += 4
        else:  # c == 3
            for _ in range(w * h):
                out[di : di + 3] = src[si : si + 3]
                out[di + 3] = 255
                si += 3
                di += 4
        return Image(w, h, 4, out)

    def composite_on(self, bg: tuple[int, int, int]) -> "Image":
        """Flatten alpha onto a solid background; returns an RGB8 image."""
        rgba = self.to_rgba()
        w, h = rgba.width, rgba.height
        src = rgba.data
        out = bytearray(w * h * 3)
        br, bgc, bb = bg
        si = di = 0
        for _ in range(w * h):
            r, g, b, a = src[si], src[si + 1], src[si + 2], src[si + 3]
            inv = 255 - a
            out[di] = (r * a + br * inv) // 255
            out[di + 1] = (g * a + bgc * inv) // 255
            out[di + 2] = (b * a + bb * inv) // 255
            si += 4
            di += 3
        return Image(w, h, 3, out)


# --------------------------------------------------------------------- reading
def _iter_chunks(buf: bytes):
    if not buf.startswith(PNG_SIGNATURE):
        raise PngError("not a PNG file (bad signature)")
    pos = len(PNG_SIGNATURE)
    while pos < len(buf):
        if pos + 8 > len(buf):
            raise PngError("truncated chunk header")
        length, ctype = struct.unpack(">I4s", buf[pos : pos + 8])
        pos += 8
        if pos + length + 4 > len(buf):
            raise PngError(f"truncated {ctype!r} chunk")
        payload = buf[pos : pos + length]
        crc = buf[pos + length : pos + length + 4]
        (expected_crc,) = struct.unpack(">I", crc)
        if zlib.crc32(ctype + payload) & 0xFFFFFFFF != expected_crc:
            raise PngError(f"CRC check failed for chunk {ctype!r}")
        pos += length + 4
        yield ctype, payload
        if ctype == b"IEND":
            break


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _unfilter(raw: bytes, width: int, height: int, bpp: int, stride: int) -> bytearray:
    """Reverse PNG per-scanline filters.  bpp is bytes per pixel (>= 1)."""
    out = bytearray(stride * height)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ftype = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        if ftype == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:  # Average
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + (left + prev[i]) // 2) & 0xFF
        elif ftype == 4:  # Paeth
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                up_left = prev[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(left, prev[i], up_left)) & 0xFF
        elif ftype != 0:
            raise PngError(f"unknown scanline filter {ftype}")
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return out


def _expand_gray(buf: bytearray, width: int, height: int, bit_depth: int) -> Image:
    if bit_depth == 8:
        return Image(width, height, 1, buf)
    out = bytearray(width * height)
    mask = (1 << bit_depth) - 1
    pixels_per_byte = 8 // bit_depth
    row_bytes = (width * bit_depth + 7) // 8
    si = 0
    for y in range(height):
        row = buf[si : si + row_bytes]
        base = y * width
        for x in range(width):
            shift = 8 - bit_depth * (x % pixels_per_byte + 1)
            v = (row[x // pixels_per_byte] >> shift) & mask
            # PNG spec: scale so that the max value maps to 255.
            out[base + x] = v * 255 // mask
        si += row_bytes
    return Image(width, height, 1, out)


def _scale16(v: int) -> int:
    # 16-bit -> 8-bit, preserving the endpoints (0 -> 0, 65535 -> 255).
    return (v * 255 + 32767) // 65535


def read_png(path: str) -> Image:
    """Decode a PNG file into an 8-bit Image (gray / GA / RGB / RGBA)."""
    with open(path, "rb") as fh:
        buf = fh.read()

    width = height = bit_depth = color_type = None
    interlace = 0
    idat = bytearray()
    palette: bytes | None = None
    trns: bytes | None = None

    for ctype, payload in _iter_chunks(buf):
        if ctype == b"IHDR":
            (
                width,
                height,
                bit_depth,
                color_type,
                compression,
                filter_method,
                interlace,
            ) = struct.unpack(">IIBBBBB", payload)
            if compression != 0 or filter_method != 0:
                raise PngError("unsupported compression/filter method")
        elif ctype == b"PLTE":
            palette = payload
        elif ctype == b"tRNS":
            trns = payload
        elif ctype == b"IDAT":
            idat.extend(payload)

    if width is None:
        raise PngError("missing IHDR chunk")
    if interlace:
        raise PngError("Adam7 interlaced PNGs are not supported; flatten the image first")

    raw = zlib.decompress(bytes(idat))

    if color_type == 3:  # palette -> RGB(A)8
        if palette is None:
            raise PngError("palette image without PLTE chunk")
        channels = 4 if trns is not None else 3
        stride = width
        decoded = _unfilter(raw, width, height, 1, stride)
        out = bytearray(width * height * channels)
        di = 0
        for idx in decoded:
            base = idx * 3
            if base + 2 >= len(palette):
                raise PngError("palette index out of range")
            out[di] = palette[base]
            out[di + 1] = palette[base + 1]
            out[di + 2] = palette[base + 2]
            if channels == 4:
                out[di + 3] = trns[idx] if idx < len(trns) else 255
            di += channels
        return Image(width, height, channels, out)

    if color_type == 0:
        src_channels, bpp = 1, max(1, bit_depth // 8)
    elif color_type == 2:
        src_channels, bpp = 3, 3 * max(1, bit_depth // 8)
    elif color_type == 4:
        src_channels, bpp = 2, 2 * max(1, bit_depth // 8)
    elif color_type == 6:
        src_channels, bpp = 4, 4 * max(1, bit_depth // 8)
    else:
        raise PngError(f"unsupported PNG color type {color_type}")

    if bit_depth < 8 and color_type != 0:
        raise PngError(f"bit depth {bit_depth} invalid for color type {color_type}")

    stride = (width * bit_depth * src_channels + 7) // 8
    decoded = _unfilter(raw, width, height, bpp, stride)

    if bit_depth < 8:  # sub-byte grayscale
        return _expand_gray(decoded, width, height, bit_depth)

    if bit_depth == 16:
        out = bytearray(width * height * src_channels)
        di = 0
        for i in range(0, len(decoded), 2):
            out[di] = _scale16((decoded[i] << 8) | decoded[i + 1])
            di += 1
        img = Image(width, height, src_channels, out)
    else:
        img = Image(width, height, src_channels, decoded)

    if trns is not None and color_type in (0, 2):
        rgba = img.to_rgba()
        if color_type == 0:
            key = struct.unpack(">H", trns[:2])[0] >> 8
            for i in range(width * height):
                if rgba.data[i * 4] == key:
                    rgba.data[i * 4 + 3] = 0
        else:
            kr, kg, kb = (v >> 8 for v in struct.unpack(">HHH", trns[:6]))
            for i in range(width * height):
                p = i * 4
                if rgba.data[p] == kr and rgba.data[p + 1] == kg and rgba.data[p + 2] == kb:
                    rgba.data[p + 3] = 0
        return rgba
    return img


# --------------------------------------------------------------------- writing
def write_png(path: str, image: Image) -> None:
    """Write an 8-bit RGB or RGBA image as a non-interlaced PNG."""
    if image.channels not in (3, 4):
        raise ValueError("write_png supports RGB8/RGBA8 images only")
    w, h, c = image.width, image.height, image.channels
    color_type = 6 if c == 4 else 2
    ihdr = struct.pack(">IIBBBBB", w, h, 8, color_type, 0, 0, 0)
    stride = w * c
    raw = bytearray()
    data = image.data
    for y in range(h):
        raw.append(0)  # filter type: None
        start = y * stride
        raw.extend(data[start : start + stride])
    compressed = zlib.compress(bytes(raw), 6)

    def chunk(tag: bytes, payload: bytes) -> bytes:
        return (
            struct.pack(">I", len(payload))
            + tag
            + payload
            + struct.pack(">I", zlib.crc32(tag + payload) & 0xFFFFFFFF)
        )

    with open(path, "wb") as fh:
        fh.write(PNG_SIGNATURE)
        fh.write(chunk(b"IHDR", ihdr))
        fh.write(chunk(b"IDAT", compressed))
        fh.write(chunk(b"IEND", b""))
