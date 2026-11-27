"""时间码与统一舍入测试。"""

import unittest
from decimal import Decimal

from srt_remap.errors import RemapError
from srt_remap.timecode import (
    format_srt_timestamp,
    parse_seconds,
    parse_srt_timestamp,
    to_millis,
)


class TestRounding(unittest.TestCase):
    def test_exact_integers_stay_exact(self):
        # 精确毫秒整数不得被推高（回归：曾因 int(x+0.5) 整体偏 1ms）
        for s, expected in [
            ("0", 0), ("1", 1000), ("5", 5000),
            ("0.001", 1), ("0.25", 250), ("12.345", 12345),
        ]:
            with self.subTest(s=s):
                self.assertEqual(to_millis(Decimal(s)), expected)

    def test_half_up_rule(self):
        # 统一 HALF_UP：0.5ms 进位，0.499ms 舍去
        self.assertEqual(to_millis(Decimal("0.0005")), 1)
        self.assertEqual(to_millis(Decimal("0.000499")), 0)
        self.assertEqual(to_millis(Decimal("1.0015")), 1002)
        self.assertEqual(to_millis(Decimal("1.001499")), 1001)

    def test_negative_not_allowed(self):
        with self.assertRaises(RemapError):
            parse_seconds("-1", field="t")

    def test_rejects_bad_and_empty(self):
        for bad in ("", "  ", "abc", float("inf"), float("nan")):
            with self.subTest(bad=bad):
                with self.assertRaises(RemapError):
                    parse_seconds(bad, field="t")

    def test_bool_rejected(self):
        with self.assertRaises(RemapError):
            parse_seconds(True, field="t")

    def test_float_via_str_is_stable(self):
        self.assertEqual(parse_seconds(0.1, field="t"), Decimal("0.1"))


class TestTimestamp(unittest.TestCase):
    def test_roundtrip(self):
        for ms in (0, 1, 999, 3_600_000, 36_615_999):
            text = format_srt_timestamp(ms)
            self.assertEqual(parse_srt_timestamp(text), ms)

    def test_accepts_comma_and_dot(self):
        self.assertEqual(parse_srt_timestamp("00:00:01,500"), 1500)
        self.assertEqual(parse_srt_timestamp("00:00:01.5"), 1500)

    def test_bad_format(self):
        for bad in ("00:01", "00:60:00,000", "00:00:60,000",
                    "aa:bb:cc,ddd", "00:00:01,xx"):
            with self.subTest(bad=bad):
                with self.assertRaises(RemapError):
                    parse_srt_timestamp(bad)


if __name__ == "__main__":
    unittest.main()
