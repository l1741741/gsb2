"""极简但健壮的 PNG 编解码（仅依赖标准库 zlib/struct）。

读取支持：
* 位深 1/2/4/8/16，颜色类型 0(灰度) / 2(RGB) / 3(索引) / 4(灰度+Alpha) / 6(RGBA)
* 调色板 + tRNS、灰度/RGB tRNS
* 全部 5 种 PNG 行过滤器
* 非 Adam7 隔行（Adam7 会抛出 :class:`UnsupportedPngError`，由上层隔离）

所有图片统一解码为 8-bit 直 alpha RGBA :class:`ImageData`；
编码只输出 8-bit RGBA（过滤器 0 + zlib），任何环境下字节一致。
"""

from __future__ import annotations

import struct
import zlib
from typing import Optional

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_MAX_DIMENSION = 200_000
_MAX_PIXELS = 200_000_000


class PngError(Exception):
    """PNG 文件损坏 / 无法解码。"""


class UnsupportedPngError(PngError):
    """PNG 本身合法但使用了本精简解码器不支持的特性（如 Adam7）。"""


class ImageData:
    """一张 8-bit RGBA 图片，``rgba`` 为长度 ``width*height*4`` 的 bytearray。"""

    __slots__ = ("width", "height", "rgba", "source_info")

    def __init__(self, width: int, height: int, rgba: Optional[bytearray] = None):
        if width <= 0 or height <= 0:
            raise ValueError("图片宽高必须为正数")
        if width > _MAX_DIMENSION or height > _MAX_DIMENSION:
            raise PngError("图片边长超过安全上限")
        if width * height > _MAX_PIXELS:
            raise PngError("图片总像素超过安全上限")
        self.width = int(width)
        self.height = int(height)
        n = self.width * self.height * 4
        if rgba is None:
            self.rgba = bytearray(n)
        else:
            if len(rgba) != n:
                raise ValueError("RGBA 缓冲区长度与宽高不符")
            self.rgba = rgba if isinstance(rgba, bytearray) else bytearray(rgba)
        #: 解码时记录的源格式信息（报告用）
        self.source_info = {}

    def copy(self) -> "ImageData":
        img = ImageData(self.width, self.height, bytearray(self.rgba))
        img.source_info = dict(self.source_info)
        return img

    def pixel(self, x: int, y: int):
        i = (y * self.width + x) * 4
        return self.rgba[i], self.rgba[i + 1], self.rgba[i + 2], self.rgba[i + 3]

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return "ImageData(%dx%d)" % (self.width, self.height)


# --------------------------------------------------------------------------- #
# 读取
# --------------------------------------------------------------------------- #

def read_png(path: str) -> ImageData:
    with open(path, "rb") as f:
        data = f.read()
    return decode_png_bytes(data, source_name=str(path))


def decode_png_bytes(data: bytes, source_name: str = "<bytes>") -> ImageData:
    if not isinstance(data, (bytes, bytearray)):
        raise PngError("输入不是字节数据")
    data = bytes(data)
    if len(data) < 8 or data[:8] != PNG_SIGNATURE:
        raise PngError("不是合法的 PNG 文件（签名不匹配）: %s" % source_name)

    pos = 8
    width = height = bit_depth = color_type = interlace = None
    palette = b""
    trns = b""
    idat = []
    saw_iend = False

    while pos + 8 <= len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        ctype = data[pos + 4:pos + 8]
        body_start = pos + 8
        body_end = body_start + length
        if body_end + 4 > len(data):
            raise PngError("PNG 数据块长度越界（文件可能已截断）")
        body = data[body_start:body_end]
        # CRC 只做读取位置校验，不强制：不少真实图片带小的 CRC 问题，
        # 强制 CRC 会降低可恢复性；结构损坏仍会在解码阶段报错。
        pos = body_end + 4

        if ctype == b"IHDR":
            if length != 13:
                raise PngError("IHDR 长度异常")
            (width, height, bit_depth, color_type,
             compression, filter_method, interlace) = struct.unpack(">IIBBBBB", body)
            if compression != 0 or filter_method != 0:
                raise UnsupportedPngError("未知的压缩/过滤器方法")
            if interlace not in (0, 1):
                raise PngError("未知隔行方式: %r" % interlace)
        elif ctype == b"PLTE":
            palette = body
        elif ctype == b"tRNS":
            trns = body
        elif ctype == b"IDAT":
            idat.append(body)
        elif ctype == b"IEND":
            saw_iend = True
            break

    if width is None:
        raise PngError("缺少 IHDR")
    if not saw_iend:
        # 不直接判死刑：IDAT 完整时仍可解码，截断通常会在 zlib 层暴露。
        pass
    if interlace == 1:
        raise UnsupportedPngError("暂不支持 Adam7 隔行 PNG，请先另存为非隔行 PNG")

    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
    if channels is None:
        raise PngError("未知颜色类型: %r" % color_type)

    valid_depths = {
        0: (1, 2, 4, 8, 16),
        2: (8, 16),
        3: (1, 2, 4, 8),
        4: (8, 16),
        6: (8, 16),
    }[color_type]
    if bit_depth not in valid_depths:
        raise PngError("颜色类型 %s 不支持位深 %s" % (color_type, bit_depth))

    if color_type == 3:
        if len(palette) < 3:
            raise PngError("索引 PNG 缺少 PLTE")
        if len(palette) % 3 != 0:
            raise PngError("PLTE 长度不是 3 的倍数")

    try:
        raw = zlib.decompress(b"".join(idat))
    except zlib.error as exc:
        raise PngError("IDAT zlib 解压失败: %s" % exc)

    img = _raw_to_image(raw, width, height, bit_depth, color_type, channels,
                        palette, trns)
    img.source_info = {
        "bit_depth": bit_depth,
        "color_type": color_type,
        "interlace": interlace,
        "source_name": source_name,
    }
    return img


def _unfilter(raw: bytes, width: int, height: int,
              channels: int, bit_depth: int) -> bytearray:
    """反转 PNG 行过滤器，返回去除 filter 字节后的交错采样字节。"""
    # 低于 8bit 时 PNG 规范规定重建用 bpp=1
    bpp = max(1, channels * bit_depth // 8)
    stride = (width * channels * bit_depth + 7) // 8
    expected = height * (stride + 1)
    if len(raw) < expected:
        raise PngError("解压后的像素数据不足: 需要约 %d 字节，实际 %d"
                       % (expected, len(raw)))

    out = bytearray(height * stride)
    src = 0
    dst = 0
    for y in range(height):
        ftype = raw[src]
        src += 1
        line_start = src
        prev_start = dst - stride if y > 0 else -1
        if ftype == 0:
            out[dst:dst + stride] = raw[line_start:line_start + stride]
            src += stride
            dst += stride
            continue
        for x in range(stride):
            cur = raw[line_start + x]
            a = out[dst + x - bpp] if x >= bpp else 0
            b = out[prev_start + x] if prev_start >= 0 else 0
            c = out[prev_start + x - bpp] if (prev_start >= 0 and x >= bpp) else 0
            if ftype == 1:  # Sub
                v = cur + a
            elif ftype == 2:  # Up
                v = cur + b
            elif ftype == 3:  # Average
                v = cur + ((a + b) >> 1)
            elif ftype == 4:  # Paeth
                p = a + b - c
                pa = abs(p - a)
                pb = abs(p - b)
                pc = abs(p - c)
                if pa <= pb and pa <= pc:
                    pr = a
                elif pb <= pc:
                    pr = b
                else:
                    pr = c
                v = cur + pr
            else:
                raise PngError("未知 PNG 过滤器类型: %r" % ftype)
            out[dst + x] = v & 0xFF
        src += stride
        dst += stride
    return out


def _expand_samples(filtered: bytearray, width: int, height: int,
                    channels: int, bit_depth: int):
    """把去过滤后的字节展开成每采样 0..255 整数的二维数组（按像素交错）。

    返回 bytearray，长度 width*height*channels。
    """
    n_pixels = width * height
    samples = bytearray(n_pixels * channels)

    if bit_depth == 8:
        # 字节已经是采样值
        need = n_pixels * channels
        samples[:need] = filtered[:need]
        return samples

    if bit_depth == 16:
        for i in range(n_pixels * channels):
            hi = filtered[i * 2]
            lo = filtered[i * 2 + 1]
            v = (hi << 8) | lo
            samples[i] = (v * 255 + 32767) // 65535
        return samples

    # 子字节位深：1/2/4，大端位序，填充扫描行
    mask = (1 << bit_depth) - 1
    scale = 255 // mask
    pixels_per_byte = 8 // bit_depth
    row_bytes = (width * channels * bit_depth + 7) // 8
    out_idx = 0
    for y in range(height):
        row_base = y * row_bytes
        bit_pos = 0
        for _ in range(width * channels):
            byte_index = row_base + (bit_pos >> 3)
            shift = 8 - bit_depth - (bit_pos & 7)
            raw_v = (filtered[byte_index] >> shift) & mask
            # PNG 的位深扩展是复制高位（等价于 round(v*255/mask)）
            samples[out_idx] = raw_v * scale if bit_depth == 4 else (
                raw_v * 255 // mask)
            out_idx += 1
            bit_pos += bit_depth
        # 一行末尾的填充位直接跳过（row_bytes 已固定）
        _ = pixels_per_byte  # 仅说明概念
    return samples


def _raw_to_image(raw: bytes, width: int, height: int, bit_depth: int,
                  color_type: int, channels: int, palette: bytes,
                  trns: bytes) -> ImageData:
    filtered = _unfilter(raw, width, height, channels, bit_depth)
    samples = _expand_samples(filtered, width, height, channels, bit_depth)
    n = width * height
    rgba = bytearray(n * 4)

    if color_type == 6:  # RGBA
        rgba[0::4] = samples[0::4]
        rgba[1::4] = samples[1::4]
        rgba[2::4] = samples[2::4]
        rgba[3::4] = samples[3::4]
        return ImageData(width, height, rgba)

    if color_type == 2:  # RGB
        for i in range(n):
            s = i * 3
            d = i * 4
            rgba[d] = samples[s]
            rgba[d + 1] = samples[s + 1]
            rgba[d + 2] = samples[s + 2]
            rgba[d + 3] = 255
        if len(trns) >= 6:
            tr, tg, tb = struct.unpack(">HHH", trns[:6])
            tr8 = (tr * 255 + 32767) // 65535 if bit_depth == 16 else tr
            tg8 = (tg * 255 + 32767) // 65535 if bit_depth == 16 else tg
            tb8 = (tb * 255 + 32767) // 65535 if bit_depth == 16 else tb
            for i in range(n):
                d = i * 4
                if rgba[d] == tr8 and rgba[d + 1] == tg8 and rgba[d + 2] == tb8:
                    rgba[d + 3] = 0
        return ImageData(width, height, rgba)

    if color_type == 0:  # 灰度
        for i in range(n):
            v = samples[i]
            d = i * 4
            rgba[d] = rgba[d + 1] = rgba[d + 2] = v
            rgba[d + 3] = 255
        if len(trns) >= 2:
            g = struct.unpack(">H", trns[:2])[0]
            g8 = (g * 255 + 32767) // 65535 if bit_depth == 16 else g
            for i in range(n):
                d = i * 4
                if rgba[d] == g8:
                    rgba[d + 3] = 0
        return ImageData(width, height, rgba)

    if color_type == 4:  # 灰度 + alpha
        for i in range(n):
            s = i * 2
            d = i * 4
            v = samples[s]
            rgba[d] = rgba[d + 1] = rgba[d + 2] = v
            rgba[d + 3] = samples[s + 1]
        return ImageData(width, height, rgba)

    # color_type == 3 索引
    palette_count = len(palette) // 3
    alpha_table = [255] * palette_count
    for i in range(min(len(trns), palette_count)):
        alpha_table[i] = trns[i]
    for i in range(n):
        idx = samples[i]
        d = i * 4
        if idx >= palette_count:
            raise PngError("像素引用了越界的调色板索引 %s" % idx)
        p = idx * 3
        rgba[d] = palette[p]
        rgba[d + 1] = palette[p + 1]
        rgba[d + 2] = palette[p + 2]
        rgba[d + 3] = alpha_table[idx]
    return ImageData(width, height, rgba)


# --------------------------------------------------------------------------- #
# 写入（始终 8-bit RGBA）
# --------------------------------------------------------------------------- #

def _chunk(chunk_type: bytes, body: bytes) -> bytes:
    return (struct.pack(">I", len(body)) + chunk_type + body
            + struct.pack(">I", zlib.crc32(chunk_type + body) & 0xFFFFFFFF))


def encode_png(img: ImageData, compress_level: int = 6) -> bytes:
    if not isinstance(img, ImageData):
        raise TypeError("encode_png 需要 ImageData")
    ihdr = struct.pack(">IIBBBBB", img.width, img.height, 8, 6, 0, 0, 0)
    stride = img.width * 4
    raw = bytearray((stride + 1) * img.height)
    for y in range(img.height):
        base = y * (stride + 1)
        raw[base] = 0  # filter None
        start = y * stride
        raw[base + 1:base + 1 + stride] = img.rgba[start:start + stride]
    idat = zlib.compress(bytes(raw), compress_level)
    return (PNG_SIGNATURE
            + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", idat)
            + _chunk(b"IEND", b""))


def write_png(path: str, img: ImageData) -> None:
    data = encode_png(img)
    with open(path, "wb") as f:
        f.write(data)
