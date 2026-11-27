"""Original/output time mapping.

Everything is derived from the :class:`~trimmer.edit.EditPlan` kept ranges, so
the map is consistent with the rendered audio down to the sample.

Conventions:

* Frame intervals are half-open ``[start, end)``.
* Time is seconds from the start of the respective timeline.
* A point landing on a boundary is attributed to the surviving side, i.e. a
  deletion start frame still maps (to the junction instant); a point inside
  ``[deletion_start, deletion_end)`` is reported as deleted.
"""

from __future__ import annotations

import bisect
from dataclasses import dataclass, field
from typing import List, Optional

from .edit import EditPlan


@dataclass
class KeptInterval:
    """One row of the interval correspondence table."""

    original_start_sec: float
    original_end_sec: float
    output_start_sec: float
    output_end_sec: float
    duration_sec: float


@dataclass
class DeletedInterval:
    """One row of the deleted-ranges report."""

    original_start_sec: float
    original_end_sec: float
    duration_sec: float
    pause_index: Optional[int]


@dataclass
class RegionMap:
    """Complete original<->output correspondence for one render."""

    sample_rate: int
    input_duration_sec: float
    output_duration_sec: float
    kept: List[KeptInterval] = field(default_factory=list)
    deleted: List[DeletedInterval] = field(default_factory=list)
    # Frame-level bookkeeping for point lookups.
    _kept_orig: List[tuple] = field(default_factory=list, repr=False)
    _deleted_frames: List[tuple] = field(default_factory=list, repr=False)
    # Output frame -> (kept list index) for reverse lookups.
    _output_starts: List[int] = field(default_factory=list, repr=False)

    def to_dict(self) -> dict:
        return {
            "sample_rate": self.sample_rate,
            "input_duration_sec": self.input_duration_sec,
            "output_duration_sec": self.output_duration_sec,
            "intervals": [
                {
                    "original_start_sec": k.original_start_sec,
                    "original_end_sec": k.original_end_sec,
                    "output_start_sec": k.output_start_sec,
                    "output_end_sec": k.output_end_sec,
                    "duration_sec": k.duration_sec,
                }
                for k in self.kept
            ],
            "deleted": [
                {
                    "original_start_sec": d.original_start_sec,
                    "original_end_sec": d.original_end_sec,
                    "duration_sec": d.duration_sec,
                    "pause_index": d.pause_index,
                }
                for d in self.deleted
            ],
            # Frame-exact bookkeeping lets tooling reconstruct point lookups
            # without re-rounding seconds back to frames.
            "frames": {
                "kept": [
                    {
                        "original_start": a,
                        "original_end": b,
                        "output_start": out,
                        "length": length,
                    }
                    for a, b, out, length in self._kept_orig
                ],
                "deleted": [
                    {
                        "original_start": a,
                        "original_end": b,
                        "pause_index": idx,
                    }
                    for a, b, idx in self._deleted_frames
                ],
            },
        }

    @classmethod
    def from_dict(cls, payload: dict) -> "RegionMap":
        """Rebuild a :class:`RegionMap` from :meth:`to_dict` output."""
        sr = payload["sample_rate"]
        rmap = cls(
            sample_rate=sr,
            input_duration_sec=payload["input_duration_sec"],
            output_duration_sec=payload["output_duration_sec"],
        )
        frames = payload.get("frames")
        if frames:
            out_cursor = 0
            for row in frames["kept"]:
                a, b, out, length = (
                    row["original_start"],
                    row["original_end"],
                    row["output_start"],
                    row["length"],
                )
                rmap.kept.append(
                    KeptInterval(a / sr, b / sr, out / sr, (out + length) / sr, length / sr)
                )
                rmap._kept_orig.append((a, b, out, length))
                rmap._output_starts.append(out)
                out_cursor = out + length
            for row in frames["deleted"]:
                a, b, idx = row["original_start"], row["original_end"], row.get("pause_index")
                rmap.deleted.append(
                    DeletedInterval(a / sr, b / sr, (b - a) / sr, idx)
                )
                rmap._deleted_frames.append((a, b, idx))
            return rmap

        # Fallback for hand-written maps without frame data.
        out_cursor = 0
        for row in payload["intervals"]:
            a = round(row["original_start_sec"] * sr)
            b = round(row["original_end_sec"] * sr)
            length = round(row["duration_sec"] * sr)
            rmap.kept.append(
                KeptInterval(
                    row["original_start_sec"],
                    row["original_end_sec"],
                    out_cursor / sr,
                    (out_cursor + length) / sr,
                    row["duration_sec"],
                )
            )
            rmap._kept_orig.append((a, b, out_cursor, length))
            rmap._output_starts.append(out_cursor)
            out_cursor += length
        for row in payload["deleted"]:
            a = round(row["original_start_sec"] * sr)
            b = round(row["original_end_sec"] * sr)
            rmap.deleted.append(
                DeletedInterval(
                    row["original_start_sec"],
                    row["original_end_sec"],
                    row["duration_sec"],
                    row.get("pause_index"),
                )
            )
            rmap._deleted_frames.append((a, b, row.get("pause_index")))
        return rmap


def build_region_map(plan: EditPlan) -> RegionMap:
    """Build the :class:`RegionMap` for an edit plan."""
    sr = plan.sample_rate
    rmap = RegionMap(
        sample_rate=sr,
        input_duration_sec=plan.total_input_frames / sr,
        output_duration_sec=plan.output_frames / sr,
    )

    out_cursor = 0
    for piece in plan.kept:
        length = piece.length
        rmap.kept.append(
            KeptInterval(
                original_start_sec=piece.start_frame / sr,
                original_end_sec=piece.end_frame / sr,
                output_start_sec=out_cursor / sr,
                output_end_sec=(out_cursor + length) / sr,
                duration_sec=length / sr,
            )
        )
        rmap._kept_orig.append(
            (piece.start_frame, piece.end_frame, out_cursor, length)
        )
        rmap._output_starts.append(out_cursor)
        out_cursor += length

    for d in plan.deleted:
        rmap.deleted.append(
            DeletedInterval(
                original_start_sec=d.start_frame / sr,
                original_end_sec=d.end_frame / sr,
                duration_sec=d.length / sr,
                pause_index=d.pause_index,
            )
        )
        rmap._deleted_frames.append((d.start_frame, d.end_frame, d.pause_index))

    return rmap


@dataclass
class MappedPoint:
    """Result of mapping a single time point in either direction."""

    source_time_sec: float
    mapped_time_sec: Optional[float]
    status: str  # "mapped" or "deleted"
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "source_time_sec": self.source_time_sec,
            "mapped_time_sec": (
                None if self.mapped_time_sec is None else round(self.mapped_time_sec, 6)
            ),
            "status": self.status,
            "detail": self.detail,
        }


def locate_original(rmap: RegionMap, original_sec: float) -> MappedPoint:
    """Map an original-timeline time point onto the output timeline.

    Returns a deleted result when the point falls inside a removed range;
    boundary frames map to the junction instant on the surviving side.
    """
    sr = rmap.sample_rate
    frame = int(round(original_sec * sr))
    if frame < 0 or frame > rmap.sample_rate * rmap.input_duration_sec:
        return MappedPoint(
            original_sec,
            None,
            "deleted",
            "time point is outside the original recording",
        )

    # Deletion check: boundaries belong to the surviving side, so only frames
    # strictly inside (d_start, d_end) are reported as deleted. Both boundary
    # frames map to the junction instant via the kept-range lookup below.
    for d_start, d_end, idx in rmap._deleted_frames:
        if d_start < frame < d_end:
            label = f"pause {idx}" if idx is not None else "merged gap"
            return MappedPoint(
                original_sec,
                None,
                "deleted",
                f"inside deleted range {d_start / sr:.3f}s-{d_end / sr:.3f}s "
                f"({label})",
            )

    # Kept-range lookup.
    for o_start, o_end, out_start, length in rmap._kept_orig:
        if o_start <= frame < o_end:
            mapped = (out_start + (frame - o_start)) / sr
            return MappedPoint(original_sec, mapped, "mapped")
        if frame == o_end:
            # Exact end boundary: attribute to the junction (end of this row).
            mapped = (out_start + length) / sr
            return MappedPoint(original_sec, mapped, "mapped")

    # Frame past the final kept end but within the file: clamp to the tail.
    if rmap.kept:
        return MappedPoint(original_sec, rmap.output_duration_sec, "mapped")
    return MappedPoint(original_sec, None, "deleted", "the whole recording was removed")


def locate_output(rmap: RegionMap, output_sec: float) -> MappedPoint:
    """Map an output-timeline time point back to original time."""
    sr = rmap.sample_rate
    frame = int(round(output_sec * sr))
    total_out = rmap.sample_rate * rmap.output_duration_sec
    if frame < 0 or frame > total_out:
        return MappedPoint(
            output_sec,
            None,
            "deleted",
            "time point is outside the output recording",
        )

    # Find the kept interval whose output span contains this frame.
    starts = rmap._output_starts
    pos = bisect.bisect_right(starts, frame) - 1
    if pos < 0:
        return MappedPoint(output_sec, None, "deleted", "no output interval found")
    o_start, o_end, out_start, length = rmap._kept_orig[pos]
    offset = min(frame - out_start, length - 1)
    original = (o_start + max(offset, 0)) / sr
    return MappedPoint(output_sec, original, "mapped")


@dataclass
class Marker:
    """An external time marker carried alongside the recording."""

    time_sec: float
    label: str = ""


@dataclass
class MappedMarker:
    """A marker after mapping, including markers swallowed by a deletion."""

    time_sec: float
    label: str
    status: str  # "mapped" or "deleted"
    mapped_time_sec: Optional[float]
    detail: str = ""

    def to_dict(self) -> dict:
        return {
            "original_time_sec": self.time_sec,
            "label": self.label,
            "status": self.status,
            "mapped_time_sec": (
                None
                if self.mapped_time_sec is None
                else round(self.mapped_time_sec, 6)
            ),
            "detail": self.detail,
        }


def map_markers(rmap: RegionMap, markers: List[Marker]) -> List[MappedMarker]:
    """Map a whole marker table; deleted markers are reported separately."""
    result = []
    for marker in markers:
        point = locate_original(rmap, marker.time_sec)
        result.append(
            MappedMarker(
                time_sec=marker.time_sec,
                label=marker.label,
                status=point.status,
                mapped_time_sec=point.mapped_time_sec,
                detail=point.detail,
            )
        )
    return result
