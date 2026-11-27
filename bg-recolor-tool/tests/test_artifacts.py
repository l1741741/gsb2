import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bg_recolor.artifacts import annotate_labels, build_change_map
from bg_recolor.engine import analyze
from bg_recolor.mini_font import GLYPHS, text_width
from bg_recolor.pngcodec import ImageData
from bg_recolor.synthetic import GEOM, generate_scene


class TestArtifacts(unittest.TestCase):
    def test_all_legend_glyphs_available(self):
        # 变化图图例 / 对比图标题用到的每个字符都要有字形
        texts = ["CHANGED", "PROTECTED-SIMILAR", "ISOLATED-SIMILAR",
                 "SAMPLE-POINT", "PROTECT-ZONE",
                 "BEFORE / LIGHT", "AFTER / DARK"]
        for t in texts:
            for ch in t:
                self.assertIn(ch, GLYPHS, "缺少字形 %r（%s）" % (ch, t))
        self.assertGreater(text_width("ABC", 2), 0)

    def test_annotate_labels_returns_true(self):
        img = ImageData(120, 40)
        before = bytes(img.rgba)
        ok = annotate_labels(img, [("ABC-123", 4, 4, (255, 255, 255))])
        self.assertTrue(ok)
        self.assertNotEqual(bytes(img.rgba), before)

    def test_change_map_has_extended_legend_area(self):
        img = generate_scene(0)
        a = analyze(img, params={"tolerance": 90, "feather": 36},
                    sample_points=GEOM["sample_points"],
                    protect_regions=[{"type": "rect",
                                      "xyxy": GEOM["protect_q_xyxy"]}])
        cmap = build_change_map(img, a)
        self.assertEqual(cmap.width, img.width)
        self.assertGreater(cmap.height, img.height + 80)


if __name__ == "__main__":
    unittest.main()
