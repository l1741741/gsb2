"""巡检编排：配置解析 → 逐窗解码分析 → 双片对比 → 截图 → 报告。"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from . import __version__
from .analysis import WindowAnalysis, analyze_window
from .compare import DiffType, compare_geometry, compare_window
from .ffmpeg_runner import (
    FFmpegError,
    extract_gray_frames,
    render_side_by_side,
)
from .probe import ProbeError, VideoInfo, probe_video
from .report import ReportBundle, write_html, write_json


@dataclass(frozen=True)
class WindowSpec:
    window_id: str
    start: float
    end: float


def load_windows(spec: str | None, config_path: str | None) -> list[WindowSpec]:
    """支持两种配置：

    1. JSON 配置文件：[{"id":"w1","start":1.0,"end":3.0}, ...]
    2. 命令行逗号分隔：w1=1.0-3.0,w2=5.0-8.0
    缺省时对整片按 10 秒切窗。
    """
    if config_path:
        data = json.loads(Path(config_path).read_text(encoding="utf-8"))
        windows = []
        for i, item in enumerate(data):
            windows.append(WindowSpec(
                window_id=str(item.get("id", f"w{i + 1}")),
                start=float(item["start"]),
                end=float(item["end"]),
            ))
        return _validate_windows(windows)
    if spec:
        windows = []
        for i, token in enumerate(spec.split(",")):
            token = token.strip()
            if not token:
                continue
            if "=" in token:
                wid, span = token.split("=", 1)
            else:
                wid, span = f"w{i + 1}", token
            start_s, end_s = span.split("-", 1)
            windows.append(WindowSpec(wid.strip(),
                                      float(start_s), float(end_s)))
        return _validate_windows(windows)
    return []


def _validate_windows(windows: list[WindowSpec]) -> list[WindowSpec]:
    for w in windows:
        if w.end <= w.start:
            raise ValueError(f"时间窗 {w.window_id} 结束时间必须大于开始时间")
        if w.start < 0:
            raise ValueError(f"时间窗 {w.window_id} 开始时间不能为负")
    return windows


def default_windows(duration: float, chunk: float = 10.0) -> list[WindowSpec]:
    windows = []
    t = 0.0
    i = 1
    while t < duration:
        end = min(t + chunk, duration)
        windows.append(WindowSpec(f"w{i}", round(t, 3), round(end, 3)))
        t = end
        i += 1
    return windows


def run_inspection(
    master_path: str,
    deliver_path: str,
    windows: list[WindowSpec],
    out_dir: str,
    sample_fps: float = 10.0,
    analysis_width: int = 480,
    bbox_diff_tolerance: float = 0.03,
) -> ReportBundle:
    out = Path(out_dir)
    shots_dir = out / "screenshots"
    shots_dir.mkdir(parents=True, exist_ok=True)

    master_info = probe_video(master_path)
    deliver_info = probe_video(deliver_path)
    geometry_issues = compare_geometry(master_info, deliver_info)

    if not windows:
        windows = default_windows(min(master_info.duration,
                                      deliver_info.duration))

    master_windows: list[WindowAnalysis] = []
    deliver_windows: list[WindowAnalysis] = []
    comparisons = []

    for spec in windows:
        m_raw, _ = extract_gray_frames(
            master_info, spec.start, spec.end, sample_fps, analysis_width)
        d_raw, _ = extract_gray_frames(
            deliver_info, spec.start, spec.end, sample_fps, analysis_width)
        m_analysis = analyze_window(spec.window_id, spec.start, spec.end, m_raw)
        d_analysis = analyze_window(spec.window_id, spec.start, spec.end, d_raw)
        cmp_ = compare_window(m_analysis, d_analysis,
                              bbox_diff_tolerance=bbox_diff_tolerance,
                              sample_fps=sample_fps)

        # 只对需要人看的结论（差异/切换/待确认）出并排截图
        if cmp_.diff_type in (DiffType.BOUNDS_DIFF, DiffType.ASPECT_SWITCH,
                              DiffType.INSUFFICIENT) and cmp_.evidence_time is not None:
            shot_name = f"{spec.window_id}_t{cmp_.evidence_time:.2f}.jpg"
            shot_path = shots_dir / shot_name
            try:
                render_side_by_side(
                    master_info, deliver_info, cmp_.evidence_time,
                    master_bbox=m_analysis.summary_bbox_norm,
                    deliver_bbox=d_analysis.summary_bbox_norm,
                    out_path=str(shot_path),
                )
                cmp_.screenshot = f"screenshots/{shot_name}"
            except Exception as exc:  # 截图失败不应拖垮整份报告
                cmp_.notes.append(f"证据截图生成失败: {exc}")

        master_windows.append(m_analysis)
        deliver_windows.append(d_analysis)
        comparisons.append(cmp_)

    return ReportBundle(
        master_info=master_info,
        deliver_info=deliver_info,
        windows=master_windows,
        deliver_windows=deliver_windows,
        comparisons=comparisons,
        geometry_issues=geometry_issues,
        sample_fps=sample_fps,
        analysis_width=analysis_width,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="aspect-inspector",
        description="离线画幅巡检：对比母版与转码交付文件的有效画面边界",
    )
    parser.add_argument("master", help="母版视频路径")
    parser.add_argument("deliver", help="转码交付视频路径")
    parser.add_argument("--windows", help="抽检时间窗，如 w1=0-2,w2=5-8")
    parser.add_argument("--config", help="时间窗 JSON 配置文件")
    parser.add_argument("--out", default="aspect_report", help="报告输出目录")
    parser.add_argument("--sample-fps", type=float, default=10.0,
                        help="窗内采样帧率（默认 10fps）")
    parser.add_argument("--analysis-width", type=int, default=480,
                        help="分析用缩放宽度（默认 480px）")
    parser.add_argument("--bbox-tolerance", type=float, default=0.03,
                        help="归一化边界差异容差（默认 0.03）")
    parser.add_argument("--version", action="version", version=__version__)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        windows = load_windows(args.windows, args.config)
        bundle = run_inspection(
            args.master, args.deliver, windows, args.out,
            sample_fps=args.sample_fps,
            analysis_width=args.analysis_width,
            bbox_diff_tolerance=args.bbox_tolerance,
        )
        write_json(bundle, str(Path(args.out) / "report.json"))
        write_html(bundle, str(Path(args.out) / "report.html"))
    except (ProbeError, FFmpegError, FileNotFoundError, ValueError,
            OSError) as exc:
        print(f"[错误] {exc}", file=sys.stderr)
        return 2

    n_diff = sum(1 for c in bundle.comparisons
                 if c.diff_type == DiffType.BOUNDS_DIFF and c.confirmed)
    n_pending = sum(1 for c in bundle.comparisons if not c.confirmed)
    n_switch = sum(1 for c in bundle.comparisons
                   if c.diff_type == DiffType.ASPECT_SWITCH)
    print(f"巡检完成：{len(bundle.comparisons)} 个时间窗 | "
          f"确认边界差异 {n_diff} | 画幅切换 {n_switch} | 待确认 {n_pending}")
    print(f"报告：{Path(args.out) / 'report.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
