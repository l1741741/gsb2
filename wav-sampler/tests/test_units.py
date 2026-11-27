"""单元测试: PCM 编解码、声道映射、时间轴扫线、清单解析。"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
import wave

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from wav_sampler.channels import apply_channel_map, default_channel_map, resolve_channel_map
from wav_sampler.manifest import load_manifest, ManifestError, seconds_to_frames
from wav_sampler.model import (
    KIND_OVERLAP,
    KIND_SILENCE,
    KIND_SOURCE,
    SegmentSpec,
)
from wav_sampler.pcm import decode_bytes, encode_samples, max_amplitude, min_amplitude
from wav_sampler.timeline import build_runs, summarize_runs

RATE = 8000


class PcmTests(unittest.TestCase):
    def test_roundtrip_all_widths(self):
        for width in (1, 2, 3, 4):
            hi = max_amplitude(width)
            lo = min_amplitude(width)
            samples = [0, 1, -1, hi // 2, lo // 2, hi, lo]
            raw = encode_samples(samples, width)
            decoded = decode_bytes(raw, width)
            if width == 1:
                # 8 bit 无符号偏置 128, 量程内整数级均可往返
                self.assertEqual(decoded, samples)
            else:
                self.assertEqual(decoded, samples)

    def test_24bit_negative(self):
        raw = encode_samples([-1, -8388608], 3)
        self.assertEqual(decode_bytes(raw, 3), [-1, -8388608])

    def test_clamp_on_narrow_width(self):
        self.assertEqual(decode_bytes(encode_samples([99999], 2), 2), [32767])
        self.assertEqual(decode_bytes(encode_samples([-99999], 2), 2), [-32768])


class ChannelMapTests(unittest.TestCase):
    def test_passthrough(self):
        self.assertEqual(default_channel_map(2, 2), (0, 1))
        self.assertEqual(default_channel_map(4, 4), (0, 1, 2, 3))

    def test_mono_upmix(self):
        self.assertEqual(default_channel_map(1, 2), (0, 0))
        self.assertEqual(default_channel_map(1, 4), (0, 0, 0, 0))

    def test_downmix_takes_first(self):
        self.assertEqual(default_channel_map(4, 1), (0,))
        self.assertEqual(default_channel_map(2, 1), (0,))

    def test_pad_silence_and_drop(self):
        self.assertEqual(default_channel_map(2, 4), (0, 1, -1, -1))
        self.assertEqual(default_channel_map(4, 2), (0, 1))
        self.assertEqual(default_channel_map(3, 2), (0, 1))

    def test_apply_frame(self):
        frame = [10, 20, 30, 40]
        self.assertEqual(apply_channel_map(frame, (0, 1), 2), [10, 20])
        self.assertEqual(apply_channel_map(frame, (3, -1), 2), [40, 0])
        mono = [7]
        self.assertEqual(apply_channel_map(mono, (0, 0), 2), [7, 7])

    def test_explicit_map_validation(self):
        with self.assertRaises(ValueError):
            resolve_channel_map((0, 5), 2, 2)
        with self.assertRaises(ValueError):
            resolve_channel_map((0,), 2, 2)
        self.assertEqual(resolve_channel_map((1, -1), 2, 2), (1, -1))


class TimelineTests(unittest.TestCase):
    def _seg(self, seg_id, start, end, priority=0, channels=2):
        spec = SegmentSpec(
            segment_id=seg_id,
            path=f"{seg_id}.wav",
            start_frame=start,
            declared_frames=end - start,
            priority=priority,
        )
        from wav_sampler.model import ResolvedSegment
        from wav_sampler.channels import default_channel_map

        return ResolvedSegment(
            spec=spec,
            actual_frames=end - start,
            channels=channels,
            sample_width=2,
            effective_start=start,
            effective_end=end,
            declared_end=end,
            channel_map=default_channel_map(channels, 2),
        )

    def test_silence_source_overlap_priority(self):
        segs = (
            self._seg("lo", 0, 100, priority=1),
            self._seg("hi", 60, 140, priority=5),
        )
        runs = build_runs(0, 200, segs)
        kinds = [(r.kind, r.start_frame, r.end_frame, r.segment_id) for r in runs]
        self.assertEqual(
            kinds,
            [
                (KIND_SOURCE, 0, 60, "lo"),
                (KIND_OVERLAP, 60, 100, "hi"),
                (KIND_SOURCE, 100, 140, "hi"),
                (KIND_SILENCE, 140, 200, None),
            ],
        )
        # 重叠段必须记录全部竞争者, 且胜者在前
        overlap = next(r for r in runs if r.kind == KIND_OVERLAP)
        self.assertEqual(overlap.contenders, ("hi", "lo"))
        # 源帧映射: hi 从项目帧 60 开始, 项目 60 -> 源 0
        self.assertEqual(overlap.source_start_frame, 0)
        self.assertEqual(overlap.source_end_frame, 40)

    def test_tie_breaks_by_id(self):
        segs = (
            self._seg("zzz", 0, 50, priority=0),
            self._seg("aaa", 0, 50, priority=0),
        )
        runs = build_runs(0, 50, segs)
        self.assertEqual(len(runs), 1)
        self.assertEqual(runs[0].segment_id, "aaa")
        self.assertEqual(runs[0].contenders, ("aaa", "zzz"))

    def test_total_frames_exact_and_adjacent_boundaries(self):
        segs = (self._seg("a", 10, 30), self._seg("b", 30, 80))
        runs = build_runs(0, 100, segs)
        self.assertEqual(sum(r.end_frame - r.start_frame for r in runs), 100)
        # 相邻 Run 首尾相接, 无重帧无缺口
        for prev, nxt in zip(runs, runs[1:]):
            self.assertEqual(prev.end_frame, nxt.start_frame)

    def test_summarize(self):
        segs = (self._seg("a", 0, 10),)
        totals = summarize_runs(build_runs(0, 20, segs))
        self.assertEqual(totals, {KIND_SOURCE: 10, KIND_OVERLAP: 0, KIND_SILENCE: 10})


class ManifestParseTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = self.tmp.name
        self._make_wav("a.wav", channels=2, frames=100, width=2)

    def _make_wav(self, name, *, channels, frames, width, rate=RATE):
        path = os.path.join(self.dir, name)
        with wave.open(path, "wb") as wf:
            wf.setnchannels(channels)
            wf.setsampwidth(width)
            wf.setframerate(rate)
            wf.writeframes(bytes(frames * channels * width))
        return path

    def _write(self, payload):
        path = os.path.join(self.dir, "manifest.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        return path

    def _base(self):
        return {
            "sample_rate": RATE,
            "output_channels": 2,
            "segments": [
                {"id": "a", "path": "a.wav", "start": 0, "duration": {"frames": 100}}
            ],
            "ranges": [{"id": "r", "start": 0, "end": {"frames": 50}}],
        }

    def test_seconds_conversion_rounds(self):
        self.assertEqual(seconds_to_frames(1.0, RATE), 8000)
        self.assertEqual(seconds_to_frames({"seconds": 0.5}, RATE), 4000)
        self.assertEqual(seconds_to_frames({"frames": 123}, RATE), 123)

    def test_bad_range_rejected(self):
        payload = self._base()
        payload["ranges"][0]["end"] = {"frames": 0}
        with self.assertRaises(ManifestError):
            load_manifest(self._write(payload))

    def test_duplicate_ids(self):
        payload = self._base()
        payload["segments"].append(dict(payload["segments"][0]))
        with self.assertRaises(ManifestError):
            load_manifest(self._write(payload))

    def test_rate_mismatch_is_diagnostic_not_exception(self):
        self._make_wav("fast.wav", channels=1, frames=50, width=2, rate=16000)
        payload = self._base()
        payload["segments"].append(
            {"id": "fast", "path": "fast.wav", "start": {"frames": 0}}
        )
        _, diags, resolved = load_manifest(self._write(payload))
        self.assertTrue(any(d.code == "sample_rate_mismatch" for d in diags))
        self.assertEqual([s.spec.segment_id for s in resolved], ["a"])


if __name__ == "__main__":
    unittest.main()
