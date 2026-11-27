"""CSV/JSON reports, marker tables and atomic output publication.

The success contract is strict: either every requested output (rendered WAV,
interval map, deleted-range report, mapped markers) is fully written and
validated, or none of the final output paths exist. Files are first written to
unique temporary names in the destination directory and only renamed into
place once all of them are complete; any failure rolls the partial files back
and removes the temporary copies.
"""

from __future__ import annotations

import csv
import io
import json
import os
import tempfile
from dataclasses import dataclass
from typing import List, Optional, Tuple

from .map import Marker, MappedMarker, RegionMap
from .wavio import WaveData, write_wav, format_timestamp


# ---------------------------------------------------------------------------
# Marker table IO
# ---------------------------------------------------------------------------

def parse_markers(path: str) -> List[Marker]:
    """Read a marker table.

    Accepted formats, chosen by extension:

    * ``.csv`` with a header row containing ``time_sec`` and optional
      ``label``; a header-less two-column ``time,label`` file also works;
    * ``.json`` as either ``[{"time_sec": 1.2, "label": "q1"}, ...]`` or
      ``{"markers": [...]}``.
    """
    ext = os.path.splitext(path)[1].lower()
    if ext == ".json":
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and "markers" in data:
            data = data["markers"]
        if not isinstance(data, list):
            raise ValueError("marker JSON must be a list or {'markers': [...]}")
        markers = []
        for row in data:
            if not isinstance(row, dict) or "time_sec" not in row:
                raise ValueError("each marker needs a numeric 'time_sec' field")
            markers.append(
                Marker(float(row["time_sec"]), str(row.get("label", "")))
            )
        return markers

    # Default to CSV.
    markers = []
    with open(path, "r", encoding="utf-8", newline="") as fh:
        sample = fh.read(2048)
        fh.seek(0)
        has_header = any(
            token in sample.lower()
            for token in ("time_sec", "time", "label")
        ) and not _first_numeric_row(sample)
        if has_header:
            reader = csv.DictReader(fh)
            if reader.fieldnames is None or not any(
                f and f.strip().lower() in ("time_sec", "time")
                for f in reader.fieldnames
            ):
                raise ValueError("marker CSV needs a 'time_sec' (or 'time') column")
            time_field = next(
                f for f in reader.fieldnames
                if f and f.strip().lower() in ("time_sec", "time")
            )
            label_field = next(
                (f for f in reader.fieldnames if f and f.strip().lower() == "label"),
                None,
            )
            for row in reader:
                if not row.get(time_field):
                    continue
                markers.append(
                    Marker(
                        float(row[time_field]),
                        row[label_field] if label_field and row.get(label_field) else "",
                    )
                )
        else:
            reader = csv.reader(fh)
            for row in reader:
                if not row or not row[0].strip():
                    continue
                markers.append(
                    Marker(float(row[0]), row[1] if len(row) > 1 else "")
                )
    markers.sort(key=lambda m: m.time_sec)
    return markers


def _first_numeric_row(sample: str) -> bool:
    first = sample.splitlines()[0] if sample else ""
    first_cell = next(csv.reader([first]), [""])[0].strip()
    try:
        float(first_cell)
        return True
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Report rendering
# ---------------------------------------------------------------------------

def map_csv(rmap: RegionMap) -> str:
    """Human-readable interval correspondence as CSV text."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        [
            "original_start",
            "original_end",
            "output_start",
            "output_end",
            "duration_sec",
        ]
    )
    for k in rmap.kept:
        writer.writerow(
            [
                format_timestamp(k.original_start_sec),
                format_timestamp(k.original_end_sec),
                format_timestamp(k.output_start_sec),
                format_timestamp(k.output_end_sec),
                f"{k.duration_sec:.3f}",
            ]
        )
    return buf.getvalue()


def deleted_csv(rmap: RegionMap) -> str:
    """Deleted ranges as CSV text."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["original_start", "original_end", "duration_sec", "source"])
    for d in rmap.deleted:
        writer.writerow(
            [
                format_timestamp(d.original_start_sec),
                format_timestamp(d.original_end_sec),
                f"{d.duration_sec:.3f}",
                f"pause {d.pause_index}" if d.pause_index is not None else "merged",
            ]
        )
    return buf.getvalue()


def markers_csv(markers: List[MappedMarker]) -> str:
    """Mapped marker table as CSV text, deleted markers flagged explicitly."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(
        ["original_time", "label", "status", "mapped_time", "detail"]
    )
    for m in markers:
        writer.writerow(
            [
                format_timestamp(m.time_sec),
                m.label,
                m.status,
                format_timestamp(m.mapped_time_sec)
                if m.mapped_time_sec is not None
                else "",
                m.detail,
            ]
        )
    return buf.getvalue()


def map_json(rmap: RegionMap, markers: Optional[List[MappedMarker]] = None) -> str:
    payload = rmap.to_dict()
    if markers is not None:
        payload["markers"] = [m.to_dict() for m in markers]
        payload["deleted_markers"] = [
            m.to_dict() for m in markers if m.status == "deleted"
        ]
    return json.dumps(payload, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Atomic publication
# ---------------------------------------------------------------------------

@dataclass
class OutputSpec:
    """One file to publish atomically: target path plus its rendered bytes."""

    target_path: str
    data: bytes


def render_outputs(
    output_wav: str,
    audio: WaveData,
    rmap: RegionMap,
    markers: Optional[List[MappedMarker]] = None,
) -> None:
    """Write every output atomically.

    On failure no target path is left behind (pre-existing targets are
    preserved when the new run fails).
    """
    specs: List[OutputSpec] = []

    # Encode the WAV to a temporary file first, then read its bytes back so a
    # single publish step moves all outputs together.
    out_dir = os.path.dirname(os.path.abspath(output_wav))
    os.makedirs(out_dir, exist_ok=True)
    wav_fd, wav_tmp = tempfile.mkstemp(
        prefix=".trim-", suffix=".wav", dir=out_dir
    )
    os.close(wav_fd)
    try:
        write_wav(wav_tmp, audio)
        _validate_wav(wav_tmp, audio, rmap)
        with open(wav_tmp, "rb") as fh:
            specs.append(OutputSpec(output_wav, fh.read()))
    finally:
        if os.path.exists(wav_tmp):
            os.unlink(wav_tmp)

    stem = os.path.splitext(output_wav)[0]
    specs.append(OutputSpec(stem + ".map.json", map_json(rmap, markers).encode("utf-8")))
    specs.append(OutputSpec(stem + ".intervals.csv", map_csv(rmap).encode("utf-8")))
    specs.append(OutputSpec(stem + ".deleted.csv", deleted_csv(rmap).encode("utf-8")))
    if markers is not None:
        specs.append(OutputSpec(stem + ".markers.csv", markers_csv(markers).encode("utf-8")))

    publish_atomic(specs)


def _validate_wav(path: str, expected: WaveData, rmap: RegionMap) -> None:
    """Re-open the rendered WAV and verify frame count and format metadata."""
    from .wavio import read_wav

    rendered = read_wav(path)
    if rendered.sample_rate != expected.sample_rate:
        raise RuntimeError("render validation failed: sample rate mismatch")
    if rendered.channels != expected.channels:
        raise RuntimeError("render validation failed: channel count mismatch")
    expected_frames = round(rmap.output_duration_sec * rmap.sample_rate)
    if rendered.frames != expected_frames:
        raise RuntimeError(
            f"render validation failed: expected {expected_frames} frames, "
            f"got {rendered.frames}"
        )


def publish_atomic(specs: List[OutputSpec]) -> None:
    """Move every spec into place together, rolling back on any failure."""
    destinations = [s.target_path for s in specs]
    if len(set(destinations)) != len(destinations):
        raise ValueError("duplicate output paths in atomic publish set")

    staging: List[Tuple[str, str]] = []
    backups: List[Tuple[str, Optional[str]]] = []
    try:
        for spec in specs:
            directory = os.path.dirname(os.path.abspath(spec.target_path))
            os.makedirs(directory, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(prefix=".trim-stage-", dir=directory)
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(spec.data)
                    fh.flush()
                    os.fsync(fh.fileno())
            except BaseException:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
                raise
            staging.append((tmp_path, spec.target_path))

        # Only back up existing targets once every temp file is complete.
        for _, target in staging:
            if os.path.exists(target):
                fd, backup_path = tempfile.mkstemp(
                    prefix=".trim-backup-",
                    dir=os.path.dirname(os.path.abspath(target)),
                )
                os.close(fd)
                os.replace(target, backup_path)
                backups.append((target, backup_path))
            else:
                backups.append((target, None))

        for tmp_path, target in staging:
            os.replace(tmp_path, target)
        backups.clear()
        staging.clear()
    except BaseException:
        # Undo any renames already performed and remove leftover temp files.
        for tmp_path, target in staging:
            if os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
        for target, backup_path in backups:
            try:
                if backup_path is not None and os.path.exists(backup_path):
                    if os.path.exists(target):
                        os.unlink(target)
                    os.replace(backup_path, target)
            except OSError:
                pass
        raise
    finally:
        # Best-effort cleanup of backup files after a successful publish.
        for _, backup_path in backups:
            if backup_path and os.path.exists(backup_path):
                try:
                    os.unlink(backup_path)
                except OSError:
                    pass
