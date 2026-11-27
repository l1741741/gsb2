"""自动核对：生成样例 -> 混音 -> 验证独讲 / 重叠 / 长静音三种情况。

用法：
  python3 -m podcast_mixer.verify_sample
全部检查通过时退出码为 0。
"""

from __future__ import annotations

import math
import os
import sys
import tempfile

from . import cli, make_sample
from .core import lin_to_db
from .wavio import read_wav

TARGET_DB = -20.0


def rms_db(samples, rate, s, e):
    vals = samples[int(s * rate):int(e * rate)]
    return lin_to_db(math.sqrt(sum(v * v for v in vals) / len(vals)))


def check(name, ok, detail):
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    return ok


def main():
    tmp = tempfile.mkdtemp(prefix="podcast_mixer_check_")
    print(f"工作目录: {tmp}")

    print("1. 生成样例")
    make_sample.main(["--outdir", tmp])
    a_path = os.path.join(tmp, "a.wav")
    b_path = os.path.join(tmp, "b.wav")
    ma = os.path.join(tmp, "a.marks.json")
    mb = os.path.join(tmp, "b.marks.json")

    results = []

    print("2. 正常混音（目标 -20 dBFS，B 允许提升 20 dB）")
    out_mix = os.path.join(tmp, "mix.wav")
    report = cli.main([
        "--a", a_path, "--marks-a", ma,
        "--b", b_path, "--marks-b", mb,
        "--target-a-db", str(TARGET_DB), "--target-b-db", str(TARGET_DB),
        "--max-boost-a-db", "12", "--max-boost-b-db", "20",
        "--out", out_mix, "--report", os.path.join(tmp, "report.json"),
    ])
    mix, rate = read_wav(out_mix)
    a_raw, _ = read_wav(a_path)

    solo_a_db = rms_db(mix, rate, 0.7, 2.8)
    results.append(check(
        "独讲段（A）电平达到目标",
        abs(solo_a_db - TARGET_DB) < 1.5,
        f"{solo_a_db:.1f} dBFS，目标 {TARGET_DB} dBFS"))

    solo_b_db = rms_db(mix, rate, 9.2, 10.8)
    results.append(check(
        "独讲段（B，原本小 14 dB）被提升到目标",
        abs(solo_b_db - TARGET_DB) < 1.5,
        f"{solo_b_db:.1f} dBFS，目标 {TARGET_DB} dBFS"))

    noise_before = rms_db(a_raw, rate, 3.3, 4.8)
    noise_after = rms_db(mix, rate, 3.3, 4.8)
    # 两路独立底噪叠加约 +3 dB；空白区间不应被说话增益抬高
    results.append(check(
        "长静音段底噪未被提升",
        noise_after < noise_before + 4.0,
        f"静音段 {noise_before:.1f} -> {noise_after:.1f} dBFS"))

    overlap_db = rms_db(mix, rate, 5.8, 7.8)
    results.append(check(
        "重叠段两人都在（能量高于单人）",
        TARGET_DB - 1.0 < overlap_db < TARGET_DB + 6.0,
        f"{overlap_db:.1f} dBFS"))

    env = report["tracks"]["b"]
    results.append(check(
        "报告给出实际调节范围",
        env["envelope_min_db"] == 0.0 and env["envelope_max_db"] > 10.0,
        f"B 路包络 {env['envelope_min_db']} ~ {env['envelope_max_db']} dB"))

    print("3. 区间输出与全片一致性")
    out_full = os.path.join(tmp, "full.wav")
    out_part = os.path.join(tmp, "part.wav")
    cli.main(["--a", a_path, "--marks-a", ma, "--b", b_path, "--marks-b", mb,
              "--max-boost-b-db", "20", "--out", out_full,
              "--report", os.path.join(tmp, "r_full.json")])
    cli.main(["--a", a_path, "--marks-a", ma, "--b", b_path, "--marks-b", mb,
              "--max-boost-b-db", "20", "--range", "4", "7", "--out", out_part,
              "--report", os.path.join(tmp, "r_part.json")])
    full, rate = read_wav(out_full)
    part, _ = read_wav(out_part)
    i0, i1 = int(4 * rate), int(7 * rate)
    same = len(part) == i1 - i0 and all(
        abs(x - y) < 1e-6 for x, y in zip(part, full[i0:i1]))
    results.append(check("区间输出与全片同位置样本一致", same,
                         f"区间 {len(part)} 样本"))

    print("4. 逐路监听")
    out_solo = os.path.join(tmp, "solo_a.wav")
    cli.main(["--a", a_path, "--marks-a", ma, "--solo", "a",
              "--out", out_solo, "--report", os.path.join(tmp, "r_solo.json")])
    solo, _ = read_wav(out_solo)
    solo_quiet = rms_db(solo, rate, 9.2, 10.8)
    results.append(check("solo A 时 B 独讲段只剩底噪", solo_quiet < -45.0,
                         f"{solo_quiet:.1f} dBFS"))

    print("5. 峰值保护（把目标设得过高，触发整体下压）")
    out_hot = os.path.join(tmp, "hot.wav")
    hot_report = cli.main([
        "--a", a_path, "--marks-a", ma, "--b", b_path, "--marks-b", mb,
        "--target-a-db", "-4", "--target-b-db", "-4",
        "--max-boost-a-db", "30", "--max-boost-b-db", "40",
        "--out", out_hot, "--report", os.path.join(tmp, "r_hot.json")])
    hot, _ = read_wav(out_hot)
    peak_after = max(max(hot), -min(hot))
    m = hot_report["mix"]
    results.append(check("过峰时整体下压且峰值不越限",
                         m["trim_applied_db"] < 0 and peak_after <= 10 ** (-1 / 20) + 0.001,
                         f"下压 {m['trim_applied_db']} dB，峰值 {m['peak_after_db']} dBFS"))
    results.append(check("报告列出受影响位置",
                         len(m["exceed_regions_s"]) > 0,
                         f"{len(m['exceed_regions_s'])} 处，首处 {m['exceed_regions_s'][0] if m['exceed_regions_s'] else '-'}"))

    print()
    if all(results):
        print(f"全部 {len(results)} 项检查通过。")
        return 0
    print(f"{results.count(False)}/{len(results)} 项检查失败。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
