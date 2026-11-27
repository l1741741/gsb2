"""时间解析与统一舍入。

设计要点
--------
1. 全程用 :class:`decimal.Decimal` 保存秒数，避免二进制浮点在毫秒边界
   产生 ``0.1 + 0.2 != 0.3`` 一类误差。
2. 毫秒是唯一的整数时间单位。:func:`to_millis` 是唯一做舍入的地方，
   全工具统一采用 ``ROUND_HALF_UP``（四舍五入）。
3. 映射公式里起点、终点各自独立舍入，保证两个紧挨的片段（前片终点
   源时间 == 后片起点源时间，且成片端点相同）舍入后仍然相等，不会
   凭空产生 1ms 重叠或缝隙。
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from .errors import RemapError

_MILLIS = Decimal("1000")
_ONE = Decimal("1")


def parse_seconds(value: object, *, field: str, line_no: int | None = None,
                  material: str | None = None) -> Decimal:
    """把清单里的时间字段解析为非负 Decimal 秒。

    接受数字（int/float/Decimal）或字符串。字符串会先 ``strip``，
    空串视为非法。
    """
    if isinstance(value, bool):  # bool 是 int 的子类，显式拒绝
        raise RemapError(
            f"{field} 不能是布尔值: {value!r}",
            line_no=line_no, material=material,
        )
    if isinstance(value, Decimal):
        dec = value
    elif isinstance(value, int):
        dec = Decimal(value)
    elif isinstance(value, float):
        # float 先转字符串，避免引入二进制尾数噪声
        dec = Decimal(str(value))
    elif isinstance(value, str):
        text = value.strip()
        if not text:
            raise RemapError(
                f"{field} 为空", line_no=line_no, material=material,
            )
        try:
            dec = Decimal(text)
        except InvalidOperation:
            raise RemapError(
                f"{field} 不是合法时间（秒）: {value!r}",
                line_no=line_no, material=material,
            ) from None
    else:
        raise RemapError(
            f"{field} 类型非法: {value!r}",
            line_no=line_no, material=material,
        )
    if not dec.is_finite() or dec < 0:
        raise RemapError(
            f"{field} 必须是非负有限秒数，实际为 {value!r}",
            line_no=line_no, material=material,
        )
    return dec


def to_millis(seconds: Decimal) -> int:
    """秒 -> 毫秒整数，全工具唯一的舍入点（HALF_UP）。

    用 ``quantize`` 而非 ``int(x + 0.5)``：后者会把精确整数也推高 1ms
    （如 5.000s 被算成 5001）。HALF_UP 下精确整数保持不变，只有真正
    大于半毫秒的尾数才进位。
    """
    return int((seconds * _MILLIS).quantize(_ONE, rounding=ROUND_HALF_UP))


def format_srt_timestamp(millis: int) -> str:
    """毫秒整数 -> SRT 时间戳 ``HH:MM:SS,mmm``。"""
    if millis < 0:
        raise ValueError(f"毫秒数不能为负: {millis}")
    hours, rem = divmod(millis, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    seconds, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{ms:03d}"


def parse_srt_timestamp(text: str, *, cue_index: int | None = None,
                        material: str | None = None) -> int:
    """SRT 时间戳 -> 毫秒整数。

    接受 ``HH:MM:SS,mmm`` 与 ``HH:MM:SS.mmm``（逗号/点均可），
    小时可超过两位，毫秒必须正好三位。
    """
    raw = text.strip()
    normalized = raw.replace(",", ".")
    parts = normalized.split(":")
    if len(parts) != 3:
        raise RemapError(
            f"SRT 时间戳格式错误: {text!r}，应为 HH:MM:SS,mmm",
            material=material, cue_index=cue_index,
        )
    h_text, m_text, tail = parts
    if "." in tail:
        s_text, ms_text = tail.split(".", 1)
    else:
        s_text, ms_text = tail, "0"
    if not h_text.isdigit() or not m_text.isdigit() or not s_text.isdigit():
        raise RemapError(
            f"SRT 时间戳格式错误: {text!r}",
            material=material, cue_index=cue_index,
        )
    if not ms_text.isdigit() or not (1 <= len(ms_text) <= 3):
        raise RemapError(
            f"SRT 毫秒部分必须是 1-3 位数字: {text!r}",
            material=material, cue_index=cue_index,
        )
    hours, minutes, seconds = int(h_text), int(m_text), int(s_text)
    millis = int(ms_text.ljust(3, "0"))
    if minutes >= 60 or seconds >= 60:
        raise RemapError(
            f"SRT 时间戳的分/秒超出范围: {text!r}",
            material=material, cue_index=cue_index,
        )
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis
