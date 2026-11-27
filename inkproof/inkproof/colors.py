"""Named spot-ink colour tables, colour distance, and stable nearest selection.

Distances are CIE Lab (Delta E 76) by default so that two inks that look close
to the eye are treated as close.  ``metric: "rgb"`` is available for
straight sRGB Euclidean distance.

Selection stability is explicit: any candidates whose distances fall inside a
``tie_epsilon`` band around the best distance are considered tied, and the tie
is broken by the ink's declared position in the colour table, then by name.
That makes the result independent of sub-epsilon floating point noise and of
the order in which pixels are visited.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .pngio import parse_hex_colour


METRICS = ("lab", "rgb")
TRANSPARENT = "transparent"


class ColourError(ValueError):
    """Raised for invalid colour tables or colour-table references."""


@dataclass(frozen=True)
class Ink:
    name: str
    rgb: tuple[int, int, int]
    previous_names: tuple[str, ...] = ()
    index: int = field(default=0, compare=False)

    @property
    def hex(self) -> str:
        return "#{:02X}{:02X}{:02X}".format(*self.rgb)

    @property
    def lab(self) -> tuple[float, float, float]:
        return rgb_to_lab(self.rgb)

    def as_json(self) -> dict:
        payload: dict[str, object] = {"name": self.name, "rgb": self.hex}
        if self.previous_names:
            payload["previous_names"] = list(self.previous_names)
        return payload


def _linear(channel: int) -> float:
    value = channel / 255.0
    if value <= 0.04045:
        return value / 12.92
    return ((value + 0.055) / 1.055) ** 2.4


def rgb_to_lab(rgb: tuple[int, int, int]) -> tuple[float, float, float]:
    """sRGB (D65) to CIE L*a*b* with the 2-degree observer."""
    red, green, blue = (
        _linear(rgb[0]),
        _linear(rgb[1]),
        _linear(rgb[2]),
    )
    # sRGB D65 matrix, standard values.
    x = red * 0.4124564 + green * 0.3575761 + blue * 0.1804375
    y = red * 0.2126729 + green * 0.7151522 + blue * 0.0721750
    z = red * 0.0193339 + green * 0.1191920 + blue * 0.9503041
    white = (0.95047, 1.0, 1.08883)

    def transform(value: float, reference: float) -> float:
        scaled = value / reference
        if scaled > 0.008856:
            return scaled ** (1.0 / 3.0)
        return 7.787 * scaled + 16.0 / 116.0

    fx = transform(x, white[0])
    fy = transform(y, white[1])
    fz = transform(z, white[2])
    return (116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz))


def distance_squared(
    metric: str,
    rgb: tuple[int, int, int],
    lab: tuple[float, float, float],
    ink: Ink,
) -> float:
    if metric == "rgb":
        red = rgb[0] - ink.rgb[0]
        green = rgb[1] - ink.rgb[1]
        blue = rgb[2] - ink.rgb[2]
        return float(red * red + green * green + blue * blue)
    ink_lab = ink.lab
    delta_l = lab[0] - ink_lab[0]
    delta_a = lab[1] - ink_lab[1]
    delta_b = lab[2] - ink_lab[2]
    return delta_l * delta_l + delta_a * delta_a + delta_b * delta_b


@dataclass(frozen=True)
class InkTable:
    inks: tuple[Ink, ...]
    order: tuple[int, ...]
    metric: str = "lab"
    tie_epsilon: float = 0.05

    def __post_init__(self) -> None:
        if not self.inks:
            raise ColourError("the colour table needs at least one ink")
        if self.metric not in METRICS:
            raise ColourError(
                f"unknown colour metric {self.metric!r}; expected one of {METRICS}"
            )
        if not math.isfinite(self.tie_epsilon) or self.tie_epsilon < 0:
            raise ColourError("tie_epsilon must be a non-negative number")
        names = [ink.name for ink in self.inks]
        if len(set(names)) != len(names):
            duplicates = sorted({name for name in names if names.count(name) > 1})
            raise ColourError(f"duplicate ink names: {', '.join(duplicates)}")
        if len(set(self.order)) != len(self.order):
            raise ColourError("display order lists an ink more than once")
        if set(self.order) != set(range(len(self.inks))):
            raise ColourError("display order must list every ink exactly once")
        for ink in self.inks:
            for alias in ink.previous_names:
                if not alias or alias == ink.name:
                    raise ColourError(
                        f"ink {ink.name!r} has an invalid previous name {alias!r}"
                    )
            if ink.name == TRANSPARENT:
                raise ColourError(
                    f"{TRANSPARENT!r} is reserved and cannot be an ink name"
                )
        aliases = self.alias_map()
        for ink in self.inks:
            for alias in ink.previous_names:
                if aliases[alias] is not ink:
                    raise ColourError(
                        f"previous name {alias!r} is claimed by more than one ink"
                    )

    def alias_map(self) -> dict[str, Ink]:
        mapping = {ink.name: ink for ink in self.inks}
        for ink in self.inks:
            for alias in ink.previous_names:
                existing = mapping.get(alias)
                if existing is None:
                    mapping[alias] = ink
        return mapping

    def resolve(self, name: str) -> Ink | None:
        """Resolve a current or previous ink name. ``transparent`` maps to None."""
        if name == TRANSPARENT:
            return None
        return self.alias_map().get(name)

    def by_name(self, name: str) -> Ink:
        ink = self.alias_map().get(name)
        if ink is None:
            raise ColourError(
                f"unknown ink {name!r}; known inks: {', '.join(ink.name for ink in self.inks)}"
            )
        return ink

    def display_order(self) -> tuple[Ink, ...]:
        return tuple(self.inks[index] for index in self.order)

    def _distances(
        self, rgb: tuple[int, int, int], lab: tuple[float, float, float]
    ) -> list[float]:
        return [
            math.sqrt(distance_squared(self.metric, rgb, lab, ink))
            for ink in self.inks
        ]

    def nearest(
        self, rgb: tuple[int, int, int], lab: tuple[float, float, float] | None = None
    ) -> tuple[int, float]:
        """Return ``(ink_index, distance)`` using the stable tie rule."""
        if lab is None:
            lab = rgb_to_lab(rgb)
        distances = self._distances(rgb, lab)
        best_distance = min(distances)
        epsilon = self.tie_epsilon
        for ink in self.inks:  # declared order, so ties are stable
            if distances[ink.index] <= best_distance + epsilon:
                return ink.index, best_distance
        raise AssertionError("unreachable: no ink within the tie band")

    def two_nearest(
        self, rgb: tuple[int, int, int], lab: tuple[float, float, float] | None = None
    ) -> tuple[int, int, float, float]:
        """Return the two nearest inks and their distances, ordered stably.

        The second index equals the first when the table has a single ink.
        """
        if lab is None:
            lab = rgb_to_lab(rgb)
        distances = self._distances(rgb, lab)
        ranked = sorted((distance, ink.index) for ink, distance in zip(self.inks, distances))
        first = ranked[0]
        second = ranked[1] if len(ranked) > 1 else ranked[0]
        return first[1], second[1], first[0], second[0]

    def mix_weights(self, first_distance: float, second_distance: float) -> float:
        """Fraction of a pixel assigned to the nearest ink when two inks mix."""
        total = first_distance + second_distance
        if total <= 0.0:
            return 1.0
        return second_distance / total


def make_table(
    inks: list[tuple[str, tuple[int, int, int], tuple[str, ...]]],
    order_names: list[str] | None = None,
    metric: str = "lab",
    tie_epsilon: float = 0.05,
) -> InkTable:
    objects = tuple(
        Ink(name=name, rgb=rgb, previous_names=aliases, index=index)
        for index, (name, rgb, aliases) in enumerate(inks)
    )
    if order_names is None:
        order = tuple(range(len(objects)))
    else:
        aliases = {ink.name: ink for ink in objects}
        for ink in objects:
            for alias in ink.previous_names:
                aliases.setdefault(alias, ink)
        resolved: list[int] = []
        for name in order_names:
            ink = aliases.get(name)
            if ink is None:
                raise ColourError(
                    f"display order refers to unknown ink {name!r}; "
                    f"known inks: {', '.join(ink.name for ink in objects)}"
                )
            if ink.index in resolved:
                raise ColourError(f"display order lists ink {name!r} more than once")
            resolved.append(ink.index)
        missing = [ink.name for ink in objects if ink.index not in resolved]
        if missing:
            raise ColourError(
                "display order is missing inks: " + ", ".join(missing)
            )
        order = tuple(resolved)
    return InkTable(
        inks=objects, order=order, metric=metric, tie_epsilon=tie_epsilon
    )


def parse_ink_entry(entry: object, index: int) -> tuple[str, tuple[int, int, int], tuple[str, ...]]:
    if not isinstance(entry, dict):
        raise ColourError(f"ink #{index + 1} must be an object with 'name' and 'rgb'")
    name = entry.get("name")
    if not isinstance(name, str) or not name.strip():
        raise ColourError(f"ink #{index + 1} needs a non-empty string 'name'")
    name = name.strip()
    if any(character.isspace() for character in name):
        raise ColourError(
            f"ink {name!r}: names cannot contain whitespace "
            "(use one token so plate file names stay predictable)"
        )
    if "rgb" not in entry:
        raise ColourError(f"ink {name!r} needs an 'rgb' colour such as '#D7261E'")
    try:
        rgb = parse_hex_colour(entry["rgb"])
    except ValueError as error:
        raise ColourError(f"ink {name!r}: {error}") from error
    previous = entry.get("previous_names", [])
    if previous is None:
        previous = []
    if not isinstance(previous, list) or not all(
        isinstance(item, str) and item.strip() for item in previous
    ):
        raise ColourError(f"ink {name!r}: previous_names must be a list of names")
    aliases = tuple(item.strip() for item in previous)
    return name, rgb, aliases
