import unittest
from types import SimpleNamespace

from support import TOOL_ROOT  # noqa: F401
from mtp.timeline import build_timeline
from mtp.errors import PlanError

BEAT = 22050
BAR = 88200


class FakeRegistry:
    """只提供 timeline 构建需要的 configs/样本率；不真正读 WAV。"""

    def __init__(self, assets):
        self.configs = {
            aid: SimpleNamespace(entry_sample=0) for aid in assets
        }

    def sample_rate(self):
        return 44100

    def get(self, aid, transition_id=None, cue_id=None):
        return SimpleNamespace()


def base_plan(transitions):
    program = [
        {"id": "c0", "asset": "a", "at": "1.1"},
    ]
    for i, tr in enumerate(transitions, start=1):
        program.append({
            "id": "c%d" % i, "asset": "b" if i % 2 else "a",
            "at": {"bar": 1 + 2 * i, "beat": 1},
            "transition": tr,
        })
    return {
        "sample_rate": 44100, "bpm": 120, "beats_per_bar": 4,
        "end": {"bar": 12, "beat": 1},
        "preview": {"pre_roll_beats": 1, "post_roll_beats": 1},
        "program": program,
    }


class TestTimeline(unittest.TestCase):
    def test_cut_has_zero_overlap(self):
        plan = base_plan([{"id": "t_cut", "mode": "cut"}])
        tl = build_timeline(plan, FakeRegistry(["a", "b"]))
        tr = tl.transitions[0]
        P = 2 * BAR + 0  # c1 at bar 3 -> (3-1)*BAR
        self.assertEqual(tr.sync_sample, 2 * BAR)
        self.assertEqual(tr.enter_sample, P)
        self.assertEqual(tr.exit_sample, P)
        self.assertEqual(tr.overlap_samples, 0)
        # 旧声部在 P 退出，新声部在 P 进入
        self.assertEqual(tl.voices[0].exit_global, P)
        self.assertEqual(tl.voices[1].enter_global, P)
        self.assertIsNone(tl.voices[1].fade_in)

    def test_crossfade_center_anchor(self):
        plan = base_plan([{
            "id": "t_cf", "mode": "crossfade",
            "duration_beats": 1, "anchor": "center",
        }])
        tl = build_timeline(plan, FakeRegistry(["a", "b"]))
        tr = tl.transitions[0]
        P = 2 * BAR
        D = BEAT
        self.assertEqual(tr.duration_samples, D)
        self.assertEqual(tr.enter_sample, P - D // 2)
        self.assertEqual(tr.exit_sample, tr.enter_sample + D)
        self.assertEqual(tr.pre_samples, D // 2)
        self.assertEqual(tr.post_samples, D - D // 2)
        self.assertEqual(tr.overlap_samples, D)

    def test_crossfade_start_and_end_anchors(self):
        p_start = base_plan([{"id": "t_s", "mode": "crossfade",
                              "duration_beats": 2, "anchor": "start"}])
        tr_s = build_timeline(p_start, FakeRegistry(["a", "b"])).transitions[0]
        self.assertEqual(tr_s.enter_sample, tr_s.sync_sample)
        self.assertEqual(tr_s.exit_sample, tr_s.sync_sample + 2 * BEAT)

        p_end = base_plan([{"id": "t_e", "mode": "crossfade",
                            "duration_beats": 2, "anchor": "end"}])
        tr_e = build_timeline(p_end, FakeRegistry(["a", "b"])).transitions[0]
        self.assertEqual(tr_e.exit_sample, tr_e.sync_sample)
        self.assertEqual(tr_e.enter_sample, tr_e.sync_sample - 2 * BEAT)

    def test_preview_region_contains_transition(self):
        plan = base_plan([{"id": "t", "mode": "crossfade",
                          "duration_beats": 1, "anchor": "center"}])
        tl = build_timeline(plan, FakeRegistry(["a", "b"]))
        tr = tl.transitions[0]
        self.assertLessEqual(tr.preview_start, tr.enter_sample)
        self.assertGreaterEqual(tr.preview_end, tr.exit_sample)
        # pre/post roll 各 1 拍 = 22050
        self.assertEqual(tr.preview_pre_roll, BEAT)
        self.assertEqual(tr.preview_post_roll, BEAT)

    def test_cut_with_duration_is_rejected(self):
        plan = base_plan([{"id": "t_bad", "mode": "cut", "duration_beats": 1}])
        with self.assertRaises(PlanError) as ctx:
            build_timeline(plan, FakeRegistry(["a", "b"]))
        self.assertEqual(ctx.exception.transition_id, "t_bad")

    def test_non_increasing_positions_rejected(self):
        plan = {
            "sample_rate": 44100, "bpm": 120, "beats_per_bar": 4,
            "end": "9.1",
            "program": [
                {"id": "c0", "asset": "a", "at": "3.1"},
                {"id": "c1", "asset": "b", "at": "3.1",
                 "transition": {"id": "t", "mode": "cut"}},
            ],
        }
        with self.assertRaises(PlanError):
            build_timeline(plan, FakeRegistry(["a", "b"]))

    def test_unknown_asset_raises_with_transition_context(self):
        plan = {
            "sample_rate": 44100, "bpm": 120, "beats_per_bar": 4,
            "end": "5.1",
            "program": [
                {"id": "c0", "asset": "a", "at": "1.1"},
                {"id": "c1", "asset": "ghost", "at": "3.1",
                 "transition": {"id": "t_ghost", "mode": "cut"}},
            ],
        }

        class Reg:
            def __init__(self):
                self.configs = {"a": SimpleNamespace(entry_sample=0)}

            def sample_rate(self):
                return 44100

            def get(self, aid, transition_id=None, cue_id=None):
                from mtp.errors import PlanError as PE
                if aid == "ghost":
                    raise PE("未配置", transition_id=transition_id, cue_id=cue_id)
                return SimpleNamespace()

        with self.assertRaises(PlanError) as ctx:
            build_timeline(plan, Reg())
        self.assertEqual(ctx.exception.transition_id, "t_ghost")


if __name__ == "__main__":
    unittest.main()
