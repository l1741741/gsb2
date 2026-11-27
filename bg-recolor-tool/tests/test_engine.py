import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bg_recolor import (CAT_CHANGED, CAT_DISCONNECTED_SIMILAR,
                        CAT_PROTECTED_SIMILAR)
from bg_recolor.accel import _evaluate_py, numpy_available
from bg_recolor.engine import (InvalidSampleError, analyze, compute_counts,
                              render_recolor)
from bg_recolor.pngcodec import ImageData

B = (200, 200, 200, 255)   # 背景
X = (20, 30, 40, 255)      # 产品深色


def grid_image(rows, mapping=None):
    """用字符网格构造 RGBA 图。'.' = 透明，默认 'B'/'X'。"""
    mapping = mapping or {"B": B, "X": X, ".": (0, 0, 0, 0)}
    h = len(rows)
    w = len(rows[0])
    img = ImageData(w, h)
    for y, row in enumerate(rows):
        assert len(row) == w
        for x, ch in enumerate(row):
            r, g, b, a = mapping[ch]
            i = (y * w + x) * 4
            img.rgba[i:i + 4] = bytes((r, g, b, a))
    return img


class TestWeights(unittest.TestCase):
    def test_exact_and_hard_boundary_rgb(self):
        # 像素与背景距离分别为 0 / 10 / 20 / 21
        img = ImageData(4, 1)
        vals = [(100, 100, 100), (110, 100, 100),
                (120, 100, 100), (121, 100, 100)]
        for i, (r, g, b) in enumerate(vals):
            img.rgba[i * 4:i * 4 + 4] = bytes((r, g, b, 255))
        a = analyze(img, params={"metric": "rgb", "tolerance": 20,
                                 "feather": 0, "connectivity": "off"},
                    background_color=(100, 100, 100))
        self.assertEqual(a["final_w"][0], 255)
        self.assertEqual(a["final_w"][1], 255)
        self.assertEqual(a["final_w"][2], 255)   # 硬边界 <=
        self.assertEqual(a["similar"][3], 0)
        self.assertEqual(a["final_w"][3], 0)

    def test_feather_midpoint(self):
        img = ImageData(1, 1)
        img.rgba[0:4] = bytes((115, 100, 100, 255))  # d=15
        a = analyze(img, params={"metric": "rgb", "tolerance": 20,
                                 "feather": 10, "connectivity": "off"},
                    background_color=(100, 100, 100))
        # inner=10；d=15 位于过渡中点 -> 约 128
        self.assertAlmostEqual(a["final_w"][0], 128, delta=1)

    def test_feather_inner_full_and_outer_zero_weight(self):
        img = ImageData(2, 1)
        img.rgba[0:4] = bytes((109, 100, 100, 255))  # d=9 <= inner 10
        img.rgba[4:8] = bytes((120, 100, 100, 255))  # d=20 == tolerance
        a = analyze(img, params={"metric": "rgb", "tolerance": 20,
                                 "feather": 10, "connectivity": "off"},
                    background_color=(100, 100, 100))
        self.assertEqual(a["final_w"][0], 255)
        self.assertEqual(a["final_w"][1], 0)
        self.assertEqual(a["similar"][1], 1)  # 外边界仍属于相似/连通掩码

    @unittest.skipUnless(numpy_available(), "需要 numpy 做双路径对照")
    def test_numpy_and_python_paths_agree(self):
        w = h = 24
        img = ImageData(w, h)
        for i in range(w * h):
            img.rgba[i * 4:i * 4 + 4] = bytes(
                ((i * 37) % 256, (i * 71) % 256, (i * 113) % 256,
                 (i * 53) % 256))
        kw = dict(bg=(120, 130, 140), metric="redmean",
                  tolerance=120.0, feather=40.0)
        wpy, spy = _evaluate_py(img.rgba, **kw)
        from bg_recolor.accel import _evaluate_np
        wnp, snp = _evaluate_np(img.rgba, **kw)
        self.assertEqual(bytes(spy), bytes(snp))
        diffs = [abs(a - b) for a, b in zip(wpy, wnp)]
        self.assertLessEqual(max(diffs), 1)


class TestTransparencyAndStats(unittest.TestCase):
    def test_fully_transparent_never_changes_and_excluded(self):
        img = ImageData(2, 2)
        # 3 个不透明背景像素 + 1 个 alpha=0 的脏颜色像素
        for i in range(3):
            img.rgba[i * 4:i * 4 + 4] = bytes((200, 200, 200, 255))
        img.rgba[12:16] = bytes((255, 0, 255, 0))
        a = analyze(img, params={"tolerance": 10, "connectivity": "off"},
                    background_color=(200, 200, 200))
        out = render_recolor(img, a, target_color="#123456")
        self.assertEqual(tuple(out.rgba[12:16]), (255, 0, 255, 0))
        counts = compute_counts(img, out, a)
        self.assertEqual(counts["fully_transparent_pixels"], 1)
        self.assertEqual(counts["visible_pixels"], 3)
        self.assertEqual(counts["changed_transparent_violations"], 0)
        self.assertEqual(counts["changed_pixels_exact"], 3)
        # 外观均值只统计 3 个可见像素
        self.assertEqual(counts["mean_rgb_visible_before"], [200.0, 200.0, 200.0])

    def test_semitransparent_classified_and_alpha_preserved(self):
        img = ImageData(2, 1)
        img.rgba[0:4] = bytes((0, 0, 0, 128))      # 半透明
        img.rgba[4:8] = bytes((200, 200, 200, 255))
        a = analyze(img, params={"metric": "rgb", "tolerance": 250,
                                 "feather": 0, "connectivity": "off"},
                    background_color=(255, 255, 255))
        out = render_recolor(img, a, target_color=(10, 20, 30))
        counts = compute_counts(img, out, a)
        self.assertEqual(counts["semitransparent_pixels"], 1)
        self.assertGreaterEqual(counts["affected_semitransparent_pixels"], 1)
        # alpha 通道保持不变
        self.assertEqual(out.rgba[3], 128)
        self.assertEqual(out.rgba[7], 255)


class TestProtection(unittest.TestCase):
    def test_protection_never_invaded_by_extreme_params(self):
        rows = ["BBBBB", "BXXXB", "BXBXB", "BXXXB", "BBBBB"]
        img = grid_image(rows)
        # 极大容差 + 全过渡 + 全局模式，保护中心 B 像素所在的整个中心格
        a = analyze(img, params={"metric": "rgb", "tolerance": 500,
                                 "feather": 499, "connectivity": "off"},
                    background_color=B[:3],
                    protect_regions=[{"type": "rect", "xyxy": [2, 2, 3, 3]}])
        self.assertEqual(a["category"][2 * 5 + 2], CAT_PROTECTED_SIMILAR)
        self.assertEqual(a["final_w"][2 * 5 + 2], 0)
        out = render_recolor(img, a, target_color="#FF0000")
        self.assertEqual(tuple(out.rgba[(2 * 5 + 2) * 4:(2 * 5 + 2) * 4 + 4]), B)
        # 保护区域外的背景确实被改了
        self.assertNotEqual(tuple(out.rgba[0:4]), B)

    def test_protection_rect_xywh_and_polygon(self):
        img = grid_image(["BBBB", "BBBB", "BBBB", "BBBB"])
        a = analyze(img, params={"connectivity": "off", "tolerance": 5},
                    background_color=B[:3],
                    protect_regions=[{"type": "rect", "xywh": [1, 1, 2, 2]}])
        self.assertEqual(sum(a["protect_mask"]), 4)
        a2 = analyze(img, params={"connectivity": "off", "tolerance": 5},
                     background_color=B[:3],
                     protect_regions=[{"type": "polygon",
                                       "points": [[0, 0], [2, 0], [0, 2]]}])
        # 直角三角形面积约 2~3 像素
        self.assertGreaterEqual(sum(a2["protect_mask"]), 2)


class TestConnectivity(unittest.TestCase):
    def test_edge_vs_global_on_enclosed_block(self):
        rows = ["BBBBB", "BXXXB", "BXBXB", "BXXXB", "BBBBB"]
        img = grid_image(rows)
        center = 2 * 5 + 2
        edge = analyze(img, params={"metric": "rgb", "tolerance": 5,
                                    "connectivity": "edge"},
                       background_color=B[:3])
        self.assertEqual(edge["category"][center], CAT_DISCONNECTED_SIMILAR)
        self.assertEqual(edge["final_w"][center], 0)
        self.assertGreater(len(edge["disconnected_components"]), 0)

        glob = analyze(img, params={"metric": "rgb", "tolerance": 5,
                                    "connectivity": "off"},
                       background_color=B[:3])
        self.assertEqual(glob["category"][center], CAT_CHANGED)

    def test_seed_mode_selects_only_seed_component(self):
        rows = ["BBBBB", "BXXXB", "BXBXB", "BXXXB", "BBBBB"]
        img = grid_image(rows)
        center = 2 * 5 + 2
        a = analyze(img, params={"metric": "rgb", "tolerance": 5,
                                 "connectivity": "seeds"},
                    background_color=B[:3], seed_points=[[2, 2]])
        self.assertEqual(a["category"][center], CAT_CHANGED)
        # 角点属于外部大背景，不含种子 -> 不被选中
        self.assertEqual(a["final_w"][0], 0)

    def test_diagonal_contact_4_vs_8(self):
        # B(1,1) 是内部像素，仅通过对角与触边的 B(0,0) 相接
        img = grid_image(["BXX", "XBX", "XXX"])
        idx = 1 * 3 + 1
        a4 = analyze(img, params={"metric": "rgb", "tolerance": 5,
                                  "connectivity": "edge", "neighborhood": 4,
                                  "sample_radius": 0},
                     sample_points=[[0, 0]])
        self.assertEqual(a4["category"][idx], CAT_DISCONNECTED_SIMILAR)
        a8 = analyze(img, params={"metric": "rgb", "tolerance": 5,
                                  "connectivity": "edge", "neighborhood": 8,
                                  "sample_radius": 0},
                     sample_points=[[0, 0]])
        self.assertEqual(a8["category"][idx], CAT_CHANGED)

    def test_invalid_sample_points(self):
        img = grid_image(["BB", "BB"])
        with self.assertRaises(InvalidSampleError):
            analyze(img, sample_points=[[99, 0]],
                    params={"tolerance": 5, "sample_radius": 0})
        hole = grid_image(["B.", ".B"])
        with self.assertRaises(InvalidSampleError):
            analyze(hole, sample_points=[[1, 0]],
                    params={"sample_radius": 0, "tolerance": 5})

    def test_sample_median_robust_to_edge_intrusion(self):
        # 3x3 背景，中心取色点邻域里混入一个产品色，中位数仍应得到背景色
        img = ImageData(3, 3)
        for i in range(9):
            img.rgba[i * 4:i * 4 + 4] = bytes((210, 210, 210, 255))
        img.rgba[4 * 4:4 * 4 + 4] = X
        a = analyze(img, sample_points=[[1, 1]],
                    params={"sample_radius": 1, "tolerance": 5})
        self.assertEqual(a["background"], [210, 210, 210])


if __name__ == "__main__":
    unittest.main()
