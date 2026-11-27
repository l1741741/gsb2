"""端到端测试: 合成三轨录音, 验证边界、优先级、声道对应、整点、诊断与原子交付。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

from wav_sampler.cli import main as cli_main  # noqa: E402
from wav_sampler.engine import ExportConfig, export  # noqa: E402
from wav_sampler.pcm import decode_bytes  # noqa: E402
from wav_sampler.report import build_delivery_manifest  # noqa: E402

RATE = 8000
MARKER = {"segA": 10000, "segB": 20000, "segC": 30000}


def write_wav(path, *, channels, width, frames, marker):
    from wav_sampler.pcm import encode_samples

    samples = []
    for frame in range(frames):
        for ch in range(channels):
            samples.append(marker + 100 * ch + (frame % 97))
    with wave.open(path, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(width)
        wf.setframerate(RATE)
        wf.writeframes(encode_samples(samples, width))


def read_wav(path):
    with wave.open(path, "rb") as wf:
        ch = wf.getnchannels()
        width = wf.getsampwidth()
        rate = wf.getframerate()
        frames = wf.getnframes()
        raw = wf.readframes(frames)
    samples = decode_bytes(raw, width)
    frames_data = [samples[i * ch:(i + 1) * ch] for i in range(frames)]
    return {"channels": ch, "width": width, "rate": rate, "frames": frames_data}


def expected_sample(seg, src_ch, src_frame):
    return MARKER[seg] + 100 * src_ch + (src_frame % 97)


class FixtureBuild:
    """生成与 tools/make_fixtures.py 相同结构的夹具 (在临时目录内)。"""

    def __init__(self, base):
        self.base = base
        self.wav_dir = os.path.join(base, "wav")
        os.makedirs(self.wav_dir, exist_ok=True)
        write_wav(os.path.join(self.wav_dir, "segA.wav"), channels=2, width=2, frames=8000, marker=MARKER["segA"])
        write_wav(os.path.join(self.wav_dir, "segB.wav"), channels=1, width=2, frames=8000, marker=MARKER["segB"])
        write_wav(os.path.join(self.wav_dir, "segC.wav"), channels=4, width=3, frames=8000, marker=MARKER["segC"])
        self.starts = {"segA": 0, "segB": 6000, "segC": 18000}

    def write_manifest(self, name, starts=None, ranges=None, extra_segments=None):
        starts = starts or self.starts
        segments = [
            {"id": "segA", "path": "wav/segA.wav", "start": {"frames": starts["segA"]},
             "duration": {"frames": 8000}, "priority": 1},
            {"id": "segB", "path": "wav/segB.wav", "start": {"frames": starts["segB"]},
             "duration": {"frames": 8000}, "priority": 5},
            {"id": "segC", "path": "wav/segC.wav", "start": {"frames": starts["segC"]},
             "duration": {"frames": 8000}, "priority": 2},
        ]
        if extra_segments:
            segments.extend(extra_segments)
        payload = {
            "sample_rate": RATE,
            "output_channels": 2,
            "segments": segments,
            "ranges": ranges or [
                {"id": "r1", "start": {"frames": 2000}, "end": {"frames": 12000}, "output": "r1.wav"},
                {"id": "r2", "start": {"frames": 10000}, "end": {"frames": 22000}, "output": "r2.wav"},
                {"id": "r3", "start": {"frames": 0}, "end": {"frames": 28000}, "output": "r3.wav"},
            ],
        }
        path = os.path.join(self.base, name)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        return path


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fx = FixtureBuild(self.tmp.name)
        self.manifest = self.fx.write_manifest("manifest.json")
        # 每个测试方法独立输出目录, 避免 skip-exists 串扰
        self.out = os.path.join(self.tmp.name, "out", self._testMethodName)

    def _run(self, **cfg):
        cfg.setdefault("output_dir", self.out)
        return export(self.manifest, ExportConfig(**cfg))

    # ---- 1. 基本交付与帧数 ----
    def test_all_ranges_delivered_with_exact_frames(self):
        record = self._run()
        self.assertEqual([r.status for r in record.results], ["delivered"] * 3)
        expected_frames = {"r1": 10000, "r2": 12000, "r3": 28000}
        for result in record.results:
            data = read_wav(os.path.join(self.out, result.output_name))
            self.assertEqual(len(data["frames"]), expected_frames[result.range_id])
            self.assertEqual(data["channels"], 2)
            self.assertEqual(data["rate"], RATE)

    # ---- 2. 边界精确: 搭接点两侧来源正确 ----
    def test_overlap_boundary_exact_frames(self):
        record = self._run()
        r1 = read_wav(os.path.join(self.out, "r1.wav"))["frames"]
        # r1 = 项目帧 [2000, 12000)
        # [2000,6000) segA; [6000,8000) 重叠, segB 优先级高; [8000,12000) segB
        # 边界帧 3999 仍是 A, 4000 (= 项目 6000) 起是 B
        self.assertEqual(r1[3999], [expected_sample("segA", 0, 5999), expected_sample("segA", 1, 5999)])
        self.assertEqual(r1[4000], [expected_sample("segB", 0, 0), expected_sample("segB", 0, 0)])
        # r1 最后一帧: 项目 11999 -> segB 源帧 5999
        self.assertEqual(r1[-1], [expected_sample("segB", 0, 5999), expected_sample("segB", 0, 5999)])

        r3 = read_wav(os.path.join(self.out, "r3.wav"))["frames"]
        # 项目 5999 -> A 源 5999; 项目 6000 -> B 源 0
        self.assertEqual(r3[5999][0], expected_sample("segA", 0, 5999))
        self.assertEqual(r3[6000][0], expected_sample("segB", 0, 0))

    # ---- 3. 优先级: 低优先段在重叠区完全不可见 ----
    def test_priority_winner_occupies_full_overlap(self):
        record = self._run()
        r3 = read_wav(os.path.join(self.out, "r3.wav"))["frames"]
        for project_frame in range(6000, 8000):
            src_frame = project_frame - 6000
            self.assertEqual(
                r3[project_frame],
                [expected_sample("segB", 0, src_frame)] * 2,
                f"重叠区项目帧 {project_frame} 应由高优先级 segB 提供",
            )
        overlap_runs = [
            r for res in record.results for r in res.runs if r.kind == "overlap"
        ]
        self.assertTrue(overlap_runs)
        for run in overlap_runs:
            self.assertEqual(run.segment_id, "segB")
            self.assertEqual(set(run.contenders), {"segA", "segB"})

    # ---- 4. 空洞补静音, 且报告区分 overlap / silence ----
    def test_silence_gap_filled_and_classified(self):
        record = self._run()
        r3 = read_wav(os.path.join(self.out, "r3.wav"))["frames"]
        # 空洞: 项目 [14000, 18000); r3 从 0 开始, 即输出帧 14000..17999
        for i in range(14000, 18000):
            self.assertEqual(r3[i], [0, 0], f"空洞帧 {i} 应为静音")
        # 空洞前后一帧必须是真实数据, 静音长度恰好 4000
        self.assertNotEqual(r3[13999], [0, 0])
        self.assertNotEqual(r3[18000], [0, 0])
        totals = {"source": 0, "overlap": 0, "silence": 0}
        per_range_silence = {}
        for res in record.results:
            range_silence = 0
            for run in res.runs:
                totals[run.kind] += run.end_frame - run.start_frame
                if run.kind == "silence":
                    range_silence += run.end_frame - run.start_frame
            per_range_silence[res.range_id] = range_silence
        # r1=[2000,12000): 全部有覆盖 -> 0
        # r2=[10000,22000): segB 到 14000, 空洞 [14000,18000) 4000, segC 到 26000
        # r3=[0,28000): 空洞 4000 + 尾部 [26000,28000) 2000
        self.assertEqual(per_range_silence, {"r1": 0, "r2": 4000, "r3": 6000})
        self.assertEqual(totals["silence"], 10000)

    # ---- 5. 声道映射: 单声道上混 / 4 声道下取 ----
    def test_channel_mapping(self):
        self._run()
        r3 = read_wav(os.path.join(self.out, "r3.wav"))["frames"]
        # segB 单声道 -> 两个输出声道都是源 0
        self.assertEqual(r3[6000], [expected_sample("segB", 0, 0)] * 2)
        # segC 4 声道 -> 默认映射 [0,1], 输出只取前两个源声道; 源 2/3 丢弃
        # 项目帧 18000 = segC 源帧 0
        self.assertEqual(
            r3[18000],
            [expected_sample("segC", 0, 0), expected_sample("segC", 1, 0)],
        )
        # segA 双声道直通
        self.assertEqual(
            r3[0],
            [expected_sample("segA", 0, 0), expected_sample("segA", 1, 0)],
        )

    def test_explicit_channel_map_with_silence_pad(self):
        # segC 显式映射: 输出0=源3, 输出1=静音
        manifest = self.fx.write_manifest(
            "mapped.json",
            extra_segments=None,
        )
        with open(manifest, encoding="utf-8") as fh:
            payload = json.load(fh)
        for seg in payload["segments"]:
            if seg["id"] == "segC":
                seg["channel_map"] = [3, -1]
        with open(manifest, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        record = export(manifest, ExportConfig(output_dir=os.path.join(self.tmp.name, "out2")))
        r3 = read_wav(os.path.join(record.results[2].output_path))["frames"]
        self.assertEqual(r3[18000], [expected_sample("segC", 3, 0), 0])

    # ---- 6. 相邻输出拼回: r1/r2 共同边界不重不丢 ----
    def test_adjacent_outputs_concatenate_without_frame_gain_or_loss(self):
        self._run()
        r1 = read_wav(os.path.join(self.out, "r1.wav"))["frames"]
        r2 = read_wav(os.path.join(self.out, "r2.wav"))["frames"]
        # r1 覆盖项目 [2000,12000), r2 覆盖 [10000,22000) (重叠 2000 帧)
        # 取 r1 全部 + r2 中项目 [12000,22000) 的部分, 应拼成连续 [2000,22000)
        r2_tail = r2[2000:]
        stitched = r1 + r2_tail
        self.assertEqual(len(stitched), 20000)
        r3 = read_wav(os.path.join(self.out, "r3.wav"))["frames"]
        # 与 r3 的 [2000,22000) 逐帧一致 (同样的 provenance 规则)
        for i, frame in enumerate(stitched):
            self.assertEqual(frame, r3[2000 + i], f"拼接帧 {i} 与全量导出不一致")

    # ---- 7. 整点前后取样 ----
    def test_hour_boundary_sampling(self):
        hour = 3600 * RATE
        starts = {"segA": hour - 4000, "segB": hour + 2000, "segC": hour + 14000}
        shift = hour - 4000
        ranges = [
            {"id": "h1", "start": {"frames": hour - 100}, "end": {"frames": hour + 100}, "output": "h1.wav"},
            {"id": "h2", "start": {"frames": hour}, "end": {"frames": hour + 1}, "output": "h2.wav"},
        ]
        manifest = self.fx.write_manifest("hour.json", starts=starts, ranges=ranges)
        record = export(manifest, ExportConfig(output_dir=os.path.join(self.tmp.name, "hour-out")))
        self.assertTrue(all(r.status == "delivered" for r in record.results))
        h1 = read_wav(os.path.join(record.results[0].output_path))["frames"]
        self.assertEqual(len(h1), 200)
        # 整点前 1 帧 (项目 hour-1): segA 覆盖 [hour-4000, hour+4000)
        a_src = (hour - 1) - starts["segA"]
        self.assertEqual(h1[99], [expected_sample("segA", 0, a_src), expected_sample("segA", 1, a_src)])
        # 整点帧本身仍是 segA (segB 从 hour+2000 才开始)
        self.assertEqual(h1[100][0], expected_sample("segA", 0, a_src + 1))
        h2 = read_wav(os.path.join(record.results[1].output_path))["frames"]
        self.assertEqual(len(h2), 1)
        self.assertEqual(h2[0][0], expected_sample("segA", 0, hour - starts["segA"]))

    # ---- 8. 文件提前结束: 定位诊断 + 拒绝受影响范围, 不影响其他范围 ----
    def test_segment_ends_early_diagnostic_and_partial_reject(self):
        manifest = self.fx.write_manifest("early.json")
        with open(manifest, encoding="utf-8") as fh:
            payload = json.load(fh)
        # segB 实际 8000 帧, 谎称 10000 帧 (声明到项目帧 16000)
        for seg in payload["segments"]:
            if seg["id"] == "segB":
                seg["duration"] = {"frames": 10000}
        with open(manifest, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        record = export(manifest, ExportConfig(output_dir=os.path.join(self.tmp.name, "early-out")))
        diag = next(d for d in record.diagnostics if d.code == "segment_ended_early")
        self.assertEqual(diag.level, "error")
        self.assertEqual(diag.segment_id, "segB")
        self.assertEqual(diag.project_frame, 14000)  # 实际结束点
        statuses = {r.range_id: r.status for r in record.results}
        # r1=[2000,12000) 全在 14000 之前 -> 仍合法; r2/r3 触及无数据区 -> 拒绝
        self.assertEqual(statuses, {"r1": "delivered", "r2": "rejected", "r3": "rejected"})
        self.assertTrue(os.path.exists(os.path.join(self.tmp.name, "early-out", "r1.wav")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "early-out", "r2.wav")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "early-out", "r3.wav")))
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "early-out", "r2.wav.part")))

    # ---- 9. 已有好文件不被不完整文件覆盖 ----
    def test_existing_output_not_overwritten(self):
        good_dir = os.path.join(self.tmp.name, "keep-out")
        os.makedirs(good_dir, exist_ok=True)
        good_path = os.path.join(good_dir, "r1.wav")
        marker_bytes = b"PREVIOUS-GOOD-DELIVERY"
        with open(good_path, "wb") as fh:
            fh.write(marker_bytes)
        record = export(self.manifest, ExportConfig(output_dir=good_dir))
        with open(good_path, "rb") as fh:
            self.assertEqual(fh.read(), marker_bytes)
        r1 = next(r for r in record.results if r.range_id == "r1")
        self.assertEqual(r1.status, "skipped_exists")
        # 跳过是保护性提示 (warning), 不是数据错误
        self.assertEqual([d.code for d in r1.diagnostics], ["output_exists"])
        self.assertEqual(r1.diagnostics[0].level, "warning")
        # 其他范围不受影响, 正常交付
        self.assertTrue(all(
            r.status == "delivered" for r in record.results if r.range_id != "r1"
        ))
        # 交付清单里 skipped 不进 delivered
        payload = build_delivery_manifest(record, self.manifest)
        self.assertEqual({d["range_id"] for d in payload["delivered"]}, {"r2", "r3"})
        self.assertEqual({d["range_id"] for d in payload["not_delivered"]}, {"r1"})
        # 纯跳过场景 CLI 退出码为 0 (无 reject / error)
        self.assertEqual(cli_main(["-m", self.manifest, "-o", good_dir]), 0)

    # ---- 10. 不可读文件: 错误诊断, 仅拒绝与之时间相交的范围, 其余正常交付 ----
    def test_unreadable_wav_rejects_affected_ranges_only(self):
        manifest = self.fx.write_manifest("broken.json")
        with open(manifest, encoding="utf-8") as fh:
            payload = json.load(fh)
        # segA 声称覆盖 [0,8000), 令其文件缺失
        payload["segments"][0]["path"] = "wav/missing.wav"
        with open(manifest, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        out = os.path.join(self.tmp.name, "broken-out")
        record = export(manifest, ExportConfig(output_dir=out))
        diag = next(d for d in record.diagnostics if d.code == "wav_unreadable")
        self.assertEqual(diag.level, "error")
        self.assertEqual(diag.affected_interval, (0, 8000))
        statuses = {r.range_id: r.status for r in record.results}
        # r1=[2000,12000) 与 [0,8000) 相交 -> 拒绝;
        # r2=[10000,22000)、r3 起点 0 也相交 -> r3 拒绝; r2 不相交 -> 交付
        self.assertEqual(statuses, {"r1": "rejected", "r2": "delivered", "r3": "rejected"})
        self.assertTrue(os.path.exists(os.path.join(out, "r2.wav")))
        self.assertFalse(os.path.exists(os.path.join(out, "r1.wav")))
        self.assertFalse(os.path.exists(os.path.join(out, "r3.wav")))
        # 拒绝范围的诊断可定位到源
        r1 = next(r for r in record.results if r.range_id == "r1")
        self.assertTrue(any(d.code == "wav_unreadable" for d in r1.diagnostics))

    def test_unreadable_without_duration_blocks_everything(self):
        # 无 duration 声明时受影响区间不可界定, 保守拒绝全部范围
        manifest = self.fx.write_manifest("broken2.json")
        with open(manifest, encoding="utf-8") as fh:
            payload = json.load(fh)
        del payload["segments"][0]["duration"]
        payload["segments"][0]["path"] = "wav/missing.wav"
        with open(manifest, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        out = os.path.join(self.tmp.name, "broken2-out")
        record = export(manifest, ExportConfig(output_dir=out))
        self.assertTrue(any(d.code == "wav_unreadable" for d in record.diagnostics))
        self.assertTrue(all(r.status == "rejected" for r in record.results))
        self.assertEqual([f for f in os.listdir(out) if f.endswith(".wav")], [])

    # ---- 11. 位深: 默认取最宽源 (24bit), 声明可覆盖 ----
    def test_output_width_default_and_override(self):
        record = self._run()
        self.assertEqual(record.output_sample_width, 3)
        manifest = self.fx.write_manifest("w16.json")
        with open(manifest, encoding="utf-8") as fh:
            payload = json.load(fh)
        payload["output_sample_width"] = 2
        with open(manifest, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        record16 = export(manifest, ExportConfig(output_dir=os.path.join(self.tmp.name, "w16-out")))
        self.assertEqual(record16.output_sample_width, 2)
        data = read_wav(os.path.join(record16.results[0].output_path))
        self.assertEqual(data["width"], 2)
        # 降位深后内容仍可追溯 (segC 24->16, 标记值在 16bit 范围内)
        r3 = data["frames"]
        # r3 是 w16 清单的第三个输出
        r3 = read_wav(os.path.join(record16.results[2].output_path))["frames"]
        self.assertEqual(r3[18000], [expected_sample("segC", 0, 0), expected_sample("segC", 1, 0)])

    # ---- 12. provenance 可追溯到源文件与源样本 ----
    def test_delivery_manifest_provenance(self):
        record = self._run()
        payload = build_delivery_manifest(record, self.manifest)
        r1 = next(d for d in payload["delivered"] if d["range_id"] == "r1")
        kinds = [(p["kind"], p["segment_id"]) for p in r1["provenance"]]
        self.assertIn(("overlap", "segB"), kinds)
        self.assertIn(("source", "segA"), kinds)
        # 每段都带源帧区间
        for p in r1["provenance"]:
            if p["kind"] != "silence":
                self.assertIsNotNone(p["source_start_frame"])
                self.assertGreater(p["source_end_frame"], p["source_start_frame"])
        # 帧数账平
        total = sum(p["frames"] for p in r1["provenance"])
        self.assertEqual(total, r1["frames_written"])

    # ---- 13. CLI 端到端 + 退出码 ----
    def test_cli_exit_codes_and_report_files(self):
        code = cli_main(["-m", self.manifest, "-o", self.out])
        self.assertEqual(code, 0)
        for name in ("delivery-manifest.json", "segments.csv", "report.md"):
            self.assertTrue(os.path.exists(os.path.join(self.out, name)))
        with open(os.path.join(self.out, "segments.csv"), encoding="utf-8") as fh:
            csv_text = fh.read()
        self.assertIn("segA", csv_text)
        self.assertIn("effective_start_frame", csv_text)

        # 制造错误后 CLI 退出码为 1
        manifest = self.fx.write_manifest("cli-bad.json")
        with open(manifest, encoding="utf-8") as fh:
            payload = json.load(fh)
        payload["segments"][0]["path"] = "wav/nope.wav"
        with open(manifest, "w", encoding="utf-8") as fh:
            json.dump(payload, fh)
        bad_out = os.path.join(self.tmp.name, "cli-bad-out")
        self.assertEqual(cli_main(["-m", manifest, "-o", bad_out]), 1)

    # ---- 14. 清单结构错误直接抛 ManifestError ----
    def test_bad_manifest_raises(self):
        path = os.path.join(self.tmp.name, "bad.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"sample_rate": -1, "output_channels": 2, "segments": [], "ranges": []}, fh)
        from wav_sampler.manifest import ManifestError

        with self.assertRaises(ManifestError):
            export(path, ExportConfig(output_dir=self.out))

    # ---- 15. 工具脚本自身可运行, 产出结构与内联夹具一致 ----
    def test_fixture_tool_output(self):
        fx_dir = os.path.join(self.tmp.name, "fx")
        script = os.path.join(ROOT, "tools", "make_fixtures.py")
        proc = subprocess.run(
            [sys.executable, "-I", script, fx_dir],
            capture_output=True,
            text=True,
            check=True,
        )
        self.assertIn("fixtures written", proc.stdout)
        for name in ("manifest.json", "manifest-hour.json"):
            with open(os.path.join(fx_dir, name), encoding="utf-8") as fh:
                data = json.load(fh)
            self.assertEqual(data["sample_rate"], RATE)
            self.assertEqual(len(data["segments"]), 3)
        out = os.path.join(fx_dir, "out")
        record = export(
            os.path.join(fx_dir, "manifest.json"),
            ExportConfig(output_dir=out),
        )
        self.assertTrue(all(r.status == "delivered" for r in record.results))


if __name__ == "__main__":
    unittest.main()
