"""Core separation: RGBA artwork to per-ink occupancy plates and proofs.

The pipeline is one-directional and auditable:

    artwork + ink table + regions
        -> assignment    (per pixel: which ink, and how much of a second ink)
        -> plates        (one 8-bit occupancy value per ink per pixel)
        -> masks         (nearest: solid; screened: halftone dots)
        -> previews      (rebuilt from the masks + the ink table only)

Two modes are supported:

``nearest``
    Every visible pixel is assigned entirely to the single nearest ink.  Each
    plate is a hard 0/255 occupancy map and the proof is flat colour.

``screened``
    Every visible pixel is approximated by up to two inks.  A pixel already
    within ``solid_delta`` of its nearest ink prints solid on that plate only;
    anything further away splits between its two nearest inks in proportion
    to their distances.  The plates therefore carry true tonal occupancy, and
    the screen turns that occupancy into halftone dots.

Invariants, checked by the test suite and by ``verify_plate_invariants``:

* A fully transparent source pixel contributes to **no** plate.
* A pixel's total occupancy never exceeds its source alpha.
* A flat pixel that is within ``solid_delta`` of an ink contributes to that
  ink's plate only, so hard edges never bleed onto a second plate.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .colors import InkTable, rgb_to_lab
from .pngio import Image
from .regions import Region
from .screen import Screen

BINARISATION_MODES = ("nearest", "screened")
TRANSPARENT_SLOT = 255
DEFAULT_SOLID_DELTA = 3.0


@dataclass
class Assignment:
    """Per-pixel ink choice and weight.

    ``primary`` / ``secondary`` hold an ink index, or ``TRANSPARENT_SLOT``.
    ``weight`` is the primary ink's share in 0..255; the secondary ink gets
    the remainder.  ``secondary`` equals ``primary`` when the pixel is solid.
    """

    width: int
    height: int
    primary: bytearray
    secondary: bytearray
    weight: bytearray

    def is_transparent(self, index: int) -> bool:
        return self.primary[index] == TRANSPARENT_SLOT

    def ink_at(self, index: int) -> int:
        value = self.primary[index]
        return -1 if value == TRANSPARENT_SLOT else value

    def transparent_count(self) -> int:
        return sum(1 for value in self.primary if value == TRANSPARENT_SLOT)


@dataclass
class Separation:
    image: Image
    table: InkTable
    assignment: Assignment
    plates: list[bytearray]
    masks: list[bytearray]
    screen: Screen | None
    mode: str
    regions: list[Region] = field(default_factory=list)
    guarded_pixels: int = 0
    solid_delta: float = DEFAULT_SOLID_DELTA
    invariant_checks: dict = field(default_factory=dict)

    def preview_masks(self) -> list[bytearray]:
        return self.masks


def _cache_key(rgb: tuple[int, int, int]) -> tuple[int, int, int]:
    return rgb


def resolve_pixel(
    table: InkTable,
    rgb: tuple[int, int, int],
    mode: str,
    solid_delta: float,
) -> tuple[int, int, int]:
    """Return ``(primary, secondary, weight)`` for one opaque pixel."""
    if mode == "nearest":
        ink, _ = table.nearest(rgb)
        return ink, ink, 255
    first, second, first_distance, second_distance = table.two_nearest(rgb)
    if first_distance <= solid_delta or first == second:
        return first, first, 255
    total = first_distance + second_distance
    if total <= 0.0:
        return first, first, 255
    weight = int(round(255.0 * second_distance / total))
    if weight <= 0:
        return second, first, 255
    if weight >= 255:
        return first, second, 255
    return first, second, weight


def build_assignment(
    image: Image,
    table: InkTable,
    regions: list[Region],
    mode: str,
    solid_delta: float,
) -> tuple[Assignment, int]:
    """Assign every pixel to up to two inks or to transparent.

    Returns the assignment and how many pixels fell inside a guard region.
    """
    width = image.width
    height = image.height
    data = image.data
    primary = bytearray([TRANSPARENT_SLOT]) * (width * height)
    secondary = bytearray([TRANSPARENT_SLOT]) * (width * height)
    weight = bytearray(width * height)

    keep = bytearray(width * height)
    force = bytearray(width * height)
    force_ink = bytearray(width * height)
    for region in regions:
        if region.policy == "force":
            for index, inside in enumerate(region.mask):
                if inside:
                    force[index] = 1
                    force_ink[index] = region.ink_index
        else:
            for index, inside in enumerate(region.mask):
                if inside:
                    keep[index] = 1

    guarded = 0
    cache: dict[tuple[int, int, int], tuple[int, int, int]] = {}
    for index in range(width * height):
        alpha = data[index * 4 + 3]
        if alpha == 0:
            continue
        if keep[index] or force[index]:
            guarded += 1
        if keep[index]:
            continue
        if force[index]:
            primary[index] = force_ink[index]
            secondary[index] = force_ink[index]
            weight[index] = 255
            continue
        rgb = (data[index * 4], data[index * 4 + 1], data[index * 4 + 2])
        resolved = cache.get(rgb)
        if resolved is None:
            resolved = resolve_pixel(table, rgb, mode, solid_delta)
            cache[rgb] = resolved
        first, second, share = resolved
        primary[index] = first
        secondary[index] = second
        weight[index] = share
    return Assignment(width, height, primary, secondary, weight), guarded


def build_plates(
    image: Image, table: InkTable, assignment: Assignment
) -> list[bytearray]:
    """Ink occupancy per ink, 0-255, conserving each pixel's alpha."""
    width = image.width
    height = image.height
    plates = [bytearray(width * height) for _ in table.inks]
    data = image.data
    primary = assignment.primary
    secondary = assignment.secondary
    weight = assignment.weight
    for index in range(width * height):
        first = primary[index]
        if first == TRANSPARENT_SLOT:
            continue
        alpha = data[index * 4 + 3]
        if alpha == 0:
            continue
        share = weight[index]
        first_amount = (alpha * share + 127) // 255
        if first_amount:
            plates[first][index] = first_amount
        second = secondary[index]
        if second != TRANSPARENT_SLOT and second != first:
            remainder = alpha - first_amount
            if remainder:
                plates[second][index] = remainder
    return plates


def build_masks(
    plates: list[bytearray],
    width: int,
    height: int,
    screen: Screen | None,
    origin: tuple[int, int] = (0, 0),
) -> list[bytearray]:
    """Solid per-ink mask (nearest mode) or dotted mask (screened mode).

    ``origin`` is the top-left pixel of the plates in full-image coordinates.
    The screen threshold field is built from those coordinates, so screening a
    crop with its true origin reproduces the exact dots of the full image.
    """
    if screen is None:
        return [bytearray(1 if value else 0 for value in plate) for plate in plates]
    field_grid = screen.threshold_field(width, height, origin)
    return [screen.apply(plate, field_grid) for plate in plates]


def rebuild_preview(
    table: InkTable,
    masks: list[bytearray],
    width: int,
    height: int,
    transparent_rgb: tuple[int, int, int] = (255, 255, 255),
) -> Image:
    """Reconstruct RGBA from per-ink masks and the ink table alone.

    A pixel covered by no mask stays transparent.  Where masks overlap, the
    last ink in display order paints over the earlier ones, mirroring ink
    order on press.  No source artwork is consulted, so this doubles as the
    "rebuild a preview from the plates" path.
    """
    data = bytearray(width * height * 4)
    order = table.display_order()
    for index in range(width * height):
        chosen: tuple[int, int, int] | None = None
        for ink in order:
            if masks[ink.index][index]:
                chosen = ink.rgb
        if chosen is None:
            data[index * 4 : index * 4 + 4] = bytes(
                (transparent_rgb[0], transparent_rgb[1], transparent_rgb[2], 0)
            )
        else:
            data[index * 4 : index * 4 + 4] = bytes(
                (chosen[0], chosen[1], chosen[2], 255)
            )
    return Image(width, height, data)


def single_ink_preview(
    table: InkTable,
    ink_index: int,
    mask: bytearray,
    width: int,
    height: int,
    transparent_rgb: tuple[int, int, int] = (255, 255, 255),
) -> Image:
    """A one-ink proof: the ink where its mask is set, transparent elsewhere."""
    ink = table.inks[ink_index]
    data = bytearray(width * height * 4)
    for index in range(width * height):
        if mask[index]:
            data[index * 4 : index * 4 + 4] = bytes(
                (ink.rgb[0], ink.rgb[1], ink.rgb[2], 255)
            )
        else:
            data[index * 4 : index * 4 + 4] = bytes(
                (transparent_rgb[0], transparent_rgb[1], transparent_rgb[2], 0)
            )
    return Image(width, height, data)


def crop_mask(
    mask: bytearray, width: int, crop: tuple[int, int, int, int]
) -> bytearray:
    x, y, crop_width, crop_height = crop
    output = bytearray(crop_width * crop_height)
    for row in range(crop_height):
        source = (y + row) * width + x
        target = row * crop_width
        output[target : target + crop_width] = mask[source : source + crop_width]
    return output


def crop_plate(plate: bytearray, width: int, crop: tuple[int, int, int, int]) -> bytearray:
    return crop_mask(plate, width, crop)


def slug(name: str) -> str:
    cleaned = "".join(
        character.lower() if character.isalnum() else "-" for character in name
    )
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    return cleaned.strip("-") or "ink"


def verify_plate_invariants(separation: Separation) -> list[str]:
    """Check the separation's structural guarantees.

    Returns human-readable problems; an empty list means every invariant held.
    Used by the tests and available for diagnosing a suspicious proof.
    """
    problems: list[str] = []
    width = separation.image.width
    height = separation.image.height
    data = separation.image.data
    plates = separation.plates
    table = separation.table
    solid_delta = separation.solid_delta
    mode = separation.mode
    checked_transparent = 0
    checked_solid = 0
    for index in range(width * height):
        alpha = data[index * 4 + 3]
        total = sum(plate[index] for plate in plates)
        if alpha == 0:
            checked_transparent += 1
            if total:
                y, x = divmod(index, width)
                problems.append(
                    f"transparent pixel ({x},{y}) carries {total} units of ink"
                )
            continue
        if total > alpha:
            y, x = divmod(index, width)
            problems.append(
                f"pixel ({x},{y}) occupancy {total} exceeds source alpha {alpha}"
            )
        if mode != "screened" or alpha != 255:
            continue
        rgb = (data[index * 4], data[index * 4 + 1], data[index * 4 + 2])
        ink_index, nearest_distance = table.nearest(rgb)
        if nearest_distance > solid_delta:
            continue
        checked_solid += 1
        for ink in table.inks:
            if ink.index != ink_index and plates[ink.index][index]:
                y, x = divmod(index, width)
                problems.append(
                    f"solid pixel ({x},{y}) near ink {table.inks[ink_index].name} "
                    f"also prints {plates[ink.index][index]} units on "
                    f"{ink.name}, a hard-edge bleed"
                )
    separation.invariant_checks = {
        "transparent_pixels": checked_transparent,
        "solid_pixels": checked_solid,
        "problems": len(problems),
    }
    return problems


class Separator:
    """A configured separation that can be re-run on any image in a group."""

    def __init__(
        self,
        table: InkTable,
        screen: Screen | None,
        mode: str = "screened",
        solid_delta: float = DEFAULT_SOLID_DELTA,
    ) -> None:
        if mode not in BINARISATION_MODES:
            raise ValueError(
                f"unknown mode {mode!r}; expected one of {BINARISATION_MODES}"
            )
        if mode == "screened" and screen is None:
            screen = Screen()
        self.table = table
        self.screen = screen
        self.mode = mode
        self.solid_delta = float(solid_delta)

    def separate(self, image: Image, regions: list[Region]) -> Separation:
        assignment, guarded = build_assignment(
            image, self.table, regions, self.mode, self.solid_delta
        )
        plates = build_plates(image, self.table, assignment)
        masks = build_masks(plates, image.width, image.height, self.screen)
        separation = Separation(
            image=image,
            table=self.table,
            assignment=assignment,
            plates=plates,
            masks=masks,
            screen=self.screen if self.mode == "screened" else None,
            mode=self.mode,
            regions=regions,
            guarded_pixels=guarded,
            solid_delta=self.solid_delta,
        )
        return separation
