"""Pause detection.

The recording is scanned in short analysis frames. A frame counts as silent
when its measured amplitude is below a threshold and the configured
multi-channel joint condition holds. Silent runs are then merged across small
noisy gaps and short runs are discarded, so borderline noise and brief gaps do
not produce a string of fragments. All boundaries are expressed in integer
sample frames.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import List, Literal

from .wavio import WaveData

AmplitudeMode = Literal["peak", "rms"]
# * all:   every channel is quiet (strict joint rule)
# * any:   at least one channel is quiet (loose rule)
# * avg:   the mean amplitude across channels is below the threshold
ChannelRule = Literal["all", "any", "avg"]


@dataclass
class DetectionConfig:
    """Tunable detection parameters.

    Attributes:
        threshold_dbfs: amplitude threshold in dBFS (0 dBFS = full scale).
        min_pause_sec: keep only silent runs at least this long.
        frame_ms: analysis frame length in milliseconds.
        hop_ms: analysis hop in milliseconds (defaults to half the frame).
        merge_gap_ms: noisy gaps shorter than this merge neighbouring runs.
        amplitude: "peak" (max absolute sample) or "rms".
        channel_rule: joint rule for multi-channel recordings.
    """

    threshold_dbfs: float = -40.0
    min_pause_sec: float = 0.8
    frame_ms: float = 20.0
    hop_ms: float | None = None
    merge_gap_ms: float = 200.0
    amplitude: AmplitudeMode = "peak"
    channel_rule: ChannelRule = "all"

    def __post_init__(self) -> None:
        if self.threshold_dbfs >= 0.0:
            raise ValueError("threshold_dbfs must be below 0 dBFS")
        if self.min_pause_sec < 0:
            raise ValueError("min_pause_sec must be non-negative")
        if self.frame_ms <= 0:
            raise ValueError("frame_ms must be positive")
        if self.merge_gap_ms < 0:
            raise ValueError("merge_gap_ms must be non-negative")
        if self.amplitude not in ("peak", "rms"):
            raise ValueError("amplitude must be 'peak' or 'rms'")
        if self.channel_rule not in ("all", "any", "avg"):
            raise ValueError("channel_rule must be 'all', 'any' or 'avg'")

    @property
    def hop_resolved_ms(self) -> float:
        return self.hop_ms if self.hop_ms is not None else self.frame_ms / 2.0


@dataclass
class Pause:
    """A detected silent region, in original sample frames (half-open)."""

    start_frame: int
    end_frame: int
    sample_rate: int
    # Per-channel maximum amplitude measured across the whole region, linear
    # 0..1. Useful in the candidate report.
    channel_peak: List[float] = field(default_factory=list)

    @property
    def start_sec(self) -> float:
        return self.start_frame / self.sample_rate

    @property
    def end_sec(self) -> float:
        return self.end_frame / self.sample_rate

    @property
    def duration_sec(self) -> float:
        return (self.end_frame - self.start_frame) / self.sample_rate


def _frame_amplitude(
    audio: WaveData, frame_start: int, frame_end: int
) -> List[float]:
    """Measure one frame's amplitude per channel as a linear 0..1 value."""
    channels = audio.channels
    samples = audio.samples
    length = frame_end - frame_start
    # Each entry is (peak_amplitude, mean_squared_energy).
    measured: List[tuple[float, float]] = []
    if length <= 0:
        return [(0.0, 0.0)] * channels

    for ch in range(channels):
        peak = 0.0
        sum_sq = 0.0
        i = frame_start * channels + ch
        end = frame_end * channels + ch
        while i < end:
            v = samples[i]
            a = -v if v < 0.0 else v
            if a > peak:
                peak = a
            sum_sq += v * v
            i += channels
        measured.append((peak, sum_sq / length))
    return measured


def _frame_is_silent(
    measured: List[float],
    mode: AmplitudeMode,
    rule: ChannelRule,
    threshold: float,
) -> bool:
    idx = 0 if mode == "peak" else 1
    values = [m[idx] for m in measured]
    if rule == "all":
        return all(v < threshold for v in values)
    if rule == "any":
        return any(v < threshold for v in values)
    # avg: judge the mean measured amplitude (in linear units).
    return sum(values) / len(values) < threshold


def detect_pauses(audio: WaveData, config: DetectionConfig) -> List[Pause]:
    """Find candidate pauses in ``audio`` under ``config``."""
    sr = audio.sample_rate
    frame_len = max(1, int(round(config.frame_ms / 1000.0 * sr)))
    hop = max(1, int(round(config.hop_resolved_ms / 1000.0 * sr)))
    merge_gap = int(round(config.merge_gap_ms / 1000.0 * sr))
    min_pause = int(round(config.min_pause_sec * sr))
    threshold = 10.0 ** (config.threshold_dbfs / 20.0)

    total = audio.frames
    # (start_frame, end_frame) silent runs, frame indices, half-open.
    runs: List[List[int]] = []
    frame_start = 0
    while frame_start < total:
        frame_end = min(frame_start + frame_len, total)
        measured = _frame_amplitude(audio, frame_start, frame_end)
        if _frame_is_silent(measured, config.amplitude, config.channel_rule, threshold):
            if runs and frame_start <= runs[-1][1]:
                # Overlapping/hop-adjacent silent frame: extend the run.
                runs[-1][1] = frame_end
            elif runs and frame_start - runs[-1][1] < merge_gap:
                # Noisy gap strictly shorter than merge_gap: merge and absorb
                # the gap itself. A gap exactly at the limit stays separate so
                # a real speech blip never disappears silently.
                runs[-1][1] = frame_end
            else:
                runs.append([frame_start, frame_end])
        frame_start += hop

    # A second merge pass handles runs whose absorbed gaps still leave them
    # within merge_gap of a neighbour, and applies the minimum-length filter.
    merged: List[List[int]] = []
    for start, end in runs:
        if merged and start - merged[-1][1] < merge_gap:
            merged[-1][1] = end
        else:
            merged.append([start, end])

    pauses: List[Pause] = []
    for start, end in merged:
        if end - start < min_pause:
            continue
        # Clamp into the valid recording span and record per-channel peak for
        # the editor's report.
        start = max(0, min(start, total))
        end = max(start, min(end, total))
        measured = _frame_amplitude(audio, start, end)
        peaks = [m[0] for m in measured]
        pauses.append(Pause(start, end, sr, peaks))
    return pauses


def dbfs(linear: float) -> float:
    """Convert a linear 0..1 amplitude to dBFS (negative infinity -> -inf)."""
    if linear <= 0.0:
        return -math.inf
    return 20.0 * math.log10(linear)
