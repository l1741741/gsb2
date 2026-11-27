"""离线 WAV 取样工具。

输入多段 PCM WAV 与段落清单, 按项目时间轴上的一个或多个时间范围取样,
处理重叠优先级、空洞补静音、声道映射, 并输出可追溯的交付清单与报告。

仅依赖 Python 标准库。
"""

from .manifest import load_manifest, ManifestError
from .model import (
    Diagnostic,
    ExportRecord,
    Manifest,
    RangeSpec,
    ResolvedSegment,
    Run,
    SegmentSpec,
)
from .engine import ExportConfig, export
from .timeline import build_runs
from .channels import apply_channel_map, default_channel_map

__all__ = [
    "load_manifest",
    "ManifestError",
    "Diagnostic",
    "ExportRecord",
    "Manifest",
    "RangeSpec",
    "ResolvedSegment",
    "Run",
    "SegmentSpec",
    "ExportConfig",
    "export",
    "build_runs",
    "apply_channel_map",
    "default_channel_map",
]

__version__ = "1.0.0"
