"""重叠区域整数位移对齐。

约定: 边 (a, b) 的位移 offset = (dx, dy) 表示 pos_b = pos_a + offset，
即 b 的左上角在 a 的坐标系中的位置。

对齐只取整数像素（扫描件已大体同向，不做旋转/缩放）。
重复纹理会产生多个得分几乎相同的解：find_candidates 把它们分组全部
列出，由人工配置选择，工具不擅自采用。
"""

from .pngio import Image

ALPHA_MIN = 128          # 低于该 alpha 的像素不参与评分
MIN_SAMPLES = 40         # 有效采样少于此数认为重叠不足
GROUP_RADIUS = 2         # 位移相距在此范围内视为同一个解（一组）


def overlap_rect(wa, ha, wb, hb, dx, dy):
    """b 以 (dx,dy) 放到 a 上时，重叠区域在 a 坐标系中的矩形。"""
    x0 = max(0, dx)
    y0 = max(0, dy)
    x1 = min(wa, dx + wb)
    y1 = min(ha, dy + hb)
    if x1 <= x0 or y1 <= y0:
        return None
    return (x0, y0, x1, y1)


def _score(a, b, dx, dy, stride):
    """重叠区采样平均绝对差（0..255），返回 (score, 有效样本数) 或 None。"""
    rect = overlap_rect(a.w, a.h, b.w, b.h, dx, dy)
    if rect is None:
        return None
    x0, y0, x1, y1 = rect
    pa, pb = a.pix, b.pix
    wa, wb = a.w, b.w
    total = 0
    n = 0
    for y in range(y0, y1, stride):
        iy = y - dy
        row_a = y * wa
        row_b = iy * wb
        for x in range(x0, x1, stride):
            ia = (row_a + x) * 4
            ib = (row_b + x - dx) * 4
            if pa[ia + 3] < ALPHA_MIN or pb[ib + 3] < ALPHA_MIN:
                continue
            d = pa[ia] - pb[ib]
            total += d if d >= 0 else -d
            d = pa[ia + 1] - pb[ib + 1]
            total += d if d >= 0 else -d
            d = pa[ia + 2] - pb[ib + 2]
            total += d if d >= 0 else -d
            n += 1
    if n < MIN_SAMPLES:
        return None
    return (total / (3.0 * n), n)


def _subsample(img, s):
    """按 s x s 块平均下采样（含 alpha），用于粗搜索加速。

    用块平均而非就近取点：避免高频纹理在粗级别产生混叠，
    保证正确位移在粗级别仍然得分最优。
    """
    w, h = img.w // s, img.h // s
    out = Image(max(w, 1), max(h, 1))
    pix, opix = img.pix, out.pix
    inv = 1.0 / (s * s)
    for y in range(out.h):
        for x in range(out.w):
            r = g = b = a = 0
            for dy in range(s):
                row = ((y * s + dy) * img.w + x * s) * 4
                for dx in range(s):
                    i = row + dx * 4
                    r += pix[i]
                    g += pix[i + 1]
                    b += pix[i + 2]
                    a += pix[i + 3]
            o = (y * out.w + x) * 4
            opix[o] = int(r * inv)
            opix[o + 1] = int(g * inv)
            opix[o + 2] = int(b * inv)
            opix[o + 3] = int(a * inv)
    return out


def _group(cands):
    """把 (dx,dy,score,n) 列表按位置邻近分组，返回按组内最优分排序的组列表。

    每组: {"offset": (dx,dy), "score": 组内最优分, "samples": n,
           "members": 组内候选数}
    """
    groups = []
    for dx, dy, score, n in sorted(cands, key=lambda c: c[2]):
        placed = False
        for g in groups:
            gx, gy = g["offset"]
            if abs(dx - gx) <= GROUP_RADIUS and abs(dy - gy) <= GROUP_RADIUS:
                g["members"] += 1
                placed = True
                break
        if not placed:
            groups.append({"offset": (dx, dy), "score": score,
                           "samples": n, "members": 1})
    groups.sort(key=lambda g: g["score"])
    return groups


def find_candidates(a, b, rough, radius=12, top=8):
    """在 rough ± radius 的整数窗口内搜索 b 相对 a 的位移。

    返回候选组列表（按得分升序）。调用方据此判断:
      - 空列表:    重叠不足或窗口内无可行解
      - 一组:      唯一解
      - 多组且次优组得分接近最优: 重复纹理导致的多解，需人工选择
    """
    # 第 1 级: 大窗口时下采样粗搜
    s = 4 if radius >= 24 else 1
    if s > 1:
        ca, cb = _subsample(a, s), _subsample(b, s)
        rough_c = (int(round(rough[0] / s)), int(round(rough[1] / s)))
        radius_c = radius // s + 1
    else:
        ca, cb, rough_c, radius_c = a, b, rough, radius
    coarse = []
    for dy in range(rough_c[1] - radius_c, rough_c[1] + radius_c + 1):
        for dx in range(rough_c[0] - radius_c, rough_c[0] + radius_c + 1):
            r = _score(ca, cb, dx, dy, 1)
            if r is not None:
                coarse.append((dx, dy, r[0], r[1]))
    if not coarse:
        return []
    # 样本量过小的粗结果噪声大，先按样本量过滤再取前 12 个做细化种子
    max_n = max(c[3] for c in coarse)
    coarse = [c for c in coarse if c[3] >= max(40, max_n // 4)]
    coarse.sort(key=lambda c: c[2])

    # 第 2 级: 粗结果附近在全分辨率上细化（稀疏采样）
    seeds = []
    for dx, dy, _sc, _n in coarse[:12]:
        lo_x, hi_x = dx * s - 1, dx * s + s + 1
        lo_y, hi_y = dy * s - 1, dy * s + s + 1
        seeds.append((lo_x, hi_x, lo_y, hi_y))
    rect0 = overlap_rect(a.w, a.h, b.w, b.h, *rough)
    if rect0 is None:
        return []
    ow, oh = rect0[2] - rect0[0], rect0[3] - rect0[1]
    stride = max(1, min(ow, oh) // 24)
    refined = {}
    for lo_x, hi_x, lo_y, hi_y in seeds:
        for dy in range(lo_y, hi_y):
            for dx in range(lo_x, hi_x):
                if (dx, dy) in refined:
                    continue
                r = _score(a, b, dx, dy, stride)
                if r is not None:
                    refined[(dx, dy)] = r
    if not refined:
        return []
    best = sorted(((dx, dy, r[0], r[1]) for (dx, dy), r in refined.items()),
                  key=lambda c: c[2])

    # 第 3 级: 前 top 个候选逐像素复评
    final = []
    for dx, dy, _sc, _n in best[:top]:
        r = _score(a, b, dx, dy, 1)
        if r is not None:
            final.append((dx, dy, r[0], r[1]))
    if not final:
        return []
    return _group(final)


def is_ambiguous(groups, rel_tol=0.10, abs_tol=1.0):
    """多组候选且次优组得分与最优组几乎相同 -> 重复纹理多解。"""
    if len(groups) < 2:
        return False
    best = groups[0]["score"]
    return groups[1]["score"] <= best * (1.0 + rel_tol) + abs_tol
