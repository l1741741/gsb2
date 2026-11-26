import unittest
import wave
from array import array
from pathlib import Path
import tempfile

from support import TOOL_ROOT  # noqa: F401
from mtp.wavio import write_wav_int16, read_wav, quantize_int16


class TestWavIo(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def test_int16_unity_roundtrip_bit_exact(self):
        # 选一批 int16 采样；float = v/32768 是 2 的幂缩放，必须逐值往返
        vals = [0, 1, -1, 2, -2, 16000, -16000, 32767, -32768, 12345, -23456]
        ch = array("d", (v / 32768.0 for v in vals))
        p = self.dir / "a.wav"
        write_wav_int16(str(p), [ch, ch], 44100, out_gain=1.0)
        w = read_wav(str(p))
        self.assertEqual(w.sample_rate, 44100)
        self.assertEqual(w.n_channels, 2)
        for c in range(2):
            back = [int(round(x * 32768.0)) for x in w.channels[c]]
            self.assertEqual(back, vals)

    def test_stereo_channels_are_distinct(self):
        L = array("d", [0.25, -0.5, 0.75, -1.0])
        R = array("d", [-0.25, 0.5, -0.75, 1.0 - 1 / 32768])
        p = self.dir / "st.wav"
        write_wav_int16(str(p), [L, R], 48000)
        w = read_wav(str(p))
        self.assertNotEqual(list(w.channels[0]), list(w.channels[1]))
        self.assertEqual([round(x * 4) for x in w.channels[0]], [1, -2, 3, -4])

    def test_clipping_is_counted_and_clamped(self):
        ch = [array("d", [0.0, 0.9, -1.4, 2.0])]
        ints, peak, clipped = quantize_int16(ch, out_gain=1.0)
        self.assertGreater(peak, 1.0)
        self.assertEqual(clipped, 2)  # -1.4 和 2.0 两帧
        self.assertEqual(ints[0][2], -32768)
        self.assertEqual(ints[0][3], 32767)

    def test_read_24bit_stereo(self):
        # 手工构造 3 个立体声帧的 24-bit PCM：L=8388607/0/-8388608, R 反之样例
        vals = [8388607, -8388608, 0, 0, -8388608, 8388607]
        raw = b""
        for v in vals:
            raw += int(v).to_bytes(3, "little", signed=True)
        p = str(self.dir / "w24.wav")
        wf = wave.open(p, "wb")
        wf.setnchannels(2)
        wf.setsampwidth(3)
        wf.setframerate(44100)
        wf.writeframes(raw)
        wf.close()

        w = read_wav(p)
        self.assertEqual(w.n_channels, 2)
        self.assertEqual(w.n_frames, 3)
        # 反交错后 L=[max,0,min], R=[min,0,max]
        self.assertAlmostEqual(w.channels[0][0], 8388607 / 8388608.0, places=6)
        self.assertEqual(w.channels[0][1], 0.0)
        self.assertAlmostEqual(w.channels[0][2], -1.0, places=6)
        self.assertAlmostEqual(w.channels[1][0], -1.0, places=6)
        self.assertEqual(w.channels[1][1], 0.0)
        self.assertAlmostEqual(w.channels[1][2], 8388607 / 8388608.0, places=6)

    def test_read_8bit_unsigned_mono(self):
        raw = bytes([128, 255, 0])  # 0, +满幅近似, -满幅
        p = str(self.dir / "w8.wav")
        wf = wave.open(p, "wb")
        wf.setnchannels(1)
        wf.setsampwidth(1)
        wf.setframerate(22050)
        wf.writeframes(raw)
        wf.close()

        w = read_wav(p)
        self.assertEqual(w.n_frames, 3)
        self.assertAlmostEqual(w.channels[0][0], 0.0, places=6)
        self.assertGreater(w.channels[0][1], 0.99)
        self.assertLess(w.channels[0][2], -0.99)


if __name__ == "__main__":
    unittest.main()
