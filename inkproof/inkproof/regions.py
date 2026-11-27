"""Guarded regions: force a specific ink, or reserve an area as transparent.

Regions are rectangles or alpha/luminance masks.  Every validation problem
carries the image name, the region name, and the pixel range, because that is
the information a designer needs to fix the artwork or the colour table.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

from .pngio import PNGError, Image, read_png

KEEP_TRANSPARENT = "keep-transparent"
FORCE = "force"


@dataclass(frozen=True)
class Issue:
    image: str
    region: str | None
    geometry: str | None
    message: str

    def format(self) -> str:
        parts = [self.image]
        if self.region is not None:
            parts.append(f'region "{self.region}"')
        if self.geometry:
            parts.append(self.geometry)
        return ": ".join(parts) + f": {self.message}"


class ValidationError(Exception):
    """One or more configuration or artwork problems, each with a location."""

    def __init__(self, issues: list[Issue], heading: str = "validation failed"):
        self.issues = list(issues)
        body = "\n".join(f"  - {issue.format()}" for issue in self.issues)
        super().__init__(f"{heading} ({len(self.issues)} problem(s)):\n{body}")


def format_rect(rect: tuple[int, int, int, int]) -> str:
    x, y, width, height = rect
    return f"[x={x}, y={y}, w={width}, h={height}]"


def mask_bounds(mask: bytearray, width: int, height: int):
    """Return ``(rect, count)`` for the set pixels of a membership mask."""
    min_x = width
    min_y = height
    max_x = -1
    max_y = -1
    count = 0
    for y in range(height):
        base = y * width
        for x in range(width):
            if mask[base + x]:
                count += 1
                if x < min_x:
                    min_x = x
                if x > max_x:
                    max_x = x
                if y < min_y:
                    min_y = y
                if y > max_y:
                    max_y = y
    if count == 0:
        return None, 0
    return (min_x, min_y, max_x - min_x + 1, max_y - min_y + 1), count


@dataclass
class Region:
    name: str
    policy: str  # KEEP_TRANSPARENT or FORCE
    ink_index: int | None
    ink_hex: str | None
    mask: bytearray
    geometry: str
    bounds: tuple[int, int, int, int] | None
    pixels: int


def _parse_policy(entry: dict) -> tuple[str, str | None, str | None]:
    policy = entry.get("policy")
    if isinstance(policy, dict):
        kind = policy.get("type", policy.get("policy"))
        ink = policy.get("ink")
    elif isinstance(policy, str):
        kind = policy
        ink = None
        if ":" in policy:
            kind, _, ink = policy.partition(":")
    else:
        return "", None, (
            "region needs a 'policy' of 'keep-transparent' or 'force:<ink>'"
        )
    if not isinstance(kind, str):
        return "", None, "'policy' type must be a string"
    if kind == KEEP_TRANSPARENT:
        if ink not in (None, ""):
            return "", None, "keep-transparent regions cannot name an ink"
        return KEEP_TRANSPARENT, None, None
    if kind == FORCE:
        if not isinstance(ink, str) or not ink.strip():
            return "", None, "force regions need an ink name, e.g. 'force:vermilion'"
        return FORCE, ink.strip(), None
    return "", None, (
        f"unknown region policy {kind!r}; expected 'keep-transparent' or 'force:<ink>'"
    )


def _parse_rect(entry: dict, width: int, height: int, region_name: str, image_name: str):
    rect = entry.get("rect", entry.get("box"))
    if rect is None:
        return None, None
    if (
        not isinstance(rect, (list, tuple))
        or len(rect) != 4
        or not all(isinstance(value, int) and not isinstance(value, bool) for value in rect)
    ):
        return None, Issue(
            image_name,
            region_name,
            None,
            "rect must be four integers [x, y, width, height]",
        )
    x, y, rect_width, rect_height = rect
    if rect_width <= 0 or rect_height <= 0:
        return None, Issue(
            image_name,
            region_name,
            format_rect((x, y, rect_width, rect_height)),
            "rect width and height must be positive",
        )
    if x < 0 or y < 0 or x + rect_width > width or y + rect_height > height:
        return None, Issue(
            image_name,
            region_name,
            format_rect((x, y, rect_width, rect_height)),
            f"rect is outside the {width}x{height} image",
        )
    return (x, y, rect_width, rect_height), None


def _rect_mask(rect: tuple[int, int, int, int], width: int, height: int) -> bytearray:
    x, y, rect_width, rect_height = rect
    mask = bytearray(width * height)
    for row in range(y, y + rect_height):
        base = row * width
        mask[base + x : base + x + rect_width] = b"\x01" * rect_width
    return mask


def _mask_membership(image: Image) -> list[bool]:
    """A mask pixel belongs to the region if it is visible or non-black.

    Opaque white-on-black artwork uses luminance.  A mask with transparency
    uses its alpha channel.  Both conventions work without a flag.
    """
    has_transparency = any(
        image.data[index] != 255 for index in range(3, len(image.data), 4)
    )
    values: list[bool] = []
    if has_transparency:
        for index in range(0, len(image.data), 4):
            values.append(image.data[index + 3] != 0)
    else:
        for index in range(0, len(image.data), 4):
            values.append(
                image.data[index] != 0
                or image.data[index + 1] != 0
                or image.data[index + 2] != 0
            )
    return values


def resolve_regions(
    image_name: str,
    width: int,
    height: int,
    entries: object,
    table,
    base_dir: str,
) -> tuple[list[Region], list[Issue]]:
    issues: list[Issue] = []
    if entries is None:
        entries = []
    if not isinstance(entries, list):
        issues.append(
            Issue(image_name, None, None, "regions must be a list of region objects")
        )
        return [], issues

    regions: list[Region] = []
    seen_names: set[str] = set()
    for position, entry in enumerate(entries):
        if not isinstance(entry, dict):
            issues.append(
                Issue(image_name, None, None, f"region #{position + 1} must be an object")
            )
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            issues.append(
                Issue(
                    image_name,
                    None,
                    None,
                    f"region #{position + 1} needs a non-empty string 'name'",
                )
            )
            continue
        name = name.strip()
        if name in seen_names:
            issues.append(
                Issue(image_name, name, None, "region name appears more than once")
            )
            continue
        seen_names.add(name)

        policy_kind, ink_reference, policy_problem = _parse_policy(entry)
        rect, rect_problem = _parse_rect(entry, width, height, name, image_name)
        mask_entry = entry.get("mask")
        geometry_parts: list[str] = []
        combined = bytearray(width * height)
        have_geometry = False

        if rect is not None:
            have_geometry = True
            combined = _rect_mask(rect, width, height)
            geometry_parts.append(format_rect(rect))
        if mask_entry is not None:
            if not isinstance(mask_entry, str) or not mask_entry.strip():
                issues.append(
                    Issue(image_name, name, None, "'mask' must be a PNG path")
                )
                continue
            mask_path = os.path.join(base_dir, mask_entry)
            geometry_parts.append(f'mask "{mask_entry}"')
            try:
                mask_image = read_png(mask_path)
            except PNGError as error:
                issues.append(Issue(image_name, name, None, str(error)))
                continue
            if mask_image.width != width or mask_image.height != height:
                issues.append(
                    Issue(
                        image_name,
                        name,
                        f'mask "{mask_entry}"',
                        "mask size "
                        f"{mask_image.width}x{mask_image.height} does not match "
                        f"the image size {width}x{height}",
                    )
                )
                continue
            membership = _mask_membership(mask_image)
            if have_geometry:
                for index, inside in enumerate(membership):
                    if not inside:
                        combined[index] = 0
            else:
                for index, inside in enumerate(membership):
                    combined[index] = 1 if inside else 0
                have_geometry = True
        if not have_geometry:
            issues.append(
                Issue(
                    image_name,
                    name,
                    None,
                    "region needs a 'rect' or a 'mask' (or both, intersected)",
                )
            )
            continue
        if policy_problem:
            issues.append(
                Issue(image_name, name, ", ".join(geometry_parts), policy_problem)
            )
            continue
        if rect_problem:
            issues.append(rect_problem)
            continue

        bounds, pixels = mask_bounds(combined, width, height)
        if pixels == 0:
            issues.append(
                Issue(
                    image_name,
                    name,
                    ", ".join(geometry_parts),
                    "region covers no pixels",
                )
            )
            continue

        ink_index = None
        ink_hex = None
        if policy_kind == FORCE:
            ink = table.resolve(ink_reference)
            if ink is None:
                known = ", ".join(ink.name for ink in table.inks)
                if ink_reference == "transparent":
                    known = ", ".join(ink.name for ink in table.inks)
                    reason = "force:transparent is not a policy; use keep-transparent"
                else:
                    reason = f"unknown ink {ink_reference!r}; known inks: {known}"
                issues.append(
                    Issue(image_name, name, ", ".join(geometry_parts), reason)
                )
                continue
            ink_index = ink.index
            ink_hex = ink.hex

        regions.append(
            Region(
                name=name,
                policy=policy_kind,
                ink_index=ink_index,
                ink_hex=ink_hex,
                mask=combined,
                geometry=", ".join(geometry_parts),
                bounds=bounds,
                pixels=pixels,
            )
        )

    # Structural conflicts between regions.
    for first_index in range(len(regions)):
        first = regions[first_index]
        for second_index in range(first_index + 1, len(regions)):
            second = regions[second_index]
            overlap = bytearray(
                1 if first.mask[index] and second.mask[index] else 0
                for index in range(width * height)
            )
            bounds, count = mask_bounds(overlap, width, height)
            if count == 0:
                continue
            location = format_rect(bounds) if bounds else "the overlap"
            first_force = first.policy == FORCE
            second_force = second.policy == FORCE
            if first_force and second_force:
                if first.ink_index != second.ink_index:
                    first_ink = table.inks[first.ink_index].name
                    second_ink = table.inks[second.ink_index].name
                    issues.append(
                        Issue(
                            image_name,
                            first.name,
                            first.geometry,
                            f"overlaps force region \"{second.name}\" at {location} "
                            f"({count} px) with a different ink "
                            f"({first_ink} vs {second_ink})",
                        )
                    )
            elif first_force or second_force:
                force_region = first if first_force else second
                keep_region = second if first_force else first
                issues.append(
                    Issue(
                        image_name,
                        keep_region.name,
                        keep_region.geometry,
                        f"overlaps force region \"{force_region.name}\" at "
                        f"{location} ({count} px): the area is both forced ink "
                        f"and reserved transparent",
                    )
                )
    return regions, issues


def visible_pixels_inside(
    region: Region, image: Image
) -> tuple[tuple[int, int, int, int] | None, int]:
    """Bounds and count of visible (alpha > 0) source pixels inside a region."""
    width = image.width
    height = image.height
    min_x = width
    min_y = height
    max_x = -1
    max_y = -1
    count = 0
    for y in range(height):
        base = y * width
        for x in range(width):
            if region.mask[base + x] and image.data[(base + x) * 4 + 3] != 0:
                count += 1
                min_x = min(min_x, x)
                max_x = max(max_x, x)
                min_y = min(min_y, y)
                max_y = max(max_y, y)
    if count == 0:
        return None, 0
    return (min_x, min_y, max_x - min_x + 1, max_y - min_y + 1), count


def check_keep_transparent(
    image_name: str, regions: list[Region], image: Image
) -> list[Issue]:
    issues: list[Issue] = []
    for region in regions:
        if region.policy != KEEP_TRANSPARENT:
            continue
        bounds, count = visible_pixels_inside(region, image)
        if count:
            issues.append(
                Issue(
                    image_name,
                    region.name,
                    region.geometry,
                    "reserved as transparent but the artwork has visible pixels "
                    f"inside at {format_rect(bounds)} ({count} px)",
                )
            )
    return issues


def region_summary(region: Region, table) -> dict:
    payload: dict[str, object] = {
        "name": region.name,
        "policy": region.policy,
        "geometry": region.geometry,
        "bounds": list(region.bounds) if region.bounds else None,
        "pixels": region.pixels,
    }
    if region.ink_index is not None:
        payload["ink"] = table.inks[region.ink_index].name
    return payload
