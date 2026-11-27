"""Local WAV silence trimmer.

A dependency-free toolkit that:

* finds long pauses in a WAV recording under configurable amplitude and
  multi-channel joint rules,
* lets an editor keep, shorten or manually re-bound each pause,
* splices the result with controllable crossfades at every cut,
* emits an original-to-output time map, the deleted ranges, and maps an
  external marker table, flagging markers that landed inside a deletion.

Only the Python standard library is used.
"""

from .wavio import WaveData, read_wav, write_wav
from .detect import DetectionConfig, Pause, detect_pauses
from .edit import Decision, EditConfig, build_segments, render_edits
from .map import (
    RegionMap,
    MappedPoint,
    build_region_map,
    locate_original,
    locate_output,
    map_markers,
    Marker,
)

__all__ = [
    "WaveData",
    "read_wav",
    "write_wav",
    "DetectionConfig",
    "Pause",
    "detect_pauses",
    "Decision",
    "EditConfig",
    "build_segments",
    "render_edits",
    "RegionMap",
    "MappedPoint",
    "build_region_map",
    "locate_original",
    "locate_output",
    "map_markers",
    "Marker",
]
