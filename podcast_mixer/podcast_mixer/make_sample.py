"""生成两人对话样例（正弦拟声 + 底噪），用于核对混音结果。

时间线（默认 12 s）：
  0.5-3.0   A 独讲
  3.0-5.0   长静音（只有底噪）
  5.0-8.5   A、B 重叠（B 从 5.5 开始）
  9.0-11.0  B 独讲
A 的说话电平约 -20 dBFS，B 约 -34 dBFS（明显偏小），两路底噪约 -55 dBFS。

用法：
  python3 -m podcast_mixer.make_sample --outdir sample/
生成：a.wav b.wav a.marks.json b.marks.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import random

from .core import lin_to_db
from .wavio import write_wav

RATE = 44100
DURATION = 12.0

A_SEGS = [(0.5, 3.0), (5.0, 8.5)]
B_SEGS = [(5.5, 8.5), (9.0, 11.0)]

A_VOICE_DB = -20.0
B_VOICE_DB = -34.0
NOISE_DB = -55.0


def synth_voice(rate, segs, total_s, f0, level_db, seed):
    """用基频 + 谐波 + 音节级调幅合成“像人在说话”的测试信号。"""
    rng = random.Random(seed)
    n = int(round(total_s * rate))
    out = [0.0] * n
    amp = 10.0 ** (level_db / 20.0)
    for s, e in segs:
        i0, i1 = int(s * rate), min(n, int(e * rate))
        phase_jitter = rng.uniform(0, 2 * math.pi)
        for i in range(i0, i1):
            t = i / rate
            # 音节节奏 ~3.5 Hz 的调幅，让电平有说话般的起伏
            am = 0.65 + 0.35 * math.sin(2 * math.pi * 3.5 * t + phase_jitter)
            # 轻微基频抖动
            f = f0 * (1.0 + 0.02 * math.sin(2 * math.pi * 5.0 * t))
            v = 0.0
            for h in range(1, 6):
                v += (1.0 / h) * math.sin(2 * math.pi * f * h * t)
            out[i] = v * am
    # 归一化到目标 RMS
    seg_sq = 0.0
    seg_n = 0
    for s, e in segs:
        for i in range(int(s * rate), min(n, int(e * rate))):
            seg_sq += out[i] * out[i]
            seg_n += 1
    rms = math.sqrt(seg_sq / seg_n)
    scale = amp / rms
    return [v * scale for v in out]


def add_noise(samples, rate, level_db, seed):
    rng = random.Random(seed)
    amp = 10.0 ** (level_db / 20.0)
    return [v + rng.gauss(0.0, amp) for v in samples]


def rms_db_of_region(samples, rate, s, e):
    vals = samples[int(s * rate):int(e * rate)]
    if not vals:
        return float("-inf")
    return lin_to_db(math.sqrt(sum(v * v for v in vals) / len(vals)))


def main(argv=None):
    p = argparse.ArgumentParser(prog="make_sample", description="生成两人样例 WAV 与说话标记")
    p.add_argument("--outdir", default="sample", help="输出目录")
    args = p.parse_args(argv)

    os.makedirs(args.outdir, exist_ok=True)

    a = synth_voice(RATE, A_SEGS, DURATION, f0=140.0, level_db=A_VOICE_DB, seed=1)
    a = add_noise(a, RATE, NOISE_DB, seed=11)
    b = synth_voice(RATE, B_SEGS, DURATION, f0=220.0, level_db=B_VOICE_DB, seed=2)
    b = add_noise(b, RATE, NOISE_DB, seed=22)

    write_wav(os.path.join(args.outdir, "a.wav"), a, RATE)
    write_wav(os.path.join(args.outdir, "b.wav"), b, RATE)
    for name, segs in (("a", A_SEGS), ("b", B_SEGS)):
        with open(os.path.join(args.outdir, f"{name}.marks.json"), "w", encoding="utf-8") as f:
            json.dump({"segments": [list(x) for x in segs]}, f, indent=2)

    print(f"样例已生成到 {args.outdir}/")
    print(f"  A 独讲段电平: {rms_db_of_region(a, RATE, 0.7, 2.8):.1f} dBFS")
    print(f"  B 独讲段电平: {rms_db_of_region(b, RATE, 9.2, 10.8):.1f} dBFS")
    print(f"  静音段底噪  : {rms_db_of_region(a, RATE, 3.3, 4.8):.1f} dBFS (A 路)")


if __name__ == "__main__":
    main()
