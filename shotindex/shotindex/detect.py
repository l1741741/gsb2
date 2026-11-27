"""镜头边界检测：硬切 / 渐变 / 闪光（短遮挡），以及临近候选抑制。

原理：对缩小灰度帧计算 64 bin 亮度直方图，相邻帧直方图差（0~2）作为变化量。
- 硬切 cut：尖峰（峰值 >= t_hard），且突变前后画面不同。
- 渐变 gradual：连续 >= min_gradual_frames 帧变化量 >= t_soft 且峰值 < t_hard。
- 闪光 flash：短促突变（含 1~2 帧的“去程+回程”两个尖峰），突变窗口前后
  两帧画面相似（hist 差 < t_same）——画面很快回到原样，是闪光或短遮挡，不是切镜。

检测时先把间隔 <=2 帧的相邻超限段合并成一个“变化窗口”，这样单帧闪光产生的
两个尖峰会被当作一个事件整体判断。
"""

DEFAULTS = {
    "t_hard": 0.45,            # 硬切阈值（直方图差）
    "t_soft": 0.12,            # 渐变持续阈值
    "t_same": 0.15,            # “回到原画面”的相似阈值
    "min_gradual_frames": 3,   # 渐变最少持续帧数
    "min_gap": 1.0,            # 候选抑制窗口（秒），可调
}

_BINS = 64
_SHIFT = 2  # 256 / 64
_GAP_TOL = 2        # 合并变化窗口时允许的低于阈值帧数
_FLASH_MAXLEN = 5   # 窗口不超过该帧数才可能是闪光


def histogram(data):
    h = [0] * _BINS
    for b in data:
        h[b >> _SHIFT] += 1
    n = len(data) or 1
    return [x / n for x in h]


def hist_diff(h1, h2):
    return sum(abs(a - b) for a, b in zip(h1, h2))


def detect_events(frames, params):
    """frames: [(time, gray_bytes), ...]；返回 (events, diffs)。

    event: {type, time, score, basis, 以及 gradual/flash 的 start/end}
    diffs: 每帧相对前一帧的直方图差（第 0 帧为 0），供报告展示判断依据。
    """
    hists = [histogram(data) for _, data in frames]
    times = [t for t, _ in frames]
    n = len(frames)
    diffs = [0.0] * n
    for i in range(1, n):
        diffs[i] = hist_diff(hists[i - 1], hists[i])

    events = []
    i = 1
    while i < n:
        if diffs[i] < params["t_soft"]:
            i += 1
            continue
        # 变化窗口 [i, j]：允许中间夹 <= _GAP_TOL 帧低于阈值的小空隙
        j = i
        while True:
            k = j + 1
            while k < n and diffs[k] < params["t_soft"]:
                k += 1
            if k < n and k - (j + 1) <= _GAP_TOL:
                j = k
            else:
                break
        window = diffs[i:j + 1]
        peak = max(window)
        peak_idx = i + window.index(peak)
        window_len = j - i + 1
        before, after = i - 1, j + 1
        returns = (
            after < n
            and hist_diff(hists[before], hists[after]) < params["t_same"]
        )
        basis = {
            "peak": round(peak, 4),
            "window_len": window_len,
            "t_hard": params["t_hard"],
            "t_soft": params["t_soft"],
            "t_same": params["t_same"],
        }
        if after < n:
            basis["before_after_diff"] = round(hist_diff(hists[before], hists[after]), 4)

        if window_len >= params["min_gradual_frames"]:
            # 持续多帧的变化是渐变——与前后画面差异大小无关
            # （两个完全不同场景之间的淡变，每帧差值也会很大）
            events.append({
                "type": "gradual",
                "time": times[(i + j) // 2],
                "start": times[i],
                "end": times[j],
                "score": peak,
                "basis": basis,
            })
        elif peak >= params["t_hard"]:
            if returns and window_len <= _FLASH_MAXLEN:
                events.append({
                    "type": "flash",
                    "time": times[peak_idx],
                    "start": times[i],
                    "end": times[j],
                    "score": peak,
                    "basis": basis,
                })
            else:
                events.append({
                    "type": "cut",
                    "time": times[peak_idx],
                    "score": peak,
                    "basis": basis,
                })
        elif returns:
            events.append({
                "type": "flash",
                "time": times[peak_idx],
                "start": times[i],
                "end": times[j],
                "score": peak,
                "basis": basis,
            })
        i = j + 1
    return events, diffs


def suppress_close(events, min_gap):
    """临近候选抑制：min_gap 秒内只保留分数最高者，其余标记 suppressed。

    只作用于真正的边界候选（cut / gradual）；flash 不是边界，不参与抑制。
    被抑制的记录仍然保留，报告中可查看、可恢复——相邻短镜头不会被静默丢掉。
    """
    boundaries = [e for e in events if e["type"] != "flash"]
    accepted = []
    for e in sorted(boundaries, key=lambda x: -x["score"]):
        clash = next(
            (a for a in accepted if abs(a["time"] - e["time"]) < min_gap), None
        )
        if clash is None:
            e["status"] = "candidate"
            accepted.append(e)
        else:
            e["status"] = "suppressed"
            e["suppressed_by_gap"] = round(abs(clash["time"] - e["time"]), 3)
    for e in events:
        if e["type"] == "flash":
            e["status"] = "candidate"
    return events
