"""poster_diff: offline PNG poster comparison with tiled diff reports."""

from .engine import CompareResult, CoverageBlock, DiffBlock, compare
from .geometry import CanvasGeometry, DiffConfig, DiffKind, PlacedImage, Rect
from .pngio import Image, read_png, write_png
from .report import build_report

__all__ = [
    "Image",
    "read_png",
    "write_png",
    "DiffConfig",
    "DiffKind",
    "Rect",
    "PlacedImage",
    "CanvasGeometry",
    "compare",
    "DiffBlock",
    "CoverageBlock",
    "CompareResult",
    "build_report",
]
