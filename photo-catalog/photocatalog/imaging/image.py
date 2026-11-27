"""Image container, format sniffing and top-level loader.

The loader never raises for a single corrupt file: callers get an
:class:`ImageError` with a human readable reason, which the pipeline records
as a per-file problem instead of aborting the batch.
"""

from __future__ import annotations

import os
import struct
from dataclasses import dataclass


class ImageError(Exception):
    """Raised when a file cannot be decoded into an :class:`Image`."""


@dataclass(slots=True)
class Image:
    """Decoded raster image.

    ``pixels`` is packed row-major RGB or RGBA, 8 bits per channel.  The
    remaining fields describe the source so reports can be honest about
    downscaling and colour handling.
    """

    width: int
    height: int
    pixels: bytes
    channels: int = 3
    format: str = "unknown"
    mode: str = "RGB"
    #: ICC / EXIF orientation was applied, or the pixels are already upright.
    oriented: bool = True

    def __post_init__(self) -> None:
        expected = self.width * self.height * self.channels
        if len(self.pixels) != expected:
            raise ImageError(
                f"pixel buffer mismatch: {len(self.pixels)} != {self.width}*"
                f"{self.height}*{self.channels}"
            )

    @property
    def size(self) -> tuple[int, int]:
        return (self.width, self.height)

    def has_alpha(self) -> bool:
        return self.channels == 4

    def to_rgb(self) -> "Image":
        """Return an RGB-only copy (alpha is dropped, not composited)."""
        if self.channels == 3:
            return self
        px = self.pixels
        rgb = bytearray(self.width * self.height * 3)
        rgb[0::3] = px[0::4]
        rgb[1::3] = px[1::4]
        rgb[2::3] = px[2::4]
        return Image(self.width, self.height, bytes(rgb), 3, self.format, self.mode, self.oriented)


_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpeg"),
    (b"BM", "bmp"),
    (b"GIF8", "gif"),
    (b"II*\x00", "tiff"),
    (b"MM\x00*", "tiff"),
    (b"RIFF", "webp-or-avi"),
)


def sniff_format(head: bytes) -> str | None:
    for magic, name in _MAGIC:
        if head.startswith(magic):
            if name == "webp-or-avi":
                return "webp" if head[8:12] == b"WEBP" else None
            return name
    if head[:2] == b"P6" or head[:2] == b"P5" or head[:2] == b"P3":
        return "ppm"
    return None


def load_image(path: str, *, max_dimension: int | None = None,
               external_tools: bool = True) -> Image:
    """Decode ``path`` into an :class:`Image`.

    ``max_dimension`` requests a decode-time downscale for JPEG (PNG is decoded
    in full and then reduced by the caller, since pure-Python PNG reduction is
    cheap).  ``external_tools`` allows falling back to a locally installed
    decoder (ffmpeg / sips / macOS Preview) for formats the pure-Python
    decoders do not understand.
    """
    try:
        with open(path, "rb") as fh:
            head = fh.read(32)
    except OSError as exc:
        raise ImageError(f"cannot open file: {exc.strerror or exc}") from exc
    if not head:
        raise ImageError("empty file")

    fmt = sniff_format(head)
    if fmt is None:
        # TGA has no magic number; recognise it by a plausible header.
        if _looks_like_tga(head):
            from .simple import decode_tga
            return decode_tga(path)
        if external_tools:
            return _decode_with_external_tool(path, max_dimension)
        raise ImageError("unrecognised image format")

    try:
        if fmt == "png":
            from .png import decode_png
            return decode_png(path)
        if fmt == "jpeg":
            from .jpeg import decode_jpeg
            return decode_jpeg(path, max_dimension=max_dimension)
        if fmt == "bmp":
            from .simple import decode_bmp
            return decode_bmp(path)
        if fmt == "ppm":
            from .simple import decode_ppm
            return decode_ppm(path)
        if fmt == "gif":
            from .simple import decode_gif_first_frame
            return decode_gif_first_frame(path)
        if fmt == "tiff":
            from .simple import decode_tiff_baseline
            return decode_tiff_baseline(path)
        if fmt == "gif":
            from .simple import decode_gif_first_frame
            return decode_gif_first_frame(path)
    except ImageError:
        raise
    except Exception as exc:  # noqa: BLE001 - decode errors are data errors
        raise ImageError(f"{fmt} decode failed: {exc}") from exc

    if external_tools:
        return _decode_with_external_tool(path, max_dimension)
    raise ImageError(f"unsupported image format: {fmt}")


def _looks_like_tga(head: bytes) -> bool:
    """True when the first 18 bytes look like a plausible TGA header."""
    if len(head) < 18:
        return False
    id_len, cmap_type, image_type = head[0], head[1], head[2]
    if id_len > 0 and image_type == 0:
        return False
    if cmap_type not in (0, 1):
        return False
    if image_type not in (1, 2, 3, 9, 10, 11):
        return False
    bpp = head[16]
    return bpp in (8, 15, 16, 24, 32)


def _decode_with_external_tool(path: str, max_dimension: int | None) -> Image:
    """Best-effort fallback using a decoder that ships with the OS."""
    from .external import decode_with_external_tool
    return decode_with_external_tool(path, max_dimension=max_dimension)
