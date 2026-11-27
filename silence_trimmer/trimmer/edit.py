"""Edit decisions, segment planning and crossfaded splicing.

A :class:`Decision` resolves one detected pause to one of:

* ``keep``    - leave the whole pause untouched;
* ``shorten`` - keep a chosen duration of the pause (head/tail/centred);
* ``delete``  - remove the pause entirely;
* ``manual``  - use hand-edited original-time boundaries.

:func:`build_segments` turns the pause list and decisions into an ordered,
non-overlapping plan of kept original frame ranges plus the deleted ranges.
:func:`render_edits` copies the kept ranges into the output and applies a
controllable equal-power or linear crossfade wherever two ranges meet across a
deletion, so splice points never click.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import List, Literal, Optional

from .wavio import WaveData

Action = Literal["keep", "shorten", "delete", "manual"]
Anchor = Literal["start", "end", "center"]
FadeCurve = Literal["linear", "equal_power"]


@dataclass
class Decision:
    """Editor decision for one pause (bound by its index in the pause list)."""

    pause_index: int
    action: Action = "keep"
    # Used by action="shorten": pause is reduced to this many seconds.
    keep_sec: Optional[float] = None
    # Used by action="shorten": which side of the pause survives.
    anchor: Anchor = "start"
    # Used by action="manual": replacement boundaries in original seconds.
    new_start_sec: Optional[float] = None
    new_end_sec: Optional[float] = None

    def __post_init__(self) -> None:
        if self.action not in ("keep", "shorten", "delete", "manual"):
            raise ValueError(f"unknown action: {self.action!r}")
        if self.anchor not in ("start", "end", "center"):
            raise ValueError(f"unknown anchor: {self.anchor!r}")


@dataclass
class EditConfig:
    """Splicing parameters.

    Attributes:
        fade_ms: crossfade duration applied at each cut junction.
        fade_curve: "linear" or "equal_power".
    """

    fade_ms: float = 8.0
    fade_curve: FadeCurve = "equal_power"

    def __post_init__(self) -> None:
        if self.fade_ms < 0:
            raise ValueError("fade_ms must be non-negative")
        if self.fade_curve not in ("linear", "equal_power"):
            raise ValueError("fade_curve must be 'linear' or 'equal_power'")


@dataclass
class KeptRange:
    """A half-open original frame range that survives into the output."""

    start_frame: int
    end_frame: int

    @property
    def length(self) -> int:
        return self.end_frame - self.start_frame


@dataclass
class DeletedRange:
    """A half-open original frame range removed from the output."""

    start_frame: int
    end_frame: int
    pause_index: Optional[int] = None

    @property
    def length(self) -> int:
        return self.end_frame - self.start_frame


@dataclass
class ResolvedPause:
    """A pause with its final retained original frame range."""

    pause_index: int
    original_start: int
    original_end: int
    retained_start: int
    retained_end: int
    action: Action

    @property
    def retained_length(self) -> int:
        return self.retained_end - self.retained_start


@dataclass
class EditPlan:
    kept: List[KeptRange]
    deleted: List[DeletedRange]
    resolved: List[ResolvedPause]
    sample_rate: int
    total_input_frames: int

    @property
    def output_frames(self) -> int:
        return sum(k.length for k in self.kept)


def _resolve_retained(pause, decision: Decision, total_frames: int):
    """Return (retained_start, retained_end) in original frames."""
    start = pause.start_frame
    end = pause.end_frame
    duration = end - start

    if decision.action == "keep":
        return start, end

    if decision.action == "delete":
        return start, start  # empty retained range

    if decision.action == "shorten":
        if decision.keep_sec is None:
            raise ValueError(
                f"pause {decision.pause_index}: shorten requires keep_sec"
            )
        if decision.keep_sec < 0:
            raise ValueError(
                f"pause {decision.pause_index}: keep_sec must be non-negative"
            )
        keep_frames = int(round(decision.keep_sec * pause.sample_rate))
        keep_frames = max(0, min(keep_frames, duration))
        if decision.anchor == "start":
            return start, start + keep_frames
        if decision.anchor == "end":
            return end - keep_frames, end
        # centre
        slack = duration - keep_frames
        left = slack // 2
        return start + left, start + left + keep_frames

    # manual
    if decision.new_start_sec is None or decision.new_end_sec is None:
        raise ValueError(
            f"pause {decision.pause_index}: manual requires new_start_sec "
            "and new_end_sec"
        )
    new_start = int(round(decision.new_start_sec * pause.sample_rate))
    new_end = int(round(decision.new_end_sec * pause.sample_rate))
    if new_start < 0 or new_end > total_frames or new_start > new_end:
        raise ValueError(
            f"pause {decision.pause_index}: manual bounds "
            f"[{decision.new_start_sec}, {decision.new_end_sec}] are invalid "
            f"for a {total_frames / pause.sample_rate:.3f}s recording"
        )
    return new_start, new_end


def build_segments(
    audio: WaveData,
    pauses,
    decisions: List[Decision],
    config: Optional[EditConfig] = None,
) -> EditPlan:
    """Build the kept/deleted frame plan from pauses and decisions."""
    total = audio.frames
    sr = audio.sample_rate

    # Bind decisions to pauses and reject duplicates / bad indices.
    by_index = {}
    for d in decisions:
        if d.pause_index < 0 or d.pause_index >= len(pauses):
            raise ValueError(
                f"decision references unknown pause index {d.pause_index} "
                f"(found {len(pauses)} pauses)"
            )
        if d.pause_index in by_index:
            raise ValueError(
                f"duplicate decision for pause index {d.pause_index}"
            )
        by_index[d.pause_index] = d

    resolved: List[ResolvedPause] = []
    for idx, pause in enumerate(pauses):
        decision = by_index.get(idx, Decision(pause_index=idx, action="keep"))
        ret_start, ret_end = _resolve_retained(pause, decision, total)
        resolved.append(
            ResolvedPause(
                pause_index=idx,
                original_start=pause.start_frame,
                original_end=pause.end_frame,
                retained_start=ret_start,
                retained_end=ret_end,
                action=decision.action,
            )
        )

    # Walk the original timeline. Between pauses the speech is always kept;
    # inside a pause only the retained sub-range is kept. Everything else is a
    # deletion. Manual ranges are validated for ordering here.
    kept: List[KeptRange] = []
    deleted: List[DeletedRange] = []
    cursor = 0

    def add_kept(a: int, b: int) -> None:
        if b <= a:
            return
        if kept and a < kept[-1].end_frame:
            raise ValueError(
                "edit ranges overlap after manual boundary adjustment; "
                "check new_start_sec/new_end_sec"
            )
        if kept and a == kept[-1].end_frame:
            kept[-1].end_frame = b  # merge contiguous pieces
        else:
            kept.append(KeptRange(a, b))

    def add_deleted(a: int, b: int, pause_idx: Optional[int]) -> None:
        if b <= a:
            return
        deleted.append(DeletedRange(a, b, pause_idx))

    for r in resolved:
        # Speech (or previously unhandled material) before this pause.
        add_kept(cursor, r.original_start)

        if r.retained_start < cursor or r.retained_end > total:
            raise ValueError(
                f"pause {r.pause_index}: manual range crosses another edit "
                "or the recording bounds"
            )

        # Deleted head and tail of the pause around the retained part.
        add_deleted(r.original_start, r.retained_start, r.pause_index)
        add_kept(r.retained_start, r.retained_end)
        add_deleted(r.retained_end, r.original_end, r.pause_index)
        cursor = r.original_end

    add_kept(cursor, total)

    # Merge contiguous deleted ranges for cleaner reporting.
    merged_deleted: List[DeletedRange] = []
    for d in deleted:
        if merged_deleted and d.start_frame == merged_deleted[-1].end_frame:
            last = merged_deleted[-1]
            merged_deleted[-1] = DeletedRange(
                last.start_frame, d.end_frame, d.pause_index
            )
        else:
            merged_deleted.append(DeletedRange(d.start_frame, d.end_frame, d.pause_index))

    plan = EditPlan(
        kept=kept,
        deleted=merged_deleted,
        resolved=resolved,
        sample_rate=sr,
        total_input_frames=total,
    )
    if plan.output_frames > total:
        raise AssertionError("output cannot be longer than the input")
    return plan


def _fade_gains(position: float, curve: FadeCurve):
    """Return (left_gain, right_gain) for normalized position 0..1."""
    if curve == "linear":
        return 1.0 - position, position
    angle = position * math.pi / 2.0
    return math.cos(angle), math.sin(angle)


def render_edits(audio: WaveData, plan: EditPlan, config: EditConfig) -> WaveData:
    """Render the output WAV from an :class:`EditPlan`."""
    import array

    sr = audio.sample_rate
    channels = audio.channels
    src = audio.samples
    fade_frames = int(round(config.fade_ms / 1000.0 * sr))

    out = array.array("d", [0.0]) * (plan.output_frames * channels)
    out_pos = 0  # in frames

    for piece_idx, piece in enumerate(plan.kept):
        src_start = piece.start_frame * channels
        src_end = piece.end_frame * channels
        length = piece.length

        # Every piece is copied wholesale first; junction blends are then
        # overwritten on top, so the output length stays exactly the sum of
        # the kept lengths.
        out[out_pos * channels : (out_pos + length) * channels] = src[
            src_start:src_end
        ]

        is_junction = (
            piece_idx > 0
            and piece.start_frame > plan.kept[piece_idx - 1].end_frame
        )
        if is_junction and fade_frames > 1:
            prev_piece = plan.kept[piece_idx - 1]
            prev_len = prev_piece.length
            f = min(fade_frames, prev_len, length)
            if f > 1:
                prev_src = prev_piece.start_frame * channels
                # The blend occupies the last f frames of the previous piece,
                # inside the already-rendered output buffer.
                blend_out = out_pos * channels - f * channels
                for i in range(f):
                    gl, gr = _fade_gains(i / (f - 1), config.fade_curve)
                    left_idx = prev_src + (prev_len - f + i) * channels
                    right_idx = src_start + i * channels
                    for ch in range(channels):
                        out[blend_out + i * channels + ch] = (
                            src[left_idx + ch] * gl + src[right_idx + ch] * gr
                        )

        out_pos += length

    if out_pos != plan.output_frames:
        raise AssertionError("rendered frame count does not match the edit plan")
    return WaveData(
        samples=out,
        sample_rate=sr,
        channels=channels,
        sampwidth=audio.sampwidth,
        is_float=audio.is_float,
    )
