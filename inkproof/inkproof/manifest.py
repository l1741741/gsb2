"""Run manifests, content hashes, and re-run verification.

A manifest records everything needed to decide whether a later run used the
same configuration and the same source pixels:

* the resolved colour table (names, colours, order, aliases, metric)
* the screen and the binarisation mode
* each image's source path and SHA-256, its guard regions, and its crop
* a SHA-256 for every output file

``verify`` re-runs a project into a temporary directory and compares it to an
existing output tree, file by file.  Because PNGs are written without any
timestamp, an unchanged configuration reproduces byte-identical outputs.
"""

from __future__ import annotations

import hashlib
import json
import os

TOOL_NAME = "inkproof"
TOOL_VERSION = "1.0.0"


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            for block in iter(lambda: handle.read(65536), b""):
                digest.update(block)
    except OSError as error:
        raise OSError(f"cannot hash {path}: {error}") from error
    return digest.hexdigest()


def canonical_json(payload: object) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def config_fingerprint(config_payload: dict) -> str:
    return sha256_bytes(canonical_json(config_payload).encode("utf-8"))


def build_config_payload(project, images_payload: list[dict], separator=None) -> dict:
    screen = project.screen
    if separator is not None and project.mode == "screened":
        screen = separator.screen
    screen_note = None if project.mode == "nearest" else screen
    return {
        "tool": TOOL_NAME,
        "version": TOOL_VERSION,
        "mode": project.mode,
        "metric": project.table.metric,
        "tie_epsilon": project.table.tie_epsilon,
        "solid_delta": 3.0 if separator is None else separator.solid_delta,
        "inks": [ink.as_json() for ink in project.table.inks],
        "order": [project.table.inks[index].name for index in project.table.order],
        "screen": None if screen_note is None else screen_note.as_json(),
        "images": images_payload,
    }


def write_manifest(path: str, manifest: dict) -> None:
    payload = json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(payload + "\n")
