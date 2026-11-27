"""命令行入口：两路 WAV + 说话标记 -> 节目版混音。

用法示例：
  python3 -m podcast_mixer \
      --a a.wav --marks-a a.marks.json \
      --b b.wav --marks-b b.marks.json \
      --target-a-db -20 --target-b-db -20 \
      --max-boost-a-db 12 --max-boost-b-db 20 \
      --out program.wav --report report.json

  # 逐路监听（处理后的单路）
  python3 -m podcast_mixer --a a.wav --marks-a a.json --solo a --out solo_a.wav

  # 仅输出选中区间（与全片相同样本位置的结果逐位一致）
  python3 -m podcast_mixer ... --range 60 90 --out excerpt.wav
"""

from __future__ import annotations

import argparse
import json
import sys

from . import core
from .wavio import read_wav, write_wav


def build_parser():
    p = argparse.ArgumentParser(
        prog="podcast_mixer",
        description="两路同步 WAV 按说话标记做电平匹配并混成节目版",
    )
    p.add_argument("--a", required=True, help="A 路 WAV 路径")
    p.add_argument("--marks-a", required=True, help="A 路说话标记 JSON")
    p.add_argument("--b", help="B 路 WAV 路径（--solo 时可省略）")
    p.add_argument("--marks-b", help="B 路说话标记 JSON")
    p.add_argument("--target-a-db", type=float, default=-20.0, help="A 说话人目标电平 dBFS(RMS)")
    p.add_argument("--target-b-db", type=float, default=-20.0, help="B 说话人目标电平 dBFS(RMS)")
    p.add_argument("--max-boost-a-db", type=float, default=15.0, help="A 路最大提升量 dB")
    p.add_argument("--max-boost-b-db", type=float, default=15.0, help="B 路最大提升量 dB")
    p.add_argument("--max-cut-db", type=float, default=24.0, help="最大衰减量 dB（两路共用）")
    p.add_argument("--ramp-ms", type=float, default=50.0, help="增益边缘过渡时长 ms")
    p.add_argument("--min-gap-ms", type=float, default=250.0,
                   help="小于该时长的断点会被并为一个说话区间")
    p.add_argument("--ceiling-db", type=float, default=-1.0,
                   help="混音峰值上限 dBFS，超过时整体下压并报告位置")
    p.add_argument("--duration", type=float, default=None,
                   help="输出总时长（秒）。缺省为最长输入；较短音轨自动补零")
    p.add_argument("--range", nargs=2, type=float, metavar=("START", "END"),
                   help="仅输出选中区间（秒），与全片同位置结果一致")
    p.add_argument("--solo", choices=["a", "b"], default=None,
                   help="只输出处理后的某一路（逐路监听）")
    p.add_argument("--out", required=True, help="输出 WAV 路径")
    p.add_argument("--report", help="报告 JSON 输出路径（缺省打印到 stdout）")
    return p


def process_track(name, wav_path, marks_path, target_db, max_boost_db, args, rate):
    samples, r = read_wav(wav_path)
    if r != rate:
        raise SystemExit(f"采样率不一致：{wav_path} 为 {r} Hz，期望 {rate} Hz")
    raw_segs = core.load_markers(marks_path)
    segs = core.merge_segments(raw_segs, args.min_gap_ms / 1000.0)
    speech_db = core.measure_speech_db(samples, segs, rate)
    if speech_db == core.NEG_INF:
        print(f"警告：{name} 路标记区间内没有有效声音，按 0 dB 增益处理", file=sys.stderr)
        requested_db = 0.0
    else:
        requested_db = target_db - speech_db
    gain_db = core.clamp_gain(requested_db, max_boost_db, args.max_cut_db)
    # 过渡时长不超过最小断点的一半，避免相邻区间包络互相覆盖
    ramp_s = min(args.ramp_ms / 1000.0, (args.min_gap_ms / 1000.0) / 2.0)
    gain = core.db_to_lin(gain_db)
    env = core.build_gain_envelope(len(samples), segs, rate, gain, ramp_s)
    processed = core.apply_envelope(samples, env)
    env_min_db, env_max_db = core.envelope_range_db(env)
    info = {
        "input": wav_path,
        "markers": marks_path,
        "input_duration_s": round(len(samples) / rate, 6),
        "segments_raw": len(raw_segs),
        "segments_merged": [[round(s, 3), round(e, 3)] for s, e in segs],
        "speech_rms_db": None if speech_db == core.NEG_INF else round(speech_db, 2),
        "target_db": target_db,
        "requested_gain_db": round(requested_db, 2),
        "applied_gain_db": round(gain_db, 2),
        "clamped": abs(gain_db - requested_db) > 1e-9,
        "max_boost_db": max_boost_db,
        "envelope_min_db": round(env_min_db, 2),
        "envelope_max_db": round(env_max_db, 2),
        "ramp_ms": round(ramp_s * 1000.0, 1),
    }
    return processed, info


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.solo is None and (not args.b or not args.marks_b):
        raise SystemExit("混音模式需要 --b 与 --marks-b（或使用 --solo 只处理一路）")

    # 采样率以 A 路为准，其余各路读取时校验一致
    _, rate = read_wav(args.a)

    tracks = {}
    report = {"sample_rate": rate, "mode": args.solo and f"solo-{args.solo}" or "mix",
              "tracks": {}, "mix": None, "output": {}}

    pa, ia = process_track("a", args.a, args.marks_a, args.target_a_db,
                           args.max_boost_a_db, args, rate)
    tracks["a"] = pa
    report["tracks"]["a"] = ia

    if args.solo != "a":
        pb, ib = process_track("b", args.b, args.marks_b, args.target_b_db,
                               args.max_boost_b_db, args, rate)
        tracks["b"] = pb
        report["tracks"]["b"] = ib

    # 输出长度：指定时长优先，否则取最长输入；较短音轨末尾补零
    if args.duration is not None:
        n = int(round(args.duration * rate))
    else:
        n = max(len(t) for t in tracks.values())
    for name, t in tracks.items():
        padded = core.pad_to(t, n)
        report["tracks"][name]["padded_to_s"] = round(len(padded) / rate, 6)
        report["tracks"][name]["padding_added_s"] = round((len(padded) - len(t)) / rate, 6)
        tracks[name] = padded[:n]

    if args.solo:
        result = tracks[args.solo]
    else:
        result = core.mix([tracks["a"], tracks["b"]], n)

    # 峰值处理：超过上限时整体下压（可解释的单一增益），并报告受影响位置
    ceiling = core.db_to_lin(args.ceiling_db)
    peak = core.peak_abs(result)
    trim_db = 0.0
    exceed = []
    if peak > ceiling:
        trim_db = core.lin_to_db(ceiling / peak)
        exceed = core.find_exceed_regions(result, ceiling, rate)
        result = core.scale(result, ceiling / peak)
    report["mix"] = {
        "ceiling_db": args.ceiling_db,
        "peak_before_db": round(core.lin_to_db(peak), 2),
        "trim_applied_db": round(trim_db, 2),
        "exceed_regions_s": [[round(s, 3), round(e, 3)] for s, e in exceed],
        "peak_after_db": round(core.lin_to_db(core.peak_abs(result)), 2),
    }

    # 区间输出：在全片处理完成后切片，保证与全片同位置逐位一致
    if args.range:
        s, e = args.range
        i0 = max(0, int(round(s * rate)))
        i1 = min(len(result), int(round(e * rate)))
        result = result[i0:i1]
        report["output"]["range_s"] = [s, e]

    write_wav(args.out, result, rate)
    report["output"].update({
        "path": args.out,
        "duration_s": round(len(result) / rate, 6),
        "samples": len(result),
    })

    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as f:
            f.write(text + "\n")
    print(text)
    return report


if __name__ == "__main__":
    main()
