"""成片合成: 融合(blend) 与 对照(compare) 两种输出。

- 透明像素(alpha==0)不作为有效颜色，不参与平均。
- 无任何图片覆盖的canvas区域保持透明(alpha==0)。
- 对照模式: 重叠区按棋盘格交替显示各来源块，便于肉眼检查接缝。
"""

from array import array

from .pngio import Image


def _bounds(images, positions):
    minx = min(p[0] for p in positions)
    miny = min(p[1] for p in positions)
    maxx = max(p[0] + im.w for im, p in zip(images, positions))
    maxy = max(p[1] + im.h for im, p in zip(images, positions))
    return minx, miny, maxx - minx, maxy - miny


def compose(images, positions, checker=16):
    """返回 (blend, compare, (minx, miny, W, H)) 两幅 Image 与画布信息。"""
    minx, miny, W, H = _bounds(images, positions)
    N = W * H
    sumr = array("i", [0]) * N
    sumg = array("i", [0]) * N
    sumb = array("i", [0]) * N
    suma = array("i", [0]) * N
    maxa = array("i", [0]) * N
    first = array("i", [-1]) * N   # 覆盖该像素的前两个图片下标
    second = array("i", [-1]) * N

    for idx, (im, (px, py)) in enumerate(zip(images, positions)):
        ox = px - minx
        oy = py - miny
        pix, w, h = im.pix, im.w, im.h
        for y in range(h):
            row = y * w * 4
            crow = (oy + y) * W + ox
            for x in range(w):
                a = pix[row + x * 4 + 3]
                if a == 0:
                    continue
                ci = crow + x
                ia = row + x * 4
                sumr[ci] += pix[ia] * a
                sumg[ci] += pix[ia + 1] * a
                sumb[ci] += pix[ia + 2] * a
                suma[ci] += a
                if a > maxa[ci]:
                    maxa[ci] = a
                if first[ci] < 0:
                    first[ci] = idx
                elif second[ci] < 0 and idx != first[ci]:
                    second[ci] = idx

    blend = Image(W, H)
    bp = blend.pix
    for ci in range(N):
        a = suma[ci]
        if a == 0:
            continue  # 无覆盖: 保持透明
        o = ci * 4
        bp[o] = sumr[ci] // a
        bp[o + 1] = sumg[ci] // a
        bp[o + 2] = sumb[ci] // a
        bp[o + 3] = maxa[ci]

    compare = Image(W, H)
    compare.pix[:] = bp
    cp = compare.pix
    for ci in range(N):
        if second[ci] < 0:
            continue  # 非重叠区与融合结果一致
        cx = ci % W
        cy = ci // W
        pick = second[ci] if ((cx // checker) + (cy // checker)) & 1 else first[ci]
        im = images[pick]
        ix = cx - (positions[pick][0] - minx)
        iy = cy - (positions[pick][1] - miny)
        ia = (iy * im.w + ix) * 4
        o = ci * 4
        cp[o:o + 4] = im.pix[ia:ia + 4]

    return blend, compare, (minx, miny, W, H)
