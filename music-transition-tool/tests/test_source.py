import unittest
from array import array
from types import SimpleNamespace

from support import TOOL_ROOT  # noqa: F401
from mtp.source import LoopSource
from mtp.wavio import WavData
from mtp.errors import MaterialMissingError


def make_source(values, loop=None):
    cfg = SimpleNamespace(
        id="x",
        has_loop=loop is not None,
        loop_start=loop[0] if loop else None,
        loop_end=loop[1] if loop else None,
    )
    wav = WavData(sample_rate=44100, channels=[array("d", values)])
    return LoopSource(cfg, wav)


class TestLoopSource(unittest.TestCase):
    def test_wrap_at_loop_end_exact_sequence(self):
        # WAV: [0,10, | 20,30,40 | 50,60]，循环区间 [2,5) = 20,30,40
        src = make_source([0, 10, 20, 30, 40, 50, 60], loop=(2, 5))
        out = src.read(start_frame=3, n_frames=10)[0]
        expected = [30, 40] + [20, 30, 40] * 2 + [20, 30]
        self.assertEqual(len(out), 10)
        self.assertEqual(list(out), [float(v) for v in expected])

    def test_cross_end_to_head_no_truncation_or_duplication(self):
        # 从循环最后一个采样开始读 8 个：40 | 20,30,40 | 20,30,40? 长度核对
        src = make_source([20, 30, 40], loop=(0, 3))
        out = src.read(start_frame=2, n_frames=8)[0]
        self.assertEqual(list(out), [40, 20, 30, 40, 20, 30, 40, 20])
        self.assertEqual(len(out), 8)

    def test_request_lengths_that_are_not_multiples_of_loop(self):
        src = make_source([1, 2, 3, 4], loop=(0, 4))
        for n in range(1, 40):
            out = src.read(start_frame=1, n_frames=n)[0]
            self.assertEqual(len(out), n)
            for i, v in enumerate(out):
                self.assertEqual(v, [2, 3, 4, 1][i % 4])

    def test_negative_start_wraps_to_loop_tail(self):
        # 居中淡变的预卷：entry=0，全局 enter 在 sync 之前 -> 负源坐标
        src = make_source([20, 30, 40], loop=(0, 3))
        out = src.read(start_frame=-1, n_frames=5)[0]
        self.assertEqual(list(out), [40, 20, 30, 40, 20])

    def test_start_exactly_at_loop_end_goes_to_head(self):
        src = make_source([20, 30, 40], loop=(0, 3))
        self.assertEqual(list(src.read(3, 3)[0]), [20, 30, 40])

    def test_stereo_reads_both_channels(self):
        cfg = SimpleNamespace(id="x", has_loop=True, loop_start=0, loop_end=2)
        wav = WavData(
            sample_rate=44100,
            channels=[array("d", [1, 2]), array("d", [10, 20])],
        )
        ls = LoopSource(cfg, wav)
        ch = ls.read(1, 5)
        self.assertEqual(list(ch[0]), [2, 1, 2, 1, 2])
        self.assertEqual(list(ch[1]), [20, 10, 20, 10, 20])

    def test_oneshot_missing_range_reports_transition(self):
        src = make_source([0.0] * 100, loop=None)
        with self.assertRaises(MaterialMissingError) as ctx:
            src.read(0, 500, transition_id="t_demo", cue_id="cue_long")
        err = ctx.exception
        self.assertEqual(err.transition_id, "t_demo")
        self.assertEqual(err.cue_id, "cue_long")
        self.assertEqual(err.requested_source_range, (0, 500))
        self.assertEqual(err.available_range, (0, 100))
        self.assertIn("t_demo", err.location_prefix())
        self.assertIn("t_demo", "%s%s" % (err.location_prefix(), err))

    def test_oneshot_negative_start_is_missing(self):
        src = make_source([0.0] * 100, loop=None)
        with self.assertRaises(MaterialMissingError):
            src.read(-2, 10, transition_id="t_neg")

    def test_zero_length_read(self):
        src = make_source([1, 2, 3], loop=(0, 3))
        self.assertEqual(src.read(0, 0)[0].__len__(), 0)


if __name__ == "__main__":
    unittest.main()
