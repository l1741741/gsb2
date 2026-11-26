import unittest
import wave
from pathlib import Path

from support import TOOL_ROOT, DemoProjectMixin  # noqa: F401
from mtp.render import render_full, render_transition_preview, render_interval
from mtp.timeline import build_timeline
from mtp.wavio import write_wav_int16, read_wav
from mtp.analyze import verify_landings
from mtp.errors import MaterialMissingError


class TestCueFullIdentity(unittest.TestCase, DemoProjectMixin):
    @classmethod
    def setUpClass(cls):
        cls.setup_demo()

    @classmethod
    def tearDownClass(cls):
        cls.teardown_demo()

    def test_float_cue_equals_full_interval_for_every_transition(self):
        full = render_full(self.tl, self.registry)
        self.assertEqual(full.n_frames, self.tl.total_samples)
        for tr in self.tl.transitions:
            cue = render_interval(
                self.tl, self.registry, tr.preview_start, tr.preview_end
            )
            self.assertEqual(
                cue.n_frames, tr.preview_end - tr.preview_start, tr.id
            )
            for c in range(self.tl.output_channels):
                seg = full.channels[c][tr.preview_start:tr.preview_end]
                self.assertEqual(len(seg), len(cue.channels[c]))
                # 必须逐 float 相同，而不只是近似
                self.assertTrue(
                    all(a == b for a, b in zip(seg, cue.channels[c])),
                    "float mismatch on %s ch%d" % (tr.id, c),
                )

    def test_wav_bytes_cue_equals_full_slice(self):
        full_p = self.tmp / "full.wav"
        write_wav_int16(
            str(full_p),
            render_full(self.tl, self.registry).channels,
            self.tl.sample_rate,
            self.tl.output_gain,
        )
        full_w = wave.open(str(full_p), "rb")
        raw = full_w.readframes(full_w.getnframes())
        nch, width = full_w.getnchannels(), full_w.getsampwidth()
        full_w.close()

        for tr in self.tl.transitions:
            cue, _ = render_transition_preview(self.tl, self.registry, tr.id)
            cue_p = self.tmp / ("%s.wav" % tr.id)
            write_wav_int16(
                str(cue_p), cue.channels, self.tl.sample_rate, self.tl.output_gain
            )
            cw = wave.open(str(cue_p), "rb")
            cue_raw = cw.readframes(cw.getnframes())
            cw.close()
            a = tr.preview_start * nch * width
            b = tr.preview_end * nch * width
            self.assertEqual(cue_raw, raw[a:b], "WAV bytes mismatch " + tr.id)


class TestChannelPreservation(unittest.TestCase, DemoProjectMixin):
    @classmethod
    def setUpClass(cls):
        cls.setup_demo()

    @classmethod
    def tearDownClass(cls):
        cls.teardown_demo()

    def test_stereo_sources_have_distinct_lr_and_survive(self):
        garden = self.registry.get("garden").wav
        self.assertEqual(garden.n_channels, 2)
        self.assertNotEqual(list(garden.channels[0]), list(garden.channels[1]))

        full = render_full(self.tl, self.registry)
        # garden 开头 1000 帧处于纯 garden、单位包络区间（plan gain 只在量化时加）
        for i in range(0, 1000):
            self.assertEqual(full.channels[0][i], garden.channels[0][i])
            self.assertEqual(full.channels[1][i], garden.channels[1][i])

    def test_mono_source_is_identical_on_both_output_channels(self):
        # harbor 在 cut 之后、它自己的淡出开始之前有一段纯 mono 区间
        tr_cut = self.tl.transition_by_id("t_market_to_harbor")
        tr_next = self.tl.transition_by_id("t_harbor_to_garden")
        g0 = tr_cut.sync_sample + 100
        g1 = tr_next.enter_sample - 100
        block = render_interval(self.tl, self.registry, g0, g1)
        self.assertGreater(block.n_frames, 0)
        for i in range(block.n_frames):
            self.assertEqual(block.channels[0][i], block.channels[1][i])

    def test_unity_cut_region_is_bit_exact_against_source_wav(self):
        # 用 gain=1 的小计划验证 int16 逐采样保留左右声道
        plan = {
            "sample_rate": 44100, "bpm": 120, "beats_per_bar": 4,
            "output": {"channels": 2, "gain": 1.0},
            "end": "3.1",
            "program": [
                {"id": "g", "asset": "garden", "at": "1.1"},
                {"id": "m", "asset": "market", "at": "2.1",
                 "transition": {"id": "cut1", "mode": "cut"}},
            ],
        }
        tl = build_timeline(plan, self.registry)
        out = render_full(tl, self.registry)
        garden = self.registry.get("garden").wav
        p = self.tmp / "unity.wav"
        write_wav_int16(str(p), out.channels, 44100, 1.0)
        back = read_wav(str(p))
        # 开头是 garden 单位增益、单声部区间；两次 int16 量化之间无任何运算误差
        for i in range(0, 4096):
            self.assertEqual(back.channels[0][i], garden.channels[0][i])
            self.assertEqual(back.channels[1][i], garden.channels[1][i])


class TestBeatLandingAfterMultipleTransitions(unittest.TestCase, DemoProjectMixin):
    @classmethod
    def setUpClass(cls):
        cls.setup_demo()

    @classmethod
    def tearDownClass(cls):
        cls.teardown_demo()

    def test_all_downbeats_land_on_predicted_samples(self):
        block = render_full(self.tl, self.registry)
        results = verify_landings(
            self.tl, self.registry, block.channels,
            global_start_sample=block.global_start_sample,
        )
        self.assertEqual(len(results), 3)
        for r in results:
            self.assertEqual(
                r["offset_samples"], 0,
                "%s landed at %s (corr=%s)"
                % (r["transition_id"], r["detected_sample"], r["correlation"]),
            )
            self.assertTrue(r["passed"], r)
            # 主峰必须明显高于无关次峰，检测不是蒙的
            self.assertGreater(r["peak_margin"], 0.1)

    def test_detector_catches_a_misconfigured_entry_point(self):
        # 故意把 market 入场点从标记所在的 0 改成 100：
        # 标记实际落点应比 sync 早 100 采样，检测必须抓到 -100。
        self.registry.configs["market"].entry_sample = 100
        try:
            from mtp.timeline import build_timeline
            tl = build_timeline(self.plan_doc, self.registry)
            block = render_full(tl, self.registry)
            results = verify_landings(
                tl, self.registry, block.channels, only_id="t_garden_to_market"
            )
            r = results[0]
            self.assertEqual(r["offset_samples"], -100)
            self.assertFalse(r["passed"])
        finally:
            self.registry.configs["market"].entry_sample = 0

    def test_source_beat_markers_are_on_configured_grid(self):
        # 合成器声明的拍点必须与 WAV 中实际拍点一致（这里核对长度/网格不变量）
        for aid in ("garden", "market", "harbor"):
            cfg = self.registry.configs[aid]
            wav = self.registry.get(aid).wav
            self.assertLessEqual(cfg.loop_end, wav.n_frames)
            for b in cfg.beats:
                self.assertEqual(b % 22050, 0)


class TestMissingAttribution(unittest.TestCase, DemoProjectMixin):
    @classmethod
    def setUpClass(cls):
        cls.setup_demo()

    @classmethod
    def tearDownClass(cls):
        cls.teardown_demo()

    def _plan(self, transition):
        return {
            "sample_rate": 44100, "bpm": 120, "beats_per_bar": 4,
            "output": {"channels": 2},
            "end": "6.1",
            "program": [
                {"id": "g", "asset": "garden", "at": "1.1"},
                {"id": "s", "asset": "sting", "at": "3.1",
                 "transition": transition},
                {"id": "m", "asset": "market", "at": "5.1",
                 "transition": {"id": "t_after", "mode": "cut"}},
            ],
        }

    def test_too_short_oneshot_blames_next_transition(self):
        plan = self._plan({"id": "t_enter_sting", "mode": "cut"})
        tl = build_timeline(plan, self.registry)
        with self.assertRaises(MaterialMissingError) as ctx:
            render_full(tl, self.registry)
        # sting 要从 3.1 响到 5.1，素材只有 1 拍 -> 归属它响不到的下一条转场
        self.assertEqual(ctx.exception.transition_id, "t_after")

    def test_negative_preroll_blames_entrance_transition(self):
        # anchor=end、2 拍淡变：enter=P-2拍，而 sting entry=0 且无循环，
        # 入场预卷需要负源采样 -> 应归入场转场 t_enter_sting
        plan = self._plan({
            "id": "t_enter_sting", "mode": "crossfade",
            "duration_beats": 2, "anchor": "end",
        })
        tl = build_timeline(plan, self.registry)
        with self.assertRaises(MaterialMissingError) as ctx:
            render_full(tl, self.registry)
        self.assertEqual(ctx.exception.transition_id, "t_enter_sting")


if __name__ == "__main__":
    unittest.main()
