#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wavalign — 同一场排练双录音的本地对齐工具。

把「待校正录音」拉到「参考录音」的时间轴上：
  * 一对锚点  -> 只修正起点差（整体平移）；
  * 多对锚点  -> 分段线性修正漂移；
  * 参考范围超出待校正录音的部分补静音，并在报告中单列缺口；
  * 支持 --start/--end 单独导出区间，结果与完整输出的对应切片逐采样一致。

仅依赖 Python 标准库（3.9+）。只支持未压缩 PCM WAV（8/16/24/32 位整型）。
"""
from __future__ import annotations

import argparse
import array
import math
import sys
import wave
from dataclasses import dataclass

BLOCK = 1 << 20  # 每个处理块的输出采样数（控制内存峰值）

# 默认认为合理的伸缩率范围（源秒 / 参考秒），超出视为锚点冲突
MIN_RATE, MAX_RATE = 0.5, 2.0

# 各采样位宽的有符号整型范围（8 位 WAV 为无符号，读取时已转为有符号）
INT_RANGE = {1: (-128, 127), 2: (-32768, 32767),
             3: (-(1 << 23), (1 << 23) - 1), 4: (-(1 << 31), (1 << 31) - 1)}

_FLIP_SIGN_BIT = bytes((i + 128) & 0xFF for i in range(256))   # 8 位 无符号<->有符号
_SIGN_BYTE = bytes(0xFF if i >= 0x80 else 0x00 for i in range(256))  # 24 位符号扩展

_INT32_CODE = "i" if array.array("i").itemsize == 4 else "l"


class AnchorError(Exception):
    """锚点非法（顺序相反 / 冲突 / 退化），信息中指明具体哪一对。"""


# ---------------------------------------------------------------- 时间解析

def parse_time(text):
    """'75.5' / '1:15.5' / '01:02:03.250' -> 秒 (float)。"""
    t = text.strip()
    if not t:
        raise ValueError("空时间串")
    parts = t.split(":")
    if len(parts) > 3:
        raise ValueError(f"无法解析时间: {text!r}")
    try:
        nums = [float(p) for p in parts]
    except ValueError:
        raise ValueError(f"无法解析时间: {text!r}") from None
    if any(n < 0 for n in nums):
        raise ValueError(f"时间不能为负: {text!r}")
    if len(parts) > 1 and nums[-1] >= 60:
        raise ValueError(f"分/秒字段应小于 60: {text!r}")
    sec = 0.0
    for n in nums:
        sec = sec * 60 + n
    return sec


# ---------------------------------------------------------------- 锚点

def validate_anchors(pairs, min_rate=MIN_RATE, max_rate=MAX_RATE):
    """校验并按参考时间排序。pairs: [(ref_sec, src_sec), ...]（用户输入顺序）。

    拒绝：负值/非有限值、参考时间相同（退化）、待校正时间相同（退化）、
    顺序相反、隐含伸缩率超出 [min_rate, max_rate]（冲突）。
    报错信息指明具体哪一对（按用户输入顺序从 1 编号）。
    """
    if not pairs:
        raise AnchorError("至少需要一对锚点。")
    for i, (r, s) in enumerate(pairs, 1):
        if not (math.isfinite(r) and math.isfinite(s)):
            raise AnchorError(f"第 {i} 对锚点含非有限数值: ({r}, {s})")
        if r < 0 or s < 0:
            raise AnchorError(f"第 {i} 对锚点含负数时间: ({r}, {s})")
    order = sorted(range(len(pairs)), key=lambda i: pairs[i][0])
    for a, b in zip(order, order[1:]):
        r0, s0 = pairs[a]
        r1, s1 = pairs[b]
        if r1 == r0:
            raise AnchorError(
                f"第 {a + 1} 对与第 {b + 1} 对锚点的参考时间相同 ({r0} s)，"
                f"参考区间长度为零（退化）。")
        if s1 == s0:
            raise AnchorError(
                f"第 {a + 1} 对与第 {b + 1} 对锚点的待校正时间相同 ({s0} s)，"
                f"待校正区间长度为零（退化）。")
        if s1 < s0:
            raise AnchorError(
                f"第 {a + 1} 对与第 {b + 1} 对锚点顺序相反：参考时间 "
                f"{r0} -> {r1} s 增加，待校正时间 {s0} -> {s1} s 却减少。")
        rate = (s1 - s0) / (r1 - r0)
        if rate < min_rate or rate > max_rate:
            raise AnchorError(
                f"第 {a + 1} 对与第 {b + 1} 对锚点相互冲突：隐含伸缩率 "
                f"{rate:.6f} 超出合理范围 [{min_rate}, {max_rate}]。")
    return [pairs[i] for i in order]


class TimeMap:
    """参考时间 -> 待校正时间 的分段线性映射（输出时间轴 = 参考时间轴）。

    首对锚点之前按第一段的速率外延，末对锚点之后按最后一段的速率外延；
    只有一对锚点时速率取 1.0（纯平移）。
    """

    def __init__(self, anchors):
        self.anchors = anchors  # 已排序、已校验
        self.rates = [(s1 - s0) / (r1 - r0)
                      for (r0, s0), (r1, s1) in zip(anchors, anchors[1:])]
        self.pre_rate = self.rates[0] if self.rates else 1.0
        self.post_rate = self.rates[-1] if self.rates else 1.0

    def src_time(self, t):
        a = self.anchors
        if t <= a[0][0]:
            return a[0][1] + (t - a[0][0]) * self.pre_rate
        for (r0, s0), (r1, s1), rate in zip(a, a[1:], self.rates):
            if t <= r1:
                return s0 + (t - r0) * rate
        return a[-1][1] + (t - a[-1][0]) * self.post_rate


# ---------------------------------------------------------------- WAV 读写

@dataclass
class WavData:
    path: str
    sr: int          # 采样率
    nch: int         # 声道数
    sampwidth: int   # 每采样字节数 1/2/3/4
    nframes: int     # 帧数
    channels: list   # 每声道一个 array.array，存放有符号整型采样

    @property
    def duration(self):
        return self.nframes / self.sr


def read_wav(path):
    """读入 PCM WAV，按声道拆成有符号整型数组（保持原声道顺序）。"""
    with wave.open(path, "rb") as wf:
        if wf.getcomptype() != "NONE":
            raise ValueError(f"{path}: 仅支持未压缩 PCM WAV")
        nch, sw = wf.getnchannels(), wf.getsampwidth()
        sr, nf = wf.getframerate(), wf.getnframes()
        raw = wf.readframes(nf)
    if sw == 1:  # 8 位无符号 -> 有符号
        arr = array.array("b", raw.translate(_FLIP_SIGN_BIT))
    elif sw == 2:
        arr = array.array("h", raw)
    elif sw == 3:  # 24 位 -> 32 位有符号（符号扩展）
        n = len(raw) // 3
        buf = bytearray(4 * n)
        buf[0::4] = raw[0::3]
        buf[1::4] = raw[1::3]
        buf[2::4] = raw[2::3]
        buf[3::4] = raw[2::3].translate(_SIGN_BYTE)
        arr = array.array(_INT32_CODE, buf)
    elif sw == 4:
        arr = array.array(_INT32_CODE, raw)
    else:
        raise ValueError(f"{path}: 不支持 {sw * 8} 位采样")
    if sys.byteorder == "big" and sw > 1:
        arr.byteswap()
    chans = [arr[c::nch] for c in range(nch)]
    return WavData(path, sr, nch, sw, nf, chans)


# ---------------------------------------------------------------- 分段计划

@dataclass
class Segment:
    n0: int    # 输出起始采样（含）
    n1: int    # 输出结束采样（不含）
    A: float   # 源采样位置 p(n) = A + n*B，n 为输出采样序号（绝对值）
    B: float   # 每输出采样消耗的源采样数 = rate * src_sr / out_sr
    rate: float  # 源秒 / 参考秒


def build_segments(tmap, n_out, out_sr, src_sr):
    """把 [0, n_out) 切成连续互不重叠的分段；段与段相接处不多不漏一帧。

    每个输出采样 n 的源位置由 p(n) = A + n*B 唯一确定（A、B 按段固定），
    因此任意区间导出与完整输出的对应切片逐采样一致。
    """
    anchors = tmap.anchors
    cuts = [round(r * out_sr) for r, _ in anchors]
    for i in range(1, len(cuts)):
        if cuts[i] <= cuts[i - 1]:
            raise AnchorError(
                f"第 {i} 对与第 {i + 1} 对锚点在输出采样率 {out_sr} Hz 下"
                f"落到同一输出采样（退化）。")
    bounds = [0] + cuts + [n_out]
    rates = [tmap.pre_rate] + tmap.rates + [tmap.post_rate]
    segs = []
    for j in range(len(bounds) - 1):
        n0, n1 = bounds[j], bounds[j + 1]
        if n1 <= n0:
            continue
        rate = rates[j]
        r_ref, s_ref = anchors[max(0, j - 1)]
        B = rate * src_sr / out_sr
        A = (s_ref + (n0 / out_sr - r_ref) * rate) * src_sr - n0 * B
        segs.append(Segment(n0, n1, A, B, rate))
    return segs


# ---------------------------------------------------------------- 渲染

def render(src, segs, out_path, out_sr, n_lo, n_hi):
    """把输出采样区间 [n_lo, n_hi) 渲染到 out_path，返回缺口列表 [(g0, g1), ...]。

    缺口 = 映射后的源位置落在源录音 [0, nframes) 之外的输出采样（补静音）。
    """
    last = src.nframes - 1
    sw, nch = src.sampwidth, src.nch
    lo, hi = INT_RANGE[sw]
    gaps = []
    gap_open = [None]  # 用列表以便在内层循环里修改

    def track(valid, k):
        if not valid and gap_open[0] is None:
            gap_open[0] = k
        elif valid and gap_open[0] is not None:
            gaps.append((gap_open[0], k))
            gap_open[0] = None

    with wave.open(out_path, "wb") as wf:
        wf.setnchannels(nch)
        wf.setsampwidth(sw)
        wf.setframerate(out_sr)
        for seg in segs:
            a, b = max(seg.n0, n_lo), min(seg.n1, n_hi)
            n = a
            while n < b:
                m = min(b - n, BLOCK)
                blocks = []
                for c in range(nch):
                    s = src.channels[c]
                    A, B = seg.A, seg.B
                    vals = []
                    ap = vals.append
                    for k in range(n, n + m):
                        p = A + k * B
                        if 0.0 <= p <= last:
                            i = int(p)
                            if i >= last:
                                v = s[last]
                            else:
                                f = p - i
                                v = s[i] + f * (s[i + 1] - s[i])
                            iv = int(v + 0.5) if v >= 0 else -int(0.5 - v)
                            if iv > hi:
                                iv = hi
                            elif iv < lo:
                                iv = lo
                            if c == 0:
                                track(True, k)
                        else:
                            iv = 0
                            if c == 0:
                                track(False, k)
                        ap(iv)
                    blocks.append(vals)
                n += m
                # 按原声道顺序交织
                if sw == 1:
                    frame = array.array("b", bytes(nch * m))
                    for c in range(nch):
                        frame[c::nch] = array.array("b", blocks[c])
                    data = frame.tobytes().translate(_FLIP_SIGN_BIT)
                elif sw == 2:
                    frame = array.array("h", bytes(2 * nch * m))
                    for c in range(nch):
                        frame[c::nch] = array.array("h", blocks[c])
                    if sys.byteorder == "big":
                        frame.byteswap()
                    data = frame.tobytes()
                elif sw == 3:
                    frame = array.array(_INT32_CODE, bytes(4 * nch * m))
                    for c in range(nch):
                        frame[c::nch] = array.array(_INT32_CODE, blocks[c])
                    if sys.byteorder == "big":
                        frame.byteswap()
                    b4 = frame.tobytes()
                    b3 = bytearray(3 * nch * m)
                    b3[0::3] = b4[0::4]
                    b3[1::3] = b4[1::4]
                    b3[2::3] = b4[2::4]
                    data = bytes(b3)
                else:  # sw == 4
                    frame = array.array(_INT32_CODE, bytes(4 * nch * m))
                    for c in range(nch):
                        frame[c::nch] = array.array(_INT32_CODE, blocks[c])
                    if sys.byteorder == "big":
                        frame.byteswap()
                    data = frame.tobytes()
                wf.writeframesraw(data)
    if gap_open[0] is not None:
        gaps.append((gap_open[0], n_hi))
    return gaps


# ---------------------------------------------------------------- 报告

def format_report(ref, src, out_sr, n_lo, n_hi, anchors, segs, gaps):
    L = []
    a = L.append
    a("wavalign 对齐报告")
    a("=" * 64)
    a(f"参考文件:   {ref.path}")
    a(f"  {ref.sr} Hz, {ref.nch} 声道, {ref.sampwidth * 8} 位, "
      f"{ref.duration:.6f} s ({ref.nframes} 帧)")
    a(f"待校正文件: {src.path}")
    a(f"  {src.sr} Hz, {src.nch} 声道, {src.sampwidth * 8} 位, "
      f"{src.duration:.6f} s ({src.nframes} 帧)")
    a(f"输出: {out_sr} Hz, {src.nch} 声道（保持待校正文件声道顺序）, "
      f"{src.sampwidth * 8} 位")
    a(f"输出范围: 采样 [{n_lo}, {n_hi}) = 参考时间 "
      f"[{n_lo / out_sr:.6f}, {n_hi / out_sr:.6f}) s, 共 {n_hi - n_lo} 帧")
    a("")
    a("锚点（已按参考时间排序）:")
    for i, (r, s) in enumerate(anchors, 1):
        a(f"  #{i}: 参考 {r:.6f} s (输出采样 {round(r * out_sr)})"
          f"  <-  待校正 {s:.6f} s")
    a("")
    a("分段（段与段相接处连续，不多不漏一帧）:")
    for j, seg in enumerate(segs, 1):
        p0 = seg.A + seg.n0 * seg.B
        p1 = seg.A + seg.n1 * seg.B
        a(f"  段 {j}: 输出采样 [{seg.n0}, {seg.n1}) = 参考时间 "
          f"[{seg.n0 / out_sr:.6f}, {seg.n1 / out_sr:.6f}) s")
        a(f"      原始区间(待校正): 采样 [{p0:.1f}, {p1:.1f}) = 时间 "
          f"[{p0 / src.sr:.6f}, {p1 / src.sr:.6f}) s")
        a(f"      伸缩: 速率 {seg.rate:.8f} 源秒/参考秒 "
          f"(漂移 {(seg.rate - 1) * 1e6:+.1f} ppm), "
          f"{seg.B:.8f} 源采样/输出采样")
    a("")
    # 有效输出范围（映射落在源录音内的部分）
    first_valid = gaps[0][1] if gaps and gaps[0][0] <= n_lo else n_lo
    last_valid = gaps[-1][0] if gaps and gaps[-1][1] >= n_hi else n_hi
    if gaps:
        runs = []
        cur = first_valid
        for g0, g1 in gaps:
            if g0 > cur:
                runs.append((cur, g0))
            cur = max(cur, g1)
        if cur < last_valid:
            runs.append((cur, last_valid))
        valid_runs = runs
    else:
        valid_runs = [(n_lo, n_hi)]
    a("有效输出范围（映射落在待校正录音内的部分）:")
    for v0, v1 in valid_runs:
        a(f"  采样 [{v0}, {v1}) = 参考时间 [{v0 / out_sr:.6f}, "
          f"{v1 / out_sr:.6f}) s")
    a("")
    a("缺口（参考范围超出待校正录音，已补静音）:")
    if not gaps:
        a("  无")
    for i, (g0, g1) in enumerate(gaps, 1):
        if g1 <= first_valid:
            side = "待校正录音开始之前"
        elif g0 >= last_valid:
            side = "待校正录音结束之后"
        else:
            side = "待校正录音范围之外"
        a(f"GAP {i}: 采样 [{g0}, {g1}) = 参考时间 [{g0 / out_sr:.6f}, "
          f"{g1 / out_sr:.6f}) s ({side}, 共 {g1 - g0} 帧)")
    return "\n".join(L) + "\n"


# ---------------------------------------------------------------- 主流程

def load_anchors(args):
    pairs = []
    for r_text, s_text in args.anchor:
        try:
            pairs.append((parse_time(r_text), parse_time(s_text)))
        except ValueError as e:
            raise AnchorError(f"--anchor 参数错误: {e}") from None
    if args.anchors:
        with open(args.anchors, "r", encoding="utf-8") as f:
            for ln, line in enumerate(f, 1):
                line = line.split("#", 1)[0].strip()
                if not line:
                    continue
                parts = line.replace(",", " ").split()
                if len(parts) != 2:
                    raise AnchorError(
                        f"{args.anchors} 第 {ln} 行应为两个时间（参考 待校正）: "
                        f"{line!r}")
                try:
                    pairs.append((parse_time(parts[0]), parse_time(parts[1])))
                except ValueError as e:
                    raise AnchorError(
                        f"{args.anchors} 第 {ln} 行: {e}") from None
    return pairs


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="wavalign",
        description="把待校正录音按锚点对齐到参考录音的时间轴（仅标准库）。",
        epilog="示例:\n"
               "  %(prog)s --ref ref.wav --src src.wav \\\n"
               "      --anchor 12.5 10.0 --anchor 5:00.2 4:58.1 \\\n"
               "      --out aligned.wav --report report.txt\n"
               "  %(prog)s --ref ref.wav --src src.wav --anchors marks.txt \\\n"
               "      --out clip.wav --start 60 --end 1:30\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ref", required=True, help="参考录音 (PCM WAV)")
    ap.add_argument("--src", required=True, help="待校正录音 (PCM WAV)")
    ap.add_argument("--anchor", nargs=2, action="append", default=[],
                    metavar=("REF", "SRC"),
                    help="一对对应时间点，可重复；时间格式 75.5 / 1:15.5 / 1:02:03.25")
    ap.add_argument("--anchors", help="锚点文件：每行 '参考时间 待校正时间'，# 为注释")
    ap.add_argument("--out", required=True, help="输出 WAV")
    ap.add_argument("--report", help="报告输出路径（缺省打印到 stdout）")
    ap.add_argument("--start", type=parse_time, default=None,
                    help="只导出该参考时间之后的区间（含）")
    ap.add_argument("--end", type=parse_time, default=None,
                    help="只导出该参考时间之前的区间（不含）")
    ap.add_argument("--out-sr", type=int, default=None,
                    help="输出采样率，缺省 = 参考文件采样率")
    ap.add_argument("--min-rate", type=float, default=MIN_RATE,
                    help=f"允许的最小伸缩率 (默认 {MIN_RATE})")
    ap.add_argument("--max-rate", type=float, default=MAX_RATE,
                    help=f"允许的最大伸缩率 (默认 {MAX_RATE})")
    args = ap.parse_args(argv)

    try:
        pairs = load_anchors(args)
        anchors = validate_anchors(pairs, args.min_rate, args.max_rate)
        ref = read_wav(args.ref)
        src = read_wav(args.src)
        if ref.nframes == 0 or src.nframes == 0:
            raise ValueError("输入文件为空。")
        out_sr = args.out_sr or ref.sr
        if out_sr <= 0:
            raise ValueError("输出采样率必须为正。")
        n_out = round(ref.duration * out_sr)
        start = args.start if args.start is not None else 0.0
        end = args.end if args.end is not None else ref.duration
        if not (0.0 <= start < end):
            raise ValueError(f"区间非法: start={start}, end={end}")
        n_lo = round(start * out_sr)
        n_hi = round(end * out_sr)
        if n_lo < 0 or n_hi > n_out or n_hi <= n_lo:
            raise ValueError(
                f"区间 [{start}, {end}) 超出参考时长 {ref.duration:.6f} s。")
        tmap = TimeMap(anchors)
        segs = build_segments(tmap, n_out, out_sr, src.sr)
        gaps = render(src, segs, args.out, out_sr, n_lo, n_hi)
        report = format_report(ref, src, out_sr, n_lo, n_hi,
                               anchors, segs, gaps)
    except (AnchorError, ValueError, wave.Error, EOFError) as e:
        print(f"错误: {e}", file=sys.stderr)
        return 2
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            f.write(report)
    else:
        sys.stdout.write(report)
    print(f"完成: {args.out} ({n_hi - n_lo} 帧 @ {out_sr} Hz), "
          f"缺口 {len(gaps)} 处", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
