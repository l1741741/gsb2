import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bg_recolor.pngcodec import (ImageData, PngError, decode_png_bytes,
                                encode_png)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class TestCodecRoundtrip(unittest.TestCase):
    def test_rgba_roundtrip(self):
        img = ImageData(3, 2)
        # 覆盖各种 alpha / 颜色
        px = [
            255, 0, 0, 255,   0, 255, 0, 128,   0, 0, 255, 0,
            10, 20, 30, 64,   200, 201, 202, 255, 1, 2, 3, 4,
        ]
        img.rgba[:] = bytearray(px)
        data = encode_png(img)
        self.assertTrue(data[:8] == b"\x89PNG\r\n\x1a\n")
        back = decode_png_bytes(data)
        self.assertEqual((back.width, back.height), (3, 2))
        self.assertEqual(bytes(back.rgba), bytes(img.rgba))

    def test_corrupt_bytes_rejected(self):
        for bad in (b"", b"not a png" * 10,
                    b"\x89PNG\r\n\x1a\n" + b"\x00" * 40):
            with self.assertRaises(PngError):
                decode_png_bytes(bad)

    def test_truncated_idat_rejected_or_error(self):
        img = ImageData(4, 4, bytearray([10] * 64))
        data = encode_png(img)
        # 砍掉结尾一大段（含 IEND / IDAT 尾部）
        with self.assertRaises(Exception):
            decode_png_bytes(data[: len(data) // 2])

    def test_encoded_png_opens_in_pillow_if_available(self):
        try:
            from PIL import Image
        except Exception:
            self.skipTest("Pillow 未安装")
        import io
        img = ImageData(5, 3)
        for i in range(15):
            img.rgba[i * 4:i * 4 + 4] = bytes(
                [(i * 17) % 256, 100, 200, 255 if i % 2 else 128])
        pil = Image.open(io.BytesIO(encode_png(img)))
        pil.load()
        self.assertEqual(pil.size, (5, 3))
        self.assertEqual(pil.mode, "RGBA")

    def test_read_pillow_variants_if_available(self):
        try:
            from PIL import Image
            import io
        except Exception:
            self.skipTest("Pillow 未安装")
        # 让 Pillow 生成 RGB / P / L / LA 等变体，验证我们的解码器
        rgba = Image.new("RGBA", (4, 3))
        rgba.putdata([(255, 0, 0, 255), (0, 255, 0, 255),
                      (0, 0, 255, 100), (10, 20, 30, 0)] * 3)
        cases = {
            "RGB": rgba.convert("RGB"),
            "L": rgba.convert("L"),
            "RGBA": rgba,
            "P": rgba.convert("P", palette=Image.ADAPTIVE),
        }
        for mode, pim in cases.items():
            buf = io.BytesIO()
            pim.save(buf, format="PNG")
            decoded = decode_png_bytes(buf.getvalue())
            self.assertEqual((decoded.width, decoded.height), (4, 3), mode)
            # 抽样：第一个像素红色在 RGB/RGBA 下应保持
            if mode in ("RGB", "RGBA"):
                self.assertEqual(
                    (decoded.rgba[0], decoded.rgba[1]), (255, 0), mode)

    def test_generated_scene_file_decodable(self):
        scene = os.path.join(ROOT, "examples", "synthetic_scene.png")
        if not os.path.exists(scene):
            self.skipTest("尚未生成 examples/synthetic_scene.png")
        from bg_recolor.pngcodec import read_png
        img = read_png(scene)
        self.assertEqual((img.width, img.height), (480, 360))


if __name__ == "__main__":
    unittest.main()
