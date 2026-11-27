"""二值掩码连通域分析（两遍扫描 + union-find，纯 Python）。

背景通常是一大片连通区域，性能上避免每像素元组 / BFS 队列的高开销。
每个连通域记录面积、包围盒、质心、是否接触图边、是否包含指定种子。
"""

from __future__ import annotations

from array import array
from typing import Dict, List, Sequence, Tuple


def connected_components(mask: bytearray, width: int, height: int,
                         neighborhood: int = 4,
                         seed_indices: Sequence[int] = ()):
    """返回 ``(label, components)``。

    * ``label`` 是长度 n 的 ``array('i')``，0 表示不属于任何域，
      否则为 components 中的 1-based 编号（即 components[label[i]-1]）
    * ``components`` 每个元素是统计 dict
    """
    if neighborhood not in (4, 8):
        raise ValueError("neighborhood 只支持 4 或 8")
    n = width * height
    if len(mask) != n:
        raise ValueError("mask 长度与宽高不符")

    labels = array("i", [0]) * n
    parent: List[int] = [0]  # 1-based 标签 -> 父标签

    def find(x: int) -> int:
        root = x
        while parent[root] != root:
            root = parent[root]
        while parent[x] != x:
            nxt = parent[x]
            parent[x] = root
            x = nxt
        return root

    def union(a: int, b: int) -> int:
        ra, rb = find(a), find(b)
        if ra != rb:
            if ra < rb:
                parent[rb] = ra
                return ra
            parent[ra] = rb
            return rb
        return ra

    next_label = 1
    w = width
    for y in range(height):
        row = y * w
        prev_row = row - w
        for x in range(w):
            idx = row + x
            if not mask[idx]:
                continue
            up = labels[prev_row + x] if y > 0 else 0
            left = labels[idx - 1] if x > 0 else 0

            if neighborhood == 4:
                if up and left:
                    lab = union(up, left)
                elif up:
                    lab = find(up)
                elif left:
                    lab = find(left)
                else:
                    lab = next_label
                    parent.append(lab)
                    next_label += 1
                labels[idx] = lab
                continue

            # 8 邻接：收集 up / left / 三个上方邻居
            ul = labels[prev_row + x - 1] if (y > 0 and x > 0) else 0
            ur = labels[prev_row + x + 1] if (y > 0 and x + 1 < w) else 0
            candidates = (up, left, ul, ur)
            first = 0
            for c in candidates:
                if c:
                    rc = find(c)
                    if first == 0:
                        first = rc
                    elif rc != first:
                        first = union(first, rc)
            if first:
                labels[idx] = find(first)
            else:
                lab = next_label
                parent.append(lab)
                next_label += 1
                labels[idx] = lab

    # 第二遍：合并等价标签并统计
    root_to_cid: Dict[int, int] = {}
    comps: List[Dict] = []
    label_out = array("i", [0]) * n

    for y in range(height):
        row = y * w
        for x in range(w):
            idx = row + x
            lab = labels[idx]
            if not lab:
                continue
            root = find(lab)
            cid = root_to_cid.get(root)
            if cid is None:
                cid = len(comps) + 1
                root_to_cid[root] = cid
                comps.append({
                    "id": cid,
                    "area": 0,
                    "min_x": x, "min_y": y,
                    "max_x": x, "max_y": y,  # inclusive
                    "sum_x": 0, "sum_y": 0,
                    "touches_edge": False,
                    "contains_seed": False,
                    "seed_points": [],
                })
            c = comps[cid - 1]
            c["area"] += 1
            c["sum_x"] += x
            c["sum_y"] += y
            if x < c["min_x"]:
                c["min_x"] = x
            if x > c["max_x"]:
                c["max_x"] = x
            if y < c["min_y"]:
                c["min_y"] = y
            if y > c["max_y"]:
                c["max_y"] = y
            if x == 0 or y == 0 or x == w - 1 or y == height - 1:
                c["touches_edge"] = True
            label_out[idx] = cid

    for c in comps:
        area = c["area"] or 1
        c["centroid"] = [round(c["sum_x"] / area, 2), round(c["sum_y"] / area, 2)]
        c["bbox_xyxy"] = [c["min_x"], c["min_y"], c["max_x"] + 1, c["max_y"] + 1]
        del c["sum_x"], c["sum_y"]

    for sidx in seed_indices:
        if 0 <= sidx < n and label_out[sidx]:
            cid = label_out[sidx]
            c = comps[cid - 1]
            c["contains_seed"] = True
            sx = sidx % w
            sy = sidx // w
            c["seed_points"].append([sx, sy])

    return label_out, comps


def select_components(comps: Sequence[Dict], mode: str):
    """根据连通模式返回选中的 component id 集合。"""
    mode = (mode or "edge").lower()
    if mode in ("off", "global", "all", "none-restriction"):
        return {c["id"] for c in comps}, []
    selected = set()
    ignored = []
    for c in comps:
        ok = False
        if mode == "edge":
            ok = c["touches_edge"]
        elif mode == "seeds" or mode == "seed":
            ok = c["contains_seed"]
        elif mode in ("edge_or_seeds", "any", "edge+seeds"):
            ok = c["touches_edge"] or c["contains_seed"]
        else:
            raise ValueError("未知 connectivity 模式: %r" % mode)
        if ok:
            selected.add(c["id"])
        else:
            ignored.append(c["id"])
    return selected, ignored
