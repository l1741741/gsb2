"""本地 PNG 配色试样工具(纯标准库实现)。"""

from .config import PaletteConfig, Rule, Scheme, load_config
from .engine import ProofResult, apply_scheme
from .pngio import Image, read_png, write_png

__all__ = [
    "PaletteConfig",
    "Rule",
    "Scheme",
    "load_config",
    "ProofResult",
    "apply_scheme",
    "Image",
    "read_png",
    "write_png",
]
