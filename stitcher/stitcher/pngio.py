"""极简 PNG 读写（仅标准库）。

读取: 支持 8bit、非隔行的 RGB(color type 2) 与 RGBA(color type 6)，
      五种滤波方式；统一解码为 RGBA。
写出: 固定输出 8bit RGBA、逐行 filter 0。
透明约定: alpha==0 的像素不携带有效颜色。
"""

import struct
import zlib

PNG_SIG = b"\x89PNG\r\n\x1a\n"


class Image:
    """w x h 的 RGBA 图像，pix 为长度 w*h*4 的 bytearray。"""

    __slots__ = ("w", "h", "pix")

    def __init__(self, w, h, pix=None):
        self.w = w
        self.h = h
        self.pix = pix if pix is not None else bytearray(w * h * 4)

    def crop(self, x0, y0, x1, y1):
        """裁出 [x0,x1) x [y0,y1) 区域（越界部分保持透明）。"""
        w, h = x1 - x0, y1 - y0
        out = Image(w, h)
        for y in range(h):
            sy = y0 + y
            if sy < 0 or sy >= self.h:
                continue
            sx0 = max(0, x0)
            sx1 = min(self.w, x1)
            if sx1 <= sx0:
                continue
            src = (sy * self.w + sx0) * 4
            dst = (y * w + (sx0 - x0)) * 4
            out.pix[dst:dst + (sx1 - sx0) * 4] = self.pix[src:src + (sx1 - sx0) * 4]
        return out


def read_png(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != PNG_SIG:
        raise ValueError("%s: 不是 PNG 文件" % path)
    pos = 8
    idat = bytearray()
    w = h = depth = ctype = interlace = None
    while pos + 8 <= len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        if tag == b"IHDR":
            w, h, depth, ctype, _comp, _filt, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or interlace != 0 or ctype not in (2, 6):
                raise ValueError(
                    "%s: 仅支持 8bit 非隔行 RGB/RGBA (depth=%d type=%d interlace=%d)"
                    % (path, depth, ctype, interlace))
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
        pos += 12 + length
    if w is None:
        raise ValueError("%s: 缺少 IHDR" % path)

    raw = zlib.decompress(bytes(idat))
    ch = 4 if ctype == 6 else 3
    stride = w * ch
    native = bytearray(w * stride)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p:p + stride])
        p += stride
        if f == 1:  # Sub
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 0xFF
        elif f == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:  # Average
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:  # Paeth
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                pp = a + b - c
                pa = pp - a if pp >= a else a - pp
                pb = pp - b if pp >= b else b - pp
                pc = pp - c if pp >= c else c - pp
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        elif f != 0:
            raise ValueError("%s: 未知滤波类型 %d" % (path, f))
        native[y * stride:(y + 1) * stride] = line
        prev = line

    if ch == 4:
        return Image(w, h, native)
    # RGB -> RGBA
    rgba = bytearray(w * h * 4)
    for i in range(w * h):
        rgba[i * 4:i * 4 + 3] = native[i * 3:i * 3 + 3]
        rgba[i * 4 + 3] = 255
    return Image(w, h, rgba)


def _chunk(tag, body):
    return (struct.pack(">I", len(body)) + tag + body
            + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))


def write_png(path, img):
    w, h = img.w, img.h
    stride = w * 4
    raw = bytearray((stride + 1) * h)
    for y in range(h):
        row = (stride + 1) * y
        raw[row] = 0  # filter: none
        raw[row + 1:row + 1 + stride] = img.pix[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    data = (PNG_SIG + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + _chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(data)
