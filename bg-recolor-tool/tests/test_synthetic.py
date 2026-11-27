import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bg_recolor import CAT_CHANGED, CAT_DISCONNECTED_SIMILAR
from bg_recolor.cli import main as cli_main
from bg_recolor.engine import analyze
from bg_recolor.pngcodec import read_png
from bg_recolor.synthetic import GEOM, generate_all, generate_scene


class TestSyntheticGeometry(unittest.TestCase):
    def setUp(self):
        self.img = generate_scene(0)

    def test_discriminator_pixels_exist_as_designed(self):
        img = self.img
        bg = (238, 236, 228, 255)

        def center(box):
            return ((box[0] + box[2]) // 2, (box[1] + box[3]) // 2)

        for key in ("block_p_xyxy", "block_q_xyxy", "block_r_xyxy"):
            x, y = center(GEOM[key])
            self.assertEqual(img.pixel(x, y), bg, key)
        cx = GEOM["corridor_x"][0] + 5
        self.assertEqual(img.pixel(cx, GEOM["corridor_y"]), bg)
        hx, hy, _ = GEOM["transparent_hole"]
        self.assertEqual(img.pixel(hx, hy)[3], 0)
        # 阴影里确实存在真 alpha 像素
        alphas = set()
        for y in range(290, 322):
            for x in range(120, 370):
                alphas.add(img.pixel(x, y)[3])
        self.assertTrue(any(0 < a < 255 for a in alphas))

    def test_scene_classification(self):
        a = analyze(self.img,
                     params={"tolerance": 90, "feather": 36,
                             "connectivity": "edge", "neighborhood": 4},
                     sample_points=GEOM["sample_points"],
                     protect_regions=[{"type": "rect",
                                       "xyxy": GEOM["protect_q_xyxy"]}])

        def cat_at(box):
            x = (box[0] + box[2]) // 2
            y = (box[1] + box[3]) // 2
            return a["category"][y * self.img.width + x]

        self.assertEqual(cat_at(GEOM["block_p_xyxy"]), CAT_DISCONNECTED_SIMILAR)
        self.assertNotEqual(cat_at(GEOM["block_q_xyxy"]), CAT_CHANGED)
        self.assertEqual(cat_at(GEOM["block_r_xyxy"]), CAT_CHANGED)
        cy = GEOM["corridor_y"]
        cx = GEOM["corridor_x"][0] + 8
        self.assertEqual(a["category"][cy * self.img.width + cx], CAT_CHANGED)
        self.assertGreaterEqual(sum(a["protect_mask"]), 1)


class TestFixturesAndCli(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bgtool-fixture-")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_generate_all_and_clean_batch_cli(self):
        ex = os.path.join(self.tmp, "examples")
        paths = generate_all(ex)
        self.assertTrue(any(p.endswith("synthetic_scene.png") for p in paths))
        rc = cli_main(["batch", os.path.join(ex, "config.example.json")])
        self.assertEqual(rc, 0)
        out = os.path.join(ex, "out-example")
        self.assertTrue(os.path.isfile(os.path.join(out, "report.html")))
        batch = json.load(open(os.path.join(out, "report.json"), encoding="utf-8"))
        self.assertEqual(batch["summary"]["total"], 2)
        self.assertEqual(batch["summary"]["error"], 0)

    def test_failure_batch_exit_code_two_and_quarantine(self):
        ex = os.path.join(self.tmp, "examples")
        generate_all(ex)
        rc = cli_main(["batch", os.path.join(ex, "batch", "batch_config.json"),
                       "--out", os.path.join(self.tmp, "custom-out")])
        self.assertEqual(rc, 2)
        batch = json.load(open(os.path.join(self.tmp, "custom-out", "report.json"),
                               encoding="utf-8"))
        self.assertEqual(batch["summary"]["ok"], 2)
        self.assertEqual(batch["summary"]["error"], 3)
        codes = {i["id"]: i["error"]["reason_code"] for i in batch["items"]
                 if i["status"] == "error"}
        self.assertEqual(codes["corrupt_file"], "unreadable_image")
        self.assertEqual(codes["bad_sample_oob"], "invalid_sample_point")
        self.assertIn(codes["bad_sample_transparent"],
                      ("invalid_sample_transparent", "invalid_sample_point"))

    def test_process_single_image_cli(self):
        ex = os.path.join(self.tmp, "ex")
        generate_all(ex)
        img = os.path.join(ex, "synthetic_scene.png")
        out = os.path.join(self.tmp, "single-out")
        rc = cli_main(["process", img, "--sample", "18,18",
                       "--protect-rect", "258,114,346,188",
                       "--connectivity", "edge",
                       "--tolerance", "90", "--feather", "36",
                       "--target", "#2F6FDB", "--out", out,
                       "--id", "one"])
        self.assertEqual(rc, 0)
        new_png = os.path.join(out, "processed", "one.new.png")
        self.assertTrue(os.path.isfile(new_png))
        read_png(new_png)


if __name__ == "__main__":
    unittest.main()
