"""剪辑清单（Edit Decision List）加载与校验。

清单为 JSON 文件，顶层结构::

    {
      "clips": [
        {
          "material": "A",          // 素材标识，必填
          "srt": "subs/a.srt",      // 该素材的 SRT，相对清单文件目录解析
          "src_in":  60.0,          // 源入点（秒；数字或字符串均可）
          "src_out": "72.5",        // 源出点（秒），必须晚于入点
          "dst_start": 0,           // 成片起点（秒），从 0 开始
          "speed": 1.0,             // 播放速度，必须为正数
          "track": 0                // 可选轨道顺序，缺省为 0；数字越小优先级越高
        }
      ]
    }

时间字段内部统一转为 :class:`decimal.Decimal` 秒；毫秒级舍入只发生在
:mod:`srt_remap.timecode` 的 ``to_millis``。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, List, Optional

from .errors import RemapError
from .timecode import parse_seconds

_REQUIRED_FIELDS = ("material", "srt", "src_in", "src_out", "dst_start", "speed")
_KNOWN_FIELDS = frozenset(_REQUIRED_FIELDS + ("track",))


@dataclass
class Clip:
    """一条剪辑片段（清单中的一行）。"""

    material: str
    srt_path: Path
    src_in: Decimal
    src_out: Decimal
    dst_start: Decimal
    speed: Decimal
    track: int
    line_no: int  # 在 clips 数组中的序号，从 1 开始
    duration_src: Decimal = field(init=False)
    duration_dst: Decimal = field(init=False)
    dst_end: Decimal = field(init=False)

    def __post_init__(self) -> None:
        self.duration_src = self.src_out - self.src_in
        # 成片时长 = 源时长 / 速度（速度 2x 时播放时长减半）
        self.duration_dst = self.duration_src / self.speed
        self.dst_end = self.dst_start + self.duration_dst


@dataclass
class EditList:
    clips: List[Clip]
    base_dir: Path
    warnings: List[str]


def _parse_speed(raw: Any, *, line_no: int, material: str) -> Decimal:
    if isinstance(raw, bool):
        raise RemapError(
            f"播放速度不能是布尔值: {raw!r}", line_no=line_no, material=material,
        )
    if isinstance(raw, Decimal):
        speed = raw
    elif isinstance(raw, (int, float)):
        speed = Decimal(str(raw))
    elif isinstance(raw, str):
        try:
            speed = Decimal(raw.strip())
        except InvalidOperation:
            raise RemapError(
                f"播放速度不是合法数字: {raw!r}",
                line_no=line_no, material=material,
            ) from None
    else:
        raise RemapError(
            f"播放速度类型非法: {raw!r}", line_no=line_no, material=material,
        )
    if not speed.is_finite() or speed <= 0:
        raise RemapError(
            f"播放速度必须为正的有限数，实际为 {raw!r}",
            line_no=line_no, material=material,
        )
    return speed


def _parse_track(raw: Any, *, line_no: int, material: str) -> int:
    # JSON 经 parse_int=Decimal 解析后，整数也以 Decimal 形式到达
    if isinstance(raw, bool):
        raise RemapError(
            f"轨道顺序 track 不能是布尔值: {raw!r}",
            line_no=line_no, material=material,
        )
    if isinstance(raw, int):
        value = raw
    elif isinstance(raw, Decimal) and raw == raw.to_integral_value():
        value = int(raw)
    else:
        raise RemapError(
            f"轨道顺序 track 必须是整数，实际为 {raw!r}",
            line_no=line_no, material=material,
        )
    if value < 0:
        raise RemapError(
            f"轨道顺序 track 不能为负，实际为 {value}",
            line_no=line_no, material=material,
        )
    return value


def load_edit_list(path: str | Path) -> EditList:
    """读取并校验剪辑清单，返回 :class:`EditList`。

    字幕文件是否存在不在此阶段检查——留到加载项目时逐素材报告，
    以便一次给出全部坏行。
    """
    p = Path(path)
    if not p.exists():
        raise RemapError(f"剪辑清单不存在: {p}")
    try:
        text = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise RemapError(f"剪辑清单读取失败: {p}（{exc}）") from None
    try:
        data = json.loads(text, parse_float=Decimal, parse_int=Decimal)
    except json.JSONDecodeError as exc:
        raise RemapError(
            f"剪辑清单不是合法 JSON: {exc.msg}（第 {exc.lineno} 行第 {exc.colno} 列）",
        ) from None

    if not isinstance(data, dict) or not isinstance(data.get("clips"), list):
        raise RemapError("剪辑清单顶层必须是对象且包含数组字段 \"clips\"")

    base_dir = p.resolve().parent
    clips: List[Clip] = []
    warnings: List[str] = []
    problems: List[str] = []

    for line_no, raw_clip in enumerate(data["clips"], start=1):
        try:
            clip, clip_warnings = _parse_clip(raw_clip, line_no, base_dir)
        except RemapError as exc:
            problems.append(exc.describe())
            continue
        clips.append(clip)
        warnings.extend(clip_warnings)

    if problems:
        raise RemapError("剪辑清单校验失败：\n  - " + "\n  - ".join(problems))

    if not clips:
        warnings.append("剪辑清单中没有任何合法片段，输出将为空时间线")
    return EditList(clips=clips, base_dir=base_dir, warnings=warnings)


def _parse_clip(raw_clip: Any, line_no: int, base_dir: Path) -> tuple[Clip, List[str]]:
    """解析并校验单行片段；任何字段问题都抛带行号/素材的 RemapError。"""
    warnings: List[str] = []
    if not isinstance(raw_clip, dict):
        raise RemapError("每个片段必须是 JSON 对象", line_no=line_no)
    material = raw_clip.get("material")
    if not isinstance(material, str) or not material.strip():
        raise RemapError(
            "素材标识 material 缺失或不是非空字符串", line_no=line_no,
        )
    material = material.strip()

    for name in _REQUIRED_FIELDS:
        if name == "material":
            continue
        if name not in raw_clip or raw_clip[name] is None:
            raise RemapError(
                f"缺少必填字段 {name!r}", line_no=line_no, material=material,
            )

    srt_raw = raw_clip["srt"]
    if not isinstance(srt_raw, str) or not srt_raw.strip():
        raise RemapError(
            "字幕路径 srt 缺失或不是非空字符串",
            line_no=line_no, material=material,
        )
    srt_path = Path(srt_raw.strip())
    if not srt_path.is_absolute():
        srt_path = base_dir / srt_path

    src_in = parse_seconds(
        raw_clip["src_in"], field="源入点 src_in",
        line_no=line_no, material=material,
    )
    src_out = parse_seconds(
        raw_clip["src_out"], field="源出点 src_out",
        line_no=line_no, material=material,
    )
    if src_out <= src_in:
        raise RemapError(
            f"源出点必须晚于源入点（src_in={src_in}s, src_out={src_out}s）",
            line_no=line_no, material=material,
        )
    dst_start = parse_seconds(
        raw_clip["dst_start"], field="成片起点 dst_start",
        line_no=line_no, material=material,
    )
    speed = _parse_speed(
        raw_clip["speed"], line_no=line_no, material=material,
    )
    track = (
        _parse_track(raw_clip["track"], line_no=line_no, material=material)
        if "track" in raw_clip and raw_clip["track"] is not None
        else 0
    )

    unknown = {
        name for name in raw_clip
        if name not in _KNOWN_FIELDS and not name.startswith("_")
    }
    if unknown:
        warnings.append(
            f"剪辑清单第 {line_no} 行（素材 {material!r}）存在未知字段，"
            f"已忽略: {', '.join(sorted(unknown))}"
        )

    clip = Clip(
        material=material,
        srt_path=srt_path,
        src_in=src_in,
        src_out=src_out,
        dst_start=dst_start,
        speed=speed,
        track=track,
        line_no=line_no,
    )
    return clip, warnings
