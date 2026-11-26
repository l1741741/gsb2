"""转场清单：把音乐位置和所有边界解析到可核对的采样坐标。"""

from __future__ import annotations

import csv
import io
import json
import math

from .timeutil import samples_to_seconds, samples_to_timecode

GAIN_THRESHOLD = 1e-3  # 约 -60 dB，用来报告“真正听得到”的有效边界


def _bar_beat(beats, bpb):
    if beats is None:
        return None
    bar0, beat0 = divmod(beats, bpb)
    return {"bar": int(bar0) + 1, "beat": round(beat0 + 1, 6)}


def _num(x):
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return str(x)


def format_expression(expr) -> str:
    """把位置输入规范成易读形式，如 {"bar":3,"beat":1} -> "3.1"。"""
    if isinstance(expr, str):
        return expr
    if isinstance(expr, (int, float)):
        return "%s 拍" % _num(expr)
    if isinstance(expr, dict):
        if "bar" in expr:
            return "%s.%s" % (expr["bar"], _num(expr.get("beat", 1)))
        if "beats" in expr:
            return "%s 拍" % _num(expr["beats"])
        if "sample" in expr:
            return "@%s 采样" % expr["sample"]
    return str(expr)


def _wrap_source(sample: int, cfg) -> int:
    """循环素材的源采样坐标 -> 实际 WAV 内被读取的采样（模循环区间）。"""
    if cfg is not None and cfg.loop_start is not None:
        l0, l1 = cfg.loop_start, cfg.loop_end
        return l0 + (sample - l0) % (l1 - l0)
    return sample


def _effective_bounds(mode, curve, duration):
    """返回 (in_first_k, out_last_k)：相对 overlap 起点的整数偏移。

    in_first_k: 淡入增益首次 >= 阈值的偏移；
    out_last_k: 淡出增益仍 >= 阈值的最后一个偏移（含）。
    """
    if mode == "cut" or duration == 0:
        return 0, -1
    eps = GAIN_THRESHOLD
    if curve == "linear":
        # in(k)=k/D >= eps  => k >= ceil(eps*D)
        in_k = int(math.ceil(eps * duration))
        # out(k)=1-k/D >= eps => k <= (1-eps)D
        out_k = int(math.floor((1.0 - eps) * duration))
    else:  # equal_power: in=sin(pi k/2D), out=cos(pi k/2D)
        theta = math.asin(min(1.0, eps))
        in_k = int(math.floor(theta * 2.0 * duration / math.pi)) + 1
        out_k = int(math.ceil(math.acos(min(1.0, eps)) * 2.0 * duration / math.pi)) - 1
    in_k = max(0, min(in_k, duration - 1))
    out_k = max(0, min(out_k, duration - 1))
    return in_k, out_k


def build_transition_record(tl, tr, registry=None) -> dict:
    sr = tl.sample_rate
    in_cue = tl.cues[tr.index]
    out_cue = tl.cues[tr.index - 1]
    in_cfg = registry.configs.get(tr.to_asset) if registry is not None else None
    out_cfg = registry.configs.get(tr.from_asset) if registry is not None else None

    def tc(s):
        return samples_to_timecode(s, sr)

    in_k, out_k = _effective_bounds(tr.mode, tr.curve, tr.duration_samples)
    eff_enter = tr.enter_sample + in_k if tr.mode == "crossfade" else tr.sync_sample
    eff_exit_last = tr.enter_sample + out_k if tr.mode == "crossfade" else tr.sync_sample - 1

    # 两路“都还有有效信号”的区间（右端开区间）
    if tr.mode == "crossfade":
        both_start = eff_enter
        both_end_excl = eff_exit_last + 1
        both_len = max(0, both_end_excl - both_start)
    else:
        both_start = both_end_excl = tr.sync_sample
        both_len = 0

    incoming_src_at_enter = in_cue.entry_sample - tr.pre_samples
    outgoing_src_at_enter = out_cue.entry_sample + (tr.enter_sample - out_cue.sync_sample)
    outgoing_src_at_exit = out_cue.entry_sample + (tr.exit_sample - out_cue.sync_sample)

    rec = {
        "id": tr.id,
        "index": tr.index,
        "cue_id": tr.cue_id,
        "plan_position": {
            "expression": tr.at_expression,
            "beats_from_origin": tr.at_beats,
            **(_bar_beat(tr.at_beats, tl.beats_per_bar) or {}),
        },
        "sync": {
            "sample": tr.sync_sample,
            "seconds": round(samples_to_seconds(tr.sync_sample, sr), 6),
            "timecode": tc(tr.sync_sample),
            "note": "全局采样；入场素材的 entry_sample 对齐到这里",
        },
        "mode": tr.mode,
        "curve": tr.curve,
        "anchor": tr.anchor,
        "duration": {
            "samples": tr.duration_samples,
            "beats": round(tr.duration_samples * tl.bpm / (60.0 * sr), 6)
            if tr.duration_samples else 0.0,
            "seconds": round(samples_to_seconds(tr.duration_samples, sr), 6),
        },
        "overlap": {
            "start_sample": tr.enter_sample,
            "end_sample_exclusive": tr.exit_sample,
            "last_sample_inclusive": tr.exit_sample - 1,
            "length_samples": tr.overlap_samples,
            "length_seconds": round(tr.overlap_samples / sr, 6),
            "start_timecode": tc(tr.enter_sample),
            "end_timecode": tc(tr.exit_sample),
        },
        "incoming": {
            "asset": tr.to_asset,
            "cue_id": tr.cue_id,
            "entry_sample": in_cue.entry_sample,
            "actual_enter_sample": tr.enter_sample,
            "actual_enter_timecode": tc(tr.enter_sample),
            "source_sample_at_actual_enter": incoming_src_at_enter,
            "wav_sample_read_at_actual_enter": _wrap_source(incoming_src_at_enter, in_cfg),
            "pre_roll_samples": tr.pre_samples,
            "effective_enter_sample_gain_ge_%g" % GAIN_THRESHOLD: eff_enter,
        },
        "outgoing": {
            "asset": tr.from_asset,
            "cue_id": out_cue.id,
            "entry_sample": out_cue.entry_sample,
            # 声部最后一个被累加的采样是 exit_sample-1，exit_sample 是开区间右端
            "actual_exit_sample_exclusive": tr.exit_sample,
            "actual_last_sample_inclusive": tr.exit_sample - 1,
            "actual_exit_timecode": tc(tr.exit_sample),
            "source_sample_at_overlap_start": outgoing_src_at_enter,
            "wav_sample_read_at_overlap_start": _wrap_source(outgoing_src_at_enter, out_cfg),
            "source_sample_at_actual_exit_exclusive": outgoing_src_at_exit,
            "wav_sample_read_at_actual_exit_exclusive": _wrap_source(outgoing_src_at_exit, out_cfg),
            "effective_last_sample_gain_ge_%g" % GAIN_THRESHOLD: eff_exit_last,
        },
        "both_effective": {
            "threshold_gain": GAIN_THRESHOLD,
            "start_sample": both_start,
            "end_sample_exclusive": both_end_excl,
            "length_samples": both_len,
            "start_timecode": tc(both_start),
            "end_timecode": tc(both_end_excl),
            "note": "两路增益都不低于阈值、可同时听到的区间；cut 时长度为 0",
        },
        "preview_region": {
            "start_sample": tr.preview_start,
            "end_sample_exclusive": tr.preview_end,
            "length_samples": tr.preview_end - tr.preview_start,
            "start_timecode": tc(tr.preview_start),
            "end_timecode": tc(tr.preview_end),
            "pre_roll_samples": tr.preview_pre_roll,
            "post_roll_samples": tr.preview_post_roll,
            "identity": "该区间导出的 WAV 必须与全程 WAV 的同采样区间逐采样一致",
        },
        "checks": {},
    }
    return rec


def build_report(tl, registry=None) -> dict:
    records = []
    for tr in tl.transitions:
        rec = build_transition_record(tl, tr, registry)
        if registry is not None:
            for role, aid in (("incoming", tr.to_asset), ("outgoing", tr.from_asset)):
                cfg = registry.configs.get(aid)
                if cfg is None:
                    continue
                beats = cfg.beats
                entry = cfg.entry_sample
                rec["checks"]["%s_entry_is_configured_beat" % role] = entry in beats
                # 同步点对应的源拍点（entry）附近配置的拍点
                rec["checks"]["%s_configured_beat_count" % role] = len(beats)
        records.append(rec)

    return {
        "tool": "music-transition-tool",
        "version": "1.0.0",
        "project": {
            "sample_rate": tl.sample_rate,
            "bpm": tl.bpm,
            "beats_per_bar": tl.beats_per_bar,
            "output_channels": tl.output_channels,
            "output_gain": tl.output_gain,
            "total_samples": tl.total_samples,
            "total_seconds": round(tl.total_samples / tl.sample_rate, 6),
            "total_timecode": samples_to_timecode(tl.total_samples, tl.sample_rate),
            "preview_defaults": {
                "pre_roll_beats": tl.preview_pre_beats,
                "post_roll_beats": tl.preview_post_beats,
            },
        },
        "cues": [
            {
                "id": c.id, "index": c.index, "asset": c.asset_id,
                "at": c.at_expression,
                "sync_sample": c.sync_sample,
                "sync_timecode": samples_to_timecode(c.sync_sample, tl.sample_rate),
                "entry_sample": c.entry_sample,
            }
            for c in tl.cues
        ],
        "transitions": records,
    }


def report_json(tl, registry=None, indent=2) -> str:
    return json.dumps(build_report(tl, registry), ensure_ascii=False, indent=indent)


# ---------------- Markdown / CSV ----------------

def report_markdown(tl, registry=None) -> str:
    rep = build_report(tl, registry)
    p = rep["project"]
    lines = []
    lines.append("# 转场清单")
    lines.append("")
    lines.append("- 采样率: %d Hz" % p["sample_rate"])
    lines.append("- 速度: %s BPM, %d/4" % (_fmt_num(p["bpm"]), p["beats_per_bar"]))
    lines.append("- 总长度: %d 采样 / %.3f 秒 / %s"
                 % (p["total_samples"], p["total_seconds"], p["total_timecode"]))
    lines.append("- 输出声道: %d（1=单声道, 2=保留左右立体声）" % p["output_channels"])
    lines.append("")
    if not tl.transitions:
        lines.append("计划中没有转场。")
        return "\n".join(lines) + "\n"

    lines.append("## 汇总表")
    lines.append("")
    headers = ["ID", "类型", "位置", "同步采样 P", "进入 E", "退出 X(开)",
               "重叠采样", "两路有效区间", "预听区间 [起,止)"]
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("|" + "---|" * len(headers))
    for r in rep["transitions"]:
        pos = r["plan_position"]
        pos_s = format_expression(pos.get("expression"))
        both = r["both_effective"]
        lines.append("| %s | %s%s | %s | %d | %d | %d | %d | [%d,%d) %d | [%d,%d) |" % (
            r["id"], r["mode"],
            ("/" + r["anchor"] + "/" + (r["curve"] or "")) if r["mode"] == "crossfade" else "",
            pos_s, r["sync"]["sample"],
            r["overlap"]["start_sample"], r["overlap"]["end_sample_exclusive"],
            r["overlap"]["length_samples"],
            both["start_sample"], both["end_sample_exclusive"], both["length_samples"],
            r["preview_region"]["start_sample"], r["preview_region"]["end_sample_exclusive"],
        ))
    lines.append("")

    lines.append("## 逐条核对")
    lines.append("")
    for r in rep["transitions"]:
        lines.append("### %s（#%d %s → %s）"
                     % (r["id"], r["index"], r["outgoing"]["asset"], r["incoming"]["asset"]))
        pp = r["plan_position"]
        lines.append("- 计划位置: `%s`（原始输入 %s）→ 第 %s 小节第 %s 拍（距原点 %s 拍）"
                     % (format_expression(pp.get("expression")),
                        json.dumps(pp.get("expression"), ensure_ascii=False),
                        pp.get("bar"), _num(pp.get("beat", 1)),
                        _num(pp.get("beats_from_origin"))))
        lines.append("- 同步点 P: **%d** 采样 = %s = %.6f 秒；入场素材 entry_sample=%d 对齐此处"
                     % (r["sync"]["sample"], r["sync"]["timecode"],
                        r["sync"]["seconds"], r["incoming"]["entry_sample"]))
        if r["mode"] == "cut":
            lines.append("- 无重叠切换: 旧声部读到 **%d**（不含），新声部从 **%d** 开始；"
                         "重叠 0 采样" % (r["sync"]["sample"], r["sync"]["sample"]))
        else:
            lines.append("- 交叉淡变(%s, anchor=%s): 实际进入 E=**%d** (%s)，"
                         "实际退出 X=**%d**（开区间右端，最后一声采样 %d，%s）；"
                         "重叠 %d 采样 (%.4f 拍 / %.3f 秒)"
                         % (r["curve"], r["anchor"],
                            r["overlap"]["start_sample"], r["overlap"]["start_timecode"],
                            r["overlap"]["end_sample_exclusive"],
                            r["overlap"]["last_sample_inclusive"],
                            r["overlap"]["end_timecode"],
                            r["overlap"]["length_samples"],
                            r["duration"]["beats"], r["duration"]["seconds"]))
            lines.append("  - 入场素材在 E 处的源坐标: %d（循环映射后实际读 WAV 采样 %d；负值表示从循环尾部预卷）；在 P 处: %d"
                         % (r["incoming"]["source_sample_at_actual_enter"],
                            r["incoming"]["wav_sample_read_at_actual_enter"],
                            r["incoming"]["entry_sample"]))
            lines.append("  - 出场素材在 E 处实际读 WAV 采样: %d；在 X 处(开)实际读: %d（源坐标分别为 %d / %d）"
                         % (r["outgoing"]["wav_sample_read_at_overlap_start"],
                            r["outgoing"]["wav_sample_read_at_actual_exit_exclusive"],
                            r["outgoing"]["source_sample_at_overlap_start"],
                            r["outgoing"]["source_sample_at_actual_exit_exclusive"]))
            lines.append("  - 增益≥%g 的有效区间: 入声从 %d 起，出声最后到 %d；"
                         "两路同时有效 [%d, %d) 共 %d 采样"
                         % (r["both_effective"]["threshold_gain"],
                            r["incoming"]["effective_enter_sample_gain_ge_%g" % GAIN_THRESHOLD],
                            r["outgoing"]["effective_last_sample_gain_ge_%g" % GAIN_THRESHOLD],
                            r["both_effective"]["start_sample"],
                            r["both_effective"]["end_sample_exclusive"],
                            r["both_effective"]["length_samples"]))
        pv = r["preview_region"]
        lines.append("- 单切点预听区间: **[%d, %d)**，长度 %d 采样（%s → %s）；"
                     "与全程 WAV 的该区间逐采样一致"
                     % (pv["start_sample"], pv["end_sample_exclusive"], pv["length_samples"],
                        pv["start_timecode"], pv["end_timecode"]))
        for k, v in r.get("checks", {}).items():
            lines.append("- 核对 %s: %s" % (k, v))
        lines.append("")
    return "\n".join(lines)


def report_csv(tl, registry=None) -> str:
    rep = build_report(tl, registry)
    buf = io.StringIO()
    cols = [
        "id", "index", "mode", "curve", "anchor", "from_asset", "to_asset",
        "plan_expression", "sync_sample", "sync_timecode",
        "enter_sample", "exit_sample_exclusive", "overlap_samples",
        "both_effective_start", "both_effective_end_exclusive",
        "preview_start", "preview_end_exclusive",
    ]
    w = csv.DictWriter(buf, fieldnames=cols)
    w.writeheader()
    for r in rep["transitions"]:
        w.writerow({
            "id": r["id"], "index": r["index"], "mode": r["mode"],
            "curve": r["curve"] or "", "anchor": r["anchor"] or "",
            "from_asset": r["outgoing"]["asset"], "to_asset": r["incoming"]["asset"],
            "plan_expression": format_expression(r["plan_position"]["expression"]),
            "sync_sample": r["sync"]["sample"],
            "sync_timecode": r["sync"]["timecode"],
            "enter_sample": r["overlap"]["start_sample"],
            "exit_sample_exclusive": r["overlap"]["end_sample_exclusive"],
            "overlap_samples": r["overlap"]["length_samples"],
            "both_effective_start": r["both_effective"]["start_sample"],
            "both_effective_end_exclusive": r["both_effective"]["end_sample_exclusive"],
            "preview_start": r["preview_region"]["start_sample"],
            "preview_end_exclusive": r["preview_region"]["end_sample_exclusive"],
        })
    return buf.getvalue()


def _fmt_num(x):
    if isinstance(x, float) and x.is_integer():
        return str(int(x))
    return str(x)
