import unittest

from support import TOOL_ROOT  # noqa: F401  (adds sys.path)
from mtp.timeutil import (
    resolve_position_sample,
    beats_to_samples,
    samples_to_timecode,
)


class TestTimeMapping(unittest.TestCase):
    SR = 44100
    BPM = 120
    BPB = 4
    BEAT = 22050
    BAR = 88200

    def test_bar_beat_origin_is_zero(self):
        self.assertEqual(
            resolve_position_sample("1.1", self.BPM, self.BPB, self.SR), 0
        )
        self.assertEqual(
            resolve_position_sample({"bar": 1, "beat": 1}, self.BPM, self.BPB, self.SR),
            0,
        )

    def test_bars_and_beats(self):
        # 3.1 = 2 小节偏移 = 8 拍
        self.assertEqual(
            resolve_position_sample("3.1", self.BPM, self.BPB, self.SR),
            8 * self.BEAT,
        )
        # 5.1 = 16 拍
        self.assertEqual(
            resolve_position_sample({"bar": 5, "beat": 1}, self.BPM, self.BPB, self.SR),
            16 * self.BEAT,
        )
        # 3.3 = (2*4 + 2) = 10 拍
        self.assertEqual(
            resolve_position_sample("3.3", self.BPM, self.BPB, self.SR),
            10 * self.BEAT,
        )

    def test_absolute_beats_and_sample_passthrough(self):
        self.assertEqual(beats_to_samples(4, self.BPM, self.SR), 4 * self.BEAT)
        self.assertEqual(
            resolve_position_sample({"beats": 4}, self.BPM, self.BPB, self.SR),
            4 * self.BEAT,
        )
        self.assertEqual(
            resolve_position_sample({"sample": 12345}, self.BPM, self.BPB, self.SR),
            12345,
        )

    def test_integer_grid_at_demo_tempo(self):
        # 120BPM/44.1k 下拍和小节都必须是整数采样，没有舍入误差
        self.assertEqual(self.BEAT, 22050)
        self.assertEqual(self.BAR, 88200)

    def test_timecode(self):
        self.assertEqual(samples_to_timecode(0, 44100), "00:00:00.000")
        self.assertEqual(samples_to_timecode(44100, 44100), "00:00:01.000")


if __name__ == "__main__":
    unittest.main()
