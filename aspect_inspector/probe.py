"""ffprobe 封装：读取流元数据、旋转信息与非方形像素信息。

所有几何信息最终都要换算到“显示坐标”（display coordinates）：
- 旋转（Display Matrix side data）会交换宽高方向；
- 非方形像素（SAR != 1）会改变显示宽高比；
- 水平翻转只影响镜像，不影响边界框几何，但仍如实记录。
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path


class ProbeError(RuntimeError):
    """ffprobe 不可用或文件无法探测时抛出。"""


@dataclass(frozen=True)
class VideoInfo:
    """单条视频流的几何与时长信息。"""

    path: str
    width: int                  # 编码/存储宽（未应用旋转）
    height: int                 # 编码/存储高
    sar: Fraction               # 采样宽高比（像素宽/高），方形像素为 1
    rotation: int               # 显示旋转角度（顺时针，归一化到 {0,90,180,270}）
    hflip: bool                 # Display Matrix 是否带水平翻转
    duration: float             # 流时长（秒），缺失时回退到容器时长
    frame_rate: float           # 平均帧率
    codec: str
    display_width: float        # 显示坐标下的宽（方形像素当量）
    display_height: float       # 显示坐标下的高
    display_aspect: Fraction    # 显示宽高比 DAR

    @property
    def is_rotated_90(self) -> bool:
        return self.rotation in (90, 270)


def _run_ffprobe(path: str) -> dict:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise ProbeError("本机未找到 ffprobe，请先安装 ffmpeg。")
    cmd = [
        ffprobe,
        "-v", "error",
        "-show_format",
        "-show_streams",
        "-of", "json",
        path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        detail = proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() \
            else "无法识别的文件或编码不支持"
        raise ProbeError(f"ffprobe 无法解码 {path}：{detail}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise ProbeError(f"ffprobe 输出无法解析: {exc}") from exc


def _parse_fraction(value: str | None, default: Fraction = Fraction(1, 1)) -> Fraction:
    if not value or value in ("0/0", "N/A"):
        return default
    # ffprobe 用冒号表示比例（如 "4:3"），Fraction 只接受斜杠
    normalized = value.replace(":", "/")
    try:
        return Fraction(normalized)
    except (ValueError, ZeroDivisionError):
        return default


def _extract_rotation_and_hflip(stream: dict) -> tuple[int, bool]:
    """从 Display Matrix side data 提取顺时针旋转角与水平翻转标记。

    ffprobe 的 JSON writer 在部分版本里会把 side data 输出成空对象，
    因此这里同时兼容 compact 文本输出（见 probe_video 的二次探测）。
    """
    rotation = 0
    hflip = False
    for side in stream.get("side_data_list", []) or []:
        if not isinstance(side, dict):
            continue
        if "rotation" in side:
            rotation = int(round(float(side["rotation"])))
        # ffprobe JSON 一般不直接给 hflip，交给 compact 回退路径
    return rotation, hflip


def _probe_side_data_compact(path: str, stream_index: int) -> tuple[int, bool]:
    """用 compact writer 补取 Display Matrix（JSON writer 信息不全时的回退）。"""
    ffprobe = shutil.which("ffprobe")
    cmd = [
        ffprobe, "-v", "error",
        "-select_streams", f"0:{stream_index}",
        "-show_entries", "stream_side_data",
        "-of", "compact",
        path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        return 0, False
    rotation = 0
    hflip = False
    for line in proc.stdout.splitlines():
        if "rotation=" in line:
            try:
                rotation = int(round(float(line.split("rotation=")[1].split("|")[0])))
            except (ValueError, IndexError):
                pass
        # Display Matrix 含 -1 系数且带翻转时，rotation 可能带负号或出现 hflip 语义
        if "hflip" in line.lower():
            hflip = True
    # 归一化到顺时针 0/90/180/270
    rotation = rotation % 360
    for canonical in (0, 90, 180, 270):
        if abs(rotation - canonical) <= 1 or abs(rotation - canonical) == 359:
            rotation = canonical
            break
    return rotation, hflip


def probe_video(path: str) -> VideoInfo:
    """探测视频文件，返回含显示坐标几何的 VideoInfo。"""
    p = Path(path)
    if not p.exists():
        raise ProbeError(f"文件不存在: {path}")

    data = _run_ffprobe(str(p))
    streams = [s for s in data.get("streams", []) if s.get("codec_type") == "video"]
    if not streams:
        raise ProbeError(f"文件中没有视频流: {path}")
    stream = streams[0]
    idx = stream.get("index", 0)

    width = int(stream["width"])
    height = int(stream["height"])
    sar = _parse_fraction(stream.get("sample_aspect_ratio"))
    rotation, hflip = _extract_rotation_and_hflip(stream)
    if rotation == 0 and not hflip:
        rotation, hflip = _probe_side_data_compact(str(p), idx)

    # 负角度（ffprobe 对逆时针的表示）归一化
    rotation = rotation % 360

    duration = stream.get("duration")
    if duration in (None, "N/A"):
        duration = data.get("format", {}).get("duration", "0")
    try:
        duration = float(duration)
    except (TypeError, ValueError):
        duration = 0.0

    rate = stream.get("avg_frame_rate", "0/0")
    try:
        frame_rate = float(Fraction(rate))
    except (ValueError, ZeroDivisionError):
        frame_rate = 0.0

    # 显示坐标：像素先按 SAR 在自身宽方向拉伸，再应用旋转。
    # 90/270 旋转交换宽高方向，因此显示宽来自存储高，显示高来自存储宽×SAR。
    if rotation in (90, 270):
        display_width = float(height)
        display_height = float(width * sar)
    else:
        display_width = float(width * sar)
        display_height = float(height)
    if display_height > 0:
        display_aspect = Fraction(
            display_width / display_height
        ).limit_denominator(10000)
    else:
        display_aspect = Fraction(0)

    return VideoInfo(
        path=str(p.resolve()),
        width=width,
        height=height,
        sar=sar,
        rotation=rotation,
        hflip=hflip,
        duration=duration,
        frame_rate=frame_rate,
        codec=stream.get("codec_name", "unknown"),
        display_width=display_width,
        display_height=display_height,
        display_aspect=display_aspect,
    )
