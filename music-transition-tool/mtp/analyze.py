"""检测转场后第一拍（入场 entry 标记）在成品中的实际落点。

做法：从素材配置的 verify 段取已知模板（样例用公开的 chirp 模板，
普通素材可直接从 entry_sample 处取一段源波形），在指定输出声道上做
归一化匹配滤波，搜索 sync_sample 附近相关值最大的整数采样偏移。

全部 O(搜索半径 * 模板长度) 的纯 Python 运算，模板默认很短。
"""

from __future__ import annotations

import math
from array import array

from .errors import PlanError


def _channel_index(spec, n_channels: int):
    if n_channels == 1:
        return 0
    s = str(spec).upper()
    if s in ("L", "LEFT", "0"):
        return 0
    if s in ("R", "RIGHT", "1"):
        return 1
    if s in ("C", "CENTER", "MIX", "AUTO"):
        return "mix"
    raise PlanError("verify.channel 无法识别: %r（用 L/R/C/mix/auto）" % spec)


def resolve_template(asset_cfg, loaded_asset):
    """返回 (template array('d'), 建议声道 spec 或索引)。"""
    v = asset_cfg.verify or {}
    tpl_spec = v.get("template", "source")

    if tpl_spec in ("downbeat_chirp_v1", "downbeat_marker_v1", "chirp"):
        from .synth import marker_template
        tpl = marker_template()
        if "length" in v:
            tpl = array("d", tpl[:int(v["length"])])
    elif tpl_spec == "source":
        length = int(v.get("length", 128))
        start = asset_cfg.entry_sample + int(v.get("source_offset", 0))
        wav = loaded_asset.wav
        if start < 0 or start + length > wav.n_frames:
            raise PlanError(
                "verify 模板区间 [%d,%d) 超出素材 %r 的 WAV [0,%d)"
                % (start, start + length, asset_cfg.id, wav.n_frames)
            )
        ch_idx = v.get("channel", "auto")
        if ch_idx == "auto":
            ch_idx = _strongest_onset_channel(wav, start, length)
        ci = _channel_index(ch_idx, wav.n_channels)
        if ci == "mix":
            tpl = array("d", [0.0]) * length
            for c in wav.channels:
                for i in range(length):
                    tpl[i] += c[start + i] / wav.n_channels
        else:
            tpl = array("d", wav.channels[ci][start:start + length])
    else:
        raise PlanError("未知 verify.template: %r" % tpl_spec)

    channel_spec = v.get("channel", "auto")
    return tpl, channel_spec


def _strongest_onset_channel(wav, start, length):
    best_c, best_e = 0, -1.0
    for ci, ch in enumerate(wav.channels):
        e = 0.0
        end = min(len(ch) - 1, start + max(length, 256))
        for i in range(start + 1, end):
            d = ch[i] - ch[i - 1]
            e += d * d
        if e > best_e:
            best_e, best_c = e, ci
    return best_c


def _target_channel(output_channels: list, spec):
    """从输出声道里取出用于相关的一维数组。"""
    ci = _channel_index(spec, len(output_channels))
    if ci == "mix":
        if len(output_channels) == 1:
            return output_channels[0]
        mix = array("d", [0.0]) * len(output_channels[0])
        for ch in output_channels:
            for i, x in enumerate(ch):
                mix[i] += x / len(output_channels)
        return mix
    return output_channels[min(ci, len(output_channels) - 1)]


def matched_filter_lag(target, expected: int, template, radius: int):
    """返回 (best_lag, best_corr)。lag 是相对 expected 的整数采样偏移。

    归一化互相关；目标窗能量用滑窗递推，每个 lag 只做一次模板点积。
    """
    k = len(template)
    t_norm = math.sqrt(sum(t * t for t in template))
    n = len(target)

    lo = max(-radius, -expected)
    hi = min(radius, n - k - expected)
    if hi < lo:
        raise PlanError("搜索区间过小：expected=%d radius=%d target_len=%d k=%d"
                        % (expected, radius, n, k))

    t = template
    s0 = expected + lo
    energy = 0.0
    for i in range(k):
        x = target[s0 + i]
        energy += x * x

    best_lag = None
    best_corr = -2.0
    # 与主峰相距 >3 采样的最高相关，用来判断峰是否唯一、置信是否充分
    runner_up = -2.0
    s = s0
    lag = lo
    scores = []
    while lag <= hi:
        dot = 0.0
        for i in range(k):
            dot += target[s + i] * t[i]
        denom = t_norm * math.sqrt(energy)
        corr = dot / denom if denom > 1e-12 else 0.0
        scores.append((lag, corr))
        if corr > best_corr:
            best_corr = corr
            best_lag = lag
        # 能量窗从 [s, s+k) 滑到 [s+1, s+1+k)
        if lag < hi:
            x_out = target[s]
            x_in = target[s + k]
            energy += x_in * x_in - x_out * x_out
            if energy < 0.0:
                energy = 0.0
        s += 1
        lag += 1
    for lag_v, c in scores:
        if abs(lag_v - best_lag) > 3 and c > runner_up:
            runner_up = c
    return best_lag, best_corr, runner_up


def verify_landings(timeline, registry, output_channels: list,
                    global_start_sample: int = 0,
                    radius_samples: int | None = None,
                    corr_threshold: float = 0.35,
                    only_id: str | None = None) -> list:
    sr = timeline.sample_rate
    if radius_samples is None:
        radius_samples = sr // 4  # 120BPM 下约半拍（11025 采样）

    results = []
    for tr in timeline.transitions:
        if only_id is not None and tr.id != only_id:
            continue
        # 区间渲染（单切点预听）时，不在本区间内的转场无法核对，跳过。
        expected_local = tr.sync_sample - global_start_sample
        if not (0 <= expected_local < len(output_channels[0])):
            if only_id is not None:
                raise PlanError(
                    "转场 %s 的同步点 %d 不在预听区间起点 %d 之后的 %d 帧内"
                    % (tr.id, tr.sync_sample, global_start_sample,
                       len(output_channels[0]))
                )
            continue
        loaded = registry.get(tr.to_asset, transition_id=tr.id, cue_id=tr.cue_id)
        template, ch_spec = resolve_template(loaded.cfg, loaded)
        target = _target_channel(output_channels, ch_spec)
        lag, corr, runner_up = matched_filter_lag(
            target, expected_local, template, radius_samples
        )
        detected_global = tr.sync_sample + lag
        results.append({
            "transition_id": tr.id,
            "to_asset": tr.to_asset,
            "channel": ch_spec,
            "expected_sample": tr.sync_sample,
            "detected_sample": detected_global,
            "offset_samples": lag,
            "correlation": round(corr, 6),
            "runner_up_correlation": round(runner_up, 6),
            "peak_margin": round(corr - runner_up, 6),
            "template_length": len(template),
            "search_radius_samples": radius_samples,
            "passed": lag == 0 and corr >= corr_threshold,
            "corr_threshold": corr_threshold,
        })
    return results
