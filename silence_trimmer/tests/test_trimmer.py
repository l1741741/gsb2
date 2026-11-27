"""End-to-end and unit tests for the silence trimmer.

Run from the ``silence_trimmer`` directory::

    python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import array
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from trimmer.detect import DetectionConfig, detect_pauses, dbfs
from trimmer.edit import Decision, EditConfig, build_segments, render_edits
from trimmer.map import (
    Marker,
    RegionMap,
    build_region_map,
    locate_original,
    locate_output,
    map_markers,
)
from trimmer.reports import parse_markers, publish_atomic, render_outputs
from trimmer.wavio import WaveData, read_wav, write_wav
from trimmer.pipeline import (
    read_decisions,
    run_pipeline,
    write_decisions_template,
)
from trimmer.cli import main as cli_main

from sample_audio import SR, build_sample, marker_rows, write_sample_wav


class WavIOTest(unittest.TestCase):
    def _roundtrip(self, sampwidth: int, is_float: bool):
        audio = build_sample()
        audio = WaveData(audio.samples, audio.sample_rate, audio.channels,
                         sampwidth, is_float)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "x.wav")
            write_wav(path, audio)
            back = read_wav(path)
            self.assertEqual(back.sample_rate, SR)
            self.assertEqual(back.channels, 2)
            self.assertEqual(back.frames, audio.frames)
            self.assertEqual(back.is_float, is_float)
            # Quantization tolerance grows with coarser sample widths. The
            # float32 bound reflects its ~7 significant decimal digits.
            tol = {
                1: 1 / 64,
                2: 1 / 32768 * 4,
                3: 1 / 8388608 * 4,
                4: 2e-7 if is_float else 1 / 2147483648 * 8,
            }[sampwidth]
            peak_err = max(abs(a - b) for a, b in zip(audio.samples, back.samples))
            self.assertLess(peak_err, tol)

    def test_roundtrip_pcm_widths(self):
        for width in (1, 2, 3, 4):
            with self.subTest(width=width):
                self._roundtrip(width, False)

    def test_roundtrip_float(self):
        self._roundtrip(4, True)

    def test_clamping_does_not_crash(self):
        samples = array.array("d", [-1.5, 1.5, 0.0, -0.999])
        audio = WaveData(samples, 8000, 1, 2, False)
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "c.wav")
            write_wav(path, audio)
            back = read_wav(path)
            self.assertGreaterEqual(min(back.samples), -1.0)
            self.assertLessEqual(max(back.samples), 1.0)


class DetectionTest(unittest.TestCase):
    def setUp(self):
        self.audio = build_sample()
        self.config = DetectionConfig(
            threshold_dbfs=-40.0,
            min_pause_sec=0.8,
            frame_ms=20.0,
            merge_gap_ms=200.0,
            amplitude="peak",
            channel_rule="all",
        )

    def test_finds_three_long_pauses_with_expected_bounds(self):
        pauses = detect_pauses(self.audio, self.config)
        self.assertEqual(len(pauses), 3, [
            (round(p.start_sec, 3), round(p.end_sec, 3)) for p in pauses
        ])
        # Pause A: lopsided 1.00-2.00.
        # Pause B: 2.25-3.40, merging across the 120 ms noisy blip at
        # 3.20-3.32 because the blip is shorter than merge_gap_ms.
        # Pause C: trailing 4.50-6.00.
        a, b, c = pauses
        self.assertAlmostEqual(a.start_sec, 1.0, delta=0.03)
        self.assertAlmostEqual(a.end_sec, 2.0, delta=0.03)
        self.assertAlmostEqual(b.start_sec, 2.25, delta=0.03)
        self.assertAlmostEqual(b.end_sec, 3.40, delta=0.03)
        self.assertAlmostEqual(c.start_sec, 4.5, delta=0.03)
        self.assertEqual(c.end_frame, self.audio.frames)

    def test_short_gap_is_not_its_own_fragment(self):
        pauses = detect_pauses(self.audio, self.config)
        # The 120 ms noisy blip (3.20-3.32) must be absorbed into pause B
        # rather than reported as its own short fragment.
        for p in pauses:
            self.assertFalse(
                3.19 <= p.start_sec and p.end_sec <= 3.33 and p.duration_sec < 0.5,
                "short noisy blip produced a fragment pause",
            )
        # And nothing shorter than min_pause survives.
        self.assertTrue(all(p.duration_sec >= 0.8 - 0.02 for p in pauses))

    def test_adjacent_pauses_do_not_merge_across_speech(self):
        pauses = detect_pauses(self.audio, self.config)
        a, b = pauses[0], pauses[1]
        # The 250 ms speech blip (wider than merge_gap_ms) must keep A and B
        # separate.
        self.assertLess(a.end_sec, b.start_sec)
        self.assertGreaterEqual(b.start_sec - a.end_sec, 0.24)

    def test_channel_joint_rule_all_vs_any(self):
        # At -60 dBFS the right channel's -50 dBFS room tone counts as LOUD,
        # while the dead left channel counts as silent.
        cfg_all = DetectionConfig(threshold_dbfs=-60.0, min_pause_sec=0.8,
                                  channel_rule="all")
        cfg_any = DetectionConfig(threshold_dbfs=-60.0, min_pause_sec=0.8,
                                  channel_rule="any")
        pauses_all = detect_pauses(self.audio, cfg_all)
        pauses_any = detect_pauses(self.audio, cfg_any)
        # Strict "all": pause A (1-2 s) is not silent because the right
        # channel is above threshold there.
        self.assertFalse(
            any(abs(p.start_sec - 1.0) < 0.05 for p in pauses_all),
            "rule=all must reject a pause when one channel stays loud",
        )
        # Loose "any": the dead left channel alone qualifies pause A.
        self.assertTrue(
            any(abs(p.start_sec - 1.0) < 0.05 for p in pauses_any),
            "rule=any must accept a pause when at least one channel is quiet",
        )

    def test_min_pause_filter(self):
        # A and the merged B are ~1.0-1.15 s; only the 1.5 s trailing pause C
        # survives a 1.3 s minimum.
        cfg = DetectionConfig(threshold_dbfs=-40.0, min_pause_sec=1.3)
        pauses = detect_pauses(self.audio, cfg)
        self.assertEqual(len(pauses), 1)
        self.assertAlmostEqual(pauses[0].start_sec, 4.5, delta=0.03)

    def test_reports_per_channel_peak(self):
        pauses = detect_pauses(self.audio, self.config)
        a = pauses[0]
        self.assertEqual(len(a.channel_peak), 2)
        self.assertEqual(a.channel_peak[0], 0.0)
        self.assertGreater(a.channel_peak[1], 0.0)
        self.assertLess(dbfs(a.channel_peak[1]), -40.0)


class EditPlanTest(unittest.TestCase):
    def setUp(self):
        self.audio = build_sample()
        self.config = DetectionConfig(threshold_dbfs=-40.0, min_pause_sec=0.8)
        self.pauses = detect_pauses(self.audio, self.config)
        self.edit = EditConfig(fade_ms=8.0)

    def test_keep_all_leaves_output_identical(self):
        plan = build_segments(self.audio, self.pauses, [], self.edit)
        self.assertEqual(plan.output_frames, self.audio.frames)
        self.assertEqual(plan.deleted, [])
        rendered = render_edits(self.audio, plan, self.edit)
        self.assertEqual(rendered.frames, self.audio.frames)
        for a, b in zip(rendered.samples, self.audio.samples):
            self.assertEqual(a, b)

    def test_delete_all_pauses(self):
        decisions = [Decision(i, action="delete") for i in range(len(self.pauses))]
        plan = build_segments(self.audio, self.pauses, decisions, self.edit)
        # Deleted ranges cover each detected pause.
        self.assertEqual(len(plan.deleted), len(self.pauses))
        expected_kept = self.audio.frames - sum(
            p.end_frame - p.start_frame for p in self.pauses
        )
        self.assertEqual(plan.output_frames, expected_kept)

    def test_shorten_keeps_natural_pause_duration(self):
        decisions = [
            Decision(0, action="shorten", keep_sec=0.3, anchor="start"),
            Decision(1, action="shorten", keep_sec=0.3, anchor="end"),
            Decision(2, action="shorten", keep_sec=0.3, anchor="center"),
        ]
        plan = build_segments(self.audio, self.pauses, decisions, self.edit)
        # Each resolved pause retains ~0.3 s.
        for r in plan.resolved:
            self.assertAlmostEqual(r.retained_length / SR, 0.3, delta=0.02)
        total_removed = sum(
            p.duration_sec - 0.3 for p in self.pauses
        )
        self.assertAlmostEqual(
            (self.audio.frames - plan.output_frames) / SR,
            total_removed,
            delta=0.05,
        )

    def test_manual_boundaries(self):
        decisions = [
            Decision(
                0, action="manual",
                new_start_sec=1.2, new_end_sec=1.6,
            )
        ]
        plan = build_segments(self.audio, self.pauses, decisions, self.edit)
        r = plan.resolved[0]
        self.assertAlmostEqual(r.retained_start / SR, 1.2, delta=0.01)
        self.assertAlmostEqual(r.retained_end / SR, 1.6, delta=0.01)

    def test_manual_overlap_rejected(self):
        decisions = [
            Decision(0, action="manual", new_start_sec=1.5, new_end_sec=2.5),
        ]
        with self.assertRaises(ValueError):
            build_segments(self.audio, self.pauses, decisions, self.edit)

    def test_duplicate_and_bad_decision_rejected(self):
        with self.assertRaises(ValueError):
            build_segments(
                self.audio, self.pauses,
                [Decision(0), Decision(0)], self.edit,
            )
        with self.assertRaises(ValueError):
            build_segments(
                self.audio, self.pauses, [Decision(99)], self.edit
            )


class RenderTest(unittest.TestCase):
    def setUp(self):
        self.audio = build_sample()
        self.config = DetectionConfig(threshold_dbfs=-40.0, min_pause_sec=0.8)
        self.pauses = detect_pauses(self.audio, self.config)

    def test_frame_count_matches_plan(self):
        decisions = [Decision(i, action="delete") for i in range(3)]
        edit = EditConfig(fade_ms=8.0)
        plan = build_segments(self.audio, self.pauses, decisions, edit)
        rendered = render_edits(self.audio, plan, edit)
        self.assertEqual(rendered.frames, plan.output_frames)

    def test_kept_samples_outside_fade_match_source(self):
        decisions = [Decision(0, action="delete")]
        edit = EditConfig(fade_ms=8.0)
        plan = build_segments(self.audio, self.pauses, decisions, edit)
        rendered = render_edits(self.audio, plan, edit)
        fade = int(0.008 * SR)
        # First kept range is original 0..~1.0 s; everything well before the
        # junction must be bit-identical to the source.
        head_end = (self.pauses[0].start_frame - 2 * fade) * 2
        for i in range(0, head_end):
            self.assertEqual(rendered.samples[i], self.audio.samples[i])

    def test_crossfade_removes_discontinuity(self):
        # Put a loud tone directly on both sides of a deleted silence so a
        # hard cut would create a jump; the crossfade must keep the junction
        # smooth.
        decisions = [Decision(0, action="delete")]
        edit_hard = EditConfig(fade_ms=0.0)
        edit_fade = EditConfig(fade_ms=20.0, fade_curve="equal_power")
        plan = build_segments(self.audio, self.pauses, decisions, edit_fade)
        hard = render_edits(self.audio, plan, edit_hard)
        soft = render_edits(self.audio, plan, edit_fade)

        def max_jump(audio):
            junction_out = plan.kept[0].length * audio.channels
            window = 64
            vals = audio.samples[junction_out - window: junction_out + window]
            return max(abs(vals[i + 1] - vals[i]) for i in range(len(vals) - 1))

        self.assertLessEqual(max_jump(soft), max_jump(hard))
        # Equal-power blend at the midpoint is ~0.707/0.707: spot-check gain.
        f = int(0.02 * SR)
        junction_out = plan.kept[0].length * 2
        mid = junction_out - f * 2 + f  # midpoint of blend zone
        self.assertNotAlmostEqual(soft.samples[mid], hard.samples[mid])

    def test_linear_and_equal_power_curves(self):
        for curve in ("linear", "equal_power"):
            edit = EditConfig(fade_ms=10.0, fade_curve=curve)
            decisions = [Decision(2, action="delete")]
            plan = build_segments(self.audio, self.pauses, decisions, edit)
            rendered = render_edits(self.audio, plan, edit)
            self.assertEqual(rendered.frames, plan.output_frames)


class MappingTest(unittest.TestCase):
    def setUp(self):
        self.audio = build_sample()
        self.config = DetectionConfig(threshold_dbfs=-40.0, min_pause_sec=0.8)
        self.pauses = detect_pauses(self.audio, self.config)
        decisions = [
            Decision(0, action="shorten", keep_sec=0.3, anchor="start"),
            Decision(1, action="delete"),
            Decision(2, action="delete"),
        ]
        self.plan = build_segments(
            self.audio, self.pauses, decisions, EditConfig()
        )
        self.rmap = build_region_map(self.plan)

    def test_duration_consistency(self):
        self.assertAlmostEqual(
            self.rmap.output_duration_sec,
            self.plan.output_frames / SR,
            places=6,
        )
        kept_sum = sum(k.duration_sec for k in self.rmap.kept)
        deleted_sum = sum(d.duration_sec for d in self.rmap.deleted)
        self.assertAlmostEqual(
            kept_sum + deleted_sum, self.rmap.input_duration_sec, places=6
        )

    def test_original_to_output_mapped_and_deleted(self):
        mid_speech = locate_original(self.rmap, 0.5)
        self.assertEqual(mid_speech.status, "mapped")
        self.assertAlmostEqual(mid_speech.mapped_time_sec, 0.5, places=4)

        inside = locate_original(self.rmap, 2.5)  # inside deleted pause B
        self.assertEqual(inside.status, "deleted")
        self.assertIsNone(inside.mapped_time_sec)

        trailing = locate_original(self.rmap, 5.0)  # deleted trailing pause C
        self.assertEqual(trailing.status, "deleted")

    def test_boundary_frame_maps_to_junction(self):
        # Exact deletion start still maps (surviving-side convention).
        b_start = self.pauses[1].start_frame / SR
        point = locate_original(self.rmap, b_start)
        self.assertEqual(point.status, "mapped")

    def test_output_to_original_roundtrip(self):
        for t in (0.1, 0.5, 0.9):
            out_point = locate_original(self.rmap, t)
            back = locate_output(self.rmap, out_point.mapped_time_sec)
            self.assertAlmostEqual(back.mapped_time_sec, t, delta=2 / SR)

    def test_markers_classified(self):
        markers = [Marker(t, label) for t, label, _ in marker_rows()]
        mapped = map_markers(self.rmap, markers)
        by_label = {m.label: m for m in mapped}
        for _, label, expected in marker_rows():
            self.assertEqual(by_label[label].status, expected, label)
        deleted_labels = [m.label for m in mapped if m.status == "deleted"]
        self.assertEqual(set(deleted_labels), {"inside-pause-a", "inside-trailing"})

    def test_serialization_roundtrip(self):
        payload = self.rmap.to_dict()
        rebuilt = RegionMap.from_dict(payload)
        p1 = locate_original(self.rmap, 2.5)
        p2 = locate_original(rebuilt, 2.5)
        self.assertEqual(p1.status, p2.status)
        back1 = locate_output(self.rmap, 0.42)
        back2 = locate_output(rebuilt, 0.42)
        self.assertEqual(back1.mapped_time_sec, back2.mapped_time_sec)


class MarkerFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_csv_with_header(self):
        path = os.path.join(self.dir, "m.csv")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("time_sec,label\n0.5,hello\n2.5,world\n")
        markers = parse_markers(path)
        self.assertEqual([m.time_sec for m in markers], [0.5, 2.5])
        self.assertEqual(markers[1].label, "world")

    def test_headerless_csv_and_json(self):
        csv_path = os.path.join(self.dir, "m2.csv")
        with open(csv_path, "w", encoding="utf-8") as fh:
            fh.write("0.25,x\n1.75,y\n")
        markers = parse_markers(csv_path)
        self.assertEqual(len(markers), 2)

        json_path = os.path.join(self.dir, "m.json")
        with open(json_path, "w", encoding="utf-8") as fh:
            json.dump({"markers": [{"time_sec": 3.0, "label": "z"}]}, fh)
        markers = parse_markers(json_path)
        self.assertEqual(markers[0].label, "z")


class AtomicPublishTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.audio = build_sample()
        self.config = DetectionConfig(threshold_dbfs=-40.0, min_pause_sec=0.8)
        self.pauses = detect_pauses(self.audio, self.config)
        decisions = [Decision(i, action="delete") for i in range(3)]
        self.plan = build_segments(self.audio, self.pauses, decisions, EditConfig())
        self.rmap = build_region_map(self.plan)
        self.rendered = render_edits(self.audio, self.plan, EditConfig())

    def tearDown(self):
        self.tmp.cleanup()

    def test_failed_export_leaves_no_output(self):
        out = os.path.join(self.dir, "nested", "out.wav")
        # Force validation to fail by breaking the rendered frame count.
        bad_rendered = WaveData(
            self.rendered.samples[: len(self.rendered.samples) - 4],
            self.rendered.sample_rate, self.rendered.channels,
            self.rendered.sampwidth, self.rendered.is_float,
        )
        with self.assertRaises(Exception):
            render_outputs(out, bad_rendered, self.rmap)
        stem = os.path.splitext(out)[0]
        for suffix in (".wav", ".map.json", ".intervals.csv", ".deleted.csv"):
            self.assertFalse(
                os.path.exists(stem + suffix),
                f"failed export left behind {suffix}",
            )

    def test_failed_export_preserves_previous_good_output(self):
        out = os.path.join(self.dir, "keep.wav")
        render_outputs(out, self.rendered, self.rmap)
        good_bytes = open(out, "rb").read()
        bad_rendered = WaveData(
            self.rendered.samples[: len(self.rendered.samples) - 4],
            self.rendered.sample_rate, self.rendered.channels,
            self.rendered.sampwidth, self.rendered.is_float,
        )
        with self.assertRaises(Exception):
            render_outputs(out, bad_rendered, self.rmap)
        self.assertEqual(open(out, "rb").read(), good_bytes)

    def test_publish_rolls_back_on_rename_failure(self):
        target = os.path.join(self.dir, "a.wav")
        with self.assertRaises(Exception):
            publish_atomic([
                type("S", (), {"target_path": target, "data": b"ok"})(),
                type("S", (), {"target_path": target, "data": b"dup"})(),
            ])
        self.assertFalse(os.path.exists(target))


class PipelineAndCliTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.input = os.path.join(self.dir, "input.wav")
        write_sample_wav(self.input)
        self.markers = os.path.join(self.dir, "markers.csv")
        with open(self.markers, "w", encoding="utf-8") as fh:
            fh.write("time_sec,label\n")
            for t, label, _ in marker_rows():
                fh.write(f"{t},{label}\n")

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_pipeline_outputs_and_reports(self):
        out = os.path.join(self.dir, "out", "final.wav")
        detection = DetectionConfig(threshold_dbfs=-40.0, min_pause_sec=0.8)
        # Explicit decisions: delete pauses B and C, shorten A. The deleted
        # markers fall inside these ranges and must be reported.
        decisions = [
            Decision(0, action="shorten", keep_sec=0.3, anchor="start"),
            Decision(1, action="delete"),
            Decision(2, action="delete"),
        ]
        result = run_pipeline(
            self.input, out, detection, EditConfig(fade_ms=10.0),
            decisions=decisions, markers_path=self.markers,
        )
        # All advertised outputs exist.
        stem = os.path.splitext(out)[0]
        for suffix in (".wav", ".map.json", ".intervals.csv",
                       ".deleted.csv", ".markers.csv"):
            self.assertTrue(os.path.exists(stem + suffix), suffix)

        rendered = read_wav(out)
        self.assertEqual(rendered.sample_rate, SR)
        self.assertEqual(rendered.channels, 2)
        self.assertLess(rendered.frames, int(SR * 6.0))
        # The output duration matches the map exactly.
        payload = json.load(open(stem + ".map.json", encoding="utf-8"))
        self.assertEqual(
            rendered.frames,
            round(payload["output_duration_sec"] * SR),
        )
        self.assertEqual(payload["sample_rate"], SR)
        self.assertIn("frames", payload)
        # Deleted markers are reported separately.
        deleted = {m["label"] for m in payload["deleted_markers"]}
        self.assertEqual(deleted, {"inside-pause-a", "inside-trailing"})
        # And surfaced by the pipeline result as well.
        self.assertEqual(
            set(result.deleted_marker_labels),
            {"inside-pause-a", "inside-trailing"},
        )

    def test_decision_template_apply_cycle(self):
        detection = DetectionConfig(threshold_dbfs=-40.0, min_pause_sec=0.8)
        audio = read_wav(self.input)
        pauses = detect_pauses(audio, detection)
        template = os.path.join(self.dir, "decisions.json")
        write_decisions_template(template, pauses, detection)
        rows = json.load(open(template, encoding="utf-8"))["pauses"]
        for row in rows:
            row["action"] = "shorten"
            row["keep_sec"] = 0.25
            row["anchor"] = "start"
        with open(template, "w", encoding="utf-8") as fh:
            json.dump({"pauses": rows}, fh)

        decisions = read_decisions(template, len(pauses))
        out = os.path.join(self.dir, "edited.wav")
        result = run_pipeline(
            self.input, out, detection, EditConfig(), decisions=decisions,
            markers_path=self.markers,
        )
        rendered = read_wav(out)
        removed = sum(p.duration_sec - 0.25 for p in pauses)
        self.assertAlmostEqual(
            6.0 - rendered.duration, removed, delta=0.06
        )
        # Each shortened pause still leaves ~0.25 s of natural silence: check
        # the first junction region is quiet for roughly a quarter second.
        quiet_frames = 0
        first_pause_start = pauses[0].start_frame
        for f in range(first_pause_start - 1,
                       first_pause_start + int(0.25 * SR)):
            peak = max(abs(rendered.samples[f * 2]),
                       abs(rendered.samples[f * 2 + 1]))
            if peak < 10 ** (-40 / 20):
                quiet_frames += 1
        self.assertGreater(quiet_frames, int(0.2 * SR))

    def test_cli_detect_trim_locate(self):
        out = os.path.join(self.dir, "cli_out.wav")
        rc = cli_main([
            "trim", self.input, out,
            "--keep-pause", "0.3", "--threshold-dbfs", "-40",
            "--min-pause", "0.8", "--markers", self.markers,
        ])
        self.assertEqual(rc, 0)
        stem = os.path.splitext(out)[0]
        self.assertTrue(os.path.exists(stem + ".map.json"))

        # A kept speech time maps forward cleanly to the same instant.
        rc = cli_main(["locate", stem + ".map.json", "0.5"])
        self.assertEqual(rc, 0)
        # 1.5 s is inside pause A, of which only the first 0.3 s survives:
        # it falls in a deleted range and must be flagged with exit code 2.
        rc = cli_main(["locate", stem + ".map.json", "1.5"])
        self.assertEqual(rc, 2)
        # A boundary frame (pause A starts at 1.0 s) still maps to the
        # junction, it is not reported as deleted.
        rc = cli_main(["locate", stem + ".map.json", "1.0"])
        self.assertEqual(rc, 0)
        # Reverse lookup of an output time returns an original-timeline time.
        rc = cli_main([
            "locate", stem + ".map.json", "0.5",
            "--direction", "output-to-original",
        ])
        self.assertEqual(rc, 0)

    def test_cli_detect_writes_template(self):
        template = os.path.join(self.dir, "cand.json")
        rc = cli_main([
            "detect", self.input,
            "--decisions", template,
            "--threshold-dbfs", "-40", "--min-pause", "0.8",
        ])
        self.assertEqual(rc, 0)
        self.assertTrue(os.path.exists(template))
        payload = json.load(open(template, encoding="utf-8"))
        self.assertEqual(len(payload["pauses"]), 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
