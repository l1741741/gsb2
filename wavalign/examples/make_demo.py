#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""可重跑样例：生成一对模拟"同一场排练、两台录音机"的 WAV，跑对齐并自检。

用法:  python3 make_demo.py
产物:  demo_out/ 下的 ref.wav / src.wav / anchors.txt / aligned.wav /
       clip.wav / report.txt，全部确定性生成，可反复重跑比对。

自检内容:
  1. 输出帧数与参考时长严格一致（段相接处不多不漏帧）；
  2. 每个脉冲在输出中的位置与参考位置的偏差（累积误差，应 < 3 ms）；
  3. 左右声道未串（左 440 Hz / 右 660 Hz）；
  4. 区间导出与完整输出的对应切片逐字节一致；
  5. 报告列出 2 处缺口（头部约 1.25 s、尾部约 2 s）。
"""
import math
import re
import struct
import subprocess
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE.parent / "wavalign.py"
OUT = HERE / "demo_out"

REF_SR = 48000
SRC_SR = 44100
REF_DUR = 40.0          # 参考时长 (s)
OFFSET = 1.25           # 待校正录音晚开机的时间 (s)
RATE_A = 1.0004         # 前 20 s 的时钟漂移
RATE_B = 0.9997         # 之后的时钟漂移
KINK = 20.0             # 漂移突变点 (s, 参考时间)
SRC_END_REF = 38.0      # 待校正录音覆盖到的参考时间（之后为尾部缺口）
CLICKS = [5.0, 15.0, 25.0, 35.0]


# ------------------------------------------------- 信号模型（参考时间轴）

def true_signal(t):
    """参考时间 t 处的真实声音 -> (左, 右)。左右用不同频率以便查声道。"""
    left = 0.30 * math.sin(2 * math.pi * 440.0 * t)
    right = 0.30 * math.sin(2 * math.pi * 660.0 * t)
    for tc in CLICKS:
        if t >= tc:
            amp = 0.9 * math.exp(-(t - tc) * 300.0)
            left += amp
            right += amp
    return left, right


def ref_to_src(t):
    """参考时间 -> 待校正录音时间（分段时钟漂移 + 晚开机）。"""
    if t <= KINK:
        return (t - OFFSET) * RATE_A
    return (KINK - OFFSET) * RATE_A + (t - KINK) * RATE_B


def src_to_ref(s):
    s_kink = (KINK - OFFSET) * RATE_A
    if s <= s_kink:
        return s / RATE_A + OFFSET
    return KINK + (s - s_kink) / RATE_B


def q16(v):
    return max(-32768, min(32767, int(v * 32767 + 0.5) if v >= 0
                             else -int(-v * 32767 + 0.5)))


def write_wav(path, sr, frames):
    """frames: [(left, right), ...] 整型采样。"""
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(2)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(b"".join(struct.pack("<hh", l, r) for l, r in frames))


def read_wav(path):
    with wave.open(str(path), "rb") as wf:
        nch, sw, sr, nf = (wf.getnchannels(), wf.getsampwidth(),
                           wf.getframerate(), wf.getnframes())
        raw = wf.readframes(nf)
    vals = struct.unpack(f"<{nf * nch}h", raw)
    return sr, nch, vals


# ------------------------------------------------- 生成样例

def generate():
    OUT.mkdir(exist_ok=True)
    ref = [tuple(q16(v) for v in true_signal(n / REF_SR))
           for n in range(round(REF_DUR * REF_SR))]
    write_wav(OUT / "ref.wav", REF_SR, ref)

    n_src = int(ref_to_src(SRC_END_REF) * SRC_SR)
    src = [tuple(q16(v) for v in true_signal(src_to_ref(n / SRC_SR)))
           for n in range(n_src)]
    write_wav(OUT / "src.wav", SRC_SR, src)

    # 锚点：脉冲真实对应时间，四舍五入到毫秒（模拟剪辑手动打点的精度）
    with open(OUT / "anchors.txt", "w", encoding="utf-8") as f:
        f.write("# 参考时间 待校正时间 (s)\n")
        for tc in CLICKS:
            f.write(f"{tc:.3f} {ref_to_src(tc):.3f}\n")
    print(f"已生成 {OUT}/ (ref {REF_SR} Hz, src {SRC_SR} Hz, "
          f"漂移 {RATE_A}/{RATE_B}, 偏移 {OFFSET} s)")


# ------------------------------------------------- 自检

def find_click(vals, nch, sr, t, win=0.1):
    """在 t ± win 内找 |采样| 最大的位置（帧序号）。"""
    c0 = max(0, round((t - win) * sr))
    c1 = min(len(vals) // nch, round((t + win) * sr))
    best, bi = -1, c0
    for i in range(c0, c1):
        v = abs(vals[i * nch])
        if v > best:
            best, bi = v, i
    return bi


def power_at(vals, nch, ch, sr, n0, n1, freq):
    w = 2 * math.pi * freq / sr
    re = im = 0.0
    for i in range(n0, n1):
        re += vals[i * nch + ch] * math.cos(w * i)
        im -= vals[i * nch + ch] * math.sin(w * i)
    return re * re + im * im


def main():
    generate()
    py = sys.executable
    full = [py, str(TOOL), "--ref", str(OUT / "ref.wav"), "--src",
            str(OUT / "src.wav"), "--anchors", str(OUT / "anchors.txt"),
            "--out", str(OUT / "aligned.wav"), "--report",
            str(OUT / "report.txt")]
    clip = [py, str(TOOL), "--ref", str(OUT / "ref.wav"), "--src",
            str(OUT / "src.wav"), "--anchors", str(OUT / "anchors.txt"),
            "--out", str(OUT / "clip.wav"), "--start", "10", "--end", "22"]
    for cmd in (full, clip):
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0:
            print(r.stderr, file=sys.stderr)
            print("DEMO FAIL: 对齐命令出错", file=sys.stderr)
            return 1

    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        print(f"  [{'PASS' if cond else 'FAIL'}] {name} {detail}")
        ok = ok and cond

    sr, nch, ref_v = read_wav(OUT / "ref.wav")
    _, _, ali_v = read_wav(OUT / "aligned.wav")

    # 1. 帧数严格一致
    check("输出帧数 == 参考帧数", len(ali_v) == len(ref_v),
          f"({len(ali_v) // nch} vs {len(ref_v) // nch})")

    # 2. 脉冲位置误差（锚点只精确到 1 ms，故阈值为 3 ms）
    worst = 0.0
    for tc in CLICKS:
        e = abs(find_click(ali_v, nch, sr, tc) -
                find_click(ref_v, nch, sr, tc)) / sr
        worst = max(worst, e)
    check("脉冲累积误差 < 3 ms", worst < 0.003, f"(最大 {worst * 1e3:.2f} ms)")

    # 3. 声道未串：8~9 s 处左声道应为 440 Hz、右声道应为 660 Hz
    n0, n1 = round(8.0 * sr), round(9.0 * sr)
    l440 = power_at(ali_v, nch, 0, sr, n0, n1, 440.0)
    l660 = power_at(ali_v, nch, 0, sr, n0, n1, 660.0)
    r440 = power_at(ali_v, nch, 1, sr, n0, n1, 440.0)
    r660 = power_at(ali_v, nch, 1, sr, n0, n1, 660.0)
    check("左声道 = 440 Hz", l440 > 100 * l660)
    check("右声道 = 660 Hz", r660 > 100 * r440)

    # 4. 区间导出 == 完整输出的对应切片（逐字节）
    with wave.open(str(OUT / "aligned.wav"), "rb") as wf:
        wf.setpos(round(10 * sr))
        sliced = wf.readframes(round(12 * sr))
    with wave.open(str(OUT / "clip.wav"), "rb") as wf:
        clip = wf.readframes(wf.getnframes())
    check("clip == full[10s:22s]", clip == sliced,
          f"({len(clip)} vs {len(sliced)} 字节)")

    # 5. 缺口：头部 ~1.25 s、尾部 ~2 s（锚点精确到 1 ms，容差 3 ms）
    report = (OUT / "report.txt").read_text(encoding="utf-8")
    gaps = [l for l in report.splitlines() if l.startswith("GAP")]
    check("报告列出 2 处缺口", len(gaps) == 2, f"(实际 {len(gaps)})")
    if len(gaps) == 2:
        span = [float(x) for x in
                re.findall(r"参考时间 \[([\d.]+), ([\d.]+)\)", gaps[0])[0]]
        check("头部缺口 ≈ [0, 1.25) s",
              abs(span[0] - 0.0) < 1e-6 and abs(span[1] - OFFSET) < 0.003,
              gaps[0])
        span = [float(x) for x in
                re.findall(r"参考时间 \[([\d.]+), ([\d.]+)\)", gaps[1])[0]]
        check("尾部缺口 ≈ [38, 40) s",
              abs(span[0] - SRC_END_REF) < 0.003 and
              abs(span[1] - REF_DUR) < 1e-3, gaps[1])

    print("DEMO PASS" if ok else "DEMO FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
