"""Suspicious-sample detection for PCM audio.

The detector is *advisory*: it proposes short frame ranges that a human then
confirms or ignores. It never edits audio itself.

Three artifact classes are searched, all computed per channel on samples
normalised to ``[-1, 1]`` (full scale = 1.0):

``impulse``
    A short deviation from a robust local median filter (radius ``--radius``).
    This covers single-sample clicks, two-sample spikes and abrupt steps that
    are localised in time, regardless of whether the waveform value is
    ``min``, ``max`` or somewhere between.

``dropout``
    A short run of near-silent samples that is entered and left with a
    noticeable jump, which is the signature of a buffered source that
    momentarily produced nothing.

``stuck``
    A short run of samples that are bit-identical to one another but is
    entered and left with a noticeable jump, which is the signature of a
    buffer that repeated its last value.

Candidate groups narrower than ``--max-width`` frames are reported as
*suspect*. Anything wider, and any group whose local RMS envelope rises
sharply across the anomaly, is reported as a *rejected transient* (a
percussion attack or similar legitimate event) so the operator can see that
it was considered and deliberately not proposed.

All thresholds are in normalised units; ``--help`` on the CLI lists them.
"""

from __future__ import annotations

import bisect
import math
from dataclasses import asdict, dataclass, field

from .errors import WavRepairError
from .wavio import Audio


@dataclass(frozen=True)
class DetectionSettings:
    """Adjustable detection criteria. All levels are full-scale normalised."""

    radius: int = 4
    mad_block: int = 256
    sensitivity: float = 6.0          # residual must exceed this multiple of block MAD
    floor: float = 0.120              # absolute hull-excess floor (12% of full scale)
    hull_span: int = 3                # neighbours each side used for the hull test
    merge_gap: int = 24               # merge suspect frames closer than this
    max_width: int = 12               # wider groups are rejected as transients
    envelope_window: int = 48         # frames either side for RMS envelope guard
    envelope_rise: float = 3.0        # after/before RMS ratio that marks an attack
    envelope_rise_min: float = 0.050  # absolute after-RMS needed for the guard
    silence_floor: float = 0.0005     # a sample this quiet counts as silent
    dropout_min: int = 2
    dropout_max: int = 2048
    boundary_jump: float = 0.050      # jump needed at both edges of a dropout
    stuck_min: int = 4
    stuck_max: int = 2048
    excerpt_before: int = 12
    excerpt_after: int = 12
    excerpt_during_max: int = 32
    channels: tuple = ()              # empty = all channels

    def validate(self) -> None:
        if self.radius < 1:
            raise WavRepairError("detector radius must be at least 1")
        if self.mad_block < 1:
            raise WavRepairError("mad_block must be at least 1")
        if self.sensitivity <= 0:
            raise WavRepairError("sensitivity must be positive")
        if not (0 <= self.floor):
            raise WavRepairError("floor must be non-negative")
        if self.merge_gap < 0:
            raise WavRepairError("merge_gap must be non-negative")
        if self.max_width < 1:
            raise WavRepairError("max_width must be at least 1")
        if self.hull_span < 1:
            raise WavRepairError("hull_span must be at least 1")
        if self.envelope_window < 1:
            raise WavRepairError("envelope_window must be at least 1")
        if self.dropout_min < 1 or self.dropout_max < self.dropout_min:
            raise WavRepairError("dropout bounds must satisfy 1 <= min <= max")
        if self.stuck_min < 2 or self.stuck_max < self.stuck_min:
            raise WavRepairError("stuck bounds must satisfy 2 <= min <= max")
        if self.excerpt_before < 0 or self.excerpt_after < 0 or self.excerpt_during_max < 1:
            raise WavRepairError("excerpt lengths must be non-negative")

    def as_dict(self) -> dict:
        data = asdict(self)
        data["channels"] = list(self.channels)
        return data


@dataclass
class Candidate:
    """One proposed (or rejected) suspicious region on one channel."""

    id: int = 0
    channel: int = 0
    kind: str = ""                    # impulse / dropout / stuck
    start: int = 0                    # inclusive frame index
    end: int = 0                      # exclusive frame index
    classification: str = "suspect"   # suspect / rejected_transient
    reason: str = ""
    peak: float = 0.0                 # normalised absolute peak of the anomaly
    rising_fraction: float = 0.0
    context: dict = field(default_factory=dict)

    @property
    def frames(self) -> int:
        return self.end - self.start

    def as_dict(self, audio: Audio) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "channel": self.channel,
            "start": self.start,
            "end": self.end,
            "frames": self.frames,
            "start_seconds": _seconds(self.start, audio.sample_rate),
            "end_seconds": _seconds(self.end, audio.sample_rate),
            "duration_seconds": _seconds(self.frames, audio.sample_rate),
            "classification": self.classification,
            "reason": self.reason,
            "peak": _round(self.peak),
            "rising_fraction": _round(self.rising_fraction),
            "context": self.context,
        }


@dataclass
class ScanResult:
    audio: Audio
    settings: DetectionSettings
    candidates: list
    analysed_channels: list

    @property
    def suspects(self) -> list:
        return [c for c in self.candidates if c.classification == "suspect"]

    @property
    def rejected(self) -> list:
        return [c for c in self.candidates if c.classification != "suspect"]

    def as_dict(self) -> dict:
        return {
            "format": "wavrepair-report",
            "version": 1,
            "source": {
                "path": self.audio.source_path,
                "sha256": self.audio.source_sha256,
                "codec": self.audio.codec,
                "channels": self.audio.channels,
                "sample_rate": self.audio.sample_rate,
                "frames": self.audio.frames,
                "duration_seconds": _seconds(self.audio.frames, self.audio.sample_rate),
            },
            "settings": self.settings.as_dict(),
            "analysed_channels": self.analysed_channels,
            "summary": {
                "candidates": len(self.candidates),
                "suspects": len(self.suspects),
                "rejected_transients": len(self.rejected),
                "suspects_by_kind": _count_by_kind(self.suspects),
            },
            "candidates": [c.as_dict(self.audio) for c in self.candidates],
        }


def scan_audio(audio: Audio, settings: DetectionSettings | None = None) -> ScanResult:
    """Run every detector over the requested channels and return candidates."""
    settings = settings or DetectionSettings()
    settings.validate()
    channels = list(settings.channels) if settings.channels else list(range(audio.channels))
    for channel in channels:
        if not 0 <= channel < audio.channels:
            raise WavRepairError(
                f"channel {channel} does not exist (input has {audio.channels} channel(s))"
            )
    channels = sorted(set(channels))

    scale = audio.code_unit_scale()
    candidates: list = []
    for channel in channels:
        values = [float(v) / scale for v in audio.channel_values(channel, 0, audio.frames)]
        found = []
        found.extend(_detect_impulses(values, settings))
        found.extend(_detect_runs(values, settings, silence=True))
        found.extend(_detect_runs(values, settings, silence=False))
        for candidate in found:
            candidate.channel = channel
        found.sort(key=lambda c: (c.start, c.end, c.kind))
        candidates.extend(found)

    candidates.sort(key=lambda c: (c.channel, c.start, c.end, c.kind))
    for index, candidate in enumerate(candidates, start=1):
        candidate.id = index
        candidate.context = _build_context(audio, candidate, settings)

    return ScanResult(
        audio=audio,
        settings=settings,
        candidates=candidates,
        analysed_channels=channels,
    )


# --------------------------------------------------------------------------
# impulse detection
# --------------------------------------------------------------------------

def _detect_impulses(values: list, settings: DetectionSettings) -> list:
    """Find isolated samples that sit outside their immediate neighbourhood.

    The decisive test is a *local hull* test: a click is a sample far outside
    the interval spanned by its immediate neighbours, whereas a drum attack is
    a broadband step whose samples stay inside that interval even though the
    median residual there is not tiny. The hull excess is recorded so the
    operator can see *how far* outside the sample was.
    """
    n = len(values)
    if n < 3:
        return []
    median = _sliding_median(values, settings.radius)
    residual = [values[i] - median[i] for i in range(n)]
    block_mad = _block_mad(residual, settings.mad_block)
    threshold = [
        max(settings.floor, settings.sensitivity * block_mad[i // settings.mad_block])
        for i in range(n)
    ]
    before_rms, after_rms = _area_rms(values, settings.envelope_window)

    flagged = []
    for i in range(n):
        excess = _hull_excess(values, i, settings.hull_span)
        if excess <= threshold[i]:
            continue
        rising = (
            after_rms[i] > settings.envelope_rise * max(before_rms[i], 1e-12)
            and after_rms[i] > settings.envelope_rise_min
        )
        flagged.append((i, excess, abs(residual[i]), rising))

    groups = _group_positions([item[0] for item in flagged], settings.merge_gap)
    result = []
    for start, end in groups:
        members = [item for item in flagged if start <= item[0] < end]
        rising_fraction = sum(1 for item in members if item[3]) / len(members)
        peak = max(item[1] for item in members)
        width = end - start
        if width > settings.max_width:
            classification = "rejected_transient"
            reason = (
                f"anomaly spans {width} frames, wider than max width "
                f"{settings.max_width}; treated as a legitimate transient"
            )
        elif rising_fraction > 0.5:
            classification = "rejected_transient"
            reason = (
                "local RMS envelope rises sharply across the anomaly "
                f"({rising_fraction:.0%} of positions), consistent with a "
                "percussion or other legitimate attack"
            )
        else:
            classification = "suspect"
            reason = (
                f"{len(members)} sample(s) lie outside the span of their immediate "
                f"neighbours by more than max(floor={settings.floor}, "
                f"{settings.sensitivity}x block MAD) without an envelope rise"
            )
        result.append(
            Candidate(
                channel=-1,
                kind="impulse",
                start=start,
                end=end,
                classification=classification,
                reason=reason,
                peak=peak,
                rising_fraction=rising_fraction,
            )
        )
    return result


def _hull_excess(values: list, index: int, span: int) -> float:
    """How far sample ``index`` lies outside its neighbours' value interval.

    Neighbours are the samples at ``index +/- 1 .. index +/- span`` (the
    immediately adjacent samples are included), excluding ``index`` itself.
    A single-sample click is far outside that interval; a smooth waveform
    stays inside it.
    """
    n = len(values)
    lower = math.inf
    upper = -math.inf
    for offset in range(1, span + 1):
        for candidate in (index - offset, index + offset):
            if 0 <= candidate < n:
                value = values[candidate]
                lower = min(lower, value)
                upper = max(upper, value)
    if lower == math.inf:
        return 0.0  # isolated file with no neighbours at all
    value = values[index]
    return max(0.0, value - upper, lower - value)


# --------------------------------------------------------------------------
# dropout / stuck runs
# --------------------------------------------------------------------------

def _detect_runs(values: list, settings: DetectionSettings, silence: bool) -> list:
    if silence:
        kind = "dropout"
        minimum, maximum = settings.dropout_min, settings.dropout_max
        bound = settings.silence_floor

        def matches(a: float, b: float) -> bool:
            return abs(a) <= bound and abs(b) <= bound

        def qualifies(run_start: int, run_end: int) -> bool:
            return True
    else:
        kind = "stuck"
        minimum, maximum = settings.stuck_min, settings.stuck_max

        def matches(a: float, b: float) -> bool:
            return a == b

        def qualifies(run_start: int, run_end: int) -> bool:
            # A stuck run must repeat one non-trivial value, not silence.
            return abs(values[run_start]) > settings.silence_floor

    runs = _runs(values, matches, minimum, maximum)
    result = []
    for start, end in runs:
        if not qualifies(start, end):
            continue
        if start == 0 or end >= len(values):
            continue  # cannot show a jump on both sides
        left_jump = abs(values[start] - values[start - 1])
        right_jump = abs(values[end] - values[end - 1])
        if left_jump < settings.boundary_jump or right_jump < settings.boundary_jump:
            continue
        peak = max(abs(v) for v in values[start - 1: end + 1])
        result.append(
            Candidate(
                channel=-1,
                kind=kind,
                start=start,
                end=end,
                classification="suspect",
                reason=(
                    f"{end - start} {('silent' if silence else 'repeated')} "
                    f"sample(s) entered and left with jumps "
                    f"{left_jump:.3f}/{right_jump:.3f} (floor "
                    f"{settings.boundary_jump})"
                ),
                peak=peak,
            )
        )
    return result


def _runs(values: list, matches, minimum: int, maximum: int) -> list:
    """Return [start, end) of maximal runs where ``matches`` holds pairwise."""
    n = len(values)
    runs = []
    start = 0
    while start < n:
        end = start + 1
        while end < n and matches(values[end - 1], values[end]):
            end += 1
        if minimum <= (end - start) <= maximum:
            runs.append((start, end))
        start = end
    return runs


# --------------------------------------------------------------------------
# numeric helpers
# --------------------------------------------------------------------------

def _sliding_median(values: list, radius: int) -> list:
    n = len(values)
    out = [0.0] * n
    window: list = []
    lo_prev = 0
    hi_prev = -1
    for i in range(n):
        lo = max(0, i - radius)
        hi = min(n - 1, i + radius)
        while hi_prev < hi:
            hi_prev += 1
            bisect.insort(window, values[hi_prev])
        while lo_prev < lo:
            index = bisect.bisect_left(window, values[lo_prev])
            window.pop(index)
            lo_prev += 1
        size = len(window)
        middle = size // 2
        if size % 2:
            out[i] = window[middle]
        else:
            out[i] = 0.5 * (window[middle - 1] + window[middle])
    return out


def _block_mad(residual: list, block: int) -> list:
    n = len(residual)
    result = [0.0] * n
    for start in range(0, n, block):
        chunk = sorted(abs(v) for v in residual[start: start + block])
        size = len(chunk)
        middle = size // 2
        mad = chunk[middle] if size % 2 else 0.5 * (chunk[middle - 1] + chunk[middle])
        for i in range(start, min(n, start + block)):
            result[i] = mad
    return result


def _area_rms(values: list, window: int) -> tuple:
    """RMS strictly before and strictly after each frame, over ``window`` frames."""
    n = len(values)
    squares = [0.0] * (n + 1)
    for i, value in enumerate(values):
        squares[i + 1] = squares[i] + value * value
    before = [0.0] * n
    after = [0.0] * n
    for i in range(n):
        lo = max(0, i - window)
        count = i - lo
        before[i] = math.sqrt((squares[i] - squares[lo]) / count) if count else 0.0
        hi = min(n, i + 1 + window)
        count = hi - (i + 1)
        after[i] = math.sqrt((squares[hi] - squares[i + 1]) / count) if count else 0.0
    return before, after


def _group_positions(positions: list, gap: int) -> list:
    if not positions:
        return []
    groups = []
    start = positions[0]
    last = positions[0]
    for position in positions[1:]:
        if position - last > gap:
            groups.append((start, last + 1))
            start = position
        last = position
    groups.append((start, last + 1))
    return groups


def _build_context(audio: Audio, candidate: Candidate, settings: DetectionSettings) -> dict:
    channel = candidate.channel
    total = audio.frames
    before_start = max(0, candidate.start - settings.excerpt_before)
    after_end = min(total, candidate.end + settings.excerpt_after)
    during_end = min(candidate.end, candidate.start + settings.excerpt_during_max)

    def frames(a: int, b: int) -> list:
        values = audio.channel_values(channel, a, b)
        return [
            {"frame": a + offset, "value": value, "normalized": _round(audio.normalize(value))}
            for offset, value in enumerate(values)
        ]

    return {
        "channel": channel,
        "before": frames(before_start, candidate.start),
        "during": frames(candidate.start, during_end),
        "after": frames(candidate.end, after_end),
        "during_truncated": during_end < candidate.end,
    }


def _count_by_kind(candidates: list) -> dict:
    counts: dict = {}
    for candidate in candidates:
        counts[candidate.kind] = counts.get(candidate.kind, 0) + 1
    return counts


def _seconds(frames: int, sample_rate: int) -> float:
    return round(frames / sample_rate, 9)


def _round(value: float) -> float:
    return round(float(value), 9)
