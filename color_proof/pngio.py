"""最小 PNG 编解码器,只依赖标准库(zlib/struct)。

仅支持本工具需要的子集:
- 解码: 8 位色深, 颜色类型 2 (RGB) 或 6 (RGBA), 非隔行;
  其余位深/隔行 PNG 会抛出 ``PNGUnsupportedError``。
- 编码: 8 位 RGBA, 非隔行。

返回/接收的像素数据统一为 (R, G, B, A) 每通道 0-255 的扁平字节序列,
行优先,长度 = width * height * 4。
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class PNGError(Exception):
    """PNG 数据本身有问题(损坏、截断等)。"""


class PNGUnsupportedError(PNGError):
    """PNG 合法但超出本工具支持的子集。"""


@dataclass(frozen=True)
class Image:
    width: int
    height: int
    rgba: bytearray  # 扁平 RGBA 字节, 长度 width*height*4

    def pixel(self, x: int, y: int) -> tuple[int, int, int, int]:
        i = (y * self.width + x) * 4
        r, g, b, a = self.rgba[i : i + 4]
        return r, g, b, a

    def set_pixel(self, x: int, y: int, rgba: tuple[int, int, int, int]) -> None:
        i = (y * self.width + x) * 4
        self.rgba[i : i + 4] = bytes(rgba)


def _read_chunks(data: bytes):
    if not data.startswith(PNG_SIGNATURE):
        raise PNGError("不是 PNG 文件(签名不匹配)")
    offset = len(PNG_SIGNATURE)
    saw_iend = False
    while offset < len(data):
        if offset + 8 > len(data):
            raise PNGError("PNG 块长度字段被截断")
        (length,) = struct.unpack(">I", data[offset : offset + 4])
        chunk_type = data[offset + 4 : offset + 8]
        start = offset + 8
        end = start + length
        if end + 4 > len(data):
            raise PNGError(f"{chunk_type!r} 块数据被截断")
        chunk_data = data[start:end]
        (crc_read,) = struct.unpack(">I", data[end : end + 4])
        crc_expect = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF
        if crc_read != crc_expect:
            raise PNGError(f"{chunk_type!r} 块 CRC 校验失败")
        yield chunk_type, chunk_data
        offset = end + 4
        if chunk_type == b"IEND":
            saw_iend = True
            break
    if not saw_iend:
        raise PNGError("缺少 IEND 块")


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _unfilter(raw: bytes, width: int, height: int, channels: int) -> bytearray:
    bpp = channels  # 8 位深度下每像素字节数 = 通道数
    stride = width * channels
    out = bytearray(stride * height)
    pos = 0
    for y in range(height):
        filter_type = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        if filter_type == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif filter_type == 2:  # Up
            if y > 0:
                prev = out[(y - 1) * stride : y * stride]
                for i in range(stride):
                    line[i] = (line[i] + prev[i]) & 0xFF
        elif filter_type == 3:  # Average
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                up = out[(y - 1) * stride + i] if y > 0 else 0
                line[i] = (line[i] + ((left + up) >> 1)) & 0xFF
        elif filter_type == 4:  # Paeth
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                up = out[(y - 1) * stride + i] if y > 0 else 0
                up_left = (
                    out[(y - 1) * stride + i - bpp]
                    if y > 0 and i >= bpp
                    else 0
                )
                line[i] = (line[i] + _paeth(left, up, up_left)) & 0xFF
        elif filter_type != 0:
            raise PNGError(f"未知行过滤器类型 {filter_type}")
        out[y * stride : (y + 1) * stride] = line
    return out


def read_png(path: str) -> Image:
    with open(path, "rb") as f:
        data = f.read()

    width = height = bit_depth = color_type = interlace = None
    idat = bytearray()
    for chunk_type, chunk_data in _read_chunks(data):
        if chunk_type == b"IHDR":
            (
                width,
                height,
                bit_depth,
                color_type,
                compression,
                filter_method,
                interlace,
            ) = struct.unpack(">IIBBBBB", chunk_data)
            if compression != 0 or filter_method != 0:
                raise PNGUnsupportedError("仅支持标准压缩/过滤方式")
        elif chunk_type == b"IDAT":
            idat.extend(chunk_data)
        # PLTE/tRNS/gAMA 等辅助块: 本工具只处理真彩, 用不到, 直接忽略

    if width is None:
        raise PNGError("缺少 IHDR 块")
    if bit_depth != 8:
        raise PNGUnsupportedError(f"仅支持 8 位色深, 当前为 {bit_depth} 位")
    if interlace != 0:
        raise PNGUnsupportedError("不支持 Adam7 隔行 PNG, 请先去隔行")
    if color_type == 6:
        channels = 4
    elif color_type == 2:
        channels = 3
    else:
        raise PNGUnsupportedError(
            f"仅支持颜色类型 2(RGB)/6(RGBA), 当前为 {color_type}"
        )

    try:
        raw = zlib.decompress(bytes(idat))
    except zlib.error as exc:
        raise PNGError(f"IDAT 解压失败: {exc}") from exc
    expected = height * (1 + width * channels)
    if len(raw) != expected:
        raise PNGError(
            f"解压后长度异常: 期望 {expected} 字节, 实际 {len(raw)} 字节"
        )

    pixels = _unfilter(raw, width, height, channels)
    if channels == 4:
        rgba = pixels
    else:
        rgba = bytearray(width * height * 4)
        for i in range(width * height):
            rgba[i * 4 : i * 4 + 3] = pixels[i * 3 : i * 3 + 3]
            rgba[i * 4 + 3] = 255
    return Image(width=width, height=height, rgba=rgba)


def _write_chunk(f, chunk_type: bytes, chunk_data: bytes) -> None:
    f.write(struct.pack(">I", len(chunk_data)))
    f.write(chunk_type)
    f.write(chunk_data)
    crc = zlib.crc32(chunk_type + chunk_data) & 0xFFFFFFFF
    f.write(struct.pack(">I", crc))


def write_png(path: str, image: Image) -> None:
    if len(image.rgba) != image.width * image.height * 4:
        raise PNGError("像素数据尺寸与宽高不一致")
    stride = image.width * 4
    # 每行使用过滤器 0(None); 简单且完全合法, zlib 负责压缩。
    raw = bytearray()
    for y in range(image.height):
        raw.append(0)
        raw.extend(image.rgba[y * stride : (y + 1) * stride])
    compressed = zlib.compress(bytes(raw), level=9)
    with open(path, "wb") as f:
        f.write(PNG_SIGNATURE)
        ihdr = struct.pack(
            ">IIBBBBB",
            image.width,
            image.height,
            8,  # bit depth
            6,  # color type RGBA
            0,
            0,
            0,  # compression/filter/interlace
        )
        _write_chunk(f, b"IHDR", ihdr)
        _write_chunk(f, b"IDAT", compressed)
        _write_chunk(f, b"IEND", b"")
