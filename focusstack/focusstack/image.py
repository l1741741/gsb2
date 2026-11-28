"""Minimal 8-bit RGB image container plus luma conversion.

The project deliberately depends only on the Python standard library, so
images are stored as one ``array('B')`` plane per channel.  Plane-level
slicing keeps copying cheap and avoids creating millions of Python objects.
"""

from __future__ import annotations

from array import array


class ImageError(ValueError):
    """Raised when image dimensions or pixel data are inconsistent."""


class Image:
    __slots__ = (
        "width",
        "height",
        "r",
        "g",
        "b",
        "a",
        "name",
        "source_bit_depth",
        "had_palette",
    )

    def __init__(
        self,
        width: int,
        height: int,
        r: array,
        g: array,
        b: array,
        a: array | None = None,
        *,
        name: str = "",
        source_bit_depth: int = 8,
        had_palette: bool = False,
    ) -> None:
        if not isinstance(width, int) or not isinstance(height, int) or width <= 0 or height <= 0:
            raise ImageError("image dimensions must be positive integers")
        expected = width * height
        for channel_name, plane in (("r", r), ("g", g), ("b", b)):
            if len(plane) != expected:
                raise ImageError(
                    "channel %s has %d samples, expected %d" % (channel_name, len(plane), expected)
                )
        if a is not None and len(a) != expected:
            raise ImageError("alpha channel has %d samples, expected %d" % (len(a), expected))
        self.width = width
        self.height = height
        self.r = r
        self.g = g
        self.b = b
        self.a = a
        self.name = name
        self.source_bit_depth = source_bit_depth
        self.had_palette = had_palette

    def __repr__(self) -> str:
        alpha = "RGBA" if self.a is not None else "RGB"
        return "<Image %dx%d %s name=%r>" % (self.width, self.height, alpha, self.name)

    def copy(self, *, name: str | None = None) -> "Image":
        return Image(
            self.width,
            self.height,
            array("B", self.r),
            array("B", self.g),
            array("B", self.b),
            array("B", self.a) if self.a is not None else None,
            name=self.name if name is None else name,
            source_bit_depth=self.source_bit_depth,
            had_palette=self.had_palette,
        )

    def pixel(self, x: int, y: int) -> tuple:
        index = y * self.width + x
        if self.a is None:
            return (self.r[index], self.g[index], self.b[index])
        return (self.r[index], self.g[index], self.b[index], self.a[index])

    def luma(self) -> array:
        """Return Rec. 601 luma as an array of bytes."""
        r, g, b = self.r, self.g, self.b
        n = len(r)
        out = array("B", bytes(n))
        for i in range(n):
            out[i] = (299 * r[i] + 587 * g[i] + 114 * b[i]) // 1000
        return out

    def crop(self, x0: int, y0: int, width: int, height: int, *, name: str | None = None) -> "Image":
        if width <= 0 or height <= 0:
            raise ImageError("crop dimensions must be positive")
        if x0 < 0 or y0 < 0 or x0 + width > self.width or y0 + height > self.height:
            raise ImageError("crop rectangle lies outside the image")
        return Image(
            width,
            height,
            self._crop_plane(self.r, x0, y0, width, height),
            self._crop_plane(self.g, x0, y0, width, height),
            self._crop_plane(self.b, x0, y0, width, height),
            self._crop_plane(self.a, x0, y0, width, height) if self.a is not None else None,
            name=self.name if name is None else name,
            source_bit_depth=self.source_bit_depth,
            had_palette=self.had_palette,
        )

    def _crop_plane(self, plane, x0, y0, width, height) -> array:
        src_width = self.width
        if x0 == 0 and width == src_width:
            return array("B", plane[y0 * src_width:(y0 + height) * src_width])
        out = array("B", bytes(width * height))
        for row in range(height):
            src = (y0 + row) * src_width + x0
            out[row * width:(row + 1) * width] = plane[src:src + width]
        return out

    def scaled(self, factor: float) -> "Image":
        """Nearest-neighbour scale used only for previews (factor < 1)."""
        if factor >= 1.0:
            raise ImageError("preview scaling factor must be below 1")
        width = max(1, int(self.width * factor))
        height = max(1, int(self.height * factor))
        if width == self.width and height == self.height:
            return self.copy()
        sx = self.width / width
        sy = self.height / height
        r = array("B", bytes(width * height))
        g = array("B", bytes(width * height))
        b = array("B", bytes(width * height))
        a = array("B", bytes(width * height)) if self.a is not None else None
        src_r, src_g, src_b, src_a = self.r, self.g, self.b, self.a
        for y in range(height):
            src_row = int(y * sy) * self.width
            dst = y * width
            for x in range(width):
                src = src_row + int(x * sx)
                r[dst + x] = src_r[src]
                g[dst + x] = src_g[src]
                b[dst + x] = src_b[src]
                if a is not None:
                    a[dst + x] = src_a[src]
        return Image(width, height, r, g, b, a, name=self.name, source_bit_depth=self.source_bit_depth)
