"""Pure-Python baseline & progressive JPEG decoder (8-bit Huffman streams).

Supports sequential and progressive DCT, restart markers, EXIF orientation,
and grayscale / YCbCr / CMYK(YCCK) colour conversion.  Block output can be
reduced to 1/2, 1/4 or 1/8 scale, which the similarity pipeline uses.

This decoder exists so the catalog tool works with no third-party packages.
It is not fast at full resolution: :mod:`photocatalog.imaging.external` provides
a faster path when ffmpeg/ImageMagick is installed, and the loader prefers it.
"""

from __future__ import annotations

import math
import struct

from .image import Image, ImageError

_ZIGZAG = (
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
)
# _ZIGZAG maps scan position -> natural (row-major) coefficient index.
# _SCAN_OF maps natural index -> scan position; only useful for encoding.
_SCAN_OF = [0] * 64
for _i, _z in enumerate(_ZIGZAG):
    _SCAN_OF[_z] = _i

# Orthonormal cosine basis for an n-point 1D IDCT.
# basis_n[u][x] = 0.5 * C(u) * cos((2x+1)u*pi/(2n)),  C(0)=sqrt(0.5)
_BASIS: dict[int, list[list[float]]] = {}


def _basis(n: int) -> list[list[float]]:
    table = _BASIS.get(n)
    if table is None:
        table = []
        for u in range(n):
            cu = math.sqrt(0.5) if u == 0 else 1.0
            row = [0.5 * cu * math.cos((2 * x + 1) * u * math.pi / (2 * n))
                   for x in range(n)]
            table.append(row)
        _BASIS[n] = table
    return table


def _clamp8(v: float) -> int:
    if v <= 0.0:
        return 0
    if v >= 255.0:
        return 255
    return int(v + 0.5)


class _Huffman:
    __slots__ = ("lookup",)

    def __init__(self, counts: list[int], symbols: list[int]):
        self.lookup: dict[tuple[int, int], int] = {}
        code = 0
        k = 0
        for length in range(1, 17):
            limit = counts[length - 1]
            for _ in range(limit):
                if k < len(symbols):
                    self.lookup[(length, code)] = symbols[k]
                    k += 1
                code += 1
            code <<= 1
        if k < len(symbols):
            raise ImageError("JPEG Huffman table has more symbols than codes")


class _BitReader:
    """Entropy-coded bit reader with byte stuffing and marker detection."""

    __slots__ = ("data", "pos", "value", "nbits", "marker", "marker_pos")

    def __init__(self, data: bytes, pos: int = 0):
        self.data = data
        self.pos = pos
        self.value = 0
        self.nbits = 0
        self.marker: int | None = None
        self.marker_pos: int | None = None

    def _next_byte(self) -> int:
        data = self.data
        pos = self.pos
        if pos >= len(data):
            return 0
        b = data[pos]
        if b != 0xFF:
            self.pos = pos + 1
            return b
        scan = pos
        while scan < len(data) and data[scan] == 0xFF:
            scan += 1
        if scan >= len(data):
            self.pos = len(data)
            return 0
        nxt = data[scan]
        if nxt == 0x00:            # stuffed 0xFF data byte
            self.pos = scan + 1
            return 0xFF
        # A real marker: stop before it and remember where it starts.
        self.marker = nxt
        self.marker_pos = pos
        self.pos = pos
        return 0

    def get_bit(self) -> int:
        if self.nbits == 0:
            self.value = self._next_byte()
            self.nbits = 8
        self.nbits -= 1
        return (self.value >> self.nbits) & 1

    def get_bits(self, count: int) -> int:
        value = 0
        for _ in range(count):
            value = (value << 1) | self.get_bit()
        return value

    def decode(self, table: _Huffman) -> int:
        code = 0
        for length in range(1, 17):
            code = (code << 1) | self.get_bit()
            sym = table.lookup.get((length, code))
            if sym is not None:
                return sym
        raise ImageError("corrupt JPEG entropy data (no matching Huffman code)")

    def reset_to_restart(self) -> None:
        """Discard buffered bits and move past the next RSTn marker."""
        self.nbits = 0
        data = self.data
        i = self.pos
        while i < len(data) - 1:
            if data[i] == 0xFF:
                j = i
                while j < len(data) and data[j] == 0xFF:
                    j += 1
                if j < len(data) and 0xD0 <= data[j] <= 0xD7:
                    self.pos = j + 1
                    return
            i += 1
        self.pos = len(data)


def _extend(value: int, bits: int) -> int:
    if bits == 0:
        return 0
    if value < (1 << (bits - 1)):
        return value - (1 << bits) + 1
    return value


class _Component:
    __slots__ = ("cid", "h", "v", "tq", "td", "ta", "blocks_x", "blocks_y",
                 "coeffs", "dc_pred", "comp_w", "comp_h", "store_x", "store_y")

    def __init__(self, cid: int, h: int, v: int, tq: int):
        self.cid = cid
        self.h = h
        self.v = v
        self.tq = tq
        self.td = 0
        self.ta = 0
        self.blocks_x = 0
        self.blocks_y = 0
        self.coeffs: list[list[int]] = []
        self.dc_pred = 0
        self.comp_w = 0
        self.comp_h = 0
        self.store_x = 0
        self.store_y = 0


def _orientation_from_exif(payload: bytes) -> int | None:
    if len(payload) < 14 or payload[:6] != b"Exif\x00\x00":
        return None
    tiff = payload[6:]
    if len(tiff) < 8:
        return None
    if tiff[:2] == b"II":
        endian = "<"
    elif tiff[:2] == b"MM":
        endian = ">"
    else:
        return None
    try:
        offset = struct.unpack(endian + "I", tiff[4:8])[0]
        if offset + 2 > len(tiff):
            return None
        count = struct.unpack(endian + "H", tiff[offset:offset + 2])[0]
        base = offset + 2
        for i in range(count):
            entry = base + i * 12
            if entry + 12 > len(tiff):
                return None
            tag, typ, _count, value = struct.unpack(endian + "HHII", tiff[entry:entry + 12])
            if tag == 0x0112:
                if typ == 3:
                    value = struct.unpack(endian + "H", tiff[entry + 8:entry + 10])[0]
                return value if 1 <= value <= 8 else None
    except (struct.error, IndexError):
        return None
    return None


def apply_orientation(img: Image, orientation: int | None) -> Image:
    """Rotate/flip an image according to EXIF orientation (1..8)."""
    if not orientation or orientation == 1:
        return img
    w, h, ch, px = img.width, img.height, img.channels, img.pixels
    transposed = orientation in (5, 6, 7, 8)
    ow, oh = (h, w) if transposed else (w, h)
    out = bytearray(ow * oh * ch)
    for y in range(h):
        for x in range(w):
            if orientation == 2:
                ox, oy = w - 1 - x, y
            elif orientation == 3:
                ox, oy = w - 1 - x, h - 1 - y
            elif orientation == 4:
                ox, oy = x, h - 1 - y
            elif orientation == 5:
                ox, oy = y, x
            elif orientation == 6:
                ox, oy = h - 1 - y, x
            elif orientation == 7:
                ox, oy = h - 1 - y, w - 1 - x
            elif orientation == 8:
                ox, oy = y, w - 1 - x
            else:
                ox, oy = x, y
            src = (y * w + x) * ch
            dst = (oy * ow + ox) * ch
            out[dst:dst + ch] = px[src:src + ch]
    return Image(ow, oh, bytes(out), ch, img.format, img.mode)


def _parse_header(data: bytes) -> tuple[dict, int]:
    """Read markers up to the first SOS.  Returns (state, SOS marker offset)."""
    pos = 2
    state = {
        "width": 0, "height": 0, "precision": 8, "components": [],
        "quant": {}, "dc_raw": {}, "ac_raw": {}, "dc": {}, "ac": {},
        "restart": 0, "progressive": False, "adobe": None, "orientation": None,
    }
    while pos < len(data):
        if data[pos] != 0xFF:
            raise ImageError(f"JPEG marker expected at offset {pos}")
        start = pos
        while pos < len(data) and data[pos] == 0xFF:
            pos += 1
        if pos >= len(data):
            break
        marker = data[pos]
        pos += 1
        if marker == 0xD9:
            raise ImageError("JPEG has no scan (SOS marker)")
        if marker in range(0xD0, 0xD8):
            continue
        if marker == 0x01:
            continue
        if marker == 0xDA:
            return state, start
        if pos + 2 > len(data):
            raise ImageError("truncated JPEG segment")
        length = struct.unpack(">H", data[pos:pos + 2])[0]
        if length < 2:
            raise ImageError("invalid JPEG segment length")
        body = data[pos + 2:pos + length]
        if len(body) != length - 2:
            raise ImageError("truncated JPEG segment body")
        _handle_segment(marker, body, state)
        pos += length
    raise ImageError("JPEG has no scan (SOS marker)")


def _handle_segment(marker: int, body: bytes, state: dict) -> None:
    if marker == 0xE1:
        if body.startswith(b"Exif\x00\x00"):
            o = _orientation_from_exif(body)
            if o:
                state["orientation"] = o
    elif marker == 0xEE:
        if len(body) >= 12 and body[:5] == b"Adobe":
            state["adobe"] = body[11]
    elif marker in (0xC0, 0xC1, 0xC2):
        if len(body) < 6:
            raise ImageError("truncated SOF")
        precision, height, width, ncomp = struct.unpack(">BHHB", body[:6])
        if precision != 8:
            raise ImageError(f"unsupported JPEG precision {precision}")
        if width <= 0 or height <= 0:
            raise ImageError(f"invalid JPEG size {width}x{height}")
        if ncomp not in (1, 3, 4):
            raise ImageError(f"unsupported JPEG component count {ncomp}")
        state["precision"] = precision
        state["height"] = height
        state["width"] = width
        state["progressive"] = marker == 0xC2
        comps = []
        for i in range(ncomp):
            if 6 + i * 3 + 3 > len(body):
                raise ImageError("truncated SOF component list")
            cid, hv, tq = struct.unpack(">BBB", body[6 + i * 3:9 + i * 3])
            h, v = hv >> 4, hv & 0x0F
            if h == 0 or v == 0 or h > 4 or v > 4:
                raise ImageError("invalid JPEG sampling factor")
            comps.append(_Component(cid, h, v, tq))
        state["components"] = comps
    elif marker in (0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
        raise ImageError(f"unsupported JPEG coding process (SOF 0x{marker:02X})")
    elif marker == 0xDB:  # DQT
        i = 0
        while i < len(body):
            pq = body[i] >> 4
            tq = body[i] & 0x0F
            i += 1
            if pq == 0:
                raw = list(body[i:i + 64])
                i += 64
            else:
                raw = list(struct.unpack(">" + "H" * 64, body[i:i + 128]))
                i += 128
            if len(raw) != 64:
                raise ImageError("truncated DQT")
            # Store in natural (row-major) coefficient order.
            natural = [1] * 64
            for z in range(64):
                natural[_ZIGZAG[z]] = raw[z]
            state["quant"][tq] = natural
    elif marker == 0xC4:  # DHT
        i = 0
        while i < len(body):
            tc = body[i] >> 4
            th = body[i] & 0x0F
            i += 1
            counts = list(body[i:i + 16])
            i += 16
            total = sum(counts)
            symbols = list(body[i:i + total])
            i += total
            if len(symbols) != total:
                raise ImageError("truncated DHT")
            if tc == 0:
                state["dc_raw"][th] = (counts, symbols)
            elif tc == 1:
                state["ac_raw"][th] = (counts, symbols)
    elif marker == 0xDD:  # DRI
        if len(body) < 2:
            raise ImageError("truncated DRI")
        state["restart"] = struct.unpack(">H", body[:2])[0]


def decode_jpeg(path: str, *, max_dimension: int | None = None) -> Image:
    with open(path, "rb") as fh:
        data = fh.read()
    if not data.startswith(b"\xff\xd8"):
        raise ImageError("not a JPEG file")
    state, sos_start = _parse_header(data)
    width, height = state["width"], state["height"]

    scale = 1
    if max_dimension is not None:
        longest = max(width, height)
        for s in (8, 4, 2, 1):
            if longest // s >= max_dimension:
                scale = s
                break
        else:
            scale = 1

    try:
        img = _decode_all(data, state, sos_start, scale)
    except ImageError:
        raise
    except (struct.error, IndexError, KeyError, ValueError) as exc:
        raise ImageError(f"JPEG decode failed: {exc}") from exc
    if state["orientation"]:
        img = apply_orientation(img, state["orientation"])
    return img


def _decode_all(data: bytes, state: dict, sos_start: int, scale: int) -> Image:
    comps: list[_Component] = state["components"]
    width, height = state["width"], state["height"]
    max_h = max(c.h for c in comps)
    max_v = max(c.v for c in comps)
    mcu_w = 8 * max_h
    mcu_h = 8 * max_v
    mcus_x = (width + mcu_w - 1) // mcu_w
    mcus_y = (height + mcu_h - 1) // mcu_h

    for c in comps:
        c.comp_w = (width * c.h + max_h - 1) // max_h
        c.comp_h = (height * c.v + max_v - 1) // max_v
        c.blocks_x = (c.comp_w + 7) // 8
        c.blocks_y = (c.comp_h + 7) // 8
        # Storage is padded up to whole MCUs so interleaved scans can index it.
        store_x = mcus_x * c.h
        store_y = mcus_y * c.v
        c.coeffs = [[0] * 64 for _ in range(store_x * store_y)]
        c.dc_pred = 0
        c.store_x = store_x
        c.store_y = store_y

    for c in comps:
        if c.tq not in state["quant"]:
            raise ImageError(f"JPEG missing quantization table {c.tq}")
    state["dc"] = {k: _Huffman(*v) for k, v in state["dc_raw"].items()}
    state["ac"] = {k: _Huffman(*v) for k, v in state["ac_raw"].items()}

    pos = sos_start
    scans = 0
    while pos < len(data):
        if data[pos] != 0xFF:
            # Resynchronise: tolerate padding/garbage between scans.
            nxt = data.find(b"\xff", pos)
            if nxt < 0:
                break
            pos = nxt
        start = pos
        while pos < len(data) and data[pos] == 0xFF:
            pos += 1
        if pos >= len(data):
            break
        marker = data[pos]
        pos += 1
        if marker == 0xD9:
            break
        if marker in range(0xD0, 0xD8) or marker == 0x01:
            continue
        if pos + 2 > len(data):
            break
        length = struct.unpack(">H", data[pos:pos + 2])[0]
        body = data[pos + 2:pos + length]
        if len(body) != length - 2:
            raise ImageError("truncated JPEG segment")
        if marker == 0xDA:
            scan_pos = pos + length
            scan = _parse_sos(body)
            for c in comps:
                c.dc_pred = 0
            reader = _BitReader(data, scan_pos)
            _decode_scan(reader, scan, comps, state, mcus_x, mcus_y)
            scans += 1
            # Resume at the marker that ended the scan.  When the entropy data
            # ended exactly on a byte boundary the reader never had to touch
            # the marker byte, so fall back to its position and resynchronise.
            if reader.marker_pos is not None:
                pos = reader.marker_pos
            else:
                pos = _next_marker_pos(data, reader.pos)
                if pos is None:
                    break
            if not state["progressive"]:
                break
            if scans > 1500:
                raise ImageError("too many JPEG scans")
            continue
        _handle_segment(marker, body, state)
        state["dc"] = {k: _Huffman(*v) for k, v in state["dc_raw"].items()}
        state["ac"] = {k: _Huffman(*v) for k, v in state["ac_raw"].items()}
        pos += length

    return _assemble(comps, width, height, scale, state["quant"], state["adobe"])


def _next_marker_pos(data: bytes, start: int) -> int | None:
    """Offset of the next real marker at or after ``start``."""
    i = start
    while i < len(data) - 1:
        if data[i] != 0xFF:
            i += 1
            continue
        j = i
        while j < len(data) and data[j] == 0xFF:
            j += 1
        if j >= len(data):
            return None
        nxt = data[j]
        if nxt == 0x00:
            i = j + 1
            continue
        if 0xD0 <= nxt <= 0xD7:
            i = j + 1
            continue
        return i
    return None


def _parse_sos(body: bytes) -> dict:
    if len(body) < 1:
        raise ImageError("empty SOS")
    ns = body[0]
    if ns < 1 or ns > 4 or len(body) < 1 + ns * 2 + 3:
        raise ImageError("invalid SOS header")
    sel = []
    for i in range(ns):
        cid = body[1 + i * 2]
        td = body[2 + i * 2] >> 4
        ta = body[2 + i * 2] & 0x0F
        sel.append((cid, td, ta))
    ss = body[1 + ns * 2]
    se = body[2 + ns * 2]
    ah = body[3 + ns * 2] >> 4
    al = body[3 + ns * 2] & 0x0F
    return {"sel": sel, "ss": ss, "se": se, "ah": ah, "al": al}


def _decode_scan(reader: _BitReader, scan: dict, comps: list[_Component],
                 state: dict, mcus_x: int, mcus_y: int) -> None:
    sel = scan["sel"]
    selected = []
    for cid, td, ta in sel:
        comp = next((c for c in comps if c.cid == cid), None)
        if comp is None:
            raise ImageError(f"SOS references unknown component id {cid}")
        comp.td, comp.ta = td, ta
        selected.append(comp)
    ss, se, ah, al = scan["ss"], scan["se"], scan["ah"], scan["al"]
    progressive = state["progressive"]
    restart = state["restart"]
    interleaved = len(selected) > 1

    eobrun = 0
    mcu_index = 0

    def check_restart() -> None:
        nonlocal eobrun
        reader.reset_to_restart()
        for c in selected:
            c.dc_pred = 0
        eobrun = 0

    if interleaved:
        for my in range(mcus_y):
            for mx in range(mcus_x):
                if reader.marker is not None:
                    return          # scan terminated early by a marker
                if restart and mcu_index and mcu_index % restart == 0:
                    check_restart()
                mcu_index += 1
                for c in ordered(selected, sel):
                    dc = _table(state["dc"], c.td)
                    ac = _table(state["ac"], c.ta)
                    bx = mx * c.h
                    by = my * c.v
                    sx = c.store_x
                    for vy in range(c.v):
                        for hx in range(c.h):
                            idx = (by + vy) * sx + bx + hx
                            eobrun = _decode_block(
                                reader, c.coeffs[idx], c, dc, ac,
                                ss, se, ah, al, progressive, eobrun)
                            if reader.marker is not None:
                                return
    else:
        c = selected[0]
        dc = _table(state["dc"], c.td)
        ac = _table(state["ac"], c.ta)
        for by in range(c.blocks_y):
            for bx in range(c.blocks_x):
                if reader.marker is not None:
                    return
                if restart and mcu_index and mcu_index % restart == 0:
                    check_restart()
                mcu_index += 1
                idx = by * c.store_x + bx
                eobrun = _decode_block(
                    reader, c.coeffs[idx], c, dc, ac,
                    ss, se, ah, al, progressive, eobrun)
                if reader.marker is not None:
                    return


def ordered(selected: list[_Component], sel: list[tuple[int, int, int]]) -> list[_Component]:
    """Return components in SOS order (JPEG interleaved scans follow that order)."""
    ids = [cid for cid, _td, _ta in sel]
    return [next(c for c in selected if c.cid == cid) for cid in ids]


def _table(tables: dict[int, _Huffman], index: int) -> _Huffman:
    table = tables.get(index)
    if table is None:
        raise ImageError(f"JPEG scan missing Huffman table {index}")
    return table


def _decode_block(reader: _BitReader, coefs: list[int], comp: _Component,
                  dc: _Huffman, ac: _Huffman, ss: int, se: int,
                  ah: int, al: int, progressive: bool, eobrun: int) -> int:
    if not progressive:
        _decode_sequential(reader, coefs, comp, dc, ac)
        return 0
    if ss == 0:
        if ah == 0:
            _decode_dc_first(reader, coefs, comp, dc, al)
        else:
            if reader.get_bit():
                coefs[0] |= (1 << al)
    else:
        if ah == 0:
            eobrun = _decode_ac_first(reader, coefs, ac, ss, se, al, eobrun)
        else:
            eobrun = _decode_ac_refine(reader, coefs, ac, ss, se, al, eobrun)
    return eobrun


def _decode_sequential(reader, coefs, comp, dc, ac):
    s = read_symbol(reader, dc)
    if s == 0:
        diff = 0
    elif s == 16:
        coefs[0] = comp.dc_pred
        raise ImageError("invalid DC magnitude in sequential scan")
    else:
        diff = _extend(reader.get_bits(s), s)
    comp.dc_pred += diff
    coefs[0] = comp.dc_pred
    k = 1
    while k < 64:
        rs = read_symbol(reader, ac)
        r, sz = rs >> 4, rs & 0x0F
        if sz == 0:
            if r == 15:
                k += 16
                continue
            break
        k += r
        if k > 63:
            break
        coefs[_ZIGZAG[k]] = _extend(reader.get_bits(sz), sz)
        k += 1


def read_symbol(reader: _BitReader, table: _Huffman) -> int:
    return reader.decode(table)


def _decode_dc_first(reader, coefs, comp, dc, al):
    s = read_symbol(reader, dc)
    if s == 0:
        diff = 0
    else:
        diff = _extend(reader.get_bits(s), s)
    comp.dc_pred += diff
    coefs[0] = comp.dc_pred << al


def _decode_ac_first(reader, coefs, ac, ss, se, al, eobrun):
    """AC coefficients, first (non-refining) progressive pass."""
    p1 = 1 << al
    k = ss
    if eobrun == 0:
        while k <= se:
            rs = read_symbol(reader, ac)
            r, s = rs >> 4, rs & 0x0F
            if s:
                k += r
                if k > se:
                    raise ImageError("AC first: coefficient outside spectral range")
                coefs[_ZIGZAG[k]] = _extend(reader.get_bits(s), s) << al
            else:
                if r != 15:
                    eobrun = 1 << r
                    if r:
                        eobrun += reader.get_bits(r)
                    break
                k += 16          # ZRL: skip 16 zero coefficients
                continue
            k += 1
    if eobrun > 0:
        eobrun -= 1
    return eobrun


def _refine_one(reader, coefs, idx, p1):
    """Add one refinement bit to an already non-zero coefficient."""
    if reader.get_bit() and (coefs[idx] & p1) == 0:
        coefs[idx] += p1 if coefs[idx] > 0 else -p1


def _decode_ac_refine(reader, coefs, ac, ss, se, al, eobrun):
    """AC coefficients, successive-approximation refinement pass."""
    p1 = 1 << al
    k = ss
    if eobrun == 0:
        while k <= se:
            rs = read_symbol(reader, ac)
            r, s = rs >> 4, rs & 0x0F
            if s:
                if s != 1:
                    raise ImageError("AC refine: invalid magnitude symbol")
                s = p1 if reader.get_bit() else -p1
            else:
                if r != 15:
                    eobrun = 1 << r
                    if r:
                        eobrun += reader.get_bits(r)
                    break
                # ZRL: r stays 15, consuming sixteen zero positions below.
            # Consume r zero coefficients, refining any non-zero ones en passant.
            while k <= se:
                idx = _ZIGZAG[k]
                if coefs[idx] != 0:
                    _refine_one(reader, coefs, idx, p1)
                else:
                    if r == 0:
                        break
                    r -= 1
                k += 1
            if s:
                if k > se:
                    raise ImageError("AC refine: coefficient outside spectral range")
                coefs[_ZIGZAG[k]] = s
            k += 1

    if eobrun > 0:
        while k <= se:
            idx = _ZIGZAG[k]
            if coefs[idx] != 0:
                _refine_one(reader, coefs, idx, p1)
            k += 1
        eobrun -= 1
    return eobrun


def _idct_scaled(coefs: list[int], quant: list[int], n: int) -> list[float]:
    """Dequantise and compute an n x n low-frequency IDCT of one block."""
    basis = _basis(n)
    d = [coefs[i] * quant[i] for i in range(64)]
    rows = [0.0] * (n * 8)
    for v in range(n):
        base = v * 8
        row_out = v * n
        for x in range(n):
            acc = 0.0
            bx = basis[0][x] * d[base]
            for u in range(1, n):
                acc += basis[u][x] * d[base + u]
            rows[row_out + x] = acc + bx
    out = [0.0] * (n * n)
    for y in range(n):
        for x in range(n):
            acc = 0.0
            for v in range(n):
                acc += basis[v][y] * rows[v * n + x]
            out[y * n + x] = acc + 128.0
    return out


def _assemble(comps: list[_Component], width: int, height: int, scale: int,
              quant: dict[int, list[int]], adobe: int | None) -> Image:
    n = 8 // scale
    out_w = max(1, (width + scale - 1) // scale)
    out_h = max(1, (height + scale - 1) // scale)

    planes: list[tuple[bytearray, int, int]] = []
    for c in comps:
        q = quant[c.tq]
        pw = c.store_x * n
        ph = c.store_y * n
        plane = bytearray(pw * ph)
        for bi, coefs in enumerate(c.coeffs):
            block = _idct_scaled(coefs, q, n)
            bx = (bi % c.store_x) * n
            by = (bi // c.store_x) * n
            for yy in range(n):
                dst = (by + yy) * pw + bx
                src = yy * n
                for xx in range(n):
                    plane[dst + xx] = _clamp8(block[src + xx])
        # Valid (non-padding) extent of this component at the decode scale.
        valid_w = max(1, (c.comp_w + scale - 1) // scale)
        valid_h = max(1, (c.comp_h + scale - 1) // scale)
        planes.append((plane, pw, ph, valid_w, valid_h))

    def sample(entry, x, y):
        plane, pw, _ph, valid_w, valid_h = entry
        sx = (x * valid_w) // out_w
        sy = (y * valid_h) // out_h
        if sx >= valid_w:
            sx = valid_w - 1
        if sy >= valid_h:
            sy = valid_h - 1
        return plane[sy * pw + sx]

    mode = "RGB"
    if len(comps) == 1:
        plane, pw, _ph, valid_w, valid_h = planes[0]
        out = bytearray(out_w * out_h * 3)
        for y in range(out_h):
            drow = y * out_w * 3
            sy = (y * ph) // out_h
            srow = sy * pw
            for x in range(out_w):
                sx = (x * valid_w) // out_w
                v = plane[srow + sx]
                o = drow + x * 3
                out[o] = out[o + 1] = out[o + 2] = v
        mode = "L"
    elif len(comps) == 3:
        e0 = planes[0]
        e1 = planes[1]
        e2 = planes[2]
        out = bytearray(out_w * out_h * 3)
        identity = adobe == 0
        mode = "RGB" if identity else "YCbCr"
        for y in range(out_h):
            drow = y * out_w * 3
            for x in range(out_w):
                v0 = sample(e0, x, y)
                v1 = sample(e1, x, y)
                v2 = sample(e2, x, y)
                o = drow + x * 3
                if identity:
                    out[o], out[o + 1], out[o + 2] = v0, v1, v2
                else:
                    out[o], out[o + 1], out[o + 2] = _ycc_to_rgb(v0, v1, v2)
    elif len(comps) == 4:
        e0 = planes[0]
        e1 = planes[1]
        e2 = planes[2]
        p3, w3, h3 = planes[3]
        ycck = adobe == 2
        out = bytearray(out_w * out_h * 3)
        mode = "CMYK"
        for y in range(out_h):
            drow = y * out_w * 3
            for x in range(out_w):
                c_ = sample(e0, x, y)
                m_ = sample(e1, x, y)
                y_ = sample(e2, x, y)
                k_ = sample(e3, x, y)
                if ycck:
                    c_, m_, y_ = _ycc_to_rgb(c_, m_, y_)
                o = drow + x * 3
                out[o] = 255 - min(255, c_ + k_)
                out[o + 1] = 255 - min(255, m_ + k_)
                out[o + 2] = 255 - min(255, y_ + k_)
    else:
        raise ImageError(f"unsupported JPEG component count {len(comps)}")

    return Image(out_w, out_h, bytes(out), 3, "jpeg", mode)


def _ycc_to_rgb(y: int, cb: int, cr: int) -> tuple[int, int, int]:
    r = y + 1.402 * (cr - 128)
    g = y - 0.344136 * (cb - 128) - 0.714136 * (cr - 128)
    b = y + 1.772 * (cb - 128)
    return _clamp8(r), _clamp8(g), _clamp8(b)
