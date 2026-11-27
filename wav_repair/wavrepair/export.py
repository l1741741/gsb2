"""Exports: short before/after excerpts, the repair manifest, and a
post-repair verification report.

Everything written here is deterministic. JSON is serialised with
``sort_keys=True`` and fixed indentation; excerpt WAVs go through the same
canonical writer as the repaired output. No timestamps or absolute paths are
recorded in machine-readable output unless the caller passes them in
explicitly (``--timestamp`` on the CLI), so two runs on the same inputs yield
identical files.
"""

from __future__ import annotations

import hashlib
import json
import os

from .errors import WavRepairError
from .wavio import Audio, read_wav, write_wav

EXCERPT_PADDING = 24  # frames shown either side of a repaired range


def write_json(path: str, payload: dict) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    _atomic_write(path, text.encode("utf-8"))


def file_sha256(path: str) -> str:
    try:
        with open(path, "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except OSError as exc:
        raise WavRepairError(f"cannot hash {path!r}: {exc}") from exc


def _atomic_write(path: str, data: bytes) -> None:
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    temporary = f"{path}.tmp-{os.getpid()}"
    try:
        with open(temporary, "wb") as handle:
            handle.write(data)
        os.replace(temporary, path)
    except OSError as exc:
        try:
            os.unlink(temporary)
        except OSError:
            pass
        raise WavRepairError(f"cannot write {path!r}: {exc}") from exc


def excerpt_wav(audio: Audio, start: int, end: int) -> Audio:
    """Slice frames ``[start, end)`` of every channel, keeping the layout."""
    start = max(0, start)
    end = min(audio.frames, end)
    channels = audio.channels
    samples = audio.samples[start * channels: end * channels]
    return Audio(
        channels=channels,
        sample_rate=audio.sample_rate,
        codec=audio.codec,
        samples=samples,
        source_sha256="",
        source_path="",
    )


def export_excerpts(
    original: Audio,
    repaired: Audio,
    record: list,
    out_dir: str,
    name_prefix: str = "excerpt",
) -> dict:
    """Write one before/after pair per applied range and return a descriptor."""
    os.makedirs(out_dir, exist_ok=True)
    entries = []
    for ordinal, entry in enumerate(record, start=1):
        channel = entry["channel"]
        start, end = entry["start"], entry["end"]
        window_start = max(0, start - EXCERPT_PADDING)
        window_end = min(original.frames, end + EXCERPT_PADDING)
        label = f"{name_prefix}-{ordinal:03d}-ch{channel}-{start}-{end}"
        before_path = os.path.join(out_dir, f"{label}-before.wav")
        after_path = os.path.join(out_dir, f"{label}-after.wav")
        before = excerpt_wav(original, window_start, window_end)
        after = excerpt_wav(repaired, window_start, window_end)
        write_wav(before_path, before)
        write_wav(after_path, after)
        entries.append(
            {
                "index": ordinal,
                "channel": channel,
                "start": start,
                "end": end,
                "method": entry["method"],
                "window_start": window_start,
                "window_end": window_end,
                "before_path": before_path,
                "after_path": after_path,
                "before_sha256": file_sha256(before_path),
                "after_sha256": file_sha256(after_path),
                "before_samples": _samples_at(original, channel, window_start, window_end),
                "after_samples": _samples_at(repaired, channel, window_start, window_end),
            }
        )
    return {"padding_frames": EXCERPT_PADDING, "entries": entries}


def _samples_at(audio: Audio, channel: int, start: int, end: int, limit: int = 96) -> list:
    values = audio.channel_values(channel, start, end)
    out = [
        {"frame": start + offset, "value": value, "normalized": round(audio.normalize(value), 9)}
        for offset, value in enumerate(values[:limit])
    ]
    if len(values) > limit:
        out.append({"frame": start + limit, "truncated": True, "remaining": len(values) - limit})
    return out


def build_manifest(
    *,
    input_audio: Audio,
    input_path: str,
    output_path: str,
    confirm_path: str,
    document,
    resolved_edits: list,
    record: dict,
    excerpts: dict,
    scan_report_path: str | None = None,
    timestamp: str | None = None,
) -> dict:
    manifest = {
        "format": "wavrepair-manifest",
        "version": 1,
        "tool": {"name": "wavrepair", "deterministic": True},
        "input": {
            "path": input_path,
            "sha256": input_audio.source_sha256,
            "codec": input_audio.codec,
            "channels": input_audio.channels,
            "sample_rate": input_audio.sample_rate,
            "frames": input_audio.frames,
        },
        "output": {
            "path": output_path,
            "sha256": file_sha256(output_path),
            "codec": input_audio.codec,
            "channels": input_audio.channels,
            "sample_rate": input_audio.sample_rate,
            "frames": input_audio.frames,
            "frames_identical": True,
        },
        "confirmation": {
            "path": confirm_path,
            "sha256": file_sha256(confirm_path),
            "overlap_policy": document.overlap_policy,
            "ignored_candidates": list(document.ignored_candidates),
        },
        "repairs": {
            "count": len(record["edits"]),
            "ranges": record["edits"],
        },
        "excerpts": excerpts,
        "verification": verify_untouched(input_audio, read_wav(output_path), resolved_edits),
        "scan_report": scan_report_path,
    }
    if timestamp is not None:
        manifest["generated_at"] = timestamp
    return manifest


def verify_untouched(original: Audio, repaired: Audio, resolved_edits: list) -> dict:
    """Prove that every sample outside the resolved ranges is bit-identical.

    Returns a summary including a digest over all unconfirmed samples so the
    claim can be checked independently of the tool.
    """
    if repaired.frames != original.frames or repaired.channels != original.channels:
        raise WavRepairError("verify_untouched: geometry mismatch between input and output")

    channels = original.channels
    allowed = set()
    for edit in resolved_edits:
        for frame in range(edit.start, edit.end):
            allowed.add((frame, edit.channel))

    digest = hashlib.sha256()
    changed_outside = 0
    compared = 0
    changed_inside = 0
    for frame in range(original.frames):
        for channel in range(channels):
            index = frame * channels + channel
            a = original.samples[index]
            b = repaired.samples[index]
            if a != b:
                if (frame, channel) in allowed:
                    changed_inside += 1
                else:
                    changed_outside += 1
            else:
                digest.update(f"{frame}:{channel}:{a!r}\n".encode("utf-8"))
            compared += 1

    return {
        "geometry_preserved": True,
        "frames": repaired.frames,
        "sample_rate": repaired.sample_rate,
        "channels": repaired.channels,
        "codec": repaired.codec,
        "confirmed_samples_changed": changed_inside,
        "unconfirmed_samples_changed": changed_outside,
        "unconfirmed_untouched": changed_outside == 0,
        "compared_samples": compared,
        "unchanged_sample_digest": digest.hexdigest(),
    }
