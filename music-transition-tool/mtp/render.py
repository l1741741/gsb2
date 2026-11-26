"""区间渲染：同一份代码路径渲染任意全局区间。

一致性保证（需求 4）：
    full = render_interval(0, total)
    cue  = render_interval(t.preview_start, t.preview_end)
那么 cue.channels[c] 与 full.channels[c][ps:pe] 逐 float 相同。
原因是每个全局采样 g 的值只取决于：
    - 同一组按 index 排序的 voice；
    - g 自身对应的源采样与包络增益；
    - 按相同 voice 顺序做的浮点累加。
区间起点只改变放置偏移，不改变这些运算。
"""

from __future__ import annotations

import math
from array import array
from dataclasses import dataclass

from .errors import PlanError


@dataclass
class RenderResult:
    channels: list          # list[array('d')]，本区间从 global_start_sample 开始
    sample_rate: int
    global_start_sample: int

    @property
    def n_frames(self) -> int:
        return len(self.channels[0]) if self.channels else 0

    def slice_global(self, g0: int, g1: int):
        """按全局坐标取段，主要给测试做恒等核对。"""
        a = g0 - self.global_start_sample
        b = g1 - self.global_start_sample
        return [array("d", ch[a:b]) for ch in self.channels]


def fade_in_gain(curve: str, t: float) -> float:
    if t <= 0.0:
        return 0.0
    if t >= 1.0:
        return 1.0
    if curve == "linear":
        return t
    # equal_power：sin/cos 保证中点两路增益都是 sqrt(2)/2
    return math.sin(t * math.pi * 0.5)


def fade_out_gain(curve: str, t: float) -> float:
    if t <= 0.0:
        return 1.0
    if t >= 1.0:
        return 0.0
    if curve == "linear":
        return 1.0 - t
    return math.cos(t * math.pi * 0.5)


def voice_gain_at(voice, g: int) -> float:
    gain = 1.0
    fi = voice.fade_in
    if fi is not None:
        s, d, curve = fi
        if g < s:
            return 0.0
        if g < s + d:
            gain = fade_in_gain(curve, (g - s) / d)
    fo = voice.fade_out
    if fo is not None:
        s, d, curve = fo
        if g >= s + d:
            return 0.0
        if g >= s:
            gain *= fade_out_gain(curve, (g - s) / d)
    return gain


def _channel_map(asset_nch: int, out_nch: int):
    """返回 [(out_channel, source_channel), ...]。"""
    if out_nch == 2:
        if asset_nch == 1:
            return [(0, 0), (1, 0)]
        if asset_nch == 2:
            return [(0, 0), (1, 1)]
        raise PlanError("暂不支持 %d 声道素材输出到立体声" % asset_nch)
    if out_nch == 1:
        if asset_nch == 1:
            return [(0, 0)]
        # 多声道折叠为单声道时做等功率-ish 的 1/n 归一
        return [(0, c) for c in range(min(2, asset_nch))]
    raise PlanError("不支持的输出声道数 %d" % out_nch)


def render_interval(timeline, registry, g0: int, g1: int) -> RenderResult:
    if g1 < g0 or g0 < 0:
        raise PlanError("非法渲染区间 [%d, %d)" % (g0, g1))
    n = g1 - g0
    out_nch = timeline.output_channels
    mix = [array("d", [0.0]) * n for _ in range(out_nch)]
    if n == 0:
        return RenderResult(mix, timeline.sample_rate, g0)

    # timeline.voices 已按节目顺序排列；这个顺序就是浮点累加顺序，不能打乱。
    for voice in timeline.voices:
        a = max(g0, voice.enter_global)
        b = min(g1, voice.exit_global)
        if a >= b:
            continue
        length = b - a
        loaded = registry.get(
            voice.asset_id,
            transition_id=voice.outro_transition_id or voice.intro_transition_id,
            cue_id=voice.cue_id,
        )
        # 关键映射：全局 sync_sample 对齐源 entry_sample。
        source_start = voice.entry_sample + (a - voice.sync_sample)
        # 缺素材的归属：起点为负说明在“入场预卷”端越界 -> 归入场转场；
        # 否则通常是素材不够响到下一条转场 -> 归出场(下一条)转场。
        if source_start < 0:
            blame_tid = voice.intro_transition_id or voice.outro_transition_id
        else:
            blame_tid = voice.outro_transition_id or voice.intro_transition_id
        src = loaded.source.read(
            source_start, length,
            transition_id=blame_tid,
            cue_id=voice.cue_id,
            global_range=(a, b),
        )
        maps = _channel_map(loaded.wav.n_channels, out_nch)
        mono_downmix = out_nch == 1 and loaded.wav.n_channels > 1
        base = a - g0

        for i in range(length):
            g = a + i
            gain = voice_gain_at(voice, g)
            if gain == 0.0:
                continue
            for oc, sc in maps:
                v = src[sc][i] * gain
                if mono_downmix:
                    v *= 0.5
                idx = base + i
                mix[oc][idx] = mix[oc][idx] + v

    return RenderResult(mix, timeline.sample_rate, g0)


def render_full(timeline, registry) -> RenderResult:
    return render_interval(timeline, registry, 0, timeline.total_samples)


def render_transition_preview(timeline, registry, transition_id: str):
    tr = timeline.transition_by_id(transition_id)
    block = render_interval(timeline, registry, tr.preview_start, tr.preview_end)
    return block, tr
