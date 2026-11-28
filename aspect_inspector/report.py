"""报告输出：结构化 JSON + 可离线打开的单文件 HTML。

HTML 不引用任何外部资源（无 CDN/字体/网络图片），截图用相对路径，
整个报告目录拷走即可在任意机器上打开。
"""

from __future__ import annotations

import html
import json
from dataclasses import asdict, dataclass
from pathlib import Path

from .analysis import WindowAnalysis
from .compare import DiffType, WindowComparison
from .probe import VideoInfo


@dataclass
class ReportBundle:
    master_info: VideoInfo
    deliver_info: VideoInfo
    windows: list[WindowAnalysis]            # 母版窗分析
    deliver_windows: list[WindowAnalysis]    # 交付版窗分析
    comparisons: list[WindowComparison]
    geometry_issues: list[str]
    sample_fps: float
    analysis_width: int

    def to_dict(self) -> dict:
        return {
            "master": _info_dict(self.master_info),
            "deliver": _info_dict(self.deliver_info),
            "params": {
                "sample_fps": self.sample_fps,
                "analysis_width_px": self.analysis_width,
            },
            "geometry_issues": self.geometry_issues,
            "windows": [
                {
                    "master": _window_dict(m),
                    "deliver": _window_dict(d),
                    "comparison": asdict(c),
                }
                for m, d, c in zip(self.windows, self.deliver_windows,
                                   self.comparisons)
            ],
        }


def _info_dict(info: VideoInfo) -> dict:
    return {
        "path": info.path,
        "codec": info.codec,
        "storage_size": [info.width, info.height],
        "sar": str(info.sar),
        "rotation_deg": info.rotation,
        "hflip": info.hflip,
        "display_size": [round(info.display_width, 2),
                         round(info.display_height, 2)],
        "display_aspect": str(info.display_aspect),
        "duration_sec": round(info.duration, 3),
        "frame_rate": round(info.frame_rate, 3),
    }


def _window_dict(w: WindowAnalysis) -> dict:
    return {
        "window_id": w.window_id,
        "start": w.start,
        "end": w.end,
        "duration": round(w.duration, 3),
        "status": w.status,
        "frame_size_px": [w.frame_width, w.frame_height],
        "sampled_count": w.sampled_count,
        "content_count": w.content_count,
        "black_count": w.black_count,
        "black_ranges": w.black_ranges,
        "summary_bbox_norm": w.summary_bbox_norm,
        "segments": [asdict(s) for s in w.segments],
    }


def write_json(bundle: ReportBundle, out_path: str) -> None:
    Path(out_path).write_text(
        json.dumps(bundle.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


_STATUS_LABEL = {
    DiffType.MATCH: ("一致", "ok"),
    DiffType.BOUNDS_DIFF: ("边界差异", "bad"),
    DiffType.ASPECT_SWITCH: ("画幅切换", "warn"),
    DiffType.ALL_BLACK: ("全黑窗", "muted"),
    DiffType.INSUFFICIENT: ("待确认", "pending"),
    DiffType.GEOMETRY_MISMATCH: ("几何不一致", "bad"),
}


def _fmt_bbox(bbox) -> str:
    if bbox is None:
        return "—"
    return "(" + ", ".join(f"{v:.3f}" for v in bbox) + ")"


def write_html(bundle: ReportBundle, out_path: str) -> None:
    b = bundle
    parts: list[str] = [
        "<!DOCTYPE html><html lang='zh-CN'><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width, initial-scale=1'>",
        "<title>画幅巡检报告</title><style>",
        _CSS, "</style></head><body>",
        "<h1>画幅巡检报告</h1>",
        _render_meta(b),
    ]
    if b.geometry_issues:
        parts.append("<div class='card bad'><h2>显示几何差异</h2><ul>")
        for issue in b.geometry_issues:
            parts.append(f"<li>{html.escape(issue)}</li>")
        parts.append("</ul></div>")

    counts: dict[str, int] = {}
    for c in b.comparisons:
        counts[c.diff_type.value] = counts.get(c.diff_type.value, 0) + 1
    parts.append(
        "<div class='card'><h2>结论汇总</h2><p>"
        + " ".join(f"<span class='pill {_STATUS_LABEL[DiffType(k)][1]}'>"
                   f"{_STATUS_LABEL[DiffType(k)][0]} × {v}</span>"
                   for k, v in sorted(counts.items()))
        + "</p></div>"
    )

    for m, d, cmp_ in zip(b.windows, b.deliver_windows, b.comparisons):
        parts.append(_render_window(m, d, cmp_))
    parts.append("</body></html>")
    Path(out_path).write_text("".join(parts), encoding="utf-8")


def _render_meta(b: ReportBundle) -> str:
    m, d = b.master_info, b.deliver_info
    return (
        "<div class='card'><h2>素材信息（显示坐标）</h2><table>"
        f"<tr><th></th><th>母版</th><th>交付版</th></tr>"
        f"<tr><td>文件</td><td>{html.escape(m.path)}</td>"
        f"<td>{html.escape(d.path)}</td></tr>"
        f"<tr><td>编码尺寸</td><td>{m.width}×{m.height}</td>"
        f"<td>{d.width}×{d.height}</td></tr>"
        f"<tr><td>旋转 / 翻转</td><td>{m.rotation}° / {'是' if m.hflip else '否'}</td>"
        f"<td>{d.rotation}° / {'是' if d.hflip else '否'}</td></tr>"
        f"<tr><td>SAR</td><td>{m.sar}</td><td>{d.sar}</td></tr>"
        f"<tr><td>显示尺寸（方形像素当量）</td>"
        f"<td>{m.display_width:.1f}×{m.display_height:.1f}</td>"
        f"<td>{d.display_width:.1f}×{d.display_height:.1f}</td></tr>"
        f"<tr><td>显示宽高比</td><td>{m.display_aspect}</td>"
        f"<td>{d.display_aspect}</td></tr>"
        f"<tr><td>时长 / 帧率</td><td>{m.duration:.2f}s / {m.frame_rate:.2f}fps</td>"
        f"<td>{d.duration:.2f}s / {d.frame_rate:.2f}fps</td></tr>"
        "</table>"
        f"<p class='muted'>采样 {b.sample_fps} fps，分析宽度 {b.analysis_width}px；"
        "边界坐标为归一化显示坐标 (x0,y0,x1,y1)，可按显示尺寸换算回像素。</p></div>"
    )


def _render_window(m: WindowAnalysis, d: WindowAnalysis,
                   cmp_: WindowComparison) -> str:
    label, cls = _STATUS_LABEL[cmp_.diff_type]
    confirm = "已确认" if cmp_.confirmed else "<b>待确认</b>"
    parts = [
        f"<div class='card {cls}'><h2>时间窗 {html.escape(cmp_.window_id)} "
        f"[{cmp_.start:.2f}s – {cmp_.end:.2f}s，时长 {cmp_.end - cmp_.start:.2f}s] "
        f"<span class='pill {cls}'>{label}</span> "
        f"<span class='pill {'ok' if cmp_.confirmed else 'pending'}'>{confirm}</span></h2>"
    ]
    parts.append(
        "<table><tr><th></th><th>母版</th><th>交付版</th></tr>"
        f"<tr><td>窗口状态</td><td>{m.status}</td><td>{d.status}</td></tr>"
        f"<tr><td>采样帧（内容/全黑）</td><td>{m.sampled_count}（{m.content_count}/{m.black_count}）</td>"
        f"<td>{d.sampled_count}（{d.content_count}/{d.black_count}）</td></tr>"
        f"<tr><td>代表性有效边界</td><td>{_fmt_bbox(m.summary_bbox_norm)}</td>"
        f"<td>{_fmt_bbox(d.summary_bbox_norm)}</td></tr>"
        f"<tr><td>画幅分段数</td><td>{len(m.segments)}</td>"
        f"<td>{len(d.segments)}</td></tr>"
        f"<tr><td>最大边界偏差</td><td colspan='2'>"
        f"{cmp_.max_bbox_deviation if cmp_.max_bbox_deviation is not None else '—'}</td></tr>"
        "</table>"
    )
    if m.black_ranges or d.black_ranges:
        parts.append("<p class='muted'>黑场区间 — "
                     f"母版: {m.black_ranges or '无'}；交付版: {d.black_ranges or '无'}</p>")
    parts.append("<h3>分段明细</h3><table><tr><th>来源</th><th>时间段</th>"
                 "<th>有效边界(归一化)</th><th>占画面宽/高</th><th>内容帧</th>"
                 "<th>黑帧</th><th>结论</th></tr>")
    for side_name, w in (("母版", m), ("交付版", d)):
        if not w.segments:
            parts.append(f"<tr><td>{side_name}</td><td colspan='6'>"
                         f"{'全黑，无内容段' if w.status == 'all_black' else '无足够采样'}</td></tr>")
        for s in w.segments:
            parts.append(
                f"<tr><td>{side_name}</td><td>{s.start_time:.2f}–{s.end_time:.2f}s</td>"
                f"<td>{_fmt_bbox(s.bbox_norm)}</td>"
                f"<td>{s.width_fraction:.3f} / {s.height_fraction:.3f}</td>"
                f"<td>{s.frame_count}</td><td>{s.black_frame_count}</td>"
                f"<td>{html.escape(s.note) if s.note else '确认'}</td></tr>"
            )
    parts.append("</table>")
    if cmp_.notes:
        parts.append("<ul class='notes'>"
                     + "".join(f"<li>{html.escape(n)}</li>" for n in cmp_.notes)
                     + "</ul>")
    if cmp_.screenshot:
        parts.append(
            f"<h3>证据截图（源片时间轴 {cmp_.evidence_time:.2f}s）</h3>"
            f"<a href='{html.escape(cmp_.screenshot)}'>"
            f"<img class='shot' src='{html.escape(cmp_.screenshot)}' "
            "loading='lazy' alt='并排证据截图'></a>"
            "<p class='muted'>左：母版（绿框）；右：交付版（橙框）。点击可查看原图。</p>"
        )
    parts.append("</div>")
    return "".join(parts)


_CSS = """
body{font-family:-apple-system,'PingFang SC','Segoe UI',sans-serif;margin:24px;
background:#f5f6f8;color:#1d1d1f;line-height:1.5}
h1{font-size:22px} h2{font-size:16px;margin:0 0 10px} h3{font-size:14px;margin:14px 0 6px}
.card{background:#fff;border-radius:10px;padding:16px 20px;margin:14px 0;
box-shadow:0 1px 3px rgba(0,0,0,.08);border-left:4px solid #bbb}
.card.ok{border-left-color:#2e9e5b} .card.bad{border-left-color:#d64545}
.card.warn{border-left-color:#e08a00} .card.pending{border-left-color:#7a5cff}
.card.muted{border-left-color:#999;opacity:.92}
table{border-collapse:collapse;width:100%;font-size:13px;margin:6px 0}
th,td{border:1px solid #e2e2e6;padding:5px 8px;text-align:left;vertical-align:top}
th{background:#fafafa}
.pill{display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;
color:#fff;background:#888;margin-right:6px}
.pill.ok{background:#2e9e5b}.pill.bad{background:#d64545}.pill.warn{background:#e08a00}
.pill.pending{background:#7a5cff}.pill.muted{background:#999}
.muted{color:#777;font-size:12px}.notes{font-size:13px}
img.shot{max-width:100%;border:1px solid #ddd;border-radius:6px}
"""
