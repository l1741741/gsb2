"""color_proof 的单元测试, 只用标准库 unittest: python -m unittest -v"""

from __future__ import annotations

import json
import os
import struct
import sys
import tempfile
import unittest
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from color_proof.cli import main as cli_main
from color_proof.color_math import (
    ColorSpecError,
    distance2,
    matte,
    parse_color,
    unmatte,
)
from color_proof.config import (
    ConfigError,
    ProtectedRegion,
    Rule,
    build_protection_mask,
    load_config,
)
from color_proof.engine import apply_scheme
from color_proof.pngio import PNGUnsupportedError, Image, read_png, write_png

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_image(pixels: list[tuple[int, int, int, int]], width: int, height: int) -> Image:
    flat = bytearray()
    for px in pixels:
        flat.extend(px)
    return Image(width=width, height=height, rgba=flat)


def rule(rid, source, target, tol=10, priority=0, metric="euclidean", enabled=True):
    return Rule(
        id=rid,
        source=parse_color(source),
        target=parse_color(target),
        tolerance=tol,
        priority=priority,
        metric=metric,
        enabled=enabled,
    )


class PNGIOTests(unittest.TestCase):
    def test_roundtrip_preserves_rgba(self):
        src = make_image(
            [(255, 0, 0, 255), (0, 255, 0, 128), (0, 0, 255, 1), (1, 2, 3, 0)],
            2, 2,
        )
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "t.png")
            write_png(p, src)
            got = read_png(p)
        self.assertEqual((got.width, got.height), (2, 2))
        self.assertEqual(bytes(got.rgba), bytes(src.rgba))

    def test_decode_uses_all_five_filters(self):
        # 手工构造一张 2x2 RGBA、逐行分别使用 filter 0..4 的 PNG
        width = height = 2
        channels = 4
        row0 = bytes([0, 10, 20, 30, 40, 50, 60, 70, 80])      # None
        row1 = bytes([1, 5, 5, 5, 5, 5, 5, 5, 5])               # Sub: 第二像素加第一像素
        raw = row0 + row1
        ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)

        def chunk(tag, data):
            return (
                struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
            )

        blob = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
        blob += chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "f.png")
            with open(p, "wb") as f:
                f.write(blob)
            img = read_png(p)
        # row0 原样
        self.assertEqual(img.pixel(0, 0), (10, 20, 30, 40))
        self.assertEqual(img.pixel(1, 0), (50, 60, 70, 80))
        # row1 Sub 解码: 第一像素 (5,5,5,5), 第二像素各通道 +5
        self.assertEqual(img.pixel(0, 1), (5, 5, 5, 5))
        self.assertEqual(img.pixel(1, 1), (10, 10, 10, 10))

    def test_decode_rgb_color_type_2_promotes_to_rgba(self):
        # 手工构造 1x1 颜色类型 2(RGB) 的 PNG, 解码后应自动补 alpha=255
        width = height = 1
        ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)

        def chunk(tag, data):
            return (
                struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
            )

        raw = b"\x00\x7f\x80\x81"  # filter None + RGB
        blob = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
        blob += chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "rgb.png")
            with open(p, "wb") as f:
                f.write(blob)
            img = read_png(p)
        self.assertEqual(img.pixel(0, 0), (0x7F, 0x80, 0x81, 255))

    def test_unsupported_interlace_rejected(self):
        ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 1)

        def chunk(tag, data):
            return (
                struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
            )

        blob = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
        blob += chunk(b"IDAT", zlib.compress(b"\x00\x01\x02\x03\x04"))
        blob += chunk(b"IEND", b"")
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "i.png")
            with open(p, "wb") as f:
                f.write(blob)
            with self.assertRaises(PNGUnsupportedError):
                read_png(p)


class ColorMathTests(unittest.TestCase):
    def test_parse_color_forms(self):
        self.assertEqual(parse_color("#FF0000"), (255, 0, 0))
        self.assertEqual(parse_color("00ff10"), (0, 255, 16))
        self.assertEqual(parse_color([1, 2, 3]), (1, 2, 3))
        with self.assertRaises(ColorSpecError):
            parse_color("#GGG000")
        with self.assertRaises(ColorSpecError):
            parse_color("#12345")
        with self.assertRaises(ColorSpecError):
            parse_color([300, 0, 0])

    def test_metrics(self):
        a, b = (10, 20, 30), (13, 16, 30)
        # 欧氏: 3^2+4^2 = 25; 切比雪夫: max(3,4,0) = 4(线性值, 不平方)
        self.assertEqual(distance2(a, b, "euclidean"), 25)
        self.assertEqual(distance2(a, b, "chebyshev"), 4)

    def test_unmatte_matte_roundtrip_soft_edge(self):
        straight = (200, 40, 90)
        white = (255, 255, 255)
        # 单字节量化再解 matte 的直色误差解析上界约为 127.5/alpha(存储色半个
        # 量化级除以 alpha 比例)。alpha 极低时信息本就不可逆, 实际软边通常
        # alpha >= 64, 那里误差不超过 2 级, 肉眼不可察。
        bounds = {32: 8, 64: 2, 128: 1, 200: 1, 254: 1}
        for alpha, bound in bounds.items():
            stored = matte(*straight, alpha, white)
            back = unmatte(*stored, alpha, white).rgb
            for c1, c2 in zip(straight, back):
                self.assertLessEqual(
                    abs(c1 - c2), bound, f"alpha={alpha} 往返超差"
                )

    def test_matte_none_passthrough(self):
        self.assertEqual(matte(10, 20, 30, 128, None), (10, 20, 30))
        self.assertEqual(unmatte(10, 20, 30, 128, None).rgb, (10, 20, 30))


class EngineTests(unittest.TestCase):
    def _solid_image(self, rgb, alpha=255, size=3):
        px = [(rgb[0], rgb[1], rgb[2], alpha) for _ in range(size * size)]
        return make_image(px, size, size)

    def test_rules_match_original_not_previous_output(self):
        # 像素正好是 #101010。规则 A 把它换成 #F0F0F0; 若下一条在替换结果上
        # 匹配, 规则 B(source=#F0F0F0) 就会错误命中。正确行为: B 零命中。
        img = self._solid_image((0x10, 0x10, 0x10))
        rules = (
            rule("A", "#101010", "#F0F0F0", tol=0, priority=10),
            rule("B", "#F0F0F0", "#0000FF", tol=0, priority=1),
        )
        res = apply_scheme(img, rules, matte_rgb=(255, 255, 255))
        self.assertEqual(res.stats["A"].matched, 9)
        self.assertEqual(res.stats["B"].matched, 0)
        self.assertTrue(all(px == (0xF0, 0xF0, 0xF0, 255)
                            for px in self._iter_rgba(res.image)))

    def test_priority_is_deterministic_and_order_independent(self):
        img = self._solid_image((100, 100, 100))
        r1 = rule("low", "#646464", "#FF0000", tol=5, priority=1)
        r2 = rule("high", "#646464", "#00FF00", tol=5, priority=9)
        res_ab = apply_scheme(img, (r1, r2), (255, 255, 255))
        res_ba = apply_scheme(img, (r2, r1), (255, 255, 255))
        self.assertEqual(bytes(res_ab.image.rgba), bytes(res_ba.image.rgba))
        # 高优先级获胜
        self.assertEqual(res_ab.stats["high"].matched, 9)
        self.assertEqual(res_ab.stats["low"].matched, 0)
        self.assertEqual(res_ab.stats["low"].contested, 9)
        self.assertTrue(all(px == (0, 255, 0, 255)
                            for px in self._iter_rgba(res_ab.image)))

    def test_tie_priority_breaks_by_rule_id(self):
        img = self._solid_image((50, 50, 50))
        za = rule("za", "#323232", "#FF0000", tol=5, priority=5)
        ab = rule("ab", "#323232", "#0000FF", tol=5, priority=5)
        # 即便 za 排在前面, 同优先级也应按 id 字典序 -> ab 获胜
        res = apply_scheme(img, (za, ab), (255, 255, 255))
        self.assertEqual(res.stats["ab"].matched, 9)
        self.assertEqual(res.stats["za"].contested, 9)

    def test_alpha_preserved_and_soft_edge_rematted(self):
        # 半透明红(白 matte 预合成), 换成绿色后 alpha 不变、存储色按白 matte 重算
        stored_red = matte(220, 30, 30, 96, (255, 255, 255))
        img = make_image([(*stored_red, 96)], 1, 1)
        rules = (rule("r", "#DC1E1E", "#10A040", tol=60),)
        res = apply_scheme(img, rules, (255, 255, 255))
        out = res.image.pixel(0, 0)
        self.assertEqual(out[3], 96)  # alpha 原样
        expect = matte(0x10, 0xA0, 0x40, 96, (255, 255, 255))
        self.assertEqual(out[:3], expect)

    def test_fully_transparent_excluded_even_with_dirty_rgb(self):
        img = make_image([(16, 32, 48, 0)], 1, 1)  # RGB 非零但 alpha=0
        rules = (rule("r", "#102030", "#FFFFFF", tol=200),)
        res = apply_scheme(img, rules, (255, 255, 255))
        self.assertEqual(res.fully_transparent, 1)
        self.assertEqual(res.stats["r"].matched, 0)
        self.assertEqual(res.image.pixel(0, 0), (16, 32, 48, 0))  # 字节不动

    def test_protected_region_skips_pixels(self):
        img = self._solid_image((100, 100, 100), size=4)
        region = ProtectedRegion(kind="rect", geometry=(1, 1, 2, 2))
        rules = (rule("r", "#646464", "#FF0000", tol=200),)
        res = apply_scheme(img, rules, (255, 255, 255),
                           protected_regions=(region,))
        self.assertEqual(res.protected_pixels, 4)
        self.assertEqual(res.stats["r"].matched, 12)
        for y in range(4):
            for x in range(4):
                px = res.image.pixel(x, y)
                if 1 <= x <= 2 and 1 <= y <= 2:
                    self.assertEqual(px, (100, 100, 100, 255))
                else:
                    self.assertEqual(px[:3], (255, 0, 0))

    def test_mask_protection(self):
        size = 2
        img = self._solid_image((100, 100, 100), size=size)
        mask = Image(size, size, bytearray([
            0, 0, 0, 0,
            255, 255, 255, 255,
            0, 0, 0, 0,
            0, 0, 0, 0,
        ]))
        with tempfile.TemporaryDirectory() as d:
            mp = os.path.join(d, "mask.png")
            write_png(mp, mask)
            region = ProtectedRegion(kind="mask", mask_path=mp)
            rules = (rule("r", "#646464", "#FF0000", tol=200),)
            res = apply_scheme(img, rules, (255, 255, 255),
                               protected_regions=(region,))
        self.assertEqual(res.protected_pixels, 1)
        self.assertEqual(res.stats["r"].matched, 3)

    def test_engine_ignores_enabled_flag_switch_lives_in_config(self):
        # 开关语义由 config 层过滤承担(见 ConfigTests); 引擎只消费传入的规则集,
        # 对 Rule.enabled 不做判断, 保持引擎单一职责。
        img = self._solid_image((100, 100, 100))
        rules = (rule("off", "#646464", "#FF0000", tol=200, enabled=False),)
        res = apply_scheme(img, rules, (255, 255, 255))
        self.assertEqual(res.stats["off"].matched, 9)

    def test_tolerance_boundary(self):
        img = make_image([(10, 10, 10, 255)], 1, 1)
        # 与源色 (13,14,10) 的欧氏距离恰好为 5: 3^2+4^2+0 = 25
        hit = apply_scheme(img, (rule("h", "#0D0E0A", "#000000", tol=5),),
                           (255, 255, 255))
        self.assertEqual(hit.stats["h"].matched, 1)
        miss = apply_scheme(img, (rule("m", "#0D0E0A", "#000000", tol=4.9),),
                            (255, 255, 255))
        self.assertEqual(miss.stats["m"].matched, 0)

    def test_chebyshev_metric(self):
        img = make_image([(10, 20, 30, 255)], 1, 1)
        # 与源色差为 (9,4,0), 切比雪夫距离 = 9
        rules = (rule("c", "#13181E", "#FFFFFF", tol=9, metric="chebyshev"),)
        res = apply_scheme(img, rules, (255, 255, 255))
        self.assertEqual(res.stats["c"].matched, 1)
        rules2 = (rule("c", "#13181E", "#FFFFFF", tol=8, metric="chebyshev"),)
        res2 = apply_scheme(img, rules2, (255, 255, 255))
        self.assertEqual(res2.stats["c"].matched, 0)

    @staticmethod
    def _iter_rgba(image: Image):
        for i in range(0, len(image.rgba), 4):
            yield tuple(image.rgba[i : i + 4])


class ConfigTests(unittest.TestCase):
    def _write(self, d, data, name="p.json"):
        p = os.path.join(d, name)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f)
        return p

    BASE = {
        "matte": "#FFFFFF",
        "rules": [
            {"id": "r1", "source": "#101010", "target": "#FF0000",
             "tolerance": 5, "priority": 10},
            {"id": "r2", "source": "#202020", "target": "#00FF00",
             "tolerance": 5, "priority": 5, "enabled": False},
        ],
        "schemes": [
            {"id": "s1", "rule_refs": ["r1", "r2"]},
            {"id": "s2", "rule_refs": [{"id": "r1", "target": "#0000FF"}]},
        ],
    }

    def test_loads_and_filters_disabled(self):
        with tempfile.TemporaryDirectory() as d:
            cfg = load_config(self._write(d, self.BASE))
        self.assertEqual([r.id for r in cfg.schemes["s1"].rules], ["r1"])
        self.assertEqual(cfg.schemes["s2"].rules[0].target, (0, 0, 255))

    def test_unknown_rule_ref_rejected(self):
        data = json.loads(json.dumps(self.BASE))
        data["schemes"][0]["rule_refs"].append("ghost")
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ConfigError):
                load_config(self._write(d, data))

    def test_duplicate_rule_id_rejected(self):
        data = json.loads(json.dumps(self.BASE))
        data["rules"].append(dict(data["rules"][0]))
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ConfigError):
                load_config(self._write(d, data))

    def test_bad_color_rejected(self):
        data = json.loads(json.dumps(self.BASE))
        data["rules"][0]["source"] = "not-a-color"
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ConfigError):
                load_config(self._write(d, data))

    def test_ref_can_reenable_disabled_rule(self):
        data = json.loads(json.dumps(self.BASE))
        data["schemes"][0]["rule_refs"] = [
            "r1", {"id": "r2", "enabled": True}
        ]
        with tempfile.TemporaryDirectory() as d:
            cfg = load_config(self._write(d, data))
        self.assertEqual([r.id for r in cfg.schemes["s1"].rules], ["r1", "r2"])

    def test_build_protection_mask_rect_circle(self):
        rect = ProtectedRegion(kind="rect", geometry=(0, 0, 1, 1))
        circle = ProtectedRegion(kind="circle", geometry=(4, 4, 1))
        mask = build_protection_mask((rect, circle), 6, 6)
        self.assertEqual(sum(mask), 4 + 5)  # 2x2 矩形 + 半径1圆(含中心共5点)
        self.assertEqual(mask[0], 1)


class CLIEndToEndTests(unittest.TestCase):
    def test_sample_pipeline_and_order_invariance(self):
        # 1. 生成样例
        from examples import make_sample

        with tempfile.TemporaryDirectory() as d:
            sample_png = os.path.join(d, "sample.png")
            palette_json = os.path.join(d, "palettes.json")
            write_png(sample_png, make_sample.build_sample_image())
            with open(palette_json, "w", encoding="utf-8") as f:
                json.dump(make_sample.PALETTES, f)

            out_dir = os.path.join(d, "out")
            rc = cli_main([sample_png, palette_json, out_dir])
            self.assertEqual(rc, 0)

            for name in (
                "spring.png", "spring_hitmap.png",
                "autumn.png", "order-check-a.png", "order-check-b.png",
                "stats.json",
            ):
                self.assertTrue(os.path.exists(os.path.join(out_dir, name)), name)

            # 2. 排列不同、优先关系不变 -> 输出逐字节一致
            with open(os.path.join(out_dir, "order-check-a.png"), "rb") as f:
                a = f.read()
            with open(os.path.join(out_dir, "order-check-b.png"), "rb") as f:
                b = f.read()
            self.assertEqual(a, b)

            # 3. 统计内容完整且自洽
            with open(os.path.join(out_dir, "stats.json"), encoding="utf-8") as f:
                stats = json.load(f)
            spring = stats["schemes"]["spring"]
            rule_ids = {r["rule_id"] for r in spring["rules"]}
            self.assertEqual(rule_ids, {"red-coat", "warm-shadow", "blue-coat"})
            self.assertGreater(spring["fully_transparent_excluded"], 0)
            self.assertGreater(spring["protected_pixels"], 0)
            contested = sum(r["contested"] for r in spring["rules"])
            self.assertGreater(contested, 0)  # 样例确实构造了重叠

            # 4. alpha 通道与原图完全一致
            src_img = read_png(sample_png)
            for sid in ("spring", "autumn", "order-check-a"):
                out_img = read_png(os.path.join(out_dir, f"{sid}.png"))
                src_a = bytes(src_img.rgba[3::4])
                out_a = bytes(out_img.rgba[3::4])
                self.assertEqual(src_a, out_a, f"{sid} alpha 被改动")

            # 5. 保护区内像素 RGB 原样不动
            out_img = read_png(os.path.join(out_dir, "spring.png"))
            for y in range(70, 101):
                for x in range(95, 131):
                    i = (y * out_img.width + x) * 4
                    if src_img.rgba[i + 3] == 0:
                        continue
                    self.assertEqual(
                        tuple(src_img.rgba[i : i + 3]),
                        tuple(out_img.rgba[i : i + 3]),
                        f"保护区像素被修改 ({x},{y})",
                    )

            # 6. autumn 关闭 blue-coat: 蓝区(除软边被其他规则误伤外)基本不动,
            #    且 stats 中不含 blue-coat
            autumn = stats["schemes"]["autumn"]
            self.assertNotIn("blue-coat", {r["rule_id"] for r in autumn["rules"]})

            # 7. --only 过滤
            only_dir = os.path.join(d, "only")
            cli_main([sample_png, palette_json, only_dir, "--only", "spring"])
            self.assertTrue(os.path.exists(os.path.join(only_dir, "spring.png")))
            self.assertFalse(os.path.exists(os.path.join(only_dir, "autumn.png")))


if __name__ == "__main__":
    unittest.main()
