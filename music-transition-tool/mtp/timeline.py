"""把转场计划解析成采样精确的时间线。

坐标约定（全部为整数采样、右端开区间）：

全局时间线：
    0 ──────────────────────────────────────────────► total_samples

每条转场 t 有一个“同步点” sync_sample = P：
    入场素材的 entry_sample 恰好落在全局 P（第一拍对齐点）。

交叉淡变有长度 D 与锚点 anchor，决定重叠区间 [enter_sample, exit_sample)：
    anchor="start"  : enter=P,         exit=P+D   （P 在淡变起点）
    anchor="center" : enter=P-floor(D/2), exit=enter+D（P 近似居中）
    anchor="end"    : enter=P-D,       exit=P     （P 在淡变终点）
无重叠切换 mode="cut"：D=0，enter=exit=P；
    旧声部读到 P 为止（不含 P），新声部从 P 开始，没有任何重叠采样。

每个节目条目对应一条 Voice：
    sync_sample/entry_sample 决定源采样映射；
    [enter_global, exit_global) 是它在全局时间线上真正参与混音的区间；
    fade_in/fade_out 是可选的增益包络 (start_sample, duration, curve)。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .errors import PlanError
from .timeutil import (
    beats_to_samples,
    duration_to_samples,
    resolve_position_sample,
    samples_to_seconds,
    samples_to_timecode,
)

VALID_MODES = ("cut", "crossfade")
VALID_CURVES = ("linear", "equal_power")
VALID_ANCHORS = ("start", "center", "end")


@dataclass
class TransitionSpec:
    id: str
    index: int                 # 第几条转场，从 1 开始
    cue_id: str
    from_asset: str | None
    to_asset: str
    at_expression: object
    at_beats: float | None
    sync_sample: int
    mode: str
    curve: str | None
    anchor: str | None
    duration_samples: int
    enter_sample: int
    exit_sample: int           # 开区间右端
    pre_samples: int           # sync - enter
    post_samples: int          # exit - sync
    preview_start: int
    preview_end: int
    preview_pre_roll: int
    preview_post_roll: int

    @property
    def overlap_samples(self) -> int:
        return self.exit_sample - self.enter_sample


@dataclass
class Voice:
    asset_id: str
    cue_id: str
    index: int
    sync_sample: int
    entry_sample: int
    enter_global: int
    exit_global: int
    fade_in: tuple | None = None    # (start, duration, curve)
    fade_out: tuple | None = None
    intro_transition_id: str | None = None
    outro_transition_id: str | None = None


@dataclass
class ResolvedCue:
    id: str
    index: int
    asset_id: str
    at_expression: object
    at_beats: float | None
    sync_sample: int
    entry_sample: int


@dataclass
class Timeline:
    sample_rate: int
    bpm: float
    beats_per_bar: int
    total_samples: int
    output_channels: int
    output_gain: float
    cues: list[ResolvedCue] = field(default_factory=list)
    transitions: list[TransitionSpec] = field(default_factory=list)
    voices: list[Voice] = field(default_factory=list)
    preview_pre_beats: float = 2.0
    preview_post_beats: float = 2.0

    def transition_by_id(self, tid: str) -> TransitionSpec:
        for t in self.transitions:
            if t.id == tid:
                return t
        raise PlanError("计划中没有转场 id %r；可用: %s"
                        % (tid, ", ".join(t.id for t in self.transitions) or "(无)"))


def _normalize_mode(raw_mode) -> str:
    if raw_mode is None:
        return "cut"
    m = str(raw_mode).lower().replace("-", "_")
    aliases = {
        "cut": "cut", "switch": "cut", "no_overlap": "cut", "none": "cut",
        "crossfade": "crossfade", "fade": "crossfade", "overlap_fade": "crossfade",
        "overlap": "crossfade",
    }
    if m not in aliases:
        raise PlanError("不支持的转场模式 %r，可选 cut / crossfade" % raw_mode)
    return aliases[m]


def build_timeline(plan: dict, registry) -> Timeline:
    sr = int(plan.get("sample_rate") or registry.sample_rate())
    bpm = float(plan.get("bpm", 120))
    bpb = int(plan.get("beats_per_bar", 4))
    if bpm <= 0 or bpb <= 0:
        raise PlanError("bpm / beats_per_bar 必须为正数")

    out_cfg = plan.get("output", {}) or {}
    out_channels = int(out_cfg.get("channels", 2))
    if out_channels not in (1, 2):
        raise PlanError("output.channels 仅支持 1 或 2，本工具保留立体声左右声道")
    output_gain = float(out_cfg.get("gain", plan.get("output_gain", 1.0)))

    preview_cfg = plan.get("preview", {}) or {}
    pre_beats = float(preview_cfg.get("pre_roll_beats", 2))
    post_beats = float(preview_cfg.get("post_roll_beats", 2))
    pre_roll_samples = beats_to_samples(pre_beats, bpm, sr)
    post_roll_samples = beats_to_samples(post_beats, bpm, sr)

    program = plan.get("program")
    if not isinstance(program, list) or not program:
        raise PlanError("计划需要非空的 \"program\" 数组")

    # ---- 结束位置 ----
    if "end" in plan and plan["end"] is not None:
        total_samples = resolve_position_sample(plan["end"], bpm, bpb, sr)
    elif "duration_bars" in plan:
        total_samples = beats_to_samples(float(plan["duration_bars"]) * bpb, bpm, sr)
    elif "duration_beats" in plan:
        total_samples = beats_to_samples(float(plan["duration_beats"]), bpm, sr)
    else:
        raise PlanError("计划需要 \"end\" 位置或 duration_bars/duration_beats")
    if total_samples <= 0:
        raise PlanError("计划总长度必须为正采样数")

    cues: list[ResolvedCue] = []
    transitions: list[TransitionSpec] = []
    used_tr_ids = set()

    for i, cue_raw in enumerate(program):
        if not isinstance(cue_raw, dict):
            raise PlanError("program[%d] 必须是对象" % i)
        cue_id = cue_raw.get("id") or "cue_%d" % (i + 1)
        asset_id = cue_raw.get("asset")
        if not asset_id:
            raise PlanError("条目缺少 asset 字段", cue_id=cue_id)
        at_expr = cue_raw.get("at", "1.1" if i == 0 else None)
        if at_expr is None:
            raise PlanError("第 %d 个条目缺少 at 位置" % (i + 1), cue_id=cue_id)

        # 先取出转场 id 提示，保证素材缺失/损坏时错误能定位到对应转场
        tr_raw = cue_raw.get("transition") or {}
        tid_hint = tr_raw.get("id") if isinstance(tr_raw, dict) else None
        # 触发 WAV 加载/校验；素材未配置或不可读时直接抛带上下文的 PlanError
        registry.get(asset_id, transition_id=tid_hint, cue_id=cue_id)
        entry_sample = registry.configs[asset_id].entry_sample

        sync = resolve_position_sample(at_expr, bpm, bpb, sr)
        if sync < 0:
            raise PlanError("条目位置解析为负采样 %d" % sync, cue_id=cue_id)
        at_beats = _safe_position_beats(at_expr, bpb)

        if cues and sync <= cues[-1].sync_sample:
            raise PlanError(
                "条目位置必须严格递增：%s(sample=%d) 不晚于上一条 %s(sample=%d)"
                % (cue_id, sync, cues[-1].id, cues[-1].sync_sample),
                cue_id=cue_id,
            )
        if sync >= total_samples:
            raise PlanError(
                "条目 %s 的同步点 sample=%d 已到达/超过计划结束 sample=%d"
                % (cue_id, sync, total_samples),
                cue_id=cue_id,
            )

        cue = ResolvedCue(
            id=cue_id, index=i, asset_id=asset_id, at_expression=at_expr,
            at_beats=at_beats, sync_sample=sync, entry_sample=entry_sample,
        )
        cues.append(cue)

        if i == 0:
            continue

        tr = _build_transition(
            tr_raw if isinstance(tr_raw, dict) else {},
            index=i, cue=cue, prev_asset=cues[i - 1].asset_id,
            bpm=bpm, bpb=bpb, sr=sr, total_samples=total_samples,
            pre_roll_samples=pre_roll_samples,
            post_roll_samples=post_roll_samples,
            used_ids=used_tr_ids,
        )
        transitions.append(tr)

    # ---- 构建 voices ----
    voices: list[Voice] = []
    for i, cue in enumerate(cues):
        tr_in = transitions[i - 1] if i >= 1 else None
        tr_out = transitions[i] if i < len(transitions) else None

        if tr_in is not None:
            enter = tr_in.enter_sample
            fade_in = ((tr_in.enter_sample, tr_in.duration_samples, tr_in.curve)
                       if tr_in.mode == "crossfade" else None)
            in_tid = tr_in.id
        else:
            enter = cue.sync_sample
            fade_in = None
            in_tid = None

        if tr_out is not None:
            exit_g = tr_out.exit_sample
            fade_out = ((tr_out.enter_sample, tr_out.duration_samples, tr_out.curve)
                        if tr_out.mode == "crossfade" else None)
            out_tid = tr_out.id
        else:
            exit_g = total_samples
            fade_out = None
            out_tid = None

        if exit_g <= enter:
            raise PlanError(
                "条目 %s 的发声区间为空：enter=%d exit=%d" % (cue.id, enter, exit_g),
                transition_id=out_tid or in_tid, cue_id=cue.id,
            )

        # 同一个声部的淡入还没结束，下一个淡变又要它淡出 —— 语义会互相叠加，
        # 明确报错而不是给出难以核对的包络。
        if fade_in is not None and fade_out is not None:
            fi_end = fade_in[0] + fade_in[1]
            fo_start = fade_out[0]
            if fo_start < fi_end:
                raise PlanError(
                    "条目 %s（素材 %s）的淡入在 sample=%d 才结束，"
                    "但下一条转场在 sample=%d 就要求它开始淡出；"
                    "请拉开转场间距或缩短淡变时长。"
                    % (cue.id, cue.asset_id, fi_end, fo_start),
                    transition_id=out_tid, cue_id=cue.id,
                )

        voices.append(Voice(
            asset_id=cue.asset_id, cue_id=cue.id, index=i,
            sync_sample=cue.sync_sample, entry_sample=cue.entry_sample,
            enter_global=enter, exit_global=exit_g,
            fade_in=fade_in, fade_out=fade_out,
            intro_transition_id=in_tid, outro_transition_id=out_tid,
        ))

    return Timeline(
        sample_rate=sr, bpm=bpm, beats_per_bar=bpb,
        total_samples=total_samples, output_channels=out_channels,
        output_gain=output_gain, cues=cues, transitions=transitions,
        voices=voices, preview_pre_beats=pre_beats, preview_post_beats=post_beats,
    )


def _safe_position_beats(value, bpb):
    try:
        from .timeutil import position_to_beats, _SamplePosition
        try:
            return position_to_beats(value, bpb)
        except _SamplePosition:
            return None
    except Exception:
        return None


def _build_transition(raw: dict, index: int, cue: ResolvedCue, prev_asset: str,
                      bpm, bpb, sr, total_samples,
                      pre_roll_samples, post_roll_samples,
                      used_ids: set) -> TransitionSpec:
    tid = raw.get("id") or "tr_%d" % index
    if tid in used_ids:
        raise PlanError("转场 id 重复: %r" % tid, transition_id=tid)
    used_ids.add(tid)

    mode = _normalize_mode(raw.get("mode", "cut"))
    curve = None
    anchor = None
    duration = 0

    if mode == "cut":
        if any(k in raw for k in ("duration_beats", "duration_samples",
                                  "duration_seconds", "overlap_beats")):
            raise PlanError(
                "mode=\"cut\" 是无重叠切换，不能设置淡变时长；"
                "需要重叠淡变请用 mode=\"crossfade\"",
                transition_id=tid, cue_id=cue.id,
            )
        enter = exit_s = cue.sync_sample
        pre = post = 0
    else:
        curve = str(raw.get("curve", "equal_power"))
        if curve not in VALID_CURVES:
            raise PlanError("不支持的淡变曲线 %r，可选 %s" % (curve, VALID_CURVES),
                            transition_id=tid)
        anchor = str(raw.get("anchor", "center"))
        if anchor not in VALID_ANCHORS:
            raise PlanError("不支持的锚点 %r，可选 %s" % (anchor, VALID_ANCHORS),
                            transition_id=tid)
        dur_spec = dict(raw)
        if "overlap_beats" in raw and "duration_beats" not in raw:
            dur_spec["duration_beats"] = raw["overlap_beats"]
        if any(k in dur_spec for k in ("duration_beats", "duration_samples",
                                      "duration_seconds")):
            duration = duration_to_samples(dur_spec, bpm, sr, what="转场 %s" % tid)
        else:
            duration = beats_to_samples(1.0, bpm, sr)
        if duration <= 0:
            raise PlanError("淡变时长必须为正（解析为 %d 采样）" % duration,
                            transition_id=tid)

        anchor_offset = {"start": 0, "center": duration // 2,
                         "end": duration}[anchor]
        enter = cue.sync_sample - anchor_offset
        exit_s = enter + duration
        pre = cue.sync_sample - enter
        post = exit_s - cue.sync_sample

        if enter < 0:
            raise PlanError(
                "转场 %s 的重叠区间起点 sample=%d 早于时间线原点 0；"
                "请把该条目后移或缩短淡变。" % (tid, enter),
                transition_id=tid, cue_id=cue.id,
            )
        if exit_s > total_samples:
            raise PlanError(
                "转场 %s 的重叠区间终点 sample=%d 超过计划结束 sample=%d；"
                "请延长 end 或缩短淡变。" % (tid, exit_s, total_samples),
                transition_id=tid, cue_id=cue.id,
            )

    pv_start = max(0, enter - pre_roll_samples)
    pv_end = min(total_samples, exit_s + post_roll_samples)
    if pv_end <= pv_start:
        raise PlanError("转场 %s 的预听区间为空" % tid, transition_id=tid)

    return TransitionSpec(
        id=tid, index=index, cue_id=cue.id,
        from_asset=prev_asset, to_asset=cue.asset_id,
        at_expression=cue.at_expression, at_beats=cue.at_beats,
        sync_sample=cue.sync_sample, mode=mode, curve=curve, anchor=anchor,
        duration_samples=duration, enter_sample=enter, exit_sample=exit_s,
        pre_samples=pre, post_samples=post,
        preview_start=pv_start, preview_end=pv_end,
        preview_pre_roll=enter - pv_start,
        preview_post_roll=pv_end - exit_s,
    )
