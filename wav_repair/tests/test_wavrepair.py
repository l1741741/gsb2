"""Tests for the wavrepair tool. Run with ``python3 -m unittest`` from the
tool directory (or ``python3 -m unittest discover -s tests``)."""

import hashlib
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from wavrepair.confirm import load_confirm, resolve_edits, ConfirmDocument, Edit
from wavrepair.detect import DetectionSettings, scan_audio
from wavrepair.errors import (
    ConfirmError,
    InputMismatchError,
    OverlapError,
    WavError,
    WavRepairError,
)
from wavrepair.export import verify_untouched
from wavrepair.repair import apply_repairs
from wavrepair.wavio import Audio, read_wav, write_wav


def _audio(samples, channels=1, rate=8000, codec="pcm_s16le"):
    return Audio(channels=channels, sample_rate=rate, codec=codec, samples=list(samples))


def _load_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def _dump_json(path, payload):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)


def _sha256(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def _tone(frames=4000, channels=1, rate=8000, amplitude=6000):
    import math

    data = []
    for frame in range(frames):
        value = int(amplitude * math.sin(2 * math.pi * 440 * frame / rate))
        for _ in range(channels):
            data.append(value)
    return _audio(data, channels, rate)


def _write_confirm(path, audio, edits, policy="merge", ignored=()):
    document = {
        "format": "wavrepair-confirm",
        "version": 1,
        "input": {
            "path": audio.source_path,
            "sha256": audio.source_sha256,
            "frames": audio.frames,
            "sample_rate": audio.sample_rate,
            "channels": audio.channels,
        },
        "overlap_policy": policy,
        "edits": edits,
        "ignored_candidates": list(ignored),
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(document, handle)


class TempDirTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def path(self, name):
        return os.path.join(self.dir, name)

    def roundtrip_audio(self, audio, name="base.wav"):
        target = self.path(name)
        write_wav(target, audio)
        return read_wav(target)


# --------------------------------------------------------------------------
# WAV I/O
# --------------------------------------------------------------------------

class WavIOTests(TempDirTestCase):
    def test_round_trip_all_supported_formats(self):
        cases = {
            "pcm_s16le": lambda i: (i % 5000) - 2500,
            "pcm_s24le": lambda i: (i % 100000) - 50000,
            "pcm_s32le": lambda i: (i % 1000000) - 500000,
            "pcm_f32le": lambda i: (i % 100) / 100.0 - 0.5,
        }
        for codec, make in cases.items():
            for channels in (1, 2):
                frames = 300
                samples = [make(i + channel) for i in range(frames) for channel in range(channels)]
                audio = _audio(samples, channels, 48000, codec)
                target = self.path(f"{codec}-{channels}.wav")
                write_wav(target, audio)
                again = read_wav(target)
                self.assertEqual(again.codec, codec)
                self.assertEqual(again.channels, channels)
                self.assertEqual(again.sample_rate, 48000)
                self.assertEqual(again.frames, frames)
                if codec == "pcm_f32le":
                    # Float WAV stores float32; compare with float32 tolerance.
                    for left, right in zip(again.samples, audio.samples):
                        self.assertAlmostEqual(left, right, places=6)
                else:
                    self.assertEqual(again.samples, audio.samples)

    def test_rejects_non_wav_file(self):
        target = self.path("bad.wav")
        with open(target, "w", encoding="utf-8") as handle:
            handle.write("not a wav")
        with self.assertRaises(WavError):
            read_wav(target)

    def test_rejects_truncated_data_chunk(self):
        target = self.path("truncated.wav")
        write_wav(target, _tone(100))
        with open(target, "rb") as handle:
            data = bytearray(handle.read())
        data[40:44] = b"\xff\xff\x00\x00"  # inflate the data chunk size
        with open(target, "wb") as handle:
            handle.write(data)
        with self.assertRaises(WavError):
            read_wav(target)

    def test_rejects_unsupported_bit_depth(self):
        # Build an 8-bit PCM header by hand; 8-bit is not in the supported set.
        import struct

        target = self.path("eight.wav")
        with open(target, "wb") as handle:
            handle.write(b"RIFF")
            handle.write(struct.pack("<I", 4 + 8 + 16 + 8 + 2))
            handle.write(b"WAVE")
            handle.write(b"fmt ")
            handle.write(struct.pack("<I", 16))
            handle.write(struct.pack("<HHIIHH", 1, 1, 8000, 8000, 1, 8))
            handle.write(b"data")
            handle.write(struct.pack("<I", 2))
            handle.write(b"\x80\x80")
        with self.assertRaises(WavError):
            read_wav(target)


# --------------------------------------------------------------------------
# Detection
# --------------------------------------------------------------------------

def _damaged_tone():
    """A tone with one injected click plus a smooth glide segment."""
    import math

    frames = 6000
    rate = 8000
    data = []
    for frame in range(frames):
        value = int(5000 * math.sin(2 * math.pi * (440 + 40 * frame / frames) * frame / rate))
        data.append(value)
    data[2500] = 32000  # injected click
    return _audio(data, 1, rate)


class DetectionTests(TempDirTestCase):
    def test_finds_injected_click(self):
        audio = _damaged_tone()
        result = scan_audio(audio, DetectionSettings())
        suspects = result.suspects
        self.assertTrue(suspects)
        self.assertTrue(any(c.start <= 2500 < c.end for c in suspects))

    def test_clean_glide_is_not_flagged(self):
        import math

        frames = 6000
        data = [int(5000 * math.sin(2 * math.pi * (300 + 300 * f / frames) * f / 8000))
                for f in range(frames)]
        result = scan_audio(_audio(data, 1, 8000), DetectionSettings())
        self.assertEqual(result.suspects, [])

    def test_impulse_group_merges_nearby_samples(self):
        import math

        frames = 4000
        data = [int(800 * math.sin(2 * math.pi * 200 * f / 8000)) for f in range(frames)]
        data[1000] = 30000
        data[1001] = -30000
        result = scan_audio(_audio(data, 1, 8000), DetectionSettings())
        groups = [c for c in result.suspects if c.start <= 1001 and c.end > 1000]
        self.assertTrue(groups)
        self.assertTrue(any(c.start == 1000 and c.end >= 1002 for c in groups))

    def test_detects_dropout_and_stuck(self):
        import math

        frames = 3000
        # Loud enough that entering/leaving the artifact is a clear jump.
        data = [int(28000 * math.sin(2 * math.pi * 100 * f / 8000)) for f in range(frames)]
        for f in range(1200, 1204):
            data[f] = 0
        for f in range(2200, 2205):
            data[f] = data[2199]
        result = scan_audio(_audio(data, 1, 8000), DetectionSettings())
        kinds = {c.kind for c in result.suspects}
        self.assertIn("dropout", kinds)
        self.assertIn("stuck", kinds)

    def test_reports_context_and_ignored_candidates_are_not_suspects(self):
        audio = _damaged_tone()
        result = scan_audio(audio, DetectionSettings())
        candidate = result.suspects[0]
        context = candidate.context
        self.assertIn("before", context)
        self.assertIn("during", context)
        self.assertIn("after", context)
        self.assertEqual(context["channel"], candidate.channel)

    def test_invalid_channel_is_rejected(self):
        audio = _tone(400, 1)
        with self.assertRaises(WavRepairError):
            scan_audio(audio, DetectionSettings(channels=(1,)))


# --------------------------------------------------------------------------
# Confirmation files and overlap policies
# ------------------------------------------------------------------

class ConfirmTests(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.audio = _tone(4000, 2)
        self.audio = self.roundtrip_audio(self.audio)

    def _write(self, edits, policy="merge", name="confirm.json"):
        path = self.path(name)
        _write_confirm(path, self.audio, edits, policy)
        return path

    def test_mismatched_sha_is_refused(self):
        path = self.path("confirm.json")
        _write_confirm(path, self.audio, [{"channel": 0, "start": 10, "end": 12, "method": "interpolate"}])
        raw = _load_json(path)
        raw["input"]["sha256"] = "0" * 64
        _dump_json(path, raw)
        with self.assertRaises(InputMismatchError):
            load_confirm(path, self.audio)

    def test_mismatched_frames_is_refused(self):
        path = self.path("confirm.json")
        _write_confirm(path, self.audio, [{"channel": 0, "start": 10, "end": 12, "method": "interpolate"}])
        raw = _load_json(path)
        raw["input"]["frames"] = 3999
        _dump_json(path, raw)
        with self.assertRaises(InputMismatchError):
            load_confirm(path, self.audio)

    def test_out_of_range_edit_is_refused(self):
        path = self._write([{"channel": 0, "start": 3999, "end": 4001, "method": "interpolate"}])
        with self.assertRaises(ConfirmError):
            load_confirm(path, self.audio)

    def test_unknown_method_is_refused(self):
        path = self._write([{"channel": 0, "start": 10, "end": 12, "method": "gain"}])
        with self.assertRaises(ConfirmError):
            load_confirm(path, self.audio)

    def test_merge_policy_merges_overlaps_and_prefers_interpolation(self):
        path = self._write([
            {"channel": 0, "start": 100, "end": 110, "method": "silence"},
            {"channel": 0, "start": 105, "end": 115, "method": "interpolate"},
        ])
        document = load_confirm(path, self.audio)
        edits = resolve_edits(document, self.audio, 4096)
        self.assertEqual(len(edits), 1)
        self.assertEqual((edits[0].start, edits[0].end), (100, 115))
        self.assertEqual(edits[0].method, "interpolate")

    def test_merge_policy_rejects_over_broad_merged_range(self):
        path = self._write([
            {"channel": 0, "start": 100, "end": 200, "method": "interpolate"},
            {"channel": 0, "start": 150, "end": 400, "method": "interpolate"},
        ])
        with self.assertRaises(OverlapError):
            load_confirm(path, self.audio, default_max_width=100)

    def test_reject_policy_refuses_overlaps(self):
        path = self._write([
            {"channel": 0, "start": 100, "end": 110, "method": "interpolate"},
            {"channel": 0, "start": 105, "end": 115, "method": "interpolate"},
        ], policy="reject")
        with self.assertRaises(OverlapError):
            load_confirm(path, self.audio)

    def test_reject_policy_refuses_conflicting_methods_across_channels(self):
        path = self._write([
            {"channel": 0, "start": 100, "end": 110, "method": "interpolate"},
            {"channel": 1, "start": 105, "end": 115, "method": "silence"},
        ], policy="reject")
        with self.assertRaises(OverlapError):
            load_confirm(path, self.audio)

    def test_reject_policy_allows_adjacent_non_overlapping_ranges(self):
        path = self._write([
            {"channel": 0, "start": 100, "end": 110, "method": "interpolate"},
            {"channel": 1, "start": 110, "end": 120, "method": "silence"},
        ], policy="reject")
        document = load_confirm(path, self.audio)
        edits = resolve_edits(document, self.audio, 4096)
        self.assertEqual(len(edits), 2)

    def test_apply_to_expands_to_multiple_channels(self):
        path = self._write([
            {"channel": 0, "start": 100, "end": 110, "method": "silence", "apply_to": [0, 1]},
        ])
        document = load_confirm(path, self.audio)
        edits = resolve_edits(document, self.audio, 4096)
        self.assertEqual({edit.channel for edit in edits}, {0, 1})

    def test_bad_apply_to_channel_is_refused(self):
        path = self._write([
            {"channel": 0, "start": 100, "end": 110, "method": "silence", "apply_to": [0, 5]},
        ])
        with self.assertRaises(ConfirmError):
            load_confirm(path, self.audio)

    def test_wrong_format_version_is_refused(self):
        path = self._write([{"channel": 0, "start": 100, "end": 110, "method": "silence"}])
        raw = _load_json(path)
        raw["version"] = 2
        _dump_json(path, raw)
        with self.assertRaises(ConfirmError):
            load_confirm(path, self.audio)


# --------------------------------------------------------------------------
# Repair and verification
# ------------------------------------------------------------------

class RepairTests(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.audio = self.roundtrip_audio(_tone(4000, 2))

    def test_interpolation_changes_only_the_range(self):
        edits = [Edit(channel=0, start=100, end=110, method="interpolate")]
        repaired, record = apply_repairs(self.audio, edits)
        for frame in range(self.audio.frames):
            for channel in range(2):
                index = frame * 2 + channel
                in_range = channel == 0 and 100 <= frame < 110
                if not in_range:
                    self.assertEqual(repaired.samples[index], self.audio.samples[index])
        left = self.audio.samples[99 * 2]
        right = self.audio.samples[110 * 2]
        gap = 110 - 100 + 1  # 11 steps between the two endpoints
        # The line is exactly left + (right-left)*k/gap at every interior frame.
        for offset in range(1, gap):
            expected = left + (right - left) * (offset / gap)
            actual = repaired.samples[(100 + offset - 1) * 2]
            self.assertLessEqual(abs(actual - expected), 1.0)
        self.assertEqual(record["edits"][0]["changed_samples"], 10)

    def test_silence_sets_zero_and_keeps_geometry(self):
        edits = [Edit(channel=1, start=200, end=205, method="silence")]
        repaired, _record = apply_repairs(self.audio, edits)
        for frame in range(200, 205):
            self.assertEqual(repaired.samples[frame * 2 + 1], 0)
        self.assertEqual(repaired.frames, self.audio.frames)
        self.assertEqual(repaired.sample_rate, self.audio.sample_rate)
        self.assertEqual(repaired.channels, self.audio.channels)

    def test_apply_to_same_range_on_both_channels(self):
        edits = [
            Edit(channel=0, start=300, end=304, method="silence", apply_to=(0, 1)),
            Edit(channel=1, start=300, end=304, method="silence"),
        ]
        repaired, record = apply_repairs(self.audio, edits)
        self.assertEqual({entry["channel"] for entry in record["edits"]}, {0, 1})
        for frame in range(300, 304):
            self.assertEqual(repaired.samples[frame * 2], 0)
            self.assertEqual(repaired.samples[frame * 2 + 1], 0)

    def test_interpolation_edge_uses_neighbour_hold(self):
        edits = [Edit(channel=0, start=0, end=3, method="interpolate")]
        repaired, record = apply_repairs(self.audio, edits)
        self.assertTrue(record["edits"][0]["edge_hold"])
        self.assertEqual(repaired.samples[0], self.audio.samples[3 * 2])
        self.assertEqual(repaired.samples[1 * 2], self.audio.samples[3 * 2])

    def test_verify_untouched_reports_no_outside_changes(self):
        repaired, _ = apply_repairs(self.audio, [Edit(channel=0, start=50, end=60, method="silence")])
        report = verify_untouched(self.audio, repaired, [Edit(channel=0, start=50, end=60, method="silence")])
        self.assertTrue(report["unconfirmed_untouched"])
        self.assertEqual(report["unconfirmed_samples_changed"], 0)
        self.assertEqual(report["confirmed_samples_changed"], 10)

    def test_verify_untouched_detects_unauthorised_change(self):
        repaired = self.audio.clone()
        repaired.samples[999 * 2] += 1
        report = verify_untouched(self.audio, repaired, [Edit(channel=0, start=50, end=60, method="silence")])
        self.assertFalse(report["unconfirmed_untouched"])
        self.assertEqual(report["unconfirmed_samples_changed"], 1)

    def test_determinism_byte_identical(self):
        edits = [Edit(channel=0, start=100, end=110, method="interpolate")]
        first, _ = apply_repairs(self.audio, edits)
        second, _ = apply_repairs(self.audio, edits)
        self.assertEqual(first.samples, second.samples)
        path_a, path_b = self.path("a.wav"), self.path("b.wav")
        write_wav(path_a, first)
        write_wav(path_b, second)
        self.assertEqual(_sha256(path_a), _sha256(path_b))


# --------------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------

class CLITests(TempDirTestCase):
    def _run(self, *args):
        from wavrepair.cli import main

        return main(list(args))

    def test_scan_and_repair_round_trip(self):
        source = self.roundtrip_audio(_damaged_tone(), "source.wav")
        report_path = self.path("report.json")
        confirm_path = self.path("draft.json")
        code = self._run("scan", source.source_path, "--report", report_path,
                         "--draft-confirm", confirm_path)
        self.assertIn(code, (0, 1))  # 1 when suspects were found
        with open(report_path, encoding="utf-8") as handle:
            report = json.load(handle)
        self.assertTrue(report["candidates"])
        with open(confirm_path, encoding="utf-8") as handle:
            draft = json.load(handle)
        self.assertTrue(draft["edits"])

        output = self.path("repaired.wav")
        manifest = self.path("manifest.json")
        code = self._run("repair", source.source_path, "--confirm", confirm_path,
                         "--output", output, "--manifest", manifest)
        self.assertEqual(code, 0)
        with open(manifest, encoding="utf-8") as handle:
            data = json.load(handle)
        self.assertTrue(data["verification"]["unconfirmed_untouched"])
        self.assertEqual(data["output"]["frames"], data["input"]["frames"])

    def test_repair_refuses_foreign_confirmation(self):
        source = self.roundtrip_audio(_damaged_tone(), "source.wav")
        # A genuinely different take: different frame count and content.
        other = self.roundtrip_audio(_tone(6000, 1, 8000, amplitude=9000), "other.wav")
        confirm_path = self.path("confirm.json")
        _write_confirm(confirm_path, other, [{"channel": 0, "start": 10, "end": 12, "method": "interpolate"}])
        output = self.path("out.wav")
        code = self._run("repair", source.source_path, "--confirm", confirm_path,
                         "--output", output)
        self.assertEqual(code, 2)
        self.assertFalse(os.path.exists(output))

    def test_verify_detects_tampering(self):
        import contextlib
        import io

        source = self.roundtrip_audio(_damaged_tone(), "source.wav")
        confirm_path = self.path("confirm.json")
        _write_confirm(confirm_path, source, [{"channel": 0, "start": 10, "end": 12, "method": "interpolate"}])
        repaired, _ = apply_repairs(source, [Edit(channel=0, start=10, end=12, method="interpolate")])
        repaired.samples[500] += 7
        tampered = self.path("tampered.wav")
        write_wav(tampered, repaired)
        with contextlib.redirect_stdout(io.StringIO()):
            code = self._run("verify", source.source_path, tampered, "--confirm", confirm_path)
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
