"""Small, dependency-free image decoding layer used by the catalog tool.

Only the pieces the similarity pipeline actually needs are implemented:

* PNG (all bit depths, colour types, interlaced and palette images)
* Baseline / progressive JPEG (pure Python; slow but correct)
* BMP, PPM/PGM, TGA (convenient for generated fixtures and archives)

Decoded images are returned as :class:`Image` objects holding 8-bit RGB(A)
bytes plus a few cheap summary statistics that the similarity engine reuses.
"""

from __future__ import annotations

from .image import Image, ImageError, load_image

__all__ = ["Image", "ImageError", "load_image"]
