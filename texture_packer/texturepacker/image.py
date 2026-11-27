"""RGBA image primitives on flat byte buffers (row-major, 4 bytes/pixel)."""

from __future__ import annotations


class Image:
    def __init__(self, width: int, height: int, pixels: bytes | bytearray | None = None):
        self.width = width
        self.height = height
        if pixels is None:
            self.pixels = bytearray(width * height * 4)
        else:
            if len(pixels) != width * height * 4:
                raise ValueError(
                    f"pixel buffer has {len(pixels)} bytes, expected {width * height * 4}"
                )
            self.pixels = bytearray(pixels)

    @classmethod
    def from_png(cls, path: str) -> "Image":
        from .png import read_png

        info = read_png(path)
        return cls(info["width"], info["height"], info["pixels"])

    def save_png(self, path: str) -> None:
        from .png import write_png

        write_png(path, self.width, self.height, bytes(self.pixels))

    def _index(self, x: int, y: int) -> int:
        return (y * self.width + x) * 4

    def get_pixel(self, x: int, y: int) -> tuple[int, int, int, int]:
        i = self._index(x, y)
        p = self.pixels
        return p[i], p[i + 1], p[i + 2], p[i + 3]

    def copy(self) -> "Image":
        return Image(self.width, self.height, self.pixels)

    def alpha_bbox(self) -> tuple[int, int, int, int] | None:
        """Bounding box of non-fully-transparent pixels as (x0, y0, x1, y1).

        Returns None when every pixel is fully transparent.
        """
        p = self.pixels
        min_x, min_y = self.width, self.height
        max_x, max_y = -1, -1
        for y in range(self.height):
            row_start = y * self.width * 4 + 3
            for x in range(self.width):
                if p[row_start + x * 4] != 0:
                    if x < min_x:
                        min_x = x
                    if x > max_x:
                        max_x = x
                    if y < min_y:
                        min_y = y
                    if y > max_y:
                        max_y = y
        if max_x < 0:
            return None
        return min_x, min_y, max_x + 1, max_y + 1

    def crop(self, x0: int, y0: int, x1: int, y1: int) -> "Image":
        w, h = x1 - x0, y1 - y0
        out = Image(w, h)
        for y in range(h):
            src = ((y0 + y) * self.width + x0) * 4
            dst = y * w * 4
            out.pixels[dst : dst + w * 4] = self.pixels[src : src + w * 4]
        return out

    def rotate_90_cw(self) -> "Image":
        """Return a copy rotated 90 degrees clockwise."""
        w, h = self.width, self.height
        out = Image(h, w)  # dimensions swap
        p, q = self.pixels, out.pixels
        for y in range(h):
            for x in range(w):
                src = (y * w + x) * 4
                # New coordinates: (x, y) -> (h - 1 - y, x)
                dst = (x * h + (h - 1 - y)) * 4
                q[dst : dst + 4] = p[src : src + 4]
        return out

    def rotate_90_ccw(self) -> "Image":
        """Return a copy rotated 90 degrees counterclockwise (inverse of CW)."""
        w, h = self.width, self.height
        out = Image(h, w)  # dimensions swap
        p, q = self.pixels, out.pixels
        for y in range(h):
            for x in range(w):
                src = (y * w + x) * 4
                # Inverse of CW: (x, y) -> (y, w - 1 - x)
                dst = ((w - 1 - x) * h + y) * 4
                q[dst : dst + 4] = p[src : src + 4]
        return out

    def add_extruded_padding(self, padding: int) -> "Image":
        """Wrap the image in `padding` transparent-sized border on every side.

        Border pixels copy the nearest edge pixel of the original content
        (clamp-to-edge), including its alpha. Fully transparent outer rows stay
        transparent when the source edge itself is transparent. The returned
        image is (w + 2p) x (h + 2p); the original image occupies the inner
        rect [p, p, w+p, h+p].
        """
        if padding < 0:
            raise ValueError("padding must be non-negative")
        if padding == 0:
            return self.copy()
        new_w, new_h = self.width + 2 * padding, self.height + 2 * padding
        out = Image(new_w, new_h)
        for ny in range(new_h):
            sy = min(max(ny - padding, 0), self.height - 1) if self.height > 0 else 0
            for nx in range(new_w):
                sx = min(max(nx - padding, 0), self.width - 1) if self.width > 0 else 0
                src = (sy * self.width + sx) * 4
                dst = (ny * new_w + nx) * 4
                out.pixels[dst : dst + 4] = self.pixels[src : src + 4]
        return out

    def blit(self, other: "Image", x: int, y: int) -> None:
        """Copy `other` onto this image at (x, y). Rectangles must fit."""
        if x < 0 or y < 0 or x + other.width > self.width or y + other.height > self.height:
            raise ValueError(
                f"blit {other.width}x{other.height} at ({x},{y}) overflows "
                f"canvas {self.width}x{self.height}"
            )
        for row in range(other.height):
            src = row * other.width * 4
            dst = ((y + row) * self.width + x) * 4
            self.pixels[dst : dst + other.width * 4] = other.pixels[
                src : src + other.width * 4
            ]


def rotate_point_90_cw(x: int, y: int, width: int, height: int) -> tuple[int, int]:
    """Map a point through the same 90-degree CW rotation as Image.rotate_90_cw.

    `width`/`height` are the ORIGINAL image dimensions.
    """
    return height - 1 - y, x
