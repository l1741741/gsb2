"""工具内统一使用的异常类型。

所有可预期的输入错误（坏时间、缺文件、非法速度、SRT 解析失败等）
都抛 :class:`RemapError`，并尽量带上剪辑行号 ``line_no`` 和素材标识
``material``，方便定位到具体的清单行与素材。
"""

from __future__ import annotations

from typing import Optional


class RemapError(Exception):
    def __init__(
        self,
        message: str,
        *,
        line_no: Optional[int] = None,
        material: Optional[str] = None,
        cue_index: Optional[int] = None,
    ) -> None:
        self.message = message
        self.line_no = line_no
        self.material = material
        self.cue_index = cue_index
        super().__init__(self.describe())

    def describe(self) -> str:
        prefixes = []
        if self.line_no is not None:
            prefixes.append(f"剪辑清单第 {self.line_no} 行")
        if self.material is not None:
            prefixes.append(f"素材 {self.material!r}")
        if self.cue_index is not None:
            prefixes.append(f"SRT 第 {self.cue_index} 条")
        location = "（".join(prefixes)
        if prefixes:
            location = "（" + "，".join(prefixes) + "）"
        return f"{location}{self.message}" if location else self.message
