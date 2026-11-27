"""Project configuration: colour table, image group, regions, and re-runs.

Two human-editable JSON files are supported:

``colors.json``
    The named ink table, with rename aliases and display order:
    ``{"inks": [{"name": ..., "rgb": "#RRGGBB", "previous_names": [...]}],
       "order": [...], "metric": "lab", "tie_epsilon": 0.05}``

``project.json``
    An *image group*: the shared colour table, screen, mode, crop, and a list
    of images with their guard regions.  Every run writes a manifest that
    records the resolved configuration and content hashes, so the same group
    can be re-run and verified later.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

from .colors import ColourError, InkTable, make_table, parse_ink_entry, TRANSPARENT
from .regions import Issue, ValidationError, resolve_regions, Region
from .screen import Screen, screen_from_json
from .separate import BINARISATION_MODES


class ConfigError(ValueError):
    """A configuration file is unreadable or structurally wrong."""


def load_json(path: str, what: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError as error:
        raise ConfigError(f"{what} file not found: {path}") from error
    except OSError as error:
        raise ConfigError(f"cannot read {what} file {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ConfigError(
            f"{what} file {path} is not valid JSON: {error.msg} "
            f"(line {error.lineno}, column {error.colno})"
        ) from error
    if not isinstance(payload, dict):
        raise ConfigError(f"{what} file {path} must contain a JSON object")
    return payload


# -- colour table ---------------------------------------------------------


@dataclass
class ColourTableFile:
    table: InkTable
    path: str

    def as_json(self) -> dict:
        return {
            "inks": [ink.as_json() for ink in self.table.inks],
            "order": [self.table.inks[index].name for index in self.table.order],
            "metric": self.table.metric,
            "tie_epsilon": self.table.tie_epsilon,
        }


def load_colour_table(path: str) -> ColourTableFile:
    payload = load_json(path, "colour table")
    inks_payload = payload.get("inks")
    if not isinstance(inks_payload, list) or not inks_payload:
        raise ConfigError(f"{path}: 'inks' must be a non-empty list")
    entries = []
    for index, entry in enumerate(inks_payload):
        try:
            entries.append(parse_ink_entry(entry, index))
        except ColourError as error:
            raise ConfigError(f"{path}: {error}") from error
    unknown = sorted(set(payload) - {"inks", "order", "metric", "tie_epsilon"})
    if unknown:
        raise ConfigError(
            f"{path}: unknown keys {', '.join(unknown)}; "
            "expected inks, order, metric, tie_epsilon"
        )
    order = payload.get("order")
    if order is not None and not isinstance(order, list):
        raise ConfigError(f"{path}: 'order' must be a list of ink names")
    metric = payload.get("metric", "lab")
    tie_epsilon = payload.get("tie_epsilon", 0.05)
    if not isinstance(tie_epsilon, (int, float)) or isinstance(tie_epsilon, bool):
        raise ConfigError(f"{path}: 'tie_epsilon' must be a number")
    try:
        table = make_table(
            entries,
            order_names=order,
            metric=metric,
            tie_epsilon=float(tie_epsilon),
        )
    except ColourError as error:
        raise ConfigError(f"{path}: {error}") from error
    return ColourTableFile(table, os.path.abspath(path))


# -- project / image group ------------------------------------------------


@dataclass
class ImageJob:
    name: str
    source: str
    source_path: str
    regions: list[Region] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    crop: object = None  # raw 'crop' object, validated against the image at run time


@dataclass
class Project:
    path: str
    base_dir: str
    table: InkTable
    table_path: str | None
    screen: Screen | None
    mode: str
    jobs: list[ImageJob]
    raw: dict
    solid_delta: float = 3.0

    def as_manifest_config(self) -> dict:
        return {
            "colour_table": None if self.table_path is None else os.path.relpath(self.table_path, self.base_dir),
            "screen": None if self.screen is None else self.screen.as_json(),
            "mode": self.mode,
        }


def _load_table_from_project(payload: dict, base_dir: str, project_path: str) -> tuple[InkTable, str | None]:
    table_reference = payload.get("colour_table")
    if isinstance(table_reference, str):
        table_path = os.path.join(base_dir, table_reference)
        try:
            loaded = load_colour_table(table_path)
        except ConfigError as error:
            raise ConfigError(f"{project_path}: {error}") from error
        return loaded.table, loaded.path
    inline = payload.get("inks")
    if inline is None:
        raise ConfigError(
            f"{project_path}: provide 'colour_table' (a path) or an inline 'inks' list"
        )
    if not isinstance(inline, list) or not inline:
        raise ConfigError(f"{project_path}: inline 'inks' must be a non-empty list")
    entries = []
    for index, entry in enumerate(inline):
        try:
            entries.append(parse_ink_entry(entry, index))
        except ColourError as error:
            raise ConfigError(f"{project_path}: {error}") from error
    order = payload.get("order")
    if order is not None and not isinstance(order, list):
        raise ConfigError(f"{project_path}: 'order' must be a list of ink names")
    metric = payload.get("metric", "lab")
    tie_epsilon = payload.get("tie_epsilon", 0.05)
    if not isinstance(tie_epsilon, (int, float)) or isinstance(tie_epsilon, bool):
        raise ConfigError(f"{project_path}: 'tie_epsilon' must be a number")
    try:
        table = make_table(
            entries, order_names=order, metric=metric, tie_epsilon=float(tie_epsilon)
        )
    except ColourError as error:
        raise ConfigError(f"{project_path}: {error}") from error
    return table, None


def load_project(path: str) -> Project:
    payload = load_json(path, "project")
    base_dir = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(base_dir):
        raise ConfigError(f"project directory does not exist: {base_dir}")
    try:
        table, table_path = _load_table_from_project(payload, base_dir, path)
    except ConfigError:
        raise
    mode = payload.get("mode", "screened")
    if mode not in BINARISATION_MODES:
        raise ConfigError(
            f"{path}: 'mode' must be one of {', '.join(BINARISATION_MODES)}"
        )
    solid_delta = payload.get("solid_delta", 3.0)
    if (
        not isinstance(solid_delta, (int, float))
        or isinstance(solid_delta, bool)
        or solid_delta < 0
    ):
        raise ConfigError(f"{path}: 'solid_delta' must be a non-negative number")
    screen: Screen | None
    if mode == "screened":
        try:
            screen = screen_from_json(payload.get("screen"))
        except ValueError as error:
            raise ConfigError(f"{path}: {error}") from error
    else:
        screen = None

    images_payload = payload.get("images")
    if not isinstance(images_payload, list) or not images_payload:
        raise ConfigError(f"{path}: 'images' must be a non-empty list")
    jobs: list[ImageJob] = []
    issues: list[Issue] = []
    seen: set[str] = set()
    for position, entry in enumerate(images_payload):
        if not isinstance(entry, dict):
            issues.append(Issue(f"images[{position}]", None, None, "image entry must be an object"))
            continue
        name = entry.get("name")
        source = entry.get("source", entry.get("file"))
        if not isinstance(name, str) or not name.strip():
            issues.append(
                Issue(
                    source if isinstance(source, str) else f"images[{position}]",
                    None,
                    None,
                    "image needs a non-empty 'name'",
                )
            )
            continue
        name = name.strip()
        if name in seen:
            issues.append(Issue(f"images[{position}]", None, None, f"duplicate image name {name!r}"))
            continue
        seen.add(name)
        if not isinstance(source, str) or not source.strip():
            issues.append(Issue(name, None, None, "image needs a 'source' PNG path"))
            continue
        if not source.lower().endswith(".png"):
            issues.append(Issue(name, None, None, "only .png artwork is supported"))
            continue
        source_path = os.path.join(base_dir, source)
        if not os.path.isfile(source_path):
            issues.append(
                Issue(name, None, None, f"source PNG not found: {source_path}")
            )
            continue
        from .pngio import PNGError, read_png

        try:
            image = read_png(source_path)
        except PNGError as error:
            issues.append(Issue(name, None, None, str(error)))
            continue
        region_entries = entry.get("regions")
        try:
            regions, region_issues = resolve_regions(
                name, image.width, image.height, region_entries, table, base_dir
            )
        except ValidationError as error:
            issues.extend(error.issues)
            continue
        issues.extend(region_issues)
        tags = entry.get("tags", [])
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            issues.append(Issue(name, None, None, "'tags' must be a list of strings"))
            tags = []
        jobs.append(
            ImageJob(
                name=name,
                source=source,
                source_path=os.path.abspath(source_path),
                regions=regions,
                tags=list(tags),
                crop=entry.get("crop"),
            )
        )
    if issues:
        raise ValidationError(issues, heading=f"cannot load project {path}")

    return Project(
        path=os.path.abspath(path),
        base_dir=base_dir,
        table=table,
        table_path=table_path,
        screen=screen,
        mode=mode,
        jobs=jobs,
        raw=payload,
        solid_delta=float(solid_delta),
    )


def colour_table_to_json(table: InkTable) -> dict:
    return {
        "inks": [ink.as_json() for ink in table.inks],
        "order": [table.inks[index].name for index in table.order],
        "metric": table.metric,
        "tie_epsilon": table.tie_epsilon,
    }
