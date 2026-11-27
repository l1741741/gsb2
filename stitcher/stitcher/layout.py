"""全局位置解算与闭环矛盾检测。

输入: 若干条边的位移测量 offset(i,j)（含义见 align.py）。
做法: 从根图出发沿生成树传播得到每块图的全局位置；
      不在生成树上的边（闭环边）其测量值与传播值之差即闭环矛盾，
      逐条接缝报告，便于定位需要重扫的接缝。
"""


def compute_layout(n, edges, root=0):
    """edges: dict {(i,j): (dx,dy)}，i != j，pos[j] = pos[i] + (dx,dy)。

    返回 (positions, residuals, unreachable):
      positions  - list[(x,y)]，root 为 (0,0)
      residuals  - dict {(i,j): (rx,ry)}，每条边的闭环残差
      unreachable- 无法连通的图片下标列表
    """
    adj = [[] for _ in range(n)]
    for (i, j), (dx, dy) in edges.items():
        adj[i].append((j, dx, dy))
        adj[j].append((i, -dx, -dy))
    positions = [None] * n
    positions[root] = (0, 0)
    queue = [root]
    while queue:
        i = queue.pop(0)
        px, py = positions[i]
        for j, dx, dy in adj[i]:
            if positions[j] is None:
                positions[j] = (px + dx, py + dy)
                queue.append(j)
    unreachable = [i for i in range(n) if positions[i] is None]
    residuals = {}
    for (i, j), (dx, dy) in edges.items():
        if positions[i] is None or positions[j] is None:
            continue
        residuals[(i, j)] = (positions[j][0] - positions[i][0] - dx,
                             positions[j][1] - positions[i][1] - dy)
    return positions, residuals, unreachable
