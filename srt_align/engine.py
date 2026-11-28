"""对齐引擎。

思路
----
1. 人工锚点先固定为若干组，并把两条字幕序列切成若干区间；自动匹配
   只在区间内进行，任何 DP 路径都不可能跨过锚点。
2. 每个区间内做「分段半马尔可夫 DP」：每个输出组可以消费原版 1..max_run
   条、译文 1..max_run 条，因此天然支持一对一、一对多（拆句）、多对一
   （合句）；条目不允许重排，DP 沿两个下标单调推进。
3. 跳过条目（缺行 / 孤立行）是显式动作，不允许把孤立行硬塞进相邻组；
   跳过会产生固定罚分，只有真正能改善匹配时才会发生。
4. 时间窗匹配成本基于条目区间的重合度与中心点距离；纯结构 DP 不依赖
   文字语言，因此不做翻译也能工作。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .models import AlignmentGroup, Cue, Issue, IssueCode


@dataclass
class AlignConfig:
    max_run: int = 3
    """单个组在每一侧最多消费的条目数（少量拆合句场景够用）。"""

    skip_penalty: float = 40.0
    """跳过一个条目的罚分（缺行 / 孤立行）。"""

    min_overlap: float = 0.25
    """两时间窗重合时长占较短窗的比例低于该值时，施加弱重合罚。"""

    cps_warn: float = 20.0
    """每秒字符数超过该值给出可读性警告（中文按字符计）。"""

    min_duration_ms: int = 600
    """单条译文在约束后的最短展示时长，低于则判定挤不下。"""

    min_char_ms: float = 83.0
    """每个字符至少需要的毫秒数（约 12 字/秒），达不到也判定挤不下。"""


@dataclass
class AlignmentResult:
    groups: list[AlignmentGroup]
    issues: list[Issue]
    unmatched_original: list[Cue] = field(default_factory=list)
    unmatched_translation: list[Cue] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 组级匹配成本
# ---------------------------------------------------------------------------

def _overlap(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def group_cost(orig: list[Cue], trans: list[Cue],
               config: AlignConfig) -> float:
    """一个候选组的匹配成本，越小越好；只看时间，不看文字。"""
    o_start = min(c.start for c in orig)
    o_end = max(c.end for c in orig)
    t_start = min(c.start for c in trans)
    t_end = max(c.end for c in trans)

    span_o = max(1, o_end - o_start)
    span_t = max(1, t_end - t_start)
    shorter = min(span_o, span_t)
    ov = _overlap(o_start, o_end, t_start, t_end)
    ratio = ov / shorter

    # 中心点距离，按原版窗长归一化
    center_o = (o_start + o_end) / 2
    center_t = (t_start + t_end) / 2
    center_gap = abs(center_o - center_t) / max(1.0, span_o)

    # 窗长差异（拆合句后两组合并窗本应接近）
    span_gap = abs(span_o - span_t) / max(span_o, span_t)

    cost = 2.0 * center_gap + span_gap
    if ratio < config.min_overlap:
        # 时间几乎不重合的组只在没有别的选择时才接受
        cost += 6.0 * (config.min_overlap - ratio)
    # 结构罚：每多消费一条加固定罚，抑制把正常 1:1 过度合并
    extras = (len(orig) - 1) + (len(trans) - 1)
    cost += 1.0 * extras

    # 内部空洞罚：真正的拆/合句，同组条目在时间上相邻；若条目之间有
    # 明显空隙（典型于把缺行吞进大组），按空洞占整窗的比例重罚，
    # 使「带空洞的合并」比「显式跳过缺行」更贵。
    def internal_gap(cues: list[Cue]) -> float:
        if len(cues) < 2:
            return 0.0
        ordered = sorted(cues, key=lambda c: c.start)
        gap = sum(max(0, ordered[k + 1].start - ordered[k].end)
                  for k in range(len(ordered) - 1))
        return gap / max(1.0, ordered[-1].end - ordered[0].start)

    cost += 40.0 * (internal_gap(orig) + internal_gap(trans))

    # 防硬塞：组内任一条与对侧整窗零时间重合，按一次跳过计罚。
    # 这样把它吸收进组永远不会比显式标记未匹配更划算。
    for cue in orig:
        if _overlap(cue.start, cue.end, t_start, t_end) == 0:
            cost += config.skip_penalty
    for cue in trans:
        if _overlap(cue.start, cue.end, o_start, o_end) == 0:
            cost += config.skip_penalty
    return cost


# ---------------------------------------------------------------------------
# 无锚点区间内的 DP
# ---------------------------------------------------------------------------

@dataclass
class _Cell:
    score: float
    back: tuple | None  # (prev_i, prev_j, kind, data)


def _align_segment(
    orig: list[Cue], trans: list[Cue], config: AlignConfig
) -> list[tuple[str, object]]:
    """对一个锚点间区间做 DP，返回按顺序的动作列表。

    动作: ("group", (orig 切片, trans 切片))
          ("skip_orig", cue) / ("skip_trans", cue)
    """
    n, m = len(orig), len(trans)
    inf = float("inf")
    table: dict[tuple[int, int], _Cell] = {
        (0, 0): _Cell(0.0, None)
    }

    def relax(i: int, j: int, prev_i: int, prev_j: int,
              added: float, back: tuple) -> None:
        prev = table.get((prev_i, prev_j))
        if prev is None:
            return
        cand = prev.score + added
        cur = table.get((i, j))
        if cur is None or cand < cur.score:
            table[(i, j)] = _Cell(cand, back)

    for i in range(n + 1):
        for j in range(m + 1):
            if (i, j) not in table:
                continue
            # 组匹配：两侧各消费 1..max_run 条
            for di in range(1, min(config.max_run, n - i) + 1):
                for dj in range(1, min(config.max_run, m - j) + 1):
                    piece_o = orig[i:i + di]
                    piece_t = trans[j:j + dj]
                    cost = group_cost(piece_o, piece_t, config)
                    relax(i + di, j + dj, i, j, cost,
                          (i, j, "group", (piece_o, piece_t)))
            # 跳过原版条目（译文缺行）
            if i < n:
                relax(i + 1, j, i, j, config.skip_penalty,
                      (i, j, "skip_orig", orig[i]))
            # 跳过译文条目（孤立行，不并入相邻组）
            if j < m:
                relax(i, j + 1, i, j, config.skip_penalty,
                      (i, j, "skip_trans", trans[j]))

    if (n, m) not in table:
        # 理论上不会发生（跳过动作保证可达），保底防御
        raise RuntimeError("对齐 DP 未到达终点")

    actions: list[tuple[str, object]] = []
    i, j = n, m
    while (i, j) != (0, 0):
        cell = table[(i, j)]
        if cell.back is None:
            raise RuntimeError("对齐回溯断裂")
        pi, pj, kind, data = cell.back
        actions.append((kind, data))
        i, j = pi, pj
    actions.reverse()
    return actions


# ---------------------------------------------------------------------------
# 时间约束：用原版组的起止约束译文组
# ---------------------------------------------------------------------------

def constrain_times(group: AlignmentGroup,
                    config: AlignConfig) -> None:
    """在原版时间窗内安排译文侧每条的起止，写入 group.timed。

    规则：
    - 译文每条保留自身相对时长，整体平移并缩放进原版窗 [W0, W1]；
    - 相邻条之间保持顺序不重叠；
    - 若某条按字符数算需要的最短时长超过可分配时长，记 TIGHT_SPAN 警告。
    """
    win_start = group.orig_start
    win_end = group.orig_end
    window = max(1, win_end - win_start)
    trans = group.translation
    k = len(trans)

    raw_durations = [max(1, c.end - c.start) for c in trans]
    total_raw = sum(raw_durations)
    if window >= k:
        # 正常情况：按原时长比例分配整个原版窗，每条至少保底 1ms
        alloc = [max(1, round(window * d / total_raw)) for d in raw_durations]
        over = sum(alloc) - window
        # 把取整误差（可能为正或负）摊到最长的一条上，同时守住 1ms 下限
        if over != 0:
            longest = max(range(k), key=lambda idx: alloc[idx])
            alloc[longest] = max(1, alloc[longest] - over)
    else:
        # 极端情况：窗内毫秒数不够每条分 1ms。优先保证 SRT 合法
        # （正时长、不重叠），允许尾部越出原版窗，挤不下警告会逐条标出。
        alloc = [1] * k

    # 顺序铺排，严格不重叠
    timed: list[tuple[int, int]] = []
    cursor = win_start
    for cue, duration in zip(trans, alloc):
        duration = max(1, duration)
        timed.append((cursor, cursor + duration))
        cursor += duration
    # 取整兜底：最后一条收尾对齐原版窗（仅在不产生零时长时）
    if timed:
        last_start, _ = timed[-1]
        if win_end > last_start:
            timed[-1] = (last_start, win_end)
    group.timed = timed

    # 可读性 / 挤不下判定
    for cue, (start, end) in zip(trans, timed):
        duration = end - start
        char_count = len(cue.text.replace("\n", "").replace(" ", ""))
        need_ms = max(
            config.min_duration_ms,
            round(char_count * config.min_char_ms),
        )
        cps = char_count / (duration / 1000.0) if duration else float("inf")
        refs = [cue.label]
        if duration < need_ms:
            group.issues.append(Issue(
                IssueCode.TIGHT_SPAN,
                f"{cue.label} 在原版窗 {win_start}-{win_end}ms 内只分到 "
                f"{duration}ms，按 {char_count} 字估算至少需要 {need_ms}ms，"
                "确实挤不下，请人工调整时间或拆分文字",
                side="output", refs=refs,
            ))
        elif cps > config.cps_warn:
            group.issues.append(Issue(
                IssueCode.CPS_HIGH,
                f"{cue.label} 字符速率约 {cps:.1f} 字/秒，高于 "
                f"{config.cps_warn:g}，建议人工复核",
                side="output", refs=refs,
            ))


# ---------------------------------------------------------------------------
# 顶层流程
# ---------------------------------------------------------------------------

def _build_segments(
    original: list[Cue],
    translation: list[Cue],
    resolved_anchors: list[tuple[list[Cue], list[Cue], Issue]],
) -> list[tuple[list[Cue], list[Cue], object]]:
    """按锚点把两条序列切成 (区间原版, 区间译文, 锚点或 None) 的交替段。"""
    segments: list[tuple[list[Cue], list[Cue], object]] = []
    oi = ti = 0
    for orig_cues, trans_cues, anchor_issue in resolved_anchors:
        o_first, o_last = orig_cues[0], orig_cues[-1]
        t_first, t_last = trans_cues[0], trans_cues[-1]
        o_lo = original.index(o_first)
        o_hi = original.index(o_last) + 1
        t_lo = translation.index(t_first)
        t_hi = translation.index(t_last) + 1

        if o_lo < oi or t_lo < ti:
            # resolve_anchors 的单调性检查应已拦住，这里防御性处理
            raise RuntimeError("锚点区间逆序")
        segments.append((original[oi:o_lo], translation[ti:t_lo], None))
        segments.append((original[o_lo:o_hi], translation[t_lo:t_hi],
                         anchor_issue))
        oi, ti = o_hi, t_hi
    segments.append((original[oi:], translation[ti:], None))
    return segments


def align(
    original: list[Cue],
    translation: list[Cue],
    resolved_anchors: list[tuple[list[Cue], list[Cue], Issue]] | None = None,
    config: AlignConfig | None = None,
) -> AlignmentResult:
    """执行对齐，返回分组、问题清单和两侧未匹配条目。"""
    config = config or AlignConfig()
    resolved_anchors = resolved_anchors or []
    segments = _build_segments(original, translation, resolved_anchors)

    groups: list[AlignmentGroup] = []
    issues: list[Issue] = []
    unmatched_o: list[Cue] = []
    unmatched_t: list[Cue] = []

    for seg_orig, seg_trans, anchor_issue in segments:
        if anchor_issue is not None:
            group = AlignmentGroup(
                original=list(seg_orig), translation=list(seg_trans),
                anchored=True, issues=[anchor_issue],
            )
            constrain_times(group, config)
            groups.append(group)
            continue

        if not seg_orig and not seg_trans:
            continue
        actions = _align_segment(seg_orig, seg_trans, config)
        for kind, data in actions:
            if kind == "group":
                piece_o, piece_t = data
                group = AlignmentGroup(
                    original=list(piece_o), translation=list(piece_t),
                )
                constrain_times(group, config)
                groups.append(group)
            elif kind == "skip_orig":
                unmatched_o.append(data)
                issues.append(Issue(
                    IssueCode.UNMATCHED_ORIG,
                    f"{data.label} 在译文中找不到对应条目（缺行），"
                    "未并入任何相邻组",
                    side="original", refs=[data.label],
                ))
            else:  # skip_trans
                unmatched_t.append(data)
                issues.append(Issue(
                    IssueCode.UNMATCHED_TRANS,
                    f"{data.label} 是译文侧孤立行，在原版中找不到对应，"
                    "未硬塞进相邻组",
                    side="translation", refs=[data.label],
                ))

    groups.sort(key=lambda g: g.orig_start)
    return AlignmentResult(
        groups=groups,
        issues=issues,
        unmatched_original=unmatched_o,
        unmatched_translation=unmatched_t,
    )
