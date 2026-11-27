"""Minimal baseline JPEG encoder (8-bit, 4:4:4 or 4:2:0, standard tables).

Used to generate realistic sample files and to round-trip test the decoder.
It intentionally supports only the common case: baseline sequential DCT,
Huffman coding, no restart markers, no EXIF metadata.  That is enough for
fixtures, and the resulting files are ordinary JPEGs any viewer can open.
"""

from __future__ import annotations

import math
import struct

# Standard luminance / chrominance quantisation tables (ITU T.81 Annex K).
_Q_LUMA = [
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
]
_Q_CHROMA = [
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
]

_ZIGZAG = (
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
)

# Standard Huffman tables from ITU T.81 Annex K.
_DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
_DC_LUMA_VALS = list(range(12))
_DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]
_DC_CHROMA_VALS = list(range(12))
_AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D]
_AC_LUMA_VALS = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
    0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08,
    0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16,
    0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
    0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
    0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7,
    0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6,
    0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5,
    0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4,
    0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
    0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA,
    0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
    0xF9, 0xFA,
]
_AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77]
_AC_CHROMA_VALS = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21,
    0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0,
    0x15, 0x62, 0x72, 0xD1, 0x0A, 0x16, 0x24, 0x34,
    0xE1, 0x25, 0xF1, 0x17, 0x18, 0x19, 0x1A, 0x26,
    0x27, 0x28, 0x29, 0x2A, 0x35, 0x36, 0x37, 0x38,
    0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
    0x79, 0x7A, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96,
    0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5,
    0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4,
    0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3,
    0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2,
    0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA,
    0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9,
    0xEA, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
    0xF9, 0xFA,
]


def _cos_table() -> list[list[float]]:
    table = []
    for u in range(8):
        cu = math.sqrt(0.5) if u == 0 else 1.0
        table.append([cu * math.cos((2 * x + 1) * u * math.pi / 16.0) / 2.0
                      for x in range(8)])
    return table


_COS = _cos_table()


def _fdct(block: list[float]) -> list[float]:
    """Forward DCT of an 8x8 block, rows then columns."""
    rows = [0.0] * 64
    for y in range(8):
        base = y * 8
        for u in range(8):
            acc = 0.0
            for x in range(8):
                acc += _COS[u][x] * block[base + x]
            rows[y * 8 + u] = acc
    out = [0.0] * 64
    for v in range(8):
        for u in range(8):
            acc = 0.0
            for y in range(8):
                acc += _COS[v][y] * rows[y * 8 + u]
            out[v * 8 + u] = acc
    return out


def _huff_codes(bits: list[int], vals: list[int]) -> tuple[dict[int, tuple[int, int]], int]:
    codes: dict[int, tuple[int, int]] = {}
    code = 0
    k = 0
    max_len = 0
    for length in range(1, 17):
        for _ in range(bits[length - 1]):
            codes[vals[k]] = (code, length)
            k += 1
            code += 1
            max_len = length
        code <<= 1
    return codes, max_len


class _BitWriter:
    def __init__(self) -> None:
        self.bytes = bytearray()
        self.acc = 0
        self.n = 0

    def put(self, value: int, length: int) -> None:
        for i in range(length - 1, -1, -1):
            self.acc = (self.acc << 1) | ((value >> i) & 1)
            self.n += 1
            if self.n == 8:
                self._emit(self.acc)
                self.acc = 0
                self.n = 0

    def _emit(self, byte: int) -> None:
        self.bytes.append(byte)
        if byte == 0xFF:
            self.bytes.append(0x00)

    def flush(self) -> None:
        while self.n:
            self.put(0, 1)


def _category(value: int) -> tuple[int, int]:
    """Return (bit length, encoded amplitude bits) for a coefficient."""
    if value == 0:
        return 0, 0
    if value < 0:
        value = -value
        mag = value.bit_length()
        return mag, ((1 << mag) - 1 - value) & ((1 << mag) - 1)
    mag = value.bit_length()
    return mag, value


def _encode_block(writer: _BitWriter, coefs: list[int], dc_codes, dc_pred: int,
                  ac_codes) -> int:
    dc = coefs[0]
    diff = dc - dc_pred
    size, amp = _category(diff) if diff else (0, 0)
    if size > 11:
        size = 11
        amp = _category(diff)[1]
    symbol = size
    code, length = dc_codes[symbol]
    writer.put(code, length)
    if size:
        writer.put(amp, size)
    run = 0
    for k in range(1, 64):
        value = coefs[_ZIGZAG[k]]
        if value == 0:
            run += 1
            continue
        while run > 15:
            code, length = ac_codes[0xF0]
            writer.put(code, length)
            run -= 16
        size, amp = _category(value)
        symbol = (run << 4) | size
        code, length = ac_codes[symbol]
        writer.put(code, length)
        writer.put(amp, size)
        run = 0
    if run:
        code, length = ac_codes[0x00]
        writer.put(code, length)
    return dc


def encode_jpeg(img, path: str, *, quality: int = 85, subsample: bool = True) -> None:
    """Encode an :class:`Image` as a baseline JPEG.

    ``quality`` follows the common IJG scaling.  ``subsample`` selects 4:2:0
    chroma subsampling, otherwise 4:4:4 is used.
    """
    from .imaging.image import Image

    rgb = img.to_rgb() if isinstance(img, Image) else img
    width, height = rgb.width, rgb.height
    scale = 100 / max(1, quality)
    q_luma = [max(1, min(255, int(round(v * scale / 2)))) for v in _Q_LUMA]
    q_chroma = [max(1, min(255, int(round(v * scale / 2)))) for v in _Q_CHROMA]

    # RGB -> YCbCr planes.
    data = rgb.pixels
    n = width * height
    y_plane = [0] * n
    cb_plane = [0] * n
    cr_plane = [0] * n
    for i in range(n):
        o = i * 3
        r, g, b = data[o], data[o + 1], data[o + 2]
        y_plane[i] = int(0.299 * r + 0.587 * g + 0.114 * b)
        cb_plane[i] = int(-0.168736 * r - 0.331264 * g + 0.5 * b + 128)
        cr_plane[i] = int(0.5 * r - 0.418688 * g - 0.081312 * b + 128)

    h_y, v_y = 2, 2
    h_c, v_c = (1, 1) if subsample else (2, 2)
    max_h, max_v = 2, 2
    mcu_w, mcu_h = 8 * max_h, 8 * max_v
    mcus_x = (width + mcu_w - 1) // mcu_w
    mcus_y = (height + mcu_h - 1) // mcu_h

    if subsample:
        cb_small = _downsample(cb_plane, width, height)
        cr_small = _downsample(cr_plane, width, height)
        cb_w, cb_h = (width + 1) // 2, (height + 1) // 2
    else:
        cb_small, cr_small = cb_plane, cr_plane
        cb_w, cb_h = width, height

    def sample(plane, pw, ph, bx, by):
        block = [0.0] * 64
        for yy in range(8):
            sy = min(ph - 1, by + yy)
            for xx in range(8):
                sx = min(pw - 1, bx + xx)
                block[yy * 8 + xx] = plane[sy * pw + sx] - 128.0
        return block

    writer = _BitWriter()
    dc_luma, _ = _huff_codes(_DC_LUMA_BITS, _DC_LUMA_VALS)
    ac_luma, _ = _huff_codes(_AC_LUMA_BITS, _AC_LUMA_VALS)
    dc_chroma, _ = _huff_codes(_DC_CHROMA_BITS, _DC_CHROMA_VALS)
    ac_chroma, _ = _huff_codes(_AC_CHROMA_BITS, _AC_CHROMA_VALS)

    pred_y = pred_cb = pred_cr = 0
    for my in range(mcus_y):
        for mx in range(mcus_x):
            for vy in range(v_y):
                for hx in range(h_y):
                    block = sample(y_plane, width, height, (mx * h_y + hx) * 8,
                                   (my * v_y + vy) * 8)
                    coefs = _quantise(_fdct(block), q_luma)
                    pred_y = _encode_block(writer, coefs, dc_luma, pred_y, ac_luma)
            for plane, pw, ph, is_cb in ((cb_small, cb_w, cb_h, True),
                                         (cr_small, cb_w, cb_h, False)):
                block = sample(plane, pw, ph, mx * h_c * 8, my * v_c * 8)
                coefs = _quantise(_fdct(block), q_chroma)
                if is_cb:
                    pred_cb = _encode_block(writer, coefs, dc_chroma, pred_cb, ac_chroma)
                else:
                    pred_cr = _encode_block(writer, coefs, dc_chroma, pred_cr, ac_chroma)
    writer.flush()

    out = bytearray(b"\xff\xd8")
    out += _segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
    out += _segment(0xDB, bytes((0x00,)) + bytes(_zigzag_order(q_luma))
                    + bytes((0x01,)) + bytes(_zigzag_order(q_chroma)))
    out += _segment(0xC0, struct.pack(">BHHB", 8, height, width, 3) +
                    bytes((1, 0x22, 0)) + bytes((2, 0x11, 1)) + bytes((3, 0x11, 1)))
    out += _segment(0xC4, _dht_payload(0x00, _DC_LUMA_BITS, _DC_LUMA_VALS) +
                    _dht_payload(0x10, _AC_LUMA_BITS, _AC_LUMA_VALS) +
                    _dht_payload(0x01, _DC_CHROMA_BITS, _DC_CHROMA_VALS) +
                    _dht_payload(0x11, _AC_CHROMA_BITS, _AC_CHROMA_VALS))
    out += _segment(0xDA, bytes((3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0)))
    out += writer.bytes
    out += b"\xff\xd9"
    with open(path, "wb") as fh:
        fh.write(out)


def _zigzag_order(table: list[int]) -> list[int]:
    return [table[z] for z in _ZIGZAG]


def _quantise(coeffs: list[float], quant: list[int]) -> list[int]:
    return [int(round(coeffs[i] / quant[i])) for i in range(64)]


def _downsample(plane: list[int], width: int, height: int) -> list[int]:
    w2, h2 = (width + 1) // 2, (height + 1) // 2
    out = [0] * (w2 * h2)
    for y in range(h2):
        for x in range(w2):
            total = 0
            count = 0
            for dy in range(2):
                sy = min(height - 1, y * 2 + dy)
                for dx in range(2):
                    sx = min(width - 1, x * 2 + dx)
                    total += plane[sy * width + sx]
                    count += 1
            out[y * w2 + x] = total // count
    return out


def _segment(marker: int, payload: bytes) -> bytes:
    return bytes((0xFF, marker)) + struct.pack(">H", len(payload) + 2) + payload


def _dht_payload(table_class: int, bits: list[int], vals: list[int]) -> bytes:
    return bytes((table_class,)) + bytes(bits) + bytes(vals)
