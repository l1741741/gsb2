"""声道映射规则。

各输入文件声道数可能不同, 但一次导出的输出声道数在清单里固定。
映射在「每段文件」上单独生效, 含义为: 输出声道 k 取自该文件的哪个源声道。

公开的默认映射 (源声道数 S, 输出声道数 C):
1. S == C: 直通, 输出 k = 源 k。
2. S == 1 (单声道文件): 上混, 每个输出声道都取源声道 0。
3. C == 1 (单声道输出): 下混, 输出声道 0 取源声道 0; 其余源声道丢弃。
4. 其余情况 (S > 1 且 C > 1 且 S != C): 按索引一一对应,
   - 源不足的输出声道补静音 (用 -1 表示);
   - 多出的源声道丢弃。
   例: S=2 -> C=4 得到 [0, 1, -1, -1]; S=4 -> C=2 得到 [0, 1]。

清单可在单段上给 "channel_map" 覆盖默认值: 长度必须等于输出声道数,
每个元素是源声道索引或 -1 (静音)。

映射中的 -1 表示该输出声道在此段内恒为静音。
"""

from __future__ import annotations


class ChannelMapError(ValueError):
    pass


def default_channel_map(source_channels: int, output_channels: int) -> tuple[int, ...]:
    if source_channels < 1 or output_channels < 1:
        raise ChannelMapError("声道数必须为正整数")
    if source_channels == output_channels:
        return tuple(range(source_channels))
    if source_channels == 1:
        return tuple(0 for _ in range(output_channels))
    if output_channels == 1:
        return (0,)
    return tuple(
        src if src < source_channels else -1 for src in range(output_channels)
    )


def resolve_channel_map(
    explicit: tuple[int, ...] | list[int] | None,
    source_channels: int,
    output_channels: int,
) -> tuple[int, ...]:
    if explicit is None:
        return default_channel_map(source_channels, output_channels)
    mapping = tuple(explicit)
    if len(mapping) != output_channels:
        raise ChannelMapError(
            f"channel_map 长度 {len(mapping)} 与输出声道数 {output_channels} 不一致"
        )
    for src in mapping:
        if src != -1 and not (0 <= src < source_channels):
            raise ChannelMapError(
                f"channel_map 中的源声道 {src} 超出文件声道范围 [0, {source_channels - 1}]"
            )
    return mapping


def apply_channel_map(
    frame: list[int],
    mapping: tuple[int, ...],
    output_channels: int,
) -> list[int]:
    """把一个交织帧 (长度 = 源声道数) 转成输出帧。

    mapping[k] 为输出声道 k 取的源声道索引, -1 表示静音 0。
    """
    if len(mapping) != output_channels:
        raise ChannelMapError("映射长度与输出声道数不一致")
    out = [0] * output_channels
    for dst, src in enumerate(mapping):
        if src >= 0:
            out[dst] = frame[src]
    return out
