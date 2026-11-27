"""Pure-Python PNG decoder.

Supports all standard PNG colour types (grey, RGB, palette, grey+alpha, RGBA)
at bit depths 1/2/4/8/16, non-interlaced and Adam7 interlaced images.  Output
is packed 8-bit RGB or RGBA.

The decoder is intentionally simple rather than fast; it exists so the tool
works on machines without Pillow/numpy.
"""

from __future__ import annotations

import struct
import zlib

from .image import Image, ImageError

_SIG = b"\x89PNG\r\n\x1a\n"
_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
_ADAM7 = (
    (0, 0, 8, 8),
    (4, 0, 8, 8),
    (0, 4, 4, 8),
    (2, 0, 4, 4),
    (0, 2, 2, 4),
    (1, 0, 2, 2),
    (0, 1, 1, 2),
)


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def byte_stride(width: int, channels: int, bit_depth: int) -> int:
    return (width * channels * bit_depth + 7) // 8


def filter_bpp(channels: int, bit_depth: int) -> int:
    return max(1, channels * bit_depth // 8)


def unfilter(data: bytes, stride: int, height: int, bpp: int) -> bytearray:
    """Reverse PNG scanline filters.

    ``data`` holds ``height`` rows of ``1 + stride`` bytes (filter byte first).
    Returns packed unfiltered rows of ``stride`` bytes each.
    """
    out = bytearray(stride * height)
    prev = bytearray(stride)
    pos = 0
    for y in range(height):
        ftype = data[pos]
        pos += 1
        cur = bytearray(data[pos:pos + stride])
        if len(cur) != stride:
            raise ImageError("truncated PNG scanline")
        pos += stride
        if ftype == 0:
            pass
        elif ftype == 1:
            for i in range(bpp, stride):
                cur[i] = (cur[i] + cur[i - bpp]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                cur[i] = (cur[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = cur[i - bpp] if i >= bpp else 0
                cur[i] = (cur[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                left = cur[i - bpp] if i >= bpp else 0
                upleft = prev[i - bpp] if i >= bpp else 0
                cur[i] = (cur[i] + paeth(left, prev[i], upleft)) & 0xFF
        else:
            raise ImageError(f"unknown PNG filter type {ftype}")
        out[y * stride:(y + 1) * stride] = cur
        prev = cur
    return out


def _sample(row: bytes, index: int, bit_depth: int) -> int:
    """Read sample ``index`` from a row packed at ``bit_depth``."""
    if bit_depth == 8:
        return row[index]
    if bit_depth == 16:
        return row[index * 2]  # high byte; low byte discarded
    per_byte = 8 // bit_depth
    byte = row[index // per_byte]
    shift = 8 - bit_depth * (index % per_byte + 1)
    return (byte >> shift) & ((1 << bit_depth) - 1)


def unpack(raw: bytearray, width: int, height: int, bit_depth: int,
           color_type: int, palette: bytes | None,
           trns: bytes | None) -> tuple[bytes, int]:
    """Convert unfiltered PNG rows into packed RGB/RGBA bytes."""
    ch = _CHANNELS[color_type]
    stride = byte_stride(width, ch, bit_depth)
    scale = 255 // ((1 << bit_depth) - 1) if bit_depth < 8 else 1

    if color_type == 3:
        if palette is None:
            raise ImageError("palette image without PLTE chunk")
        entries = len(palette) // 3
        has_alpha = trns is not None
        out_ch = 4 if has_alpha else 3
        out = bytearray(width * height * out_ch)
        for y in range(height):
            row = raw[y * stride:(y + 1) * stride]
            for x in range(width):
                idx = _sample(row, x, bit_depth)
                if idx >= entries:
                    raise ImageError(f"palette index {idx} out of range ({entries})")
                o = (y * width + x) * out_ch
                out[o] = palette[idx * 3]
                out[o + 1] = palette[idx * 3 + 1]
                out[o + 2] = palette[idx * 3 + 2]
                if has_alpha:
                    out[o + 3] = trns[idx] if idx < len(trns) else 255
        return bytes(out), out_ch

    if color_type == 6:
        return _generic_rgba(raw, width, height, stride, bit_depth, ch, trns, 0, 1, 2, 3)
    if color_type == 2:
        return _generic_rgb(raw, width, height, stride, bit_depth, ch, scale, (0, 1, 2))
    if color_type == 0:
        grey = _generic_grey(raw, width, height, stride, bit_depth, scale)
        if trns is not None and len(trns) >= 2:
            key = trns[0] if bit_depth < 16 else trns[0]
            return _grey_with_key(grey, key, scale, width, height)
        out = bytearray(width * height * 3)
        out[0::3] = grey
        out[1::3] = grey
        out[2::3] = grey
        return bytes(out), 3
    if color_type == 4:
        return _generic_rgba(raw, width, height, stride, bit_depth, ch, None, 0, 1, 2, 3,
                             grey_alpha=True)
    raise ImageError(f"unsupported PNG colour type {color_type}")


def _generic_rgb(raw, width, height, stride, bit_depth, ch, scale, order):
    out = bytearray(width * height * 3)
    for y in range(height):
        row = raw[y * stride:(y + 1) * stride]
        base = y * width * 3
        for x in range(width):
            o = base + x * 3
            out[o] = _sample(row, x * ch + order[0], bit_depth) * scale
            out[o + 1] = _sample(row, x * ch + order[1], bit_depth) * scale
            out[o + 2] = _sample(row, x * ch + order[2], bit_depth) * scale
    return bytes(out), 3


def _generic_grey(raw, width, height, stride, bit_depth, scale):
    out = bytearray(width * height)
    for y in range(height):
        row = raw[y * stride:(y + 1) * stride]
        base = y * width
        for x in range(width):
            out[base + x] = _sample(row, x, bit_depth) * scale
    return out


def _grey_with_key(grey, key, scale, width, height):
    key8 = key * scale
    out = bytearray(width * height * 4)
    for i, v in enumerate(grey):
        o = i * 4
        out[o] = out[o + 1] = out[o + 2] = v
        out[o + 3] = 0 if v == key8 else 255
    return bytes(out), 4


def _generic_rgba(raw, width, height, stride, bit_depth, ch, trns, r, g, b, a,
                  grey_alpha: bool = False):
    out = bytearray(width * height * 4)
    for y in range(height):
        row = raw[y * stride:(y + 1) * stride]
        base = y * width * 4
        for x in range(width):
            o = base + x * 4
            if grey_alpha:
                v = _sample(row, x * 2, bit_depth)
                out[o] = out[o + 1] = out[o + 2] = v
                out[o + 3] = _sample(row, x * 2 + 1, bit_depth)
            else:
                out[o] = _sample(row, x * ch + r, bit_depth)
                out[o + 1] = _sample(row, x * ch + g, bit_depth)
                out[o + 2] = _sample(row, x * ch + b, bit_depth)
                out[o + 3] = _sample(row, x * ch + a, bit_depth)
    return bytes(out), 4


def decode_png(path: str) -> Image:
    with open(path, "rb") as fh:
        data = fh.read()
    if not data.startswith(_SIG):
        raise ImageError("not a PNG file")

    pos = len(_SIG)
    ihdr = None
    palette = None
    trns = None
    idat: list[bytes] = []
    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if len(body) != length:
            raise ImageError(f"truncated PNG chunk {ctype!r}")
        if ctype == b"IHDR":
            if length != 13:
                raise ImageError("bad IHDR length")
            ihdr = struct.unpack(">IIBBBBB", body)
        elif ctype == b"PLTE":
            palette = body
        elif ctype == b"tRNS":
            trns = body
        elif ctype == b"IDAT":
            idat.append(body)
        elif ctype == b"IEND":
            break
        elif not (ctype[0] & 0x20):
            raise ImageError(f"unsupported critical PNG chunk {ctype!r}")
        pos += 12 + length

    if ihdr is None:
        raise ImageError("PNG without IHDR")
    width, height, bit_depth, color_type, compression, filt, interlace = ihdr
    if width <= 0 or height <= 0:
        raise ImageError(f"invalid PNG size {width}x{height}")
    if compression != 0 or filt != 0:
        raise ImageError("unsupported PNG compression/filter method")
    if bit_depth not in (1, 2, 4, 8, 16) or color_type not in _CHANNELS:
        raise ImageError(f"invalid PNG bit depth/colour type {bit_depth}/{color_type}")
    if color_type == 3 and palette is None:
        raise ImageError("palette PNG missing PLTE")

    try:
        raw = zlib.decompress(b"".join(idat))
    except zlib.error as exc:
        raise ImageError(f"PNG zlib data corrupt: {exc}") from exc

    ch = _CHANNELS[color_type]
    if interlace == 0:
        stride = byte_stride(width, ch, bit_depth)
        expected = height * (1 + stride)
        if len(raw) < expected:
            raise ImageError(f"PNG data truncated ({len(raw)} < {expected})")
        rows = unfilter(raw[:expected], stride, height, filter_bpp(ch, bit_depth))
        pixels, channels = unpack(rows, width, height, bit_depth, color_type,
                                  palette, trns)
    elif interlace == 1:
        pixels, channels = _decode_adam7(raw, width, height, bit_depth,
                                         color_type, palette, trns)
    else:
        raise ImageError(f"unknown PNG interlace method {interlace}")

    mode = {0: "L", 2: "RGB", 3: "P", 4: "LA", 6: "RGBA"}[color_type]
    if color_type == 3 and trns is not None:
        mode = "PA"
    return Image(width, height, pixels, channels, "png", mode)


def _decode_adam7(raw: bytes, width: int, height: int, bit_depth: int,
                  color_type: int, palette: bytes | None,
                  trns: bytes | None) -> tuple[bytes, int]:
    ch = _CHANNELS[color_type]
    pixels = bytearray(width * height * 4)
    pos = 0
    for x0, y0, dx, dy in _ADAM7:
        pw = (width - x0 + dx - 1) // dx if width > x0 else 0
        ph = (height - y0 + dy - 1) // dy if height > y0 else 0
        if pw == 0 or ph == 0:
            continue
        stride = byte_stride(pw, ch, bit_depth)
        need = ph * (1 + stride)
        chunk = raw[pos:pos + need]
        if len(chunk) < need:
            raise ImageError("interlaced PNG data truncated")
        pos += need
        rows = unfilter(chunk, stride, ph, filter_bpp(ch, bit_depth))
        sub, sub_ch = unpack(rows, pw, ph, bit_depth, color_type, palette, trns)
        for sy in range(ph):
            yy = y0 + sy * dy
            src_off = sy * pw * sub_ch
            for sx in range(pw):
                xx = x0 + sx * dx
                d = (yy * width + xx) * 4
                s = src_off + sx * sub_ch
                pixels[d] = sub[s]
                pixels[d + 1] = sub[s + 1]
                pixels[d + 2] = sub[s + 2]
                pixels[d + 3] = sub[s + 3] if sub_ch == 4 else 255
    if trns is None and color_type in (0, 2, 3):
        rgb = bytearray(width * height * 3)
        rgb[0::3] = pixels[0::4]
        rgb[1::3] = pixels[1::4]
        rgb[2::3] = pixels[2::4]
        return bytes(rgb), 3
    return bytes(pixels), 4
