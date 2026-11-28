"""ffmpeg 子进程封装：

1. 按“显示坐标”解码灰度帧（应用旋转 + SAR 校正，输出方形像素）；
2. 抽取指定时刻的单帧并在画面上绘制有效边界框；
3. 生成母版/交付版并排对比截图。

不依赖第三方库，时间戳用 ffmpeg 的 showinfo 输出回传，
管道里只走原始 gray8 字节，内存占用与分析分辨率成正比。
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .probe import VideoInfo


class FFmpegError(RuntimeError):
    pass


def _ffmpeg_bin() -> str:
    binary = shutil.which("ffmpeg")
    if not binary:
        raise FFmpegError("本机未找到 ffmpeg，请先安装 ffmpeg。")
    return binary


def rotation_filter(rotation: int, hflip: bool) -> str:
    """把 Display Matrix 旋转/翻转翻译成显式滤镜（输入已用 -noautorotate 关闭自动旋转）。

    transpose=1 为顺时针 90°，transpose=2 为逆时针 90°。
    """
    chain = []
    if hflip:
        chain.append("hflip")
    if rotation == 90:
        chain.append("transpose=1")
    elif rotation == 180:
        chain.append("transpose=2,transpose=2")
    elif rotation == 270:
        chain.append("transpose=2")
    return ",".join(chain) if chain else "null"


def display_correction_chain(info: VideoInfo, target_width: int) -> str:
    """构造把存储坐标变成显示坐标（方形像素）的滤镜链。

    顺序：显式旋转 → 按显示宽高比缩放到方形像素统一分析宽度 → 强制 SAR=1。
    """
    parts = [rotation_filter(info.rotation, info.hflip)]
    if info.display_height <= 0:
        raise FFmpegError(f"无效的显示尺寸: {info.path}")
    # 旋转后的帧经 scale 拉伸到显示宽高比（display_width:display_height）
    target_height = max(
        2, round(target_width * info.display_height / info.display_width))
    parts.append(f"scale={target_width}:{target_height}:flags=bicubic")
    parts.append("setsar=1")
    return ",".join(parts)


@dataclass
class RawFrame:
    index: int
    pts_time: float
    width: int
    height: int
    gray: bytes  # gray8, 长度 width*height


def extract_gray_frames(
    info: VideoInfo,
    start: float,
    end: float,
    sample_fps: float,
    analysis_width: int = 480,
) -> tuple[list[RawFrame], str]:
    """解码时间窗内的灰度帧（显示坐标、方形像素）。

    返回 (帧列表, ffmpeg stderr 文本)。showinfo 负责回传每帧 pts_time，
    这样 VFR/丢帧情况下时间戳仍然准确。
    """
    duration = max(0.0, end - start)
    chain = (
        display_correction_chain(info, analysis_width)
        + f",fps={sample_fps},showinfo"
    )
    # 先探测一帧拿到校正后的实际尺寸
    dims = _probe_chain_dimensions(info, chain)
    width, height = dims

    cmd = [
        _ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "info",
        "-noautorotate",
        "-ss", f"{start:.3f}",
        "-t", f"{duration:.3f}",
        "-i", info.path,
        "-an",
        "-vf", chain,
        "-pix_fmt", "gray",
        "-f", "rawvideo",
        "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    assert proc.stdout is not None and proc.stderr is not None
    frame_size = width * height
    timestamps, stderr_lines, pump_thread = _pump_stderr(proc.stderr)

    frames: list[RawFrame] = []
    index = 0
    buf = b""
    try:
        while True:
            chunk = proc.stdout.read(frame_size - len(buf))
            if not chunk:
                break
            buf += chunk
            if len(buf) == frame_size:
                ts = timestamps[index] if index < len(timestamps) else start + index / sample_fps
                # bytes 不可变，此处拷贝确保每帧独立，避免 buf 复用导致别名
                frames.append(RawFrame(index, ts, width, height, bytes(buf)))
                buf = b""
                index += 1
    finally:
        proc.stdout.close()
    proc.wait()
    pump_thread.join(timeout=5.0)
    stderr_text = "".join(stderr_lines)
    proc.stderr.close()
    if proc.returncode != 0 and not frames:
        raise FFmpegError(
            f"ffmpeg 解码失败 {info.path} [{start:.3f},{end:.3f}]: {stderr_text[-800:]}"
        )
    return frames, stderr_text


def _probe_chain_dimensions(info: VideoInfo, chain: str) -> tuple[int, int]:
    """跑 1 帧滤镜链，从 showinfo 里读出输出尺寸。"""
    cmd = [
        _ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "info",
        "-noautorotate",
        "-i", info.path,
        "-frames:v", "1",
        "-vf", chain,
        "-f", "null",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    for line in proc.stderr.splitlines():
        if "showinfo" in line and " s:" in line:
            token = line.split(" s:")[1].split()[0]
            w, h = token.split("x")
            return int(w), int(h)
    raise FFmpegError(f"无法确定分析帧尺寸 {info.path}: {proc.stderr[-400:]}")


def _pump_stderr(stderr_stream) -> tuple[list[float], list[str], "object"]:
    """后台线程读取 ffmpeg stderr：收集 showinfo pts_time 与全部日志行。

    ffmpeg 在写出每帧前打印 showinfo，若不及时消费 stderr，
    管道缓冲写满后 ffmpeg 会阻塞，造成主进程读 stdout 时死锁。
    返回 (时间戳列表, 日志行列表, 线程对象)，调用方在收尾时 join。
    """
    import threading

    timestamps: list[float] = []
    lines: list[str] = []

    def pump() -> None:
        while True:
            raw = stderr_stream.readline()
            if not raw:
                break
            line = raw.decode("utf-8", errors="replace")
            lines.append(line)
            if "showinfo" in line and "pts_time:" in line:
                try:
                    token = line.split("pts_time:")[1].split()[0]
                    timestamps.append(float(token))
                except (IndexError, ValueError):
                    pass

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()
    return timestamps, lines, thread


def display_panel_size(info: VideoInfo, panel_width: int) -> tuple[int, int]:
    """显示校正并缩放到 panel_width 后的实际 (宽, 高)。"""
    if info.display_height <= 0:
        raise FFmpegError(f"无效的显示尺寸: {info.path}")
    h = max(2, round(panel_width * info.display_height / info.display_width))
    return panel_width, h


def render_boundary_frame(
    info: VideoInfo,
    timestamp: float,
    bbox_norm: tuple[float, float, float, float] | None,
    out_path: str,
    out_width: int = 640,
    box_color: str = "0x00FF66",
    box_thickness: int = 3,
) -> None:
    """抽取单个时刻的显示坐标帧，并在归一化 bbox 位置画边界框。

    bbox_norm = (x0, y0, x1, y1)，取值 0..1；None 表示全黑帧（不画框）。
    """
    chain = display_correction_chain(info, out_width)
    if bbox_norm is not None:
        pw, ph = display_panel_size(info, out_width)
        chain = _append_box(chain, bbox_norm, box_color, pw, ph)
    cmd = [
        _ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-noautorotate",
        "-ss", f"{timestamp:.3f}",
        "-i", info.path,
        "-vf", chain + ",setsar=1",
        "-frames:v", "1",
        "-y",
        out_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not Path(out_path).exists():
        raise FFmpegError(f"截图失败 {info.path}@{timestamp:.3f}: {proc.stderr[-500:]}")


def render_side_by_side(
    master_info: VideoInfo,
    deliver_info: VideoInfo,
    timestamp: float,
    master_bbox: tuple[float, float, float, float] | None,
    deliver_bbox: tuple[float, float, float, float] | None,
    out_path: str,
    panel_width: int = 560,
) -> None:
    """生成母版与交付版在同一时间点的并排截图，各自带有效边界框。

    两路分别做显示校正、缩放到相同面板尺寸、画框，再 hstack 拼接。
    时间戳语义一致（都是源片时间轴上的同一秒），用于从报告定位回原片。
    """
    # 两路统一到相同面板高，避免显示比例不同导致 hstack 尺寸不齐
    _, panel_height = display_panel_size(master_info, panel_width)
    left = display_correction_chain(master_info, panel_width)
    right = (
        display_correction_chain(deliver_info, panel_width)
        + f",scale={panel_width}:{panel_height}:flags=bicubic,setsar=1"
    )
    left = _append_box(left, master_bbox, "0x00FF66",
                       panel_width, panel_height)
    right = _append_box(right, deliver_bbox, "0xFF8800",
                        panel_width, panel_height)
    filter_complex = (
        f"[0:v]{left},setsar=1[l];"
        f"[1:v]{right}[r];"
        f"[l][r]hstack=inputs=2[out]"
    )
    cmd = [
        _ffmpeg_bin(),
        "-hide_banner",
        "-nostdin",
        "-loglevel", "error",
        "-noautorotate",
        "-ss", f"{timestamp:.3f}",
        "-i", master_info.path,
        "-noautorotate",
        "-ss", f"{timestamp:.3f}",
        "-i", deliver_info.path,
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-frames:v", "1",
        "-y",
        out_path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not Path(out_path).exists():
        raise FFmpegError(f"并排截图失败 @{timestamp:.3f}: {proc.stderr[-600:]}")


def _append_box(chain: str, bbox_norm: tuple[float, float, float, float] | None,
                color: str, panel_width: int, panel_height: int) -> str:
    """在滤镜链上追加边界框。

    用具体像素坐标而非 iw/ih 表达式：在 filter_complex 里带标签的链
    可能被延迟到 hstack 后求值，导致 iw 变成拼接后的总宽度、框错位。
    """
    if bbox_norm is None:
        return chain
    x0, y0, x1, y1 = bbox_norm
    px = round(x0 * panel_width)
    py = round(y0 * panel_height)
    pw = max(1, round((x1 - x0) * panel_width))
    ph = max(1, round((y1 - y0) * panel_height))
    return chain + (
        f",drawbox=x={px}:y={py}:w={pw}:h={ph}:color={color}:t=3"
    )
