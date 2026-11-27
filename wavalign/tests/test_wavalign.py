#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""wavalign 单元测试（仅标准库）。

运行:  python3 test_wavalign.py   或   python3 -m unittest
"""
import array
import math
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import wavalign as wa  # noqa: E402

REF_SR = 8000
SRC_SR = 11025  # 故意与参考不同


def write_wav(path, sr, channels, sampwidth=2):
    """channels: 每声道一个 int 列表（16 位有符号量程）。"""
    nch = len(channels)
    n = len(channels[0])
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(nch)
        wf.setsampwidth(sampwidth)
        wf.setframerate(sr)
        frames = array.array("h", bytes(2 * nch * n))
        for c, data in enumerate(channels):
            frames[c::nch] = array.array("h", data)
        wf.writeframes(frames.tobytes())


def read_ch(path, ch=0):
    with wave.open(str(path), "rb") as wf:
        nch, sr, nf = wf.getnchannels(), wf.getframerate(), wf.getnframes()
        raw = wf.readframes(nf)
    arr = array.array("h", raw)
    return sr, nch, nf, arr[ch::nch]


def impulse_track(sr, dur, times, amp=20000):
    n = round(dur * sr)
    data = [0] * n
    for t in times:
        data[round(t * sr)] = amp
    return data


class WavAlignTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def make_files(self, ref_chs, src_chs):
        rp, sp = self.dir / "ref.wav", self.dir / "src.wav"
        write_wav(rp, REF_SR, ref_chs)
        write_wav(sp, SRC_SR, src_chs)
        return rp, sp

    def run_tool(self, extra, expect=0):
        rc = wa.main(extra)
        self.assertEqual(rc, expect)
        return rc

    # ------------------------------------------------ 单锚点：纯平移
    def test_single_anchor_offset(self):
        clicks = [1.0, 2.0, 3.0]
        off = 0.5  # 待校正晚 0.5 s
        ref = impulse_track(REF_SR, 4.0, clicks)
        src = impulse_track(SRC_SR, 5.0, [t + off for t in clicks])
        rp, sp = self.make_files([ref], [src])
        out = self.dir / "out.wav"
        self.run_tool(["--ref", str(rp), "--src", str(sp),
                       "--anchor", "1.0", "1.5", "--out", str(out)])
        sr, nch, nf, data = read_ch(str(out))
        self.assertEqual(nf, round(4.0 * REF_SR))  # 帧数严格等于参考
        for t in clicks:
            i = round(t * sr)
            # 单采样脉冲经线性插值峰值会分散，窗口内应有明显峰值且位置正确
            win = data[i - 2:i + 3]
            self.assertGreaterEqual(max(win), 20000 * 0.4,
                                    f"脉冲应落在 {t} s 附近")
            peak = i - 2 + win.index(max(win))
            self.assertLessEqual(abs(peak - i), 1)

    # ------------------------------------------------ 多锚点：分段漂移
    def test_multi_anchor_drift(self):
        clicks = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0]
        stretch = 1.01  # 待校正时钟慢 1%
        ref = impulse_track(REF_SR, 8.0, clicks)
        src = impulse_track(SRC_SR, 9.0, [t * stretch for t in clicks])
        rp, sp = self.make_files([ref], [src])
        out = self.dir / "out.wav"
        self.run_tool(["--ref", str(rp), "--src", str(sp),
                       "--anchor", "2.0", str(2.0 * stretch),
                       "--anchor", "6.0", str(6.0 * stretch),
                       "--out", str(out)])
        sr, nch, nf, data = read_ch(str(out))
        self.assertEqual(nf, round(8.0 * REF_SR))
        for t in clicks:
            i = round(t * sr)
            peak = max(range(max(0, i - 3), min(nf, i + 4)),
                       key=lambda k: data[k])
            self.assertLessEqual(abs(peak - i), 2,
                                 f"{t} s 处脉冲偏差 {peak - i} 采样")

    def test_segments_contiguous(self):
        """分段必须连续覆盖 [0, n_out)，不多不漏一帧。"""
        anchors = wa.validate_anchors([(1.0, 1.5), (3.0, 3.6), (6.0, 6.5)])
        segs = wa.build_segments(wa.TimeMap(anchors), 64000, REF_SR, SRC_SR)
        self.assertEqual(segs[0].n0, 0)
        self.assertEqual(segs[-1].n1, 64000)
        for a, b in zip(segs, segs[1:]):
            self.assertEqual(a.n1, b.n0)
        self.assertEqual(sum(s.n1 - s.n0 for s in segs), 64000)

    # ------------------------------------------------ 区间导出 == 切片
    def test_clip_equals_slice(self):
        clicks = [0.5, 1.5, 2.5, 3.5]
        ref = impulse_track(REF_SR, 4.0, clicks)
        src = impulse_track(SRC_SR, 5.0, [t * 1.005 + 0.2 for t in clicks])
        rp, sp = self.make_files([ref], [src])
        full, clip = self.dir / "full.wav", self.dir / "clip.wav"
        base = ["--ref", str(rp), "--src", str(sp),
                "--anchor", "1.0", "1.205", "--anchor", "3.0", "3.215"]
        self.run_tool(base + ["--out", str(full)])
        self.run_tool(base + ["--out", str(clip), "--start", "1.0",
                              "--end", "2.5"])
        with wave.open(str(full), "rb") as wf:
            wf.setpos(round(1.0 * REF_SR))
            sliced = wf.readframes(round(1.5 * REF_SR))
        with wave.open(str(clip), "rb") as wf:
            got = wf.readframes(wf.getnframes())
        self.assertEqual(got, sliced)

    # ------------------------------------------------ 声道顺序
    def test_channel_order_preserved(self):
        left = impulse_track(REF_SR, 4.0, [1.0])
        right = impulse_track(REF_SR, 4.0, [2.0])
        src_l = impulse_track(SRC_SR, 5.0, [1.2])
        src_r = impulse_track(SRC_SR, 5.0, [2.2])
        rp, sp = self.make_files([left, right], [src_l, src_r])
        out = self.dir / "out.wav"
        self.run_tool(["--ref", str(rp), "--src", str(sp),
                       "--anchor", "1.0", "1.2", "--out", str(out)])
        sr, nch, nf, ch0 = read_ch(str(out), 0)
        _, _, _, ch1 = read_ch(str(out), 1)
        self.assertEqual(nch, 2)
        p0 = max(range(nf), key=lambda k: ch0[k])
        p1 = max(range(nf), key=lambda k: ch1[k])
        self.assertLessEqual(abs(p0 - round(1.0 * sr)), 2)
        self.assertLessEqual(abs(p1 - round(2.0 * sr)), 2)

    # ------------------------------------------------ 缺口补静音
    def test_gaps_silence_and_report(self):
        # 待校正只覆盖参考时间 [1.0, 3.0]，头尾各 1 s 缺口
        ref = impulse_track(REF_SR, 4.0, [0.5, 1.5, 2.5, 3.5])
        src = impulse_track(SRC_SR, 2.0, [0.5, 1.5])
        rp, sp = self.make_files([ref], [src])
        out = self.dir / "out.wav"
        rep = self.dir / "report.txt"
        self.run_tool(["--ref", str(rp), "--src", str(sp),
                       "--anchor", "1.0", "0.0", "--anchor", "3.0", "2.0",
                       "--out", str(out), "--report", str(rep)])
        sr, nch, nf, data = read_ch(str(out))
        self.assertTrue(all(v == 0 for v in data[:round(0.99 * sr)]),
                        "头部缺口应为静音")
        self.assertTrue(all(v == 0 for v in data[round(3.01 * sr):]),
                        "尾部缺口应为静音")
        text = rep.read_text(encoding="utf-8")
        gaps = [l for l in text.splitlines() if l.startswith("GAP")]
        self.assertEqual(len(gaps), 2)
        self.assertIn("待校正录音开始之前", gaps[0])
        self.assertIn("待校正录音结束之后", gaps[1])

    # ------------------------------------------------ 非法锚点
    def test_reject_reversed(self):
        with self.assertRaises(wa.AnchorError) as cm:
            wa.validate_anchors([(1.0, 1.0), (2.0, 0.5)])
        self.assertIn("第 1 对与第 2 对", str(cm.exception))
        self.assertIn("顺序相反", str(cm.exception))

    def test_reject_degenerate_same_ref(self):
        with self.assertRaises(wa.AnchorError) as cm:
            wa.validate_anchors([(1.0, 1.0), (1.0, 2.0)])
        self.assertIn("退化", str(cm.exception))

    def test_reject_degenerate_same_src(self):
        with self.assertRaises(wa.AnchorError) as cm:
            wa.validate_anchors([(1.0, 1.0), (2.0, 1.0)])
        self.assertIn("退化", str(cm.exception))

    def test_reject_conflict_rate(self):
        with self.assertRaises(wa.AnchorError) as cm:
            wa.validate_anchors([(1.0, 1.0), (2.0, 5.0)])  # 隐含速率 4.0
        self.assertIn("冲突", str(cm.exception))
        self.assertIn("第 1 对与第 2 对", str(cm.exception))

    def test_reject_degenerate_at_output_rate(self):
        anchors = wa.validate_anchors([(1.0, 1.0), (1.0 + 1e-7, 1.0 + 1e-7)])
        with self.assertRaises(wa.AnchorError):
            wa.build_segments(wa.TimeMap(anchors), 64000, REF_SR, SRC_SR)

    def test_cli_reject_exit_code(self):
        ref = impulse_track(REF_SR, 4.0, [1.0])
        src = impulse_track(SRC_SR, 4.0, [1.0])
        rp, sp = self.make_files([ref], [src])
        self.run_tool(["--ref", str(rp), "--src", str(sp),
                       "--anchor", "1.0", "2.0", "--anchor", "2.0", "1.0",
                       "--out", str(self.dir / "x.wav")], expect=2)

    # ------------------------------------------------ 24 位 PCM
    def test_24bit_roundtrip(self):
        # 手工写一个 24 位立体声 WAV
        vals = [(0, -8388608), (1234567, -7654321), (8388607, 100)]
        raw = b"".join(int.to_bytes(v & 0xFFFFFF, 3, "little")
                       for pair in vals for v in pair)
        src = self.dir / "src24.wav"
        with wave.open(str(src), "wb") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(3)
            wf.setframerate(REF_SR)
            wf.writeframes(raw)
        data = wa.read_wav(str(src))
        self.assertEqual(data.sampwidth, 3)
        self.assertEqual(list(data.channels[0]), [0, 1234567, 8388607])
        self.assertEqual(list(data.channels[1]), [-8388608, -7654321, 100])
        # 对齐输出应保持 24 位，且帧数精确
        ref = impulse_track(REF_SR, 1.0, [0.5])
        rp = self.dir / "ref.wav"
        write_wav(rp, REF_SR, [ref])
        out = self.dir / "out24.wav"
        self.run_tool(["--ref", str(rp), "--src", str(src),
                       "--anchor", "0.0", "0.0", "--out", str(out)])
        with wave.open(str(out), "rb") as wf:
            self.assertEqual(wf.getsampwidth(), 3)
            self.assertEqual(wf.getnchannels(), 2)
            self.assertEqual(wf.getnframes(), round(1.0 * REF_SR))

    # ------------------------------------------------ 时间解析
    def test_parse_time(self):
        self.assertAlmostEqual(wa.parse_time("75.5"), 75.5)
        self.assertAlmostEqual(wa.parse_time("1:15.5"), 75.5)
        self.assertAlmostEqual(wa.parse_time("01:02:03.25"), 3723.25)
        with self.assertRaises(ValueError):
            wa.parse_time("1:75")
        with self.assertRaises(ValueError):
            wa.parse_time("-3")


if __name__ == "__main__":
    unittest.main(verbosity=2)
