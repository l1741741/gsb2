import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bg_recolor.pngcodec import ImageData, read_png, write_png
from bg_recolor.pipeline import run_batch


def make_basic_png(path, w=12, h=10):
    img = ImageData(w, h)
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            if 3 <= x <= 8 and 2 <= y <= 7:
                img.rgba[i:i + 4] = bytes((30, 90, 100, 255))
            else:
                img.rgba[i:i + 4] = bytes((210, 208, 200, 255))
    # 一个全透明脏像素
    img.rgba[0:4] = bytes((255, 0, 255, 0))
    write_png(path, img)
    return img


class PipelineTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="bgtool-test-")
        self.img_path = os.path.join(self.tmp, "prod.png")
        make_basic_png(self.img_path)
        self.out = os.path.join(self.tmp, "out")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cfg(self, images, **top):
        cfg = {"output_dir": self.out,
               "defaults": {"tolerance": 40, "feather": 12,
                            "connectivity": "edge"},
               "images": images}
        cfg.update(top)
        cfg["_config_dir"] = self.tmp
        return run_batch(config_dict=cfg)


class TestBatchHappyPath(PipelineTestBase):
    def test_all_artifacts_written_and_valid(self):
        batch = self.run_cfg([{
            "id": "prod", "path": self.img_path,
            "sample_points": [[11, 9]],
            "target_color": "#3366CC",
        }])
        self.assertEqual(batch["summary"]["error"], 0, batch["items"])
        item = batch["items"][0]
        for key in ("new_png", "change_map", "preview_light",
                    "preview_dark", "compare_sheet", "item_report"):
            p = os.path.join(self.out, item["outputs"][key])
            self.assertTrue(os.path.isfile(p), key)
            self.assertGreater(os.path.getsize(p), 40)
        # 所有 PNG 产物都能被回读
        for key in ("new_png", "change_map", "preview_light",
                    "preview_dark", "compare_sheet"):
            read_png(os.path.join(self.out, item["outputs"][key]))
        for name in ("report.json", "report.md", "report.html"):
            self.assertTrue(os.path.isfile(os.path.join(self.out, name)))
        with open(os.path.join(self.out, "report.json"), encoding="utf-8") as f:
            reloaded = json.load(f)
        self.assertEqual(reloaded["summary"]["ok"], 1)
        # 逐图 JSON 与批次 JSON 都带图像产物哈希且一致
        with open(os.path.join(self.out, item["outputs"]["item_report"]),
                  encoding="utf-8") as f:
            item_json = json.load(f)
        self.assertIn("output_sha256", item_json)
        self.assertEqual(item_json["output_sha256"]["new_png"],
                         item["output_sha256"]["new_png"])
        # 深浅底预览在有透明像素时应当不同
        lp = os.path.join(self.out, item["outputs"]["preview_light"])
        dp = os.path.join(self.out, item["outputs"]["preview_dark"])
        self.assertNotEqual(open(lp, "rb").read(), open(dp, "rb").read())

    def test_no_temp_files_left(self):
        self.run_cfg([{"id": "prod", "path": self.img_path,
                       "sample_points": [[11, 9]]}])
        leftovers = []
        for root, _dirs, files in os.walk(self.out):
            leftovers += [f for f in files if f.startswith(".tmp-")]
        self.assertEqual(leftovers, [])


class TestIsolationAndNoOverwrite(PipelineTestBase):
    def test_corrupt_image_isolated(self):
        bad = os.path.join(self.tmp, "broken.png")
        with open(bad, "wb") as f:
            f.write(b"not a png" * 20)
        batch = self.run_cfg([
            {"id": "good", "path": self.img_path, "sample_points": [[11, 9]]},
            {"id": "bad", "path": bad, "sample_points": [[1, 1]]},
        ])
        self.assertEqual(batch["summary"]["ok"], 1)
        self.assertEqual(batch["summary"]["error"], 1)
        bad_item = [i for i in batch["items"] if i["id"] == "bad"][0]
        self.assertEqual(bad_item["error"]["reason_code"], "unreadable_image")
        self.assertTrue(os.path.isfile(
            os.path.join(self.out, bad_item["error_record"])))
        self.assertTrue(os.path.isfile(
            os.path.join(self.out, bad_item["quarantined_source"])))
        # 合法图产物不受影响
        self.assertTrue(os.path.isfile(
            os.path.join(self.out, "processed", "good.new.png")))

    def test_invalid_sample_isolated(self):
        batch = self.run_cfg([
            {"id": "oob", "path": self.img_path,
             "sample_points": [[-5, 999]]},
        ])
        self.assertEqual(batch["summary"]["error"], 1)
        self.assertEqual(batch["items"][0]["error"]["reason_code"],
                         "invalid_sample_point")
        self.assertFalse(os.path.exists(
            os.path.join(self.out, "processed", "oob.new.png")))

    def test_good_result_not_overwritten_by_later_bad_run(self):
        good_path = os.path.join(self.out, "processed", "sameid.new.png")
        # 第一次：合法运行
        b1 = self.run_cfg([{"id": "sameid", "path": self.img_path,
                            "sample_points": [[11, 9]],
                            "target_color": "#123456"}])
        self.assertEqual(b1["summary"]["ok"], 1)
        good_bytes = open(good_path, "rb").read()
        self.assertGreater(len(good_bytes), 40)

        # 第二次：同 id，但取色点越界 -> 必须失败且不得覆写已有合法 PNG
        b2 = self.run_cfg([{"id": "sameid", "path": self.img_path,
                            "sample_points": [[7777, 1]]}])
        self.assertEqual(b2["summary"]["error"], 1)
        self.assertTrue(os.path.isfile(good_path))
        self.assertEqual(open(good_path, "rb").read(), good_bytes)
        # 旧文件仍是合法 PNG
        read_png(good_path)

    def test_missing_file_isolated(self):
        batch = self.run_cfg([{"id": "missing",
                               "path": os.path.join(self.tmp, "nope.png"),
                               "sample_points": [[1, 1]]}])
        self.assertEqual(batch["items"][0]["error"]["reason_code"],
                         "file_not_found")


if __name__ == "__main__":
    unittest.main()
