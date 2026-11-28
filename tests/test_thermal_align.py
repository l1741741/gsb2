"""thermal_align 单元测试与场景测试。

运行方式（仓库根目录）::

    python3 tests/run_tests.py

测试覆盖：

1. 点表解析、坐标约定与错误提示；
2. 仿射拟合真值恢复、点数不足/共线/坏控制点诊断；
3. 最近邻重采样保原值、哨兵与有效零值区分、无重叠报错；
4. 热值范围调整只改预览、不改对齐 16 位图；
5. 合成样例 normal / no-overlap / bad-point 三场景端到端行为。
"""

from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np
from PIL import Image

from thermal_align import colormap, geometry, imaging, overlay, samplegen, warp
from thermal_align.cli import main as cli_main
from thermal_align.geometry import RegistrationError, fit_affine
from thermal_align.points import (
    Correspondence,
    PointTableError,
    load_points,
    save_points,
    split_points,
)
from thermal_align.warp import WarpError, warp_thermal


def _affine_correspondences(matrix, translation, vis_points, use_all_fit=True):
    """按给定真值仿射制造无噪声对应点。"""
    points = []
    for idx, vis in enumerate(vis_points):
        vis = np.asarray(vis, dtype=np.float64)
        ir = matrix @ vis + translation
        points.append(
            Correspondence(
                label=f"P{idx}",
                vis=(float(vis[0]), float(vis[1])),
                ir=(float(ir[0]), float(ir[1])),
                use="fit",
            )
        )
    return points


def _square_points():
    # 12 个散开的网格点。仿射有 6 个参数，坏点隔离需要足够冗余：
    # 点太少时单点偏差会被最小二乘摊薄到所有点上，无法可靠识别。
    return [
        (float(x), float(y))
        for y in (20, 70, 120, 170)
        for x in (10, 60, 110)
    ]


class PointTableTests(unittest.TestCase):
    def test_roundtrip_and_holdout_split(self):
        points = [
            Correspondence("A", (1.5, 2.0), (3.0, 4.25), "fit"),
            Correspondence("B", (10, 10), (20, 20), "holdout"),
        ]
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "points.csv"
            save_points(path, points)
            loaded = load_points(path)
        self.assertEqual(len(loaded), 2)
        self.assertEqual(loaded[0].label, "A")
        self.assertAlmostEqual(loaded[0].vis[0], 1.5)
        self.assertAlmostEqual(loaded[1].ir[1], 20.0)
        fit, holdout = split_points(loaded)
        self.assertEqual([p.label for p in fit], ["A"])
        self.assertEqual([p.label for p in holdout], ["B"])

    def test_comment_and_tsv_and_default_use(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "p.tsv"
            path.write_text(
                "# 注释行\nlabel\tvis_x\tvis_y\tir_x\tir_y\n"
                "A\t1\t2\t3\t4\nB\t5\t6\t7\t8\t0\n",
                encoding="utf-8",
            )
            loaded = load_points(path)
        self.assertEqual(loaded[0].use, "fit")
        self.assertEqual(loaded[1].use, "holdout")

    def test_missing_column_and_bad_number(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.csv"
            path.write_text("A,1,2,3\n", encoding="utf-8")
            with self.assertRaises(PointTableError):
                load_points(path)
            path.write_text("A,1,x,3,4\n", encoding="utf-8")
            with self.assertRaises(PointTableError):
                load_points(path)
            path.write_text("# only comment\n", encoding="utf-8")
            with self.assertRaises(PointTableError):
                load_points(path)

    def test_duplicate_label_rejected(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "dup.csv"
            path.write_text(
                "A,1,2,3,4\nA,5,6,7,8\n", encoding="utf-8"
            )
            with self.assertRaises(PointTableError):
                load_points(path)


class GeometryTests(unittest.TestCase):
    def setUp(self):
        angle = np.deg2rad(20.0)
        self.matrix = 0.5 * np.array(
            [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]
        ) @ np.array([[1.0, 0.04], [-0.03, 1.0]])
        self.translation = np.array([15.0, 8.0])

    def test_recovers_ground_truth_transform(self):
        points = _affine_correspondences(
            self.matrix, self.translation, _square_points()
        )
        model = fit_affine(points)
        np.testing.assert_allclose(model.matrix, self.matrix, atol=1e-9)
        np.testing.assert_allclose(model.translation, self.translation, atol=1e-9)
        np.testing.assert_allclose(model.residuals, 0.0, atol=1e-8)
        # 正逆映射互为反函数（两种调用形式都验证）
        xy = np.array([[12.0, 34.0], [56.0, 78.0]])
        np.testing.assert_allclose(model.apply_inverse(model.apply(xy)), xy, atol=1e-8)
        # 显式按定义 vis = M^{-1}(ir - t) 复核，防止两端共用同一错误公式
        inv = np.linalg.inv(model.matrix)
        np.testing.assert_allclose(
            model.apply_inverse(xy),
            (xy - model.translation) @ inv.T,
            atol=1e-10,
        )

    def test_too_few_points(self):
        points = _affine_correspondences(
            self.matrix, self.translation, _square_points()[:2]
        )
        with self.assertRaisesRegex(RegistrationError, "至少需要 3"):
            fit_affine(points)

    def test_collinear_points_rejected(self):
        vis = [(0.0, 0.0), (10.0, 10.0), (20.0, 20.0), (30.0, 30.0)]
        points = _affine_correspondences(self.matrix, self.translation, vis)
        with self.assertRaisesRegex(RegistrationError, "共线"):
            fit_affine(points)

    def test_coincident_points_rejected(self):
        vis = [(0.0, 0.0), (0.0, 0.0), (10.0, 0.0), (0.0, 10.0)]
        points = _affine_correspondences(self.matrix, self.translation, vis)
        with self.assertRaisesRegex(RegistrationError, "重合"):
            fit_affine(points)

    def test_bad_control_point_detected_and_droppable(self):
        points = _affine_correspondences(
            self.matrix, self.translation, _square_points()
        )
        # 拧偏一个点的红外坐标 30 px
        bad = points[2]
        points[2] = Correspondence(
            bad.label, bad.vis, (bad.ir[0] + 30.0, bad.ir[1]), bad.use
        )
        with self.assertRaisesRegex(RegistrationError, "疑似误点"):
            fit_affine(points)
        model = fit_affine(points, drop_outliers=True)
        self.assertEqual(model.dropped, ["P2"])
        np.testing.assert_allclose(model.matrix, self.matrix, atol=1e-7)
        np.testing.assert_allclose(model.translation, self.translation, atol=1e-7)

    def test_holdout_independent_error(self):
        points = _affine_correspondences(
            self.matrix, self.translation, _square_points()
        )
        holdout = Correspondence(
            "H1", (77.0, 88.0),
            tuple(self.matrix @ np.array([77.0, 88.0]) + self.translation),
            "holdout",
        )
        points.append(holdout)
        model = fit_affine(points)
        errors = geometry.holdout_errors(model, points)
        self.assertEqual(len(errors), 1)
        self.assertAlmostEqual(errors[0][1], 0.0, places=8)

    def test_mirror_warning(self):
        # 行列式为负（镜像）应给出警告而非静默
        matrix = np.array([[-1.0, 0.0], [0.0, 1.0]])
        points = _affine_correspondences(matrix, np.array([5.0, 5.0]),
                                         _square_points())
        model = fit_affine(points)
        report = geometry.build_report(model)
        self.assertTrue(any("镜像" in w for w in report.warnings))


class ImagingAndWarpTests(unittest.TestCase):
    def test_16bit_roundtrip_preserves_values(self):
        rng = np.random.default_rng(42)
        thermal = rng.integers(0, 65535, size=(40, 50), dtype=np.uint16)
        thermal[0, 0] = 0
        thermal[0, 1] = 65535
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.png"
            imaging.save_thermal_uint16(path, thermal)
            with Image.open(path) as im:
                self.assertIn(im.mode, ("I;16", "I"))
            loaded = imaging.load_thermal(path)
        np.testing.assert_array_equal(loaded, thermal)

    def test_visible_rgb_roundtrip(self):
        rgb = np.zeros((30, 40, 3), dtype=np.uint8)
        rgb[..., 0] = 200
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "v.png"
            imaging.save_rgb(path, rgb)
            loaded = imaging.load_visible(path)
        np.testing.assert_array_equal(loaded, rgb)

    def test_warp_nearest_neighbor_preserves_raw_values(self):
        # 恒等变换：对齐图有效区必须与源热图逐像素相等
        thermal = np.arange(100, dtype=np.uint16).reshape(10, 10) + 1
        thermal[0, 0] = 0  # 真实零值
        model = geometry.AffineModel(
            matrix=np.eye(2),
            translation=np.zeros(2),
            condition_number=1.0,
            residuals=np.zeros(4),
            labels=["a", "b", "c", "d"],
        )
        result = warp_thermal(thermal, model, (10, 10))
        np.testing.assert_array_equal(result.aligned[result.mask], thermal[result.mask])
        self.assertTrue(result.mask.all())
        self.assertEqual(warp.count_effective_zeros(result), 1)
        self.assertEqual(warp.count_outside(result), 0)

    def test_sentinel_distinguishes_outside_from_real_zero(self):
        # 热图整体偏移，使画布右下方无覆盖；背景含真实零值
        thermal = np.zeros((8, 8), dtype=np.uint16)
        thermal[2:6, 2:6] = 3000
        model = geometry.AffineModel(
            matrix=np.eye(2),
            translation=np.array([4.0, 3.0]),  # ir = vis + (4,3)
            condition_number=1.0,
            residuals=np.zeros(4),
            labels=["a", "b", "c", "d"],
        )
        result = warp_thermal(thermal, model, (10, 10))
        self.assertFalse(result.mask.all())
        # 范围外全部是哨兵
        self.assertTrue((result.aligned[~result.mask] == result.sentinel).all())
        # 有效区内允许出现真实零值，且与哨兵不同
        self.assertGreater(warp.count_effective_zeros(result), 0)
        self.assertNotEqual(int(result.sentinel), 0)
        # 掩模是区分二者的唯一权威：哨兵像素必在掩模外
        self.assertTrue((~result.mask[result.aligned == result.sentinel]).all())

    def test_sentinel_collision_auto_selects_another(self):
        thermal = np.full((4, 4), 65535, dtype=np.uint16)
        sentinel = warp.choose_sentinel(thermal)
        self.assertNotEqual(int(sentinel), 65535)
        with self.assertRaises(WarpError):
            warp.choose_sentinel(thermal, requested=65535)

    def test_no_overlap_raises(self):
        thermal = np.full((6, 6), 1000, dtype=np.uint16)
        model = geometry.AffineModel(
            matrix=np.eye(2),
            translation=np.array([100.0, 100.0]),
            condition_number=1.0,
            residuals=np.zeros(3),
            labels=["a", "b", "c"],
        )
        with self.assertRaisesRegex(WarpError, "无重叠"):
            warp_thermal(thermal, model, (8, 8))

    def test_rotated_warp_values_are_source_values(self):
        # 旋转 90 度整数变换，输出值集合必须是源值集合的子集（无插值造数）
        angle = np.pi / 2
        matrix = np.array(
            [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]
        )
        thermal = (np.arange(64, dtype=np.uint16).reshape(8, 8) + 1) * 100
        model = geometry.AffineModel(
            matrix=matrix,
            translation=np.array([7.0, 0.0]),
            condition_number=1.0,
            residuals=np.zeros(3),
            labels=["a", "b", "c"],
        )
        result = warp_thermal(thermal, model, (8, 8))
        source_set = set(np.unique(thermal).tolist())
        aligned_values = set(np.unique(result.aligned[result.mask]).tolist())
        self.assertTrue(aligned_values.issubset(source_set))

    def test_translated_warp_lands_at_correct_pixels(self):
        # ir = vis + (4,3)：源图 (r,c) 的值应出现在对齐图 (r+3, c+4)
        thermal = np.zeros((8, 8), dtype=np.uint16)
        thermal[2, 1] = 4242
        model = geometry.AffineModel(
            matrix=np.eye(2),
            translation=np.array([4.0, 3.0]),
            condition_number=1.0,
            residuals=np.zeros(3),
            labels=["a", "b", "c"],
        )
        result = warp_thermal(thermal, model, (10, 10))
        # 有效区起点应为 (y=3, x=4)
        ys, xs = np.where(result.mask)
        self.assertEqual((ys.min(), xs.min()), (3, 4))
        self.assertEqual(int(result.aligned[5, 5]), 4242)
        # 平移前的原位置在新画布上属于范围外
        self.assertFalse(result.mask[2, 1])

    def test_identity_inverse_roundtrip_with_translation(self):
        # 带平移的仿射，逆映射必须精确回到原坐标
        matrix = np.array([[1.1, 0.05], [-0.04, 0.9]])
        translation = np.array([13.7, -8.2])
        model = geometry.AffineModel(
            matrix=matrix, translation=translation,
            condition_number=2.0, residuals=np.zeros(3),
            labels=["a", "b", "c"],
        )
        xy = np.array([[0.0, 0.0], [100.0, 50.0], [-20.0, 33.3]])
        np.testing.assert_allclose(model.apply_inverse(model.apply(xy)), xy, atol=1e-9)
        # 原点的红外坐标 ir=t，反算必须回到 vis=(0,0)
        np.testing.assert_allclose(
            model.apply_inverse(translation.reshape(1, 2)),
            [[0.0, 0.0]], atol=1e-9,
        )

    def test_partial_coverage_mask_and_sentinel_partition(self):
        # 红外视场只覆盖画布一部分：掩模内外必须构成完整且互斥的划分
        thermal = np.full((6, 6), 1000, dtype=np.uint16)
        model = geometry.AffineModel(
            matrix=np.eye(2), translation=np.array([2.0, 2.0]),
            condition_number=1.0, residuals=np.zeros(3),
            labels=["a", "b", "c"],
        )
        result = warp_thermal(thermal, model, (10, 10))
        self.assertEqual(
            int(result.mask.sum()) + int((~result.mask).sum()), 100
        )
        # 有效区是源值，范围外全是哨兵
        self.assertTrue((result.aligned[result.mask] == 1000).all())
        self.assertTrue((result.aligned[~result.mask] == result.sentinel).all())

    def test_auto_sentinel_when_65535_present(self):
        # 热图真实包含 65535 时，自动哨兵必须换成别的值且不与任何真值冲突
        thermal = np.full((4, 4), 65535, dtype=np.uint16)
        thermal[0, 0] = 65534
        result = warp_thermal(
            thermal,
            geometry.AffineModel(
                matrix=np.eye(2), translation=np.zeros(2),
                condition_number=1.0, residuals=np.zeros(3),
                labels=["a", "b", "c"],
            ),
            (4, 4),
        )
        self.assertNotIn(int(result.sentinel), {65535, 65534})
        # 全覆盖时不应有误标的范围外像素
        self.assertTrue(result.mask.all())

    def test_color_image_rejected_as_thermal(self):
        rgb = np.zeros((4, 4, 3), dtype=np.uint8)
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "rgb.png"
            imaging.save_rgb(path, rgb)
            with self.assertRaises(imaging.ImageLoadError):
                imaging.load_thermal(path)

    def test_32bit_out_of_range_rejected(self):
        # 32 位整数图含超过 uint16 的值时必须报错，不能静默截断。
        # PNG 不支持 32 位模式 I，用 TIFF 构造等价输入。
        arr32 = np.full((3, 3), 70000, dtype=np.int32)
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "wide.tif"
            Image.fromarray(arr32, mode="I").save(path, format="TIFF")
            with self.assertRaises(imaging.ImageLoadError):
                imaging.load_thermal(path)
            # 落在 16 位范围内的 32 位图应正常提升
            ok_path = Path(tmp) / "ok.tif"
            Image.fromarray(np.full((3, 3), 12345, dtype=np.int32), mode="I").save(
                ok_path, format="TIFF"
            )
            loaded = imaging.load_thermal(ok_path)
            np.testing.assert_array_equal(loaded, np.full((3, 3), 12345, np.uint16))

    def test_overlay_size_mismatch_rejected(self):
        thermal = np.ones((6, 6), dtype=np.uint16) * 100
        model = geometry.AffineModel(
            matrix=np.eye(2), translation=np.zeros(2),
            condition_number=1.0, residuals=np.zeros(3),
            labels=["a", "b", "c"],
        )
        result = warp_thermal(thermal, model, (6, 6))
        wrong_visible = np.zeros((8, 8, 3), dtype=np.uint8)
        with self.assertRaises(ValueError):
            overlay.blend_overlay(wrong_visible, result)


class DisplayIsolationTests(unittest.TestCase):
    def setUp(self):
        thermal = np.arange(100, dtype=np.uint16).reshape(10, 10)
        model = geometry.AffineModel(
            matrix=np.eye(2), translation=np.zeros(2),
            condition_number=1.0, residuals=np.zeros(3),
            labels=["a", "b", "c"],
        )
        self.result = warp_thermal(thermal, model, (10, 10))
        self.visible = np.full((10, 10, 3), 128, dtype=np.uint8)
        self.snapshot = self.result.aligned.copy()

    def test_range_changes_preview_not_aligned(self):
        preview_a = overlay.blend_overlay(
            self.visible, self.result, vmin=0, vmax=99
        )
        preview_b = overlay.blend_overlay(
            self.visible, self.result, vmin=40, vmax=60
        )
        self.assertFalse(np.array_equal(preview_a, preview_b))
        # 对齐热值逐位不变
        np.testing.assert_array_equal(self.result.aligned, self.snapshot)

    def test_invalid_range_rejected(self):
        with self.assertRaises(ValueError):
            overlay.blend_overlay(self.visible, self.result, vmin=50, vmax=50)
        with self.assertRaises(ValueError):
            overlay.blend_overlay(self.visible, self.result, vmin=80, vmax=20)

    def test_colorize_does_not_mutate_input(self):
        before = self.result.aligned.copy()
        colormap.colorize(self.result.aligned, self.result.mask, vmin=10, vmax=90)
        np.testing.assert_array_equal(self.result.aligned, before)

    def test_alpha_bounds(self):
        with self.assertRaises(ValueError):
            overlay.blend_overlay(self.visible, self.result, alpha=1.5)


class SampleScenarioTests(unittest.TestCase):
    def test_normal_scenario_end_to_end_and_holdout(self):
        with TemporaryDirectory() as tmp:
            spec = samplegen.generate_sample(tmp, "normal")
            buf_out, buf_err = io.StringIO(), io.StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                code = cli_main([
                    "align",
                    "--visible", str(spec.visible_png),
                    "--thermal", str(spec.thermal_png),
                    "--points", str(spec.points_csv),
                    "--out-dir", str(Path(tmp) / "out"),
                    "--name", "normal",
                ])
            self.assertEqual(code, 0, buf_err.getvalue())
            log = buf_out.getvalue()
            self.assertIn("holdout", log)
            out = Path(tmp) / "out"
            meta = json.loads((out / "normal_meta.json").read_text(encoding="utf-8"))
            # 拟合应逼近真值
            np.testing.assert_allclose(
                np.array(meta["transform_vis_to_ir"]["matrix"]),
                spec.ground_truth_matrix, atol=1e-6,
            )
            # holdout 独立偏差应在亚像素量级
            worst = max(h["error_px"] for h in meta["holdout"])
            self.assertLess(worst, 1.0)
            # 输出齐全且 16 位图值未被调色板污染
            aligned = imaging.load_thermal(out / "normal_aligned_uint16.png")
            self.assertEqual(aligned.dtype, np.uint16)
            with Image.open(out / "normal_coverage_mask.png") as im:
                mask = np.array(im.convert("L"), dtype=np.uint8) > 127
            self.assertEqual(mask.shape, aligned.shape)
            self.assertTrue((aligned[mask] != 65535).all())
            self.assertTrue((aligned[~mask] == meta["coverage"]["sentinel_value"]).all())

    def test_no_overlap_scenario_fails_loudly(self):
        with TemporaryDirectory() as tmp:
            spec = samplegen.generate_sample(tmp, "no-overlap")
            buf_err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(buf_err):
                code = cli_main([
                    "align",
                    "--visible", str(spec.visible_png),
                    "--thermal", str(spec.thermal_png),
                    "--points", str(spec.points_csv),
                    "--out-dir", str(Path(tmp) / "out"),
                ])
            self.assertNotEqual(code, 0)
            self.assertIn("无重叠", buf_err.getvalue())
            # 失败时不得产出对齐文件
            self.assertFalse((Path(tmp) / "out").exists())

    def test_bad_point_scenario_blocks_then_recovers(self):
        with TemporaryDirectory() as tmp:
            spec = samplegen.generate_sample(tmp, "bad-point")
            # 默认：坏点导致失败，不产出
            buf_err = io.StringIO()
            with redirect_stdout(io.StringIO()), redirect_stderr(buf_err):
                code = cli_main([
                    "align",
                    "--visible", str(spec.visible_png),
                    "--thermal", str(spec.thermal_png),
                    "--points", str(spec.points_csv),
                    "--out-dir", str(Path(tmp) / "out_blocked"),
                ])
            self.assertEqual(code, 3)
            self.assertIn("疑似误点", buf_err.getvalue())
            self.assertFalse((Path(tmp) / "out_blocked").exists())

            # 显式 --drop-outliers：剔除坏点后恢复，holdout 仍应准确
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = cli_main([
                    "align",
                    "--visible", str(spec.visible_png),
                    "--thermal", str(spec.thermal_png),
                    "--points", str(spec.points_csv),
                    "--out-dir", str(Path(tmp) / "out"),
                    "--name", "recovered",
                    "--drop-outliers",
                ])
            self.assertEqual(code, 0)
            meta = json.loads(
                (Path(tmp) / "out" / "recovered_meta.json").read_text(encoding="utf-8")
            )
            self.assertIn("C01", meta["fit"]["dropped"])
            worst = max(h["error_px"] for h in meta["holdout"])
            self.assertLess(worst, 1.0)

    def test_preview_command_never_touches_aligned(self):
        with TemporaryDirectory() as tmp:
            spec = samplegen.generate_sample(tmp, "normal")
            out = Path(tmp) / "out"
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(0, cli_main([
                    "align", "--visible", str(spec.visible_png),
                    "--thermal", str(spec.thermal_png),
                    "--points", str(spec.points_csv),
                    "--out-dir", str(out), "--name", "p",
                ]))
            aligned_path = out / "p_aligned_uint16.png"
            before = aligned_path.read_bytes()
            preview_out = out / "p_preview_custom.png"
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = cli_main([
                    "preview",
                    "--aligned", str(aligned_path),
                    "--points", str(spec.points_csv),
                    "--mask", str(out / "p_coverage_mask.png"),
                    "--visible", str(spec.visible_png),
                    "--output", str(preview_out),
                    "--vmin", "3000", "--vmax", "3500",
                ])
            self.assertEqual(code, 0)
            self.assertTrue(preview_out.exists())
            self.assertEqual(before, aligned_path.read_bytes())

    def test_preview_uses_meta_sentinel_without_mask(self):
        # 当哨兵不是默认 65535 时，preview 无掩模必须靠 meta.json 还原真实哨兵
        with TemporaryDirectory() as tmp:
            spec = samplegen.generate_sample(tmp, "normal")
            out = Path(tmp) / "out"
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(0, cli_main([
                    "align", "--visible", str(spec.visible_png),
                    "--thermal", str(spec.thermal_png),
                    "--points", str(spec.points_csv),
                    "--out-dir", str(out), "--name", "p",
                    "--sentinel", "60000",
                ]))
            meta = json.loads((out / "p_meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["coverage"]["sentinel_value"], 60000)
            expected_coverage = meta["coverage"]["ratio"]

            # 用 --meta 推断掩模：覆盖率应与 align 时一致
            preview_meta = out / "prev_meta.png"
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                code = cli_main([
                    "preview",
                    "--aligned", str(out / "p_aligned_uint16.png"),
                    "--meta", str(out / "p_meta.json"),
                    "--output", str(preview_meta),
                ])
            self.assertEqual(code, 0)
            aligned = imaging.load_thermal(out / "p_aligned_uint16.png")
            inferred_mask = aligned != np.uint16(60000)
            self.assertAlmostEqual(inferred_mask.mean(), expected_coverage, places=6)

            # 反例：不给 meta 也不给哨兵，按默认 65535 推断会得到错误的全覆盖
            wrong_mask = aligned != np.uint16(65535)
            self.assertTrue(wrong_mask.all())
            self.assertNotAlmostEqual(
                wrong_mask.mean(), expected_coverage, places=3
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
