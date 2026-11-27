"""Render a project: plates, occupancy maps, previews, crop proofs, manifest.

Layout written under ``--out``::

    manifest.json
    report.json
    report.md
    images/<slug>/preview.png                composite, rebuilt from plates + table
    images/<slug>/plates/<ink>.png            the printing plate (0/1 screen mask)
    images/<slug>/occupancy/<ink>.png         grayscale 0-255 ink occupancy
    images/<slug>/previews/<ink>.png          one-ink proof, from plate + table
    images/<slug>/crops/<crop>/...            the same three families for a crop

Two distinct concepts are kept apart on purpose:

* **occupancy** is how much ink a pixel wants (0-255).  It is what a designer
  reads when judging how much of an area a colour covers.
* **plate** is what actually prints after the screen is applied (0 or 1).  The
  composite preview is rebuilt from the plates and the colour table *only*, so
  anyone holding the plates and the table can reproduce the preview exactly.

Crop proofs are screened with the crop's true full-image origin.  The run then
compares every crop plate and the crop preview against the same rectangle cut
from the full-image result; any difference is a hard error naming the image,
the crop, and the exact pixel range.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

from .colors import InkTable
from .manifest import (
    TOOL_NAME,
    TOOL_VERSION,
    build_config_payload,
    config_fingerprint,
    sha256_file,
    write_manifest,
)
from .pngio import (
    Image,
    PNGError,
    encode_gray8_png,
    encode_rgba_png,
    read_png,
    write_bytes_atomic,
)
from .regions import (
    Issue,
    ValidationError,
    check_keep_transparent,
    format_rect,
    region_summary,
)
from .separate import (
    Separator,
    build_masks,
    crop_mask,
    rebuild_preview,
    single_ink_preview,
    slug,
    verify_plate_invariants,
)

DEFAULT_TRANSPARENT_RGB = (255, 255, 255)


@dataclass
class CropSpec:
    name: str
    x: int
    y: int
    width: int
    height: int

    @property
    def rect(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.width, self.height)

    def as_json(self) -> dict:
        return {
            "name": self.name,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        }


def parse_crop(
    entry: object,
    image_width: int,
    image_height: int,
    image_name: str,
    where: str,
) -> CropSpec | None:
    if entry is None:
        return None
    if not isinstance(entry, dict):
        raise ValidationError(
            [Issue(image_name, None, None, f"{where}: 'crop' must be an object")]
        )
    name = entry.get("name", "crop")
    if not isinstance(name, str) or not name.strip():
        raise ValidationError(
            [Issue(image_name, None, None, f"{where}: crop 'name' must be a non-empty string")]
        )
    name = name.strip()
    values = [entry.get(key) for key in ("x", "y", "width", "height")]
    if not all(isinstance(value, int) and not isinstance(value, bool) for value in values):
        raise ValidationError(
            [Issue(image_name, name, None, f"{where}: crop needs integer x, y, width, height")]
        )
    x, y, width, height = values  # type: ignore[misc]
    if width <= 0 or height <= 0:
        raise ValidationError(
            [
                Issue(
                    image_name,
                    name,
                    format_rect((x, y, width, height)),
                    f"{where}: crop width and height must be positive",
                )
            ]
        )
    if x < 0 or y < 0 or x + width > image_width or y + height > image_height:
        raise ValidationError(
            [
                Issue(
                    image_name,
                    name,
                    format_rect((x, y, width, height)),
                    f"{where}: crop is outside the {image_width}x{image_height} image",
                )
            ]
        )
    return CropSpec(name, x, y, width, height)


def resolve_job_crop(project, job, image) -> CropSpec | None | ValidationError:
    """A per-image crop wins over the project-level crop."""
    if job.crop is not None:
        try:
            return parse_crop(job.crop, image.width, image.height, job.name, "image crop")
        except ValidationError as error:
            return error
    project_crop = project.raw.get("crop")
    if project_crop is None:
        return None
    try:
        return parse_crop(project_crop, image.width, image.height, job.name, "project crop")
    except ValidationError as error:
        return error


def _plate_bytes(width: int, height: int, plate: bytearray) -> bytes:
    return encode_gray8_png(width, height, bytes(plate))


def _check_crop_consistency(
    image_name: str,
    crop: CropSpec,
    full_masks: list[bytearray],
    crop_masks: list[bytearray],
    full_preview: Image,
    crop_preview: Image,
    table: InkTable,
) -> list[Issue]:
    """Compare a crop against the same rectangle of the full-image result."""
    issues: list[Issue] = []
    full_width = full_preview.width
    for ink in table.inks:
        full = full_masks[ink.index]
        cropped = crop_masks[ink.index]
        mismatch = 0
        min_x = min_y = 10**9
        max_x = max_y = -1
        for row in range(crop.height):
            source = (crop.y + row) * full_width + crop.x
            for column in range(crop.width):
                left = full[source + column]
                right = cropped[row * crop.width + column]
                if left != right:
                    mismatch += 1
                    full_x = crop.x + column
                    full_y = crop.y + row
                    min_x = min(min_x, full_x)
                    max_x = max(max_x, full_x)
                    min_y = min(min_y, full_y)
                    max_y = max(max_y, full_y)
        if mismatch:
            bounds = format_rect((min_x, min_y, max_x - min_x + 1, max_y - min_y + 1))
            issues.append(
                Issue(
                    image_name,
                    crop.name,
                    format_rect(crop.rect),
                    f'crop plate "{ink.name}" differs from the full plate at '
                    f"{bounds} ({mismatch} px): screen dots are not aligned",
                )
            )
    pixel_mismatch = 0
    min_x = min_y = 10**9
    max_x = max_y = -1
    for row in range(crop.height):
        for column in range(crop.width):
            full_pixel = full_preview.pixel(crop.x + column, crop.y + row)
            crop_pixel = crop_preview.pixel(column, row)
            if full_pixel != crop_pixel:
                pixel_mismatch += 1
                full_x = crop.x + column
                full_y = crop.y + row
                min_x = min(min_x, full_x)
                max_x = max(max_x, full_x)
                min_y = min(min_y, full_y)
                max_y = max(max_y, full_y)
    if pixel_mismatch:
        bounds = format_rect((min_x, min_y, max_x - min_x + 1, max_y - min_y + 1))
        issues.append(
            Issue(
                image_name,
                crop.name,
                format_rect(crop.rect),
                f"crop preview differs from the full preview at {bounds} "
                f"({pixel_mismatch} px): screen dots are not aligned",
            )
        )
    return issues


def _usage_markdown(image_name: str, stats: dict) -> list[str]:
    prefix = f"images/{slug(image_name)}"
    lines = [
        f"### {image_name}",
        "",
        f"Total pixels: {stats['total_pixels']}",
        "",
        "| Ink | Colour | Occupancy px | Occupancy % | Printed px | Printed % | "
        "Occupancy map | Plate | Preview |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in stats["inks"]:
        lines.append(
            f"| {row['ink']} | {row['rgb']} | {row['occupancy_pixels']:.2f} | "
            f"{row['occupancy_ratio'] * 100:.2f}% | {row['printed_pixels']} | "
            f"{row['printed_ratio'] * 100:.2f}% | "
            f"`{prefix}/occupancy/{slug(row['ink'])}.png` | "
            f"`{prefix}/plates/{slug(row['ink'])}.png` | "
            f"`{prefix}/previews/{slug(row['ink'])}.png` |"
        )
    transparent = stats["transparent"]
    lines.append(
        f"| (transparent) | — | — | — | {transparent['preview_pixels']} | "
        f"{transparent['preview_ratio'] * 100:.2f}% | — | — | — |"
    )
    lines.extend(
        [
            "",
            f"Remaining transparent area: {transparent['preview_pixels']} px "
            f"({transparent['preview_ratio'] * 100:.2f}%) in the proof; "
            f"{transparent['source_pixels']} px "
            f"({transparent['source_ratio'] * 100:.2f}%) in the source artwork. "
            f"Pixels inside guard regions: {stats['guarded_pixels']}.",
            "",
        ]
    )
    return lines


def _statistics(separation, preview: Image) -> dict:
    total = separation.image.width * separation.image.height
    inks: list[dict] = []
    for ink in separation.table.inks:
        plate = separation.plates[ink.index]
        mask = separation.masks[ink.index]
        printed = sum(mask)
        occupancy = sum(plate) / 255.0
        inks.append(
            {
                "ink": ink.name,
                "rgb": ink.hex,
                "printed_pixels": printed,
                "printed_ratio": round(printed / total, 6) if total else 0.0,
                "occupancy_pixels": round(occupancy, 3),
                "occupancy_ratio": round(occupancy / total, 6) if total else 0.0,
            }
        )
    source_transparent = separation.assignment.transparent_count()
    preview_transparent = 0
    preview_data = preview.data
    for index in range(total):
        if preview_data[index * 4 + 3] == 0:
            preview_transparent += 1
    return {
        "total_pixels": total,
        "inks": inks,
        "transparent": {
            "source_pixels": source_transparent,
            "source_ratio": round(source_transparent / total, 6) if total else 0.0,
            "preview_pixels": preview_transparent,
            "preview_ratio": round(preview_transparent / total, 6) if total else 0.0,
        },
        "guarded_pixels": separation.guarded_pixels,
    }


def _write_image_family(
    output_dir: str,
    image_dir: str,
    table: InkTable,
    plates: list[bytearray],
    masks: list[bytearray],
    width: int,
    height: int,
    transparent_rgb: tuple[int, int, int],
) -> dict:
    """Write occupancy maps, plates, per-ink proofs, and the composite preview."""
    occupancy_paths: list[str] = []
    plate_paths: list[str] = []
    preview_paths: list[str] = []
    for ink in table.inks:
        occupancy_path = os.path.join(image_dir, "occupancy", f"{slug(ink.name)}.png")
        write_bytes_atomic(occupancy_path, _plate_bytes(width, height, plates[ink.index]))
        occupancy_paths.append(occupancy_path)
        plate_path = os.path.join(image_dir, "plates", f"{slug(ink.name)}.png")
        write_bytes_atomic(plate_path, _plate_bytes(width, height, masks[ink.index]))
        plate_paths.append(plate_path)
        proof = single_ink_preview(
            table, ink.index, masks[ink.index], width, height, transparent_rgb
        )
        proof_path = os.path.join(image_dir, "previews", f"{slug(ink.name)}.png")
        write_bytes_atomic(proof_path, encode_rgba_png(proof))
        preview_paths.append(proof_path)
    composite = rebuild_preview(table, masks, width, height, transparent_rgb)
    composite_path = os.path.join(image_dir, "preview.png")
    write_bytes_atomic(composite_path, encode_rgba_png(composite))
    return {
        "preview": composite_path,
        "composite": composite,
        "plates": plate_paths,
        "occupancy": occupancy_paths,
        "previews": preview_paths,
    }


def run_project(project, output_dir: str, write_manifest_file: bool = True) -> dict:
    """Render the project into ``output_dir`` and return the manifest payload."""
    os.makedirs(output_dir, exist_ok=True)
    table: InkTable = project.table
    screen = project.screen
    separator = Separator(
        table, screen, project.mode, getattr(project, "solid_delta", 3.0)
    )

    issues: list[Issue] = []
    outputs: list[dict] = []
    image_manifest_entries: list[dict] = []
    report_images: list[dict] = []
    report_markdown: list[str] = [
        "# Inkproof separation report",
        "",
        f"Tool: {TOOL_NAME} {TOOL_VERSION}  ",
        f"Mode: `{project.mode}`  ",
        f"Metric: `{table.metric}` (tie epsilon {table.tie_epsilon})  ",
        "Screen: "
        + (
            "none (nearest ink, flat plates)"
            if project.mode == "nearest"
            else f"`{separator.screen.kind}` cell {separator.screen.cell} px, "
            f"angle {separator.screen.angle}°, {separator.screen.levels} levels, "
            f"solid delta {separator.solid_delta}"
        ),
        "",
        "## Colour table",
        "",
        "| Order | Ink | Colour | Previous names |",
        "| --- | --- | --- | --- |",
    ]
    for position, ink in enumerate(table.display_order(), start=1):
        aliases = ", ".join(ink.previous_names) if ink.previous_names else "—"
        report_markdown.append(f"| {position} | {ink.name} | {ink.hex} | {aliases} |")
    report_markdown.append("")

    transparent_rgb = DEFAULT_TRANSPARENT_RGB
    for job in project.jobs:
        try:
            image = read_png(job.source_path)
        except PNGError as error:
            issues.append(Issue(job.name, None, None, str(error)))
            continue
        keep_issues = check_keep_transparent(job.name, job.regions, image)
        if keep_issues:
            issues.extend(keep_issues)
            continue

        crop = resolve_job_crop(project, job, image)
        if isinstance(crop, ValidationError):
            issues.extend(crop.issues)
            continue

        separation = separator.separate(image, job.regions)
        invariant_problems = verify_plate_invariants(separation)
        if invariant_problems:
            for problem in invariant_problems:
                issues.append(Issue(job.name, None, None, problem))
            continue

        image_dir = os.path.join(output_dir, "images", slug(job.name))
        full = _write_image_family(
            output_dir,
            image_dir,
            table,
            separation.plates,
            separation.masks,
            image.width,
            image.height,
            transparent_rgb,
        )
        stats = _statistics(separation, full["composite"])

        crop_entries: list[dict] = []
        if crop is not None:
            crop_dir = os.path.join(image_dir, "crops", slug(crop.name))
            crop_plates = [
                crop_mask(plate, image.width, crop.rect) for plate in separation.plates
            ]
            crop_masks = build_masks(
                crop_plates,
                crop.width,
                crop.height,
                separator.screen if project.mode == "screened" else None,
                origin=(crop.x, crop.y),
            )
            crop_output = _write_image_family(
                output_dir,
                crop_dir,
                table,
                crop_plates,
                crop_masks,
                crop.width,
                crop.height,
                transparent_rgb,
            )
            consistency_issues = _check_crop_consistency(
                job.name,
                crop,
                separation.masks,
                crop_masks,
                full["composite"],
                crop_output["composite"],
                table,
            )
            issues.extend(consistency_issues)
            crop_entries.append(
                {
                    "name": crop.name,
                    "rect": crop.as_json(),
                    "preview": os.path.relpath(crop_output["preview"], output_dir),
                    "plates": [
                        os.path.relpath(path, output_dir) for path in crop_output["plates"]
                    ],
                    "occupancy": [
                        os.path.relpath(path, output_dir) for path in crop_output["occupancy"]
                    ],
                    "previews": [
                        os.path.relpath(path, output_dir) for path in crop_output["previews"]
                    ],
                    "consistent": not consistency_issues,
                }
            )
            for path in [
                crop_output["preview"],
                *crop_output["plates"],
                *crop_output["occupancy"],
                *crop_output["previews"],
            ]:
                outputs.append(
                    {"path": os.path.relpath(path, output_dir), "sha256": sha256_file(path)}
                )

        report_images.append(
            {
                "name": job.name,
                "source": job.source,
                "width": image.width,
                "height": image.height,
                "regions": [region_summary(region, table) for region in job.regions],
                "statistics": stats,
                "crops": crop_entries,
                "invariants": separation.invariant_checks,
                "preview": os.path.relpath(full["preview"], output_dir),
                "plates": [os.path.relpath(path, output_dir) for path in full["plates"]],
                "occupancy": [
                    os.path.relpath(path, output_dir) for path in full["occupancy"]
                ],
                "previews": [
                    os.path.relpath(path, output_dir) for path in full["previews"]
                ],
            }
        )
        report_markdown.extend(_usage_markdown(job.name, stats))
        if job.regions:
            report_markdown.append("Guard regions:")
            for region in job.regions:
                ink = (
                    table.inks[region.ink_index].name
                    if region.ink_index is not None
                    else "—"
                )
                report_markdown.append(
                    f"- `{region.name}`: {region.policy}"
                    + (f" → {ink}" if region.ink_index is not None else "")
                    + f", {region.geometry}, {region.pixels} px"
                )
            report_markdown.append("")
        for entry in crop_entries:
            report_markdown.append(
                f"Crop `{entry['name']}` at {format_rect(crop.rect)}: dot alignment "
                f"{'OK' if entry['consistent'] else 'MISMATCH'}."
            )
        if crop_entries:
            report_markdown.append("")

        image_manifest_entries.append(
            {
                "name": job.name,
                "source": job.source,
                "source_sha256": sha256_file(job.source_path),
                "width": image.width,
                "height": image.height,
                "regions": [region_summary(region, table) for region in job.regions],
                "crops": [entry["rect"] for entry in crop_entries],
                "outputs": {
                    "preview": os.path.relpath(full["preview"], output_dir),
                    "plates": [os.path.relpath(path, output_dir) for path in full["plates"]],
                    "occupancy": [
                        os.path.relpath(path, output_dir) for path in full["occupancy"]
                    ],
                    "previews": [
                        os.path.relpath(path, output_dir) for path in full["previews"]
                    ],
                    "crops": [
                        {
                            "name": entry["name"],
                            "preview": entry["preview"],
                            "plates": entry["plates"],
                            "occupancy": entry["occupancy"],
                            "previews": entry["previews"],
                        }
                        for entry in crop_entries
                    ],
                },
            }
        )
        for path in [
            full["preview"],
            *full["plates"],
            *full["occupancy"],
            *full["previews"],
        ]:
            outputs.append(
                {"path": os.path.relpath(path, output_dir), "sha256": sha256_file(path)}
            )

    if issues:
        raise ValidationError(issues, heading="separation failed")

    report = {
        "tool": TOOL_NAME,
        "version": TOOL_VERSION,
        "mode": project.mode,
        "metric": table.metric,
        "tie_epsilon": table.tie_epsilon,
        "solid_delta": separator.solid_delta,
        "inks": [ink.as_json() for ink in table.inks],
        "order": [table.inks[index].name for index in table.order],
        "screen": None if project.mode == "nearest" else separator.screen.as_json(),
        "images": report_images,
    }
    report_json_path = os.path.join(output_dir, "report.json")
    write_bytes_atomic(
        report_json_path,
        (json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode(
            "utf-8"
        ),
    )
    report_md_path = os.path.join(output_dir, "report.md")
    write_bytes_atomic(
        report_md_path,
        ("\n".join(report_markdown).rstrip() + "\n").encode("utf-8"),
    )
    for path in (report_json_path, report_md_path):
        outputs.append(
            {"path": os.path.relpath(path, output_dir), "sha256": sha256_file(path)}
        )

    config_payload = build_config_payload(project, image_manifest_entries, separator)
    manifest = {
        "tool": TOOL_NAME,
        "version": TOOL_VERSION,
        "config": config_payload,
        "config_fingerprint": config_fingerprint(config_payload),
        "outputs": sorted(outputs, key=lambda entry: entry["path"]),
    }
    if write_manifest_file:
        write_manifest(os.path.join(output_dir, "manifest.json"), manifest)
    return manifest
