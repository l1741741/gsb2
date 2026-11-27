"""wavrepair: local PCM WAV inspection and confirmed short-range repair."""

__all__ = [
    "DetectionSettings",
    "scan_audio",
    "load_confirm",
    "resolve_edits",
    "apply_repairs",
    "read_wav",
    "write_wav",
    "verify_untouched",
]

__version__ = "1.0.0"

from .confirm import load_confirm, resolve_edits  # noqa: E402
from .detect import DetectionSettings, scan_audio  # noqa: E402
from .export import verify_untouched  # noqa: E402
from .repair import apply_repairs  # noqa: E402
from .wavio import read_wav, write_wav  # noqa: E402
