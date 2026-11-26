"""命令行接口。

示例：
    python3 run.py generate-samples
    python3 run.py validate --plan examples/plan.json
    python3 run.py list --plan examples/plan.json --format md
    python3 run.py render --plan examples/plan.json \
        --out examples/output/full_preview.wav \
        --report examples/output/transitions.json
    python3 run.py render --plan examples/plan.json --only t_market_to_harbor
    python3 run.py verify-beats --plan examples/plan.json \
        --wav examples/output/full_preview.wav
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .analyze import verify_landings
from .config import Registry, load_asset_configs, load_json
from .errors import MusicToolError, PlanError
from .render import render_full, render_interval, render_transition_preview
from .report import report_csv, report_json, report_markdown
from .synth import generate_all
from .timeline import build_timeline
from .wavio import read_wav, write_wav_int16


def _resolve_assets_path(args, plan_doc: dict, plan_path: Path) -> Path:
    if getattr(args, "assets", None):
        return Path(args.assets).resolve()
    if isinstance(plan_doc.get("assets"), str):
        return (plan_path.parent / plan_doc["assets"]).resolve()
    sibling = plan_path.parent / "assets.json"
    if sibling.is_file():
        return sibling
    raise PlanError("请用 --assets 指定素材库文件，或在 plan 中写 \"assets\": \"...\"")


def _build(args, load_all_assets: bool = True):
    plan_path = Path(args.plan).resolve()
    plan_doc = load_json(plan_path)
    assets_path = _resolve_assets_path(args, plan_doc, plan_path)
    configs, _base, assets_doc = load_asset_configs(assets_path)
    registry = Registry(
        configs,
        expected_sample_rate=plan_doc.get("sample_rate"),
        sample_rate_from_doc=assets_doc.get("sample_rate"),
    )
    tl = build_timeline(plan_doc, registry)
    if load_all_assets:
        for c in tl.cues:
            registry.get(c.asset_id, cue_id=c.id)
    return tl, registry, plan_path


def _default_out(plan_path: Path, name: str) -> Path:
    d = plan_path.parent / "output"
    d.mkdir(exist_ok=True)
    return d / name


# ---------------- commands ----------------

def cmd_generate_samples(args) -> int:
    out = Path(args.out)
    if not out.is_absolute():
        out = Path.cwd() / out
    info = generate_all(out)
    print("已生成合成样例到 %s" % out)
    for name, meta in info.items():
        print("  - %-24s %8d 帧  %d 声道  loop=%s"
              % (name, meta["frames"], meta["channels"], meta["loop"]))
    return 0


def cmd_validate(args) -> int:
    tl, registry, _ = _build(args)
    print("OK: 计划可解析，全部素材可读")
    print("  采样率 %d Hz | BPM %s | %d 拍/小节 | 总长度 %d 采样 (%.3f s)"
          % (tl.sample_rate, tl.bpm, tl.beats_per_bar, tl.total_samples,
             tl.total_samples / tl.sample_rate))
    print("  条目 %d 个 | 转场 %d 条 | 输出声道 %d"
          % (len(tl.cues), len(tl.transitions), tl.output_channels))
    for tr in tl.transitions:
        print("   - %-28s %-9s sync=%-9d enter=%-9d exit=%-9d"
              % (tr.id, tr.mode, tr.sync_sample, tr.enter_sample, tr.exit_sample))
    return 0


def cmd_list(args) -> int:
    tl, registry, _ = _build(args)
    if args.format == "json":
        text = report_json(tl, registry)
    elif args.format == "md":
        text = report_markdown(tl, registry)
    elif args.format == "csv":
        text = report_csv(tl, registry)
    else:
        raise PlanError("未知格式 %r" % args.format)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        print("已写出转场清单(%s): %s" % (args.format, args.out))
    else:
        sys.stdout.write(text)
    return 0


def _print_verify(results) -> bool:
    print("第一拍落点核对：")
    all_ok = True
    for r in results:
        mark = "PASS" if r["passed"] else "FAIL"
        if not r["passed"]:
            all_ok = False
        print("  [%s] %-28s 期望 %-9d 实测 %-9d 偏移 %+4d 采样  corr=%.3f (次峰 %.3f) ch=%s"
              % (mark, r["transition_id"], r["expected_sample"],
                 r["detected_sample"], r["offset_samples"],
                 r["correlation"], r["runner_up_correlation"], r["channel"]))
    return all_ok


def cmd_render(args) -> int:
    tl, registry, plan_path = _build(args)

    if args.only:
        tr = tl.transition_by_id(args.only)
        block = render_interval(tl, registry, tr.preview_start, tr.preview_end)
        default_name = "cue_%s.wav" % tr.id
        scope = "单切点预听 %s 区间 [%d,%d)" % (tr.id, tr.preview_start, tr.preview_end)
    else:
        block = render_full(tl, registry)
        default_name = "full_preview.wav"
        scope = "全程试听 [0,%d)" % tl.total_samples

    out_path = Path(args.out) if args.out else _default_out(plan_path, default_name)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    stats = write_wav_int16(str(out_path), block.channels, tl.sample_rate, tl.output_gain)
    print("已导出 %s" % out_path)
    print("  %s | %d 帧 | %d 声道 | peak=%.4f | 钳位帧=%d"
          % (scope, stats["frames"], len(block.channels),
             stats["peak_amplitude"], stats["clipped_frames"]))
    if stats["clipped_frames"] and not args.allow_clip:
        print("  警告: 存在钳位失真，可在 plan.output.gain 设小于 1 的增益（当前 %s）"
              % tl.output_gain, file=sys.stderr)

    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(report_json(tl, registry), encoding="utf-8")
        print("已写出报告: %s" % args.report)

    if args.verify:
        results = verify_landings(
            tl, registry, block.channels,
            global_start_sample=block.global_start_sample,
            only_id=args.only if args.only else None,
        )
        ok = _print_verify(results)
        if args.strict_verify and not ok:
            return 3
    return 0


def cmd_verify_beats(args) -> int:
    tl, registry, _ = _build(args)
    if args.wav:
        wav = read_wav(args.wav)
        if wav.sample_rate != tl.sample_rate:
            raise PlanError("WAV 采样率 %d 与计划 %d 不一致"
                            % (wav.sample_rate, tl.sample_rate))
        channels = list(wav.channels)
        start = 0
    else:
        block = render_full(tl, registry)
        channels = block.channels
        start = block.global_start_sample

    results = verify_landings(tl, registry, channels, global_start_sample=start)
    ok = _print_verify(results)
    if args.json:
        import json
        Path(args.json).write_text(
            json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print("已写出: %s" % args.json)
    return 0 if ok else 3


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="music-transition-tool",
        description="本地 WAV 循环素材 + 转场计划的离线预听/导出/核对工具",
    )
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="command", required=True)

    sp = sub.add_parser("generate-samples", help="生成合成音频样例")
    sp.add_argument("--out", default="examples/wavs")
    sp.set_defaults(func=cmd_generate_samples)

    def add_plan_args(sp):
        sp.add_argument("--plan", required=True, help="转场计划 JSON")
        sp.add_argument("--assets", help="素材库 JSON（默认取 plan.assets 或同目录 assets.json）")

    sp = sub.add_parser("validate", help="校验计划与素材")
    add_plan_args(sp)
    sp.set_defaults(func=cmd_validate)

    sp = sub.add_parser("list", help="输出转场清单")
    add_plan_args(sp)
    sp.add_argument("--format", choices=["json", "md", "csv"], default="md")
    sp.add_argument("--out", help="写到文件而不是 stdout")
    sp.set_defaults(func=cmd_list)

    sp = sub.add_parser("render", help="渲染全程或单个切点")
    add_plan_args(sp)
    sp.add_argument("--only", help="只渲染指定 transition id 的预听区间")
    sp.add_argument("--out", help="输出 WAV 路径")
    sp.add_argument("--report", help="同时把 JSON 报告写到该路径")
    sp.add_argument("--verify", action="store_true", help="渲染后核对第一拍落点")
    sp.add_argument("--strict-verify", action="store_true",
                    help="落点核对不通过时以退出码 3 结束")
    sp.add_argument("--allow-clip", action="store_true", help="不打印钳位警告")
    sp.set_defaults(func=cmd_render)

    sp = sub.add_parser("verify-beats", help="用匹配滤波核对第一拍实际落点")
    add_plan_args(sp)
    sp.add_argument("--wav", help="待核对 WAV；不传则现场渲染全程")
    sp.add_argument("--json", help="把结构化结果写到 JSON")
    sp.set_defaults(func=cmd_verify_beats)
    return p


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except MusicToolError as exc:
        loc = ""
        if isinstance(exc, PlanError):
            loc = exc.location_prefix()
        print("错误: %s%s" % (loc, exc), file=sys.stderr)
        return 2
    except FileNotFoundError as exc:
        print("错误: 找不到文件: %s" % exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
