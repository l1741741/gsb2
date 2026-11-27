"""Decoders for simple / archival raster formats.

Covered: BMP (uncompressed and RLE8 24/32/8/4/1-bit), binary PPM/PGM (P5/P6),
TGA (uncompressed and RLE, 8/24/32-bit), the first frame of a GIF, and a
baseline (uncompressed / packbits / LZW-defiltered) TIFF.  These formats show up
in photo archives far more often than one expects, and they are simple enough
to support directly.
"""

from __future__ import annotations

import struct

from .image import Image, ImageError


def decode_bmp(path: str) -> Image:
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 26 or data[:2] != b"BM":
        raise ImageError("not a BMP file")
    pixel_offset = struct.unpack("<I", data[10:14])[0]
    header_size = struct.unpack("<I", data[14:18])[0]
    if header_size == 12:  # BITMAPCOREHEADER
        width, height, _planes, bpp = struct.unpack("<HHHH", data[18:26])
        compression = 0
        palette_entry = 3
    elif header_size >= 40:
        width, height_signed, _planes, bpp, compression = struct.unpack("<iiHHI", data[18:34])
        if compression in (3, 6):
            raise ImageError("BMP: bitfield compression not supported")
        palette_entry = 4
        height = height_signed
    else:
        raise ImageError(f"unsupported BMP header size {header_size}")

    top_down = height < 0
    height = abs(height)
    if width <= 0 or height == 0:
        raise ImageError("invalid BMP dimensions")

    palette = None
    if bpp <= 8 and compression == 0:
        colours = 1 << bpp
        pal_start = 14 + header_size
        palette = bytearray()
        for i in range(colours):
            off = pal_start + i * palette_entry
            if off + 3 > len(data):
                break
            b, g, r = data[off:off + 3]
            palette += bytes((r, g, b))

    if compression in (1, 2):
        if bpp != 8:
            raise ImageError("BMP RLE requires 8-bit indices")
        rows = _bmp_rle(data, pixel_offset, width, height)
        if palette is None:
            raise ImageError("BMP RLE without palette")
        out = bytearray(width * height * 3)
        for i, idx in enumerate(rows):
            if idx * 3 + 2 < len(palette):
                out[i * 3:i * 3 + 3] = palette[idx * 3:idx * 3 + 3]
        return Image(width, height, bytes(out), 3, "bmp", "P")

    if bpp not in (1, 4, 8, 24, 32):
        raise ImageError(f"unsupported BMP bit depth {bpp}")

    row_bytes = ((width * bpp + 31) // 32) * 4
    if pixel_offset + row_bytes * height > len(data):
        raise ImageError("BMP pixel data truncated")
    channels = 3 if bpp <= 24 else 4
    out = bytearray(width * height * channels)
    for row in range(height):
        src_row = row if top_down else height - 1 - row
        base = pixel_offset + src_row * row_bytes
        dst = row * width * channels
        if bpp == 24 or bpp == 32:
            step = bpp // 8
            for x in range(width):
                s = base + x * step
                d = dst + x * channels
                out[d] = data[s + 2]
                out[d + 1] = data[s + 1]
                out[d + 2] = data[s]
                if channels == 4:
                    out[d + 3] = data[s + 3] if data[s + 3] else 255
        else:
            if palette is None:
                raise ImageError("indexed BMP without palette")
            per_byte = 8 // bpp
            mask = (1 << bpp) - 1
            for x in range(width):
                byte = data[base + x // per_byte]
                shift = 8 - bpp * (x % per_byte + 1)
                idx = (byte >> shift) & mask
                if idx * 3 + 2 < len(palette):
                    d = dst + x * channels
                    out[d:d + 3] = palette[idx * 3:idx * 3 + 3]
    return Image(width, height, bytes(out), channels, "bmp",
                 "RGB" if channels == 3 else "RGBA")


def _bmp_rle(data: bytes, start: int, width: int, height: int) -> list[int]:
    rows = [255] * (width * height)
    x = 0
    y = height - 1
    pos = start
    while pos + 1 < len(data) and y >= 0:
        count = data[pos]
        code = data[pos + 1]
        pos += 2
        if count == 0:
            if code == 0:       # end of line
                x = 0
                y -= 1
            elif code == 1:     # end of bitmap
                break
            elif code == 2:     # delta
                if pos + 1 >= len(data):
                    break
                x += data[pos]
                y -= data[pos + 1]
                pos += 2
            else:               # absolute run of `code` bytes
                n = code
                for i in range(n):
                    if pos >= len(data):
                        break
                    if 0 <= y < height and x + i < width:
                        rows[y * width + x + i] = data[pos]
                    pos += 1
                if n % 2:
                    pos += 1
                x += n
        else:
            idx = code
            for i in range(count):
                if 0 <= y < height and x + i < width:
                    rows[y * width + x + i] = idx
            x += count
    return rows


def decode_ppm(path: str) -> Image:
    with open(path, "rb") as fh:
        header = fh.read(1024)
    # Parse the netpbm header allowing comments.
    tokens = []
    i = 0
    while len(tokens) < 4 and i < len(header):
        ch = header[i:i + 1]
        if ch in b" \t\r\n":
            i += 1
            continue
        if ch == b"#":
            while i < len(header) and header[i:i + 1] not in b"\r\n":
                i += 1
            continue
        j = i
        while j < len(header) and header[j:j + 1] not in b" \t\r\n":
            j += 1
        tokens.append(header[i:j])
        i = j
    magic = tokens[0]
    if magic not in (b"P5", b"P6"):
        raise ImageError(f"unsupported PPM magic {magic!r}")
    width, height, maxval = int(tokens[1]), int(tokens[2]), int(tokens[3])
    # Data starts after the whitespace following the maxval token.
    start = i
    while start < len(header) and header[start:start + 1] in b" \t\r\n":
        start += 1
    with open(path, "rb") as fh:
        fh.seek(start)
        payload = fh.read()
    channels = 1 if magic == b"P5" else 3
    need = width * height * channels
    if len(payload) < need:
        raise ImageError("PPM data truncated")
    if maxval > 255:
        payload = payload[0::2][:need]
    if channels == 1:
        out = bytearray(width * height * 3)
        out[0::3] = payload[:width * height]
        out[1::3] = payload[:width * height]
        out[2::3] = payload[:width * height]
        return Image(width, height, bytes(out), 3, "ppm", "L")
    return Image(width, height, bytes(payload[:need]), 3, "ppm", "RGB")


def decode_tga(path: str) -> Image:
    with open(path, "rb") as fh:
        data = fh.read()
    if len(data) < 18:
        raise ImageError("truncated TGA header")
    id_len, cmap_type, image_type = data[0], data[1], data[2]
    _cmap_first, cmap_len, cmap_bits = struct.unpack("<HHB", data[3:8])
    _x_origin, _y_origin, width, height, bpp, descriptor = struct.unpack(
        "<HHHHBB", data[8:18])
    if width == 0 or height == 0:
        raise ImageError("invalid TGA dimensions")
    channels = {24: 3, 32: 4, 8: 1, 15: 3, 16: 3}.get(bpp)
    if channels is None:
        raise ImageError(f"unsupported TGA bit depth {bpp}")
    palette = None
    pos = 18 + id_len
    if cmap_type == 1:
        size = cmap_len * ((cmap_bits + 7) // 8)
        raw_cmap = data[pos:pos + size]
        pos += size
        if len(raw_cmap) < size:
            raise ImageError("truncated TGA palette")
        palette = bytearray()
        step = (cmap_bits + 7) // 8
        for k in range(cmap_len):
            entry = raw_cmap[k * step:(k + 1) * step]
            if len(entry) < 3:
                palette += b"\x00\x00\x00"
                continue
            palette += bytes((entry[2], entry[1], entry[0]))
    if image_type not in (1, 2, 3, 9, 10, 11):
        raise ImageError(f"unsupported TGA image type {image_type}")
    rle = image_type >= 9
    indexed = image_type in (1, 9) or (image_type in (3, 11) and bpp == 8 and cmap_type == 1)
    grey = image_type in (3, 11) and not indexed

    pixel_count = width * height
    samples: list[bytes] = []
    if rle:
        while len(samples) < pixel_count and pos < len(data):
            packet = data[pos]
            pos += 1
            count = (packet & 0x7F) + 1
            if packet & 0x80:
                repeat = data[pos:pos + (bpp // 8)]
                pos += bpp // 8
                if len(repeat) < bpp // 8:
                    break
                samples.extend([repeat] * count)
            else:
                for _ in range(count):
                    chunk = data[pos:pos + (bpp // 8)]
                    pos += bpp // 8
                    if len(chunk) < bpp // 8:
                        break
                    samples.append(chunk)
    else:
        step = bpp // 8
        for _ in range(pixel_count):
            samples.append(data[pos:pos + step])
            pos += step
    if len(samples) < pixel_count:
        raise ImageError("TGA pixel data truncated")

    origin_top = bool(descriptor & 0x20)
    origin_right = bool(descriptor & 0x10)
    out = bytearray(width * height * 3)
    for n in range(pixel_count):
        sy, sx = divmod(n, width)
        y = sy if origin_top else height - 1 - sy
        x = width - 1 - sx if origin_right else sx
        s = samples[n]
        d = (y * width + x) * 3
        if grey:
            v = s[0]
            out[d] = out[d + 1] = out[d + 2] = v
        elif indexed:
            idx = s[0]
            if palette is not None and idx * 3 + 2 < len(palette):
                out[d:d + 3] = palette[idx * 3:idx * 3 + 3]
        else:
            out[d] = s[2]
            out[d + 1] = s[1]
            out[d + 2] = s[0]
            if bpp == 16 and len(s) >= 2:
                v = (s[1] << 8) | s[0]
                out[d] = ((v & 0x7C00) >> 7)
                out[d + 1] = ((v & 0x03E0) >> 2)
                out[d + 2] = ((v & 0x001F) << 3)
            elif bpp == 15:
                v = (s[1] << 8) | s[0]
                out[d] = ((v & 0x7C00) >> 7)
                out[d + 1] = ((v & 0x03E0) >> 2)
                out[d + 2] = ((v & 0x001F) << 3)
    return Image(width, height, bytes(out), 3, "tga", "RGB")


def decode_gif_first_frame(path: str) -> Image:
    with open(path, "rb") as fh:
        data = fh.read()
    if not data.startswith(b"GIF8"):
        raise ImageError("not a GIF file")
    width, height, packed, bg, _aspect = struct.unpack("<HHBBB", data[6:13])
    pos = 13
    global_palette = None
    if packed & 0x80:
        size = 3 * (1 << ((packed & 0x07) + 1))
        global_palette = data[pos:pos + size]
        pos += size
    while pos < len(data):
        block = data[pos]
        pos += 1
        if block == 0x21:  # extension
            label = data[pos]
            pos += 1
            if label == 0xF9:
                pos += 1
                block_size = data[pos]
                pos += block_size + 1 + 1
                continue
            while pos < len(data):
                size = data[pos]
                pos += 1
                if size == 0:
                    break
                pos += size
            continue
        if block == 0x2C:  # image descriptor
            left, top, w, h, ipacked = struct.unpack("<HHHHB", data[pos:pos + 9])
            pos += 9
            local_palette = None
            if ipacked & 0x80:
                size = 3 * (1 << ((ipacked & 0x07) + 1))
                local_palette = data[pos:pos + size]
                pos += size
            lzw_min = data[pos]
            pos += 1
            sub_blocks = bytearray()
            while pos < len(data):
                size = data[pos]
                pos += 1
                if size == 0:
                    break
                sub_blocks += data[pos:pos + size]
                pos += size
            palette = local_palette or global_palette
            if palette is None:
                raise ImageError("GIF without palette")
            indices = _gif_lzw(bytes(sub_blocks), lzw_min, w * h)
            interlaced = bool(ipacked & 0x40)
            out = bytearray(width * height * 3)
            for k in range(min(w * h, len(indices))):
                idx = indices[k]
                if interlaced:
                    row, col = divmod(k, w)
                    row = _gif_row(row, h)
                else:
                    row, col = divmod(k, w)
                dst = ((top + row) * width + (left + col)) * 3
                if dst + 2 >= len(out):
                    continue
                if idx * 3 + 2 < len(palette):
                    out[dst:dst + 3] = palette[idx * 3:idx * 3 + 3]
            return Image(width, height, bytes(out), 3, "gif", "P")
        raise ImageError(f"no image data in GIF (block 0x{block:02X})")
    raise ImageError("GIF has no image frame")


_GIF_INTERLACE = ((0, 8), (4, 8), (2, 4), (1, 2))


def _gif_row(row: int, height: int) -> int:
    """Map a sequential row index to its interlaced source row."""
    for start, step in _GIF_INTERLACE:
        span = (height - start + step - 1) // step if height > start else 0
        if row < span:
            return start + row * step
        row -= span
    return min(row, height - 1)


def _gif_lzw(data: bytes, min_code_size: int, expected: int) -> list[int]:
    if min_code_size < 2 or min_code_size > 11:
        raise ImageError(f"invalid GIF LZW code size {min_code_size}")
    clear = 1 << min_code_size
    eoi = clear + 1
    code_size = min_code_size + 1
    next_code = eoi + 1
    table: dict[int, bytes] = {i: bytes((i,)) for i in range(clear)}
    result: list[int] = []
    prev: bytes | None = None
    bit_pos = 0
    total_bits = len(data) * 8
    while bit_pos + code_size <= total_bits and len(result) < expected:
        byte_index = bit_pos // 8
        chunk = data[byte_index:byte_index + 3]
        while len(chunk) < 3:
            chunk += b"\x00"
        value = int.from_bytes(chunk, "little")
        code = (value >> (bit_pos % 8)) & ((1 << code_size) - 1)
        bit_pos += code_size
        if code == clear:
            code_size = min_code_size + 1
            next_code = eoi + 1
            table = {i: bytes((i,)) for i in range(clear)}
            prev = None
            continue
        if code == eoi:
            break
        if prev is None:
            entry = table.get(code)
            if entry is None:
                raise ImageError("corrupt GIF LZW stream")
        elif code in table:
            entry = table[code]
            table[next_code] = prev + entry[:1]
            next_code += 1
        elif code == next_code:
            entry = prev + prev[:1]
            table[next_code] = entry
            next_code += 1
        else:
            raise ImageError("corrupt GIF LZW stream (bad code)")
        result.extend(entry)
        prev = entry
        if next_code == (1 << code_size) and code_size < 12:
            code_size += 1
    return result[:expected]


def decode_tiff_baseline(path: str) -> Image:
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:2] == b"II":
        endian = "<"
    elif data[:2] == b"MM":
        endian = ">"
    else:
        raise ImageError("not a TIFF file")
    magic = struct.unpack(endian + "H", data[2:4])[0]
    if magic != 42:
        raise ImageError("unsupported TIFF variant (BigTIFF?)")
    ifd = struct.unpack(endian + "I", data[4:8])[0]
    count = struct.unpack(endian + "H", data[ifd:ifd + 2])[0]
    tags: dict[int, tuple[int, int, int, bytes]] = {}
    type_size = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}
    for i in range(count):
        entry = ifd + 2 + i * 12
        tag, typ, num = struct.unpack(endian + "HHI", data[entry:entry + 8])
        tag_bytes = type_size.get(typ, 4) * num
        if tag_bytes <= 4:
            value = data[entry + 8:entry + 12][:tag_bytes]
        else:
            offset = struct.unpack(endian + "I", data[entry + 8:entry + 12])[0]
            value = data[offset:offset + tag_bytes]
        tags[tag] = (typ, num, tag_bytes, value)

    def values(tag_id: int) -> list[int]:
        entry = tags.get(tag_id)
        if entry is None:
            return []
        typ, num, tag_bytes, raw = entry
        fmt = {3: "H", 4: "I", 1: "B", 8: "h", 9: "i"}.get(typ)
        if fmt is None:
            return []
        return list(struct.unpack(endian + fmt * num, raw[:tag_bytes]))

    width = values(256)[0] if values(256) else 0
    height = values(257)[0] if values(257) else 0
    if not width or not height:
        raise ImageError("TIFF missing image dimensions")
    bits = values(258)
    compression = (values(259) or [1])[0]
    photometric = (values(262) or [2])[0]
    samples = (values(277) or [1])[0]
    planar = (values(284) or [1])[0]
    predictor = (values(317) or [1])[0]
    strip_offsets = values(273)
    strip_counts = values(279)
    rows_per_strip = (values(278) or [height])[0]
    if not strip_offsets:
        raise ImageError("TIFF has no strips (tiled TIFF unsupported)")
    if compression not in (1, 5, 8, 32946, 32773):
        raise ImageError(f"unsupported TIFF compression {compression}")
    if planar != 1:
        raise ImageError("TIFF planar configuration 2 unsupported")
    if not bits:
        bits = [8]
    if any(b != 8 for b in bits):
        raise ImageError(f"unsupported TIFF bit depth {bits}")

    raw = bytearray()
    for off, cnt in zip(strip_offsets, strip_counts):
        chunk = data[off:off + cnt]
        if compression in (5, 32946):
            chunk = _tiff_lzw_decode(bytes(chunk))
        elif compression in (8, 32946):
            chunk = _tiff_zip_decode(bytes(chunk))
        elif compression == 32773:
            chunk = _packbits_decode(bytes(chunk), width * samples * rows_per_strip)
        raw += chunk
    if len(raw) < width * height * samples:
        raise ImageError("TIFF pixel data truncated")
    if predictor == 2 and samples >= 3:
        _tiff_undo_predictor(raw, width, height, samples)

    if photometric == 2 and samples >= 3:
        out = bytearray(width * height * 3)
        out[0::3] = raw[0:width * height * samples:samples]
        out[1::3] = raw[1:width * height * samples:samples]
        out[2::3] = raw[2:width * height * samples:samples]
        if samples >= 4:
            alpha = bytearray(width * height * 4)
            alpha[0::4] = out[0::3]
            alpha[1::4] = out[1::3]
            alpha[2::4] = out[2::3]
            alpha[3::4] = raw[3:width * height * samples:samples]
            return Image(width, height, bytes(alpha), 4, "tiff", "RGBA")
        return Image(width, height, bytes(out), 3, "tiff", "RGB")
    if photometric in (0, 1) and samples == 1:
        grey = raw[:width * height]
        if photometric == 0:
            grey = bytes(255 - v for v in grey)
        out = bytearray(width * height * 3)
        out[0::3] = grey
        out[1::3] = grey
        out[2::3] = grey
        return Image(width, height, bytes(out), 3, "tiff", "L")
    raise ImageError(f"unsupported TIFF photometric interpretation {photometric}")


def _tiff_zip_decode(data: bytes) -> bytes:
    import zlib
    try:
        return zlib.decompress(data)
    except zlib.error as exc:
        raise ImageError(f"TIFF deflate stream corrupt: {exc}") from exc


def _tiff_undo_predictor(buf: bytearray, width: int, height: int, samples: int) -> None:
    stride = width * samples
    for y in range(height):
        base = y * stride
        for i in range(samples, stride):
            buf[base + i] = (buf[base + i] + buf[base + i - samples]) & 0xFF


def _packbits_decode(data: bytes, expected: int) -> bytes:
    out = bytearray()
    i = 0
    while i < len(data) and len(out) < expected:
        n = data[i]
        i += 1
        if n < 128:
            out += data[i:i + n + 1]
            i += n + 1
        elif n > 128:
            if i >= len(data):
                break
            out += bytes((data[i],)) * (257 - n)
            i += 1
    return bytes(out[:expected])


def _tiff_lzw_decode(data: bytes) -> bytes:
    """TIFF-flavoured LZW (MSB-first, early change)."""
    out = bytearray()
    table: dict[int, bytes] = {i: bytes((i,)) for i in range(256)}
    next_code = 258
    code_size = 9
    prev: bytes | None = None
    bit_pos = 0
    total = len(data) * 8

    def read_code(size: int) -> int:
        nonlocal bit_pos
        if bit_pos + size > total:
            return -1
        byte_index = bit_pos // 8
        shift = bit_pos % 8
        chunk = data[byte_index:byte_index + 3]
        while len(chunk) < 3:
            chunk += b"\x00"
        # TIFF LZW is big-endian bit order.
        value = 0
        for k in range(size):
            bit = bit_pos + k
            value = (value << 1) | ((data[bit // 8] >> (7 - bit % 8)) & 1)
        bit_pos += size
        return value

    while True:
        code = read_code(code_size)
        if code < 0 or code == 257:  # EOI
            break
        if code == 256:             # clear table
            table = {i: bytes((i,)) for i in range(256)}
            next_code = 258
            code_size = 9
            prev = None
            continue
        if prev is None:
            entry = table.get(code)
            if entry is None:
                break
            out += entry
            prev = entry
            continue
        if code in table:
            entry = table[code]
            table[next_code] = prev + entry[:1]
        elif code == next_code:
            entry = prev + prev[:1]
            table[next_code] = entry
        else:
            raise ImageError("corrupt TIFF LZW stream")
        out += entry
        prev = entry
        next_code += 1
        if next_code + 1 >= (1 << code_size) and code_size < 12:
            code_size += 1
    return bytes(out)
