"""SRT 读取与写入。

解析器按块切分（空行分隔），对序号缺失/非数字保持宽容（按出现顺序
重编号），但对时间戳格式、时间倒挂等硬性错误抛出带素材与条号的
:class:`~srt_remap.errors.RemapError`。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Sequence

from .errors import RemapError
from .timecode import format_srt_timestamp, parse_srt_timestamp


@dataclass
class Cue:
    """一条源 SRT 字幕，时间均为毫秒整数。"""

    start: int
    end: int
    text: str
    index: int  # 源文件中的序号（解析后的顺序号，从 1 开始）

    def __post_init__(self) -> None:
        if self.start < 0 or self.end < 0:
            raise RemapError(
                "SRT 时间不能为负", cue_index=self.index,
            )
        if self.end <= self.start:
            raise RemapError(
                f"SRT 条目结束时间必须晚于开始时间（{self.start} -> {self.end}）",
                cue_index=self.index,
            )


def parse_srt(content: str, *, material: str | None = None) -> List[Cue]:
    """解析 SRT 文本。``material`` 仅用于错误定位。"""
    # 统一换行；去掉 BOM
    content = content.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    blocks = content.split("\n\n")
    cues: List[Cue] = []
    order = 0
    for block in blocks:
        lines = [ln for ln in block.split("\n") if ln.strip() != ""]
        if not lines:
            continue
        order += 1
        # 可选序号行
        if "-->" in lines[0]:
            time_line = lines[0]
            text_lines = lines[1:]
        else:
            if len(lines) < 2 or "-->" not in lines[1]:
                raise RemapError(
                    f"SRT 第 {order} 块缺少时间轴行",
                    material=material, cue_index=order,
                )
            time_line = lines[1]
            text_lines = lines[2:]
        if "-->" not in time_line:
            raise RemapError(
                f"SRT 时间轴行格式错误: {time_line!r}",
                material=material, cue_index=order,
            )
        left, right = time_line.split("-->", 1)
        start = parse_srt_timestamp(left, cue_index=order, material=material)
        end = parse_srt_timestamp(right, cue_index=order, material=material)
        text = "\n".join(text_lines).strip()
        if not text:
            raise RemapError(
                "SRT 条目文本为空", material=material, cue_index=order,
            )
        cues.append(Cue(start=start, end=end, text=text, index=order))
    return cues


def read_srt(path: str | Path, *, material: str | None = None) -> List[Cue]:
    p = Path(path)
    if not p.exists():
        raise RemapError(
            f"字幕文件不存在: {p}", material=material,
        )
    if not p.is_file():
        raise RemapError(
            f"字幕路径不是普通文件: {p}", material=material,
        )
    try:
        content = p.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        # 退一步尝试带 BOM 的 UTF-16（部分剪辑软件导出格式）
        try:
            content = p.read_text(encoding="utf-16")
        except UnicodeDecodeError as exc:
            raise RemapError(
                f"字幕文件无法按 UTF-8/UTF-16 解码: {p}（{exc}）",
                material=material,
            ) from None
    except OSError as exc:
        raise RemapError(
            f"字幕文件读取失败: {p}（{exc}）", material=material,
        ) from None
    return parse_srt(content, material=material)


def write_srt(path: str | Path, cues: Sequence[Cue]) -> None:
    """按 SRT 规范写出；序号从 1 连续重排。"""
    parts = []
    for i, cue in enumerate(cues, start=1):
        parts.append(
            f"{i}\n"
            f"{format_srt_timestamp(cue.start)} --> {format_srt_timestamp(cue.end)}\n"
            f"{cue.text}\n"
        )
    Path(path).write_text("\n".join(parts), encoding="utf-8")
