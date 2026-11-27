"""Repair application. Only the confirmed ranges are ever written to.

Two methods are supported:

``interpolate``
    A straight line between the last unaffected sample before the range and
    the first unaffected sample after it. The endpoints themselves are not
    modified, so any transient energy just outside the range is preserved
    bit-exactly.

``silence``
    The samples in the range are set to the format's zero code unit (0 for
    integer PCM, +0.0 for float). This is a "mute a short buffered segment"
    operation, not a fade.

Both methods are pure functions of (input samples, resolved edits): no
randomness, no wall clock, no dict-order dependence. Re-running the same
confirmation file against the same input produces byte-identical output.
"""

from __future__ import annotations

import math

from .confirm import ResolvedEdit
from .errors import WavRepairError
from .wavio import Audio


def apply_repairs(audio: Audio, edits: list) -> tuple:
    """Return ``(repaired_audio, record)`` where record describes what changed.

    ``audio`` is never mutated. ``record`` is a list of per-edit entries with
    enough information for the manifest and for verifying afterwards that
    unconfirmed frames are untouched.
    """
    repaired = audio.clone()
    samples = repaired.samples
    channel_count = audio.channels
    frame_count = audio.frames

    record = []
    for edit in edits:
        if edit.channel >= channel_count:
            raise WavRepairError(f"repair targets missing channel {edit.channel}")
        if not (0 <= edit.start < edit.end <= frame_count):
            raise WavRepairError(
                f"repair range {edit.start}..{edit.end} is outside the audio "
                f"(0..{frame_count})"
            )
        if edit.method == "interpolate":
            changed, edge_hold = _interpolate(samples, channel_count, edit, audio)
        elif edit.method == "silence":
            changed, edge_hold = _silence(samples, channel_count, edit)
        else:  # pragma: no cover - resolve_edits restricts the set
            raise WavRepairError(f"unknown repair method {edit.method!r}")

        record.append(
            {
                "channel": edit.channel,
                "start": edit.start,
                "end": edit.end,
                "frames": edit.end - edit.start,
                "method": edit.method,
                "edge_hold": edge_hold,
                "source_edits": list(getattr(edit, "source_edits", ())),
                "changed_samples": changed,
                "original": _snapshot(audio, edit.channel, edit.start, edit.end),
                "replaced": _snapshot(repaired, edit.channel, edit.start, edit.end),
            }
        )

    _assert_invariants(audio, repaired)
    return repaired, {"edits": record, "frames_changed": len({(e.channel, e.start, e.end) for e in edits})}


def _interpolate(samples: list, channels: int, edit: ResolvedEdit, audio: Audio) -> tuple:
    """Straight-line fill between the neighbours outside the range."""
    start, end = edit.start, edit.end
    frame_count = len(samples) // channels
    if start == 0 or end == frame_count:
        # No neighbour on one side. Extrapolating is not interpolation, so the
        # deterministic safe choice is to hold the single known neighbour's
        # value across the range. This keeps the frame count intact and is
        # recorded in the manifest as ``edge_hold``.
        anchor = end if start == 0 else start - 1
        base = anchor * channels + edit.channel
        value = samples[base]
        changed = 0
        for frame in range(start, end):
            index = frame * channels + edit.channel
            if samples[index] != value:
                samples[index] = value
                changed += 1
        return changed, True

    left_index = (start - 1) * channels + edit.channel
    right_index = end * channels + edit.channel
    left = samples[left_index]
    right = samples[right_index]
    span = end - start + 1
    changed = 0
    for offset in range(1, span):
        frame = start + offset - 1
        fraction = offset / span
        if audio.is_float:
            value = left + (right - left) * fraction
        else:
            # Round half away from zero so the result is independent of the
            # platform's float-to-int default and stable across re-runs.
            value = _round_half_away(left + (right - left) * fraction)
        index = frame * channels + edit.channel
        if samples[index] != value:
            samples[index] = value
            changed += 1
    return changed, False


def _silence(samples: list, channels: int, edit: ResolvedEdit) -> tuple:
    value = 0  # integer zero; the float encoder converts it to +0.0
    changed = 0
    for frame in range(edit.start, edit.end):
        index = frame * channels + edit.channel
        if samples[index] != value:
            samples[index] = value
            changed += 1
    return changed, False


def _round_half_away(value: float) -> int:
    if value >= 0:
        return math.floor(value + 0.5)
    return math.ceil(value - 0.5)


def _snapshot(audio: Audio, channel: int, start: int, end: int, limit: int = 64) -> list:
    values = audio.channel_values(channel, start, end)
    out = [
        {"frame": start + offset, "value": value, "normalized": round(audio.normalize(value), 9)}
        for offset, value in enumerate(values[:limit])
    ]
    if len(values) > limit:
        out.append({"frame": start + limit, "truncated": True, "remaining": len(values) - limit})
    return out


def _assert_invariants(before: Audio, after: Audio) -> None:
    if after.frames != before.frames:
        raise WavRepairError(
            f"repair changed the frame count ({before.frames} -> {after.frames})"
        )
    if after.sample_rate != before.sample_rate:
        raise WavRepairError(
            f"repair changed the sample rate ({before.sample_rate} -> {after.sample_rate})"
        )
    if after.channels != before.channels:
        raise WavRepairError(
            f"repair changed the channel count ({before.channels} -> {after.channels})"
        )
    if after.codec != before.codec:
        raise WavRepairError(
            f"repair changed the sample codec ({before.codec} -> {after.codec})"
        )
    if len(after.samples) != len(before.samples):
        raise WavRepairError("repair changed the interleaved sample length")


def silenced_value(audio: Audio):
    return 0.0 if audio.is_float else 0
