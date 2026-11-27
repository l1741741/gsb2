"""Confirmation files: the operator's whitelist of repair ranges.

Public schema (JSON, UTF-8, stable key ordering when written)::

    {
      "format": "wavrepair-confirm",
      "version": 1,
      "input": {"path": "...", "sha256": "...", "frames": N,
                "sample_rate": N, "channels": N},
      "overlap_policy": "merge" | "reject",
      "edits": [
        {"channel": 0, "start": 10, "end": 14,
         "method": "interpolate" | "silence",
         "apply_to": [0, 1]        # optional; defaults to [channel]
        }
      ],
      "ignored_candidates": [3, 7]  # report-only, never applied
    }

``start`` is inclusive and ``end`` is exclusive, both in frame indices. The
tool refuses to run when ``input.sha256`` and ``input.frames`` do not match
the audio actually supplied, so a confirmation file cannot be pointed at a
different take.

Overlap rules (public and fixed):

``merge`` (default)
    Ranges on the *same channel* that overlap or touch are merged into one
    range. The merged range inherits ``interpolate`` if any member asks for
    interpolation (interpolation is the less destructive method); otherwise
    ``silence``. If a merged span would exceed the configured maximum repair
    width, the file is rejected -- the tool never silently repairs far more
    audio than the operator asked for.

``reject``
    Any overlap or touching ranges on the same channel, or any cross-channel
    ranges that disagree on ``method`` for a shared frame, stop the run with
    an error naming the conflicting edits.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from .errors import ConfirmError, InputMismatchError, OverlapError

CONFIRM_FORMAT = "wavrepair-confirm"
CONFIRM_VERSION = 1

METHODS = ("interpolate", "silence")
OVERLAP_POLICIES = ("merge", "reject")


@dataclass(frozen=True)
class Edit:
    channel: int
    start: int
    end: int
    method: str
    apply_to: tuple = ()

    @property
    def target_channels(self) -> tuple:
        return self.apply_to or (self.channel,)

    def as_dict(self) -> dict:
        data = {
            "channel": self.channel,
            "start": self.start,
            "end": self.end,
            "method": self.method,
            "frames": self.end - self.start,
        }
        if self.apply_to:
            data["apply_to"] = list(self.apply_to)
        return data


@dataclass(frozen=True)
class ConfirmDocument:
    input_sha256: str
    input_frames: int
    input_sample_rate: int
    input_channels: int
    overlap_policy: str
    edits: tuple
    ignored_candidates: tuple = ()
    path: str = ""

    def as_dict(self) -> dict:
        return {
            "format": CONFIRM_FORMAT,
            "version": CONFIRM_VERSION,
            "input": {
                "sha256": self.input_sha256,
                "frames": self.input_frames,
                "sample_rate": self.input_sample_rate,
                "channels": self.input_channels,
            },
            "overlap_policy": self.overlap_policy,
            "edits": [edit.as_dict() for edit in self.edits],
            "ignored_candidates": list(self.ignored_candidates),
        }


def load_confirm(path: str, audio, default_max_width: int = 4096) -> ConfirmDocument:
    """Read and validate a confirmation file against ``audio``."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except OSError as exc:
        raise ConfirmError(f"cannot read confirmation file {path!r}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ConfirmError(f"{path!r} is not valid JSON: {exc}") from exc

    if not isinstance(raw, dict):
        raise ConfirmError(f"{path!r} must contain a JSON object")
    if raw.get("format") != CONFIRM_FORMAT:
        raise ConfirmError(
            f"{path!r} is not a {CONFIRM_FORMAT} file "
            f"(found format {raw.get('format')!r})"
        )
    if raw.get("version") != CONFIRM_VERSION:
        raise ConfirmError(
            f"{path!r} has unsupported version {raw.get('version')!r}; "
            f"this tool understands version {CONFIRM_VERSION}"
        )

    source = raw.get("input")
    if not isinstance(source, dict):
        raise ConfirmError(f"{path!r} is missing the input block")
    sha256 = source.get("sha256")
    frames = source.get("frames")
    sample_rate = source.get("sample_rate")
    channels = source.get("channels")
    for name, value in (
        ("input.sha256", sha256),
        ("input.frames", frames),
        ("input.sample_rate", sample_rate),
        ("input.channels", channels),
    ):
        if value in (None, ""):
            raise ConfirmError(f"{path!r} is missing {name}")

    mismatches = []
    if not isinstance(sha256, str) or sha256.lower() != audio.source_sha256.lower():
        mismatches.append(f"sha256 {sha256!r} != input {audio.source_sha256!r}")
    if frames != audio.frames:
        mismatches.append(f"frames {frames!r} != input {audio.frames}")
    if sample_rate != audio.sample_rate:
        mismatches.append(f"sample_rate {sample_rate!r} != input {audio.sample_rate}")
    if channels != audio.channels:
        mismatches.append(f"channels {channels!r} != input {audio.channels}")
    if mismatches:
        raise InputMismatchError(
            f"confirmation file {path!r} does not match input "
            f"{audio.source_path!r}: " + "; ".join(mismatches)
        )

    policy = raw.get("overlap_policy", "merge")
    if policy not in OVERLAP_POLICIES:
        raise ConfirmError(
            f"{path!r} has unknown overlap_policy {policy!r}; "
            f"expected one of {', '.join(OVERLAP_POLICIES)}"
        )

    edits_raw = raw.get("edits")
    if not isinstance(edits_raw, list):
        raise ConfirmError(f"{path!r} is missing the edits list")
    edits = tuple(_parse_edit(index, item, audio, path) for index, item in enumerate(edits_raw))

    ignored = raw.get("ignored_candidates", [])
    if not isinstance(ignored, list) or any(
        not isinstance(item, int) or isinstance(item, bool) for item in ignored
    ):
        raise ConfirmError(f"{path!r} ignored_candidates must be a list of integers")

    document = ConfirmDocument(
        input_sha256=sha256,
        input_frames=frames,
        input_sample_rate=sample_rate,
        input_channels=channels,
        overlap_policy=policy,
        edits=edits,
        ignored_candidates=tuple(ignored),
        path=path,
    )
    resolve_edits(document, audio, default_max_width)
    return document


def _parse_edit(index: int, item, audio, path: str) -> Edit:
    where = f"{path!r} edits[{index}]"
    if not isinstance(item, dict):
        raise ConfirmError(f"{where} must be an object")
    channel = item.get("channel")
    start = item.get("start")
    end = item.get("end")
    method = item.get("method")
    if method is None:
        method = "interpolate"
    if method not in METHODS:
        raise ConfirmError(f"{where} method must be one of {', '.join(METHODS)}, got {method!r}")
    for name, value, low in (
        ("channel", channel, 0),
        ("start", start, 0),
        ("end", end, 0),
    ):
        if not isinstance(value, int) or isinstance(value, bool):
            raise ConfirmError(f"{where} {name} must be an integer")
        if value < low:
            raise ConfirmError(f"{where} {name} must be >= {low}")
    if not 0 <= channel < audio.channels:
        raise ConfirmError(f"{where} channel {channel} does not exist")
    if start >= end:
        raise ConfirmError(f"{where} start must be less than end")
    if end > audio.frames:
        raise ConfirmError(f"{where} end {end} exceeds frame count {audio.frames}")

    apply_to_raw = item.get("apply_to")
    if apply_to_raw is None:
        apply_to = ()
    else:
        if not isinstance(apply_to_raw, list) or not apply_to_raw:
            raise ConfirmError(f"{where} apply_to must be a non-empty list of channels")
        for channel_item in apply_to_raw:
            if not isinstance(channel_item, int) or isinstance(channel_item, bool):
                raise ConfirmError(f"{where} apply_to entries must be integers")
            if not 0 <= channel_item < audio.channels:
                raise ConfirmError(f"{where} apply_to channel {channel_item} does not exist")
        apply_to = tuple(apply_to_raw)

    return Edit(channel=channel, start=start, end=end, method=method, apply_to=apply_to)


def resolve_edits(document: ConfirmDocument, audio, max_width: int) -> list:
    """Apply the documented overlap policy and return resolved :class:`Edit`s.

    Resolved edits are canonical: one per ``(target channel, start, end)``
    with the merged method, sorted by ``(channel, start, end)``. This function
    is the single source of truth for both validation and repair application,
    so the written manifest and the produced audio cannot disagree.
    """
    expanded = []
    for ordinal, edit in enumerate(document.edits):
        for target in edit.target_channels:
            expanded.append(
                (target, edit.start, edit.end, edit.method, ordinal)
            )

    if document.overlap_policy == "reject":
        resolved = _reject_overlaps(expanded)
    else:
        resolved = _merge_overlaps(expanded, max_width)

    resolved.sort(key=lambda item: (item.channel, item.start, item.end))
    return resolved


def _merge_overlaps(expanded, max_width):
    by_channel: dict = {}
    for target, start, end, method, ordinal in expanded:
        by_channel.setdefault(target, []).append((start, end, method, ordinal))

    resolved = []
    for channel, spans in by_channel.items():
        spans.sort(key=lambda item: (item[0], item[1], item[2]))
        merged = []
        for start, end, method, ordinal in spans:
            if merged and start <= merged[-1][1]:
                cur_start, cur_end, cur_method, members = merged[-1]
                merged[-1] = (
                    cur_start,
                    max(cur_end, end),
                    _merge_method(cur_method, method),
                    members + (ordinal,),
                )
            else:
                merged.append((start, end, method, (ordinal,)))
        for start, end, method, members in merged:
            if end - start > max_width:
                raise OverlapError(
                    f"merging overlapping edits on channel {channel} would repair "
                    f"frames {start}..{end} ({end - start} frames), wider than the "
                    f"maximum repair width {max_width}; lower the range count or "
                    f"split the edits explicitly"
                )
            resolved.append(
                ResolvedEdit(
                    channel=channel,
                    start=start,
                    end=end,
                    method=method,
                    source_edits=members,
                )
            )
    return resolved


def _reject_overlaps(expanded):
    seen: dict = {}
    resolved = []
    for target, start, end, method, ordinal in expanded:
        for other_start, other_end, _other_method, other_ordinal in seen.get(target, ()):
            # ``end`` is exclusive, so adjacent ranges such as [10,20) and
            # [20,30) share no frames and are allowed. Only a genuine overlap
            # (at least one shared frame) is rejected.
            if start < other_end and other_start < end:
                raise OverlapError(
                    f"edits[{other_ordinal}] and edits[{ordinal}] overlap on channel "
                    f"{target} (shared frames {max(other_start, start)}.."
                    f"{min(other_end, end)}); overlap_policy is 'reject'"
                )
        seen.setdefault(target, []).append((start, end, method, ordinal))
        resolved.append(
            ResolvedEdit(
                channel=target,
                start=start,
                end=end,
                method=method,
                source_edits=(ordinal,),
            )
        )

    # Cross-channel disagreement: the same frame repaired with two methods is
    # ambiguous even without a same-channel overlap, so reject mode refuses it.
    by_frame: dict = {}
    for edit in resolved:
        for frame in range(edit.start, edit.end):
            by_frame.setdefault(frame, set()).add(edit.method)
    conflicts = [frame for frame, methods in by_frame.items() if len(methods) > 1]
    if conflicts:
        first = min(conflicts)
        raise OverlapError(
            "overlap_policy 'reject' forbids using different methods at the same "
            f"frame; frame {first} would be repaired with both interpolate and silence"
        )
    return resolved


def _merge_method(left: str, right: str) -> str:
    # interpolation is the less destructive method, so it wins a merge.
    return "interpolate" if "interpolate" in (left, right) else "silence"


@dataclass(frozen=True)
class ResolvedEdit:
    channel: int
    start: int
    end: int
    method: str
    source_edits: tuple = ()

    @property
    def frames(self) -> int:
        return self.end - self.start
