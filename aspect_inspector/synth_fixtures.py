"""用本机 ffmpeg 自生成小型测试视频，供离线自验使用。

所有素材都生成到调用方指定的临时目录，绝不修改任何既有素材。
覆盖场景：
1. constant_bars  恒定黑边（带淡入淡出 + 黑边上的文字条）；
2. aspect_switch  片中画幅切换（pillarbox ↔ 全屏）；
3. all_black      全黑窗 / 片头黑场 / 单个黑帧；
4. rotated_sar    旋转 90° + 非方形像素；
5. bar_text       大黑边上的少量文字，验证不会把边界撑开。

每个场景产出母版与两种交付版：
- faithful  忠实转码（尺寸/编码不同但有效边界一致）；
- widened   黑边宽度不同（制造持续画幅差异）。
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class FixtureError(RuntimeError):
    pass


def _ffmpeg() -> str:
    binary = shutil.which("ffmpeg")
    if not binary:
        raise FixtureError("本机未找到 ffmpeg")
    return binary


def _run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FixtureError(
            f"ffmpeg 命令失败: {' '.join(cmd[:6])}...\n{proc.stderr[-1200:]}"
        )


@dataclass
class FixtureSet:
    master: str
    faithful: str
    widened: str
    description: str


def _content_chain(w: int, h: int, draw_text_box: bool = False,
                   duration: float | None = None) -> str:
    """彩色测试内容 + 可选的“黑边文字”小条（用白块模拟，无 drawtext 依赖）。"""
    dur = f":d={duration}" if duration is not None else ""
    chain = (
        f"testsrc2=size={w}x{h}:rate=25{dur},"
        f"drawbox=x=40:y=30:w=160:h=110:color=yellow:t=fill,"
        f"drawbox=x={w - 200}:y={h - 140}:w=150:h=90:color=cyan:t=fill"
    )
    if draw_text_box:
        # 左上黑边区域内的细长白条，模拟烧录在黑边上的文字/时间码
        chain += ",drawbox=x=12:y=8:w=110:h=14:color=white:t=fill"
    return chain


def generate_constant_bars(out_dir: str, duration: float = 6.0) -> FixtureSet:
    """恒定 4:3 内容居中在 16:9 画幅里，含淡入淡出与黑边文字。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    master = str(out / "constant_master.mp4")
    faithful = str(out / "constant_faithful.mp4")
    widened = str(out / "constant_widened.mp4")

    # 母版：640x360 内容放在 960x540 帧中（左右各 160px 黑边），
    # 淡入 0.5s、淡出 0.5s，黑边上有文字条。
    # overlay 中 pad 在前、内容在后（[bg][fg]），x 是内容左上角的横坐标
    filter_complex = (
        f"color=c=black:s=960x540:r=25:d={duration}[bg];"
        f"{_content_chain(640, 360, True, duration)}[fg];"
        f"[bg][fg]overlay=x=160:y=0:shortest=1"
        f",fade=t=in:st=0:d=0.5,fade=t=out:st={duration - 0.5}:d=0.5,setsar=1"
    )
    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error",
          "-filter_complex", filter_complex,
          "-t", str(duration), "-c:v", "libx264", "-pix_fmt", "yuv420p",
          "-y", master])

    # 忠实交付：整帧缩放到 1280x720，归一化边界应保持一致
    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", master,
          "-vf", "scale=1280:720,setsar=1", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", faithful])

    # 加宽黑边交付：内容缩到 560x360 居中（左右黑边各 200px），边界明显不同
    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i",
          f"testsrc2=size=560x360:rate=25:d={duration}",
          "-f", "lavfi", "-i",
          f"color=c=black:s=960x540:r=25:d={duration}",
          "-filter_complex",
          "[1:v][0:v]overlay=x=200:y=0:shortest=1,setsar=1",
          "-t", str(duration), "-c:v", "libx264", "-pix_fmt", "yuv420p",
          "-y", widened])

    return FixtureSet(master, faithful, widened,
                      "恒定黑边 + 淡入淡出 + 黑边文字")


def generate_aspect_switch(out_dir: str) -> FixtureSet:
    """前半段 pillarbox、后半段全屏，模拟片中画幅切换。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    master = str(out / "switch_master.mp4")
    faithful = str(out / "switch_faithful.mp4")
    widened = str(out / "switch_widened.mp4")

    def seg_filter(content_w: int) -> str:
        x = (960 - content_w) // 2
        return (
            f"color=c=black:s=960x540:r=25:d=3[bg{content_w}];"
            f"testsrc2=size={content_w}x360:rate=25:d=3[fg{content_w}];"
            f"[bg{content_w}][fg{content_w}]overlay=x={x}:y=0:shortest=1"
            f",setsar=1,format=yuv420p[v{content_w}]"
        )

    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error",
          "-filter_complex",
          seg_filter(640) + ";" + seg_filter(960) +
          ";[v640][v960]concat=n=2:v=1[v]",
          "-map", "[v]", "-r", "25",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", master])

    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", master,
          "-vf", "scale=1280:720,setsar=1", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-y", faithful])

    # 交付版全程 pillarbox（把后半段全屏内容也压进黑边）→ 与母版持续不同
    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", master,
          "-vf",
          "scale=640:360,pad=960:540:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", widened])

    return FixtureSet(master, faithful, widened, "片中画幅切换")


def generate_all_black(out_dir: str) -> FixtureSet:
    """片头 1.5s 黑场 + 中间 1s 全黑 + 内容帧，含单个孤立黑帧。

    分片段生成后用 concat demuxer 拼接（比 filter_complex 链式 concat 稳，
    不会因为某段的 enable 表达式导致前段被吞）。
    """
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    master = str(out / "black_master.mp4")
    faithful = str(out / "black_faithful.mp4")
    widened = str(out / "black_widened.mp4")
    parts_dir = out / "parts"
    parts_dir.mkdir(exist_ok=True)

    def part(name: str, graph: str, dur: float) -> str:
        path = str(parts_dir / name)
        _run([_ffmpeg(), "-hide_banner", "-loglevel", "error",
              "-f", "lavfi", "-i", graph,
              "-t", str(dur), "-r", "25",
              "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", path])
        return path

    # 内容段：灰底（贯穿全帧，保证全屏内容始终明亮，不被误判为黑边）
    # 叠加 testsrc2 图样，再用 drawbox 在第 50 帧盖一个孤立黑帧
    content_graph = (
        "color=c=0x555555:s=640x360:r=25[bg];"
        "testsrc2=size=640x360:rate=25[fg];"
        "[bg][fg]overlay=shortest=1,"
        "drawbox=x=0:y=0:w=640:h=360:color=black:t=fill:enable='eq(n,50)'"
    )

    # 段1：1.5s 片头黑场
    p1 = part("p1.mp4", "color=c=black:s=640x360:r=25", 1.5)
    # 段2：3s 内容，第 50 帧（约 2s 处）替换为孤立黑帧
    p2 = part("p2.mp4", content_graph, 3.0)
    # 段3：1s 全黑
    p3 = part("p3.mp4", "color=c=black:s=640x360:r=25", 1.0)
    # 段4：2s 内容（无孤立黑帧）
    p4 = part(
        "p4.mp4",
        "color=c=0x555555:s=640x360:r=25[bg];"
        "testsrc2=size=640x360:rate=25[fg];[bg][fg]overlay=shortest=1",
        2.0,
    )

    list_file = parts_dir / "concat.txt"
    list_file.write_text(
        "".join(f"file '{Path(p).name}'\n" for p in (p1, p2, p3, p4)),
        encoding="utf-8",
    )
    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error",
          "-f", "concat", "-safe", "0", "-i", str(list_file),
          "-c", "copy", "-y", master])

    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", master,
          "-vf", "scale=960:540,setsar=1", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-y", faithful])

    # widened：内容阶段加黑边（黑场段本身无边界，不影响差异结论的持续性逻辑）
    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", master,
          "-vf",
          "scale=480:270,pad=640:360:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", widened])

    return FixtureSet(master, faithful, widened,
                      "片头黑场 + 全黑窗 + 孤立黑帧")


def generate_rotated_sar(out_dir: str) -> FixtureSet:
    """竖拍内容：90° 显示旋转 + 非方形像素（SAR=4/3）。"""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    base = str(out / "rot_base.mp4")
    master = str(out / "rot_master.mp4")
    faithful = str(out / "rot_faithful.mp4")
    widened = str(out / "rot_widened.mp4")

    # 存储 640x480、SAR 4/3（显示 853.3x480），再写入 90° 显示矩阵
    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i",
          "testsrc2=size=640x480:rate=25:d=4,"
          "drawbox=x=120:y=90:w=240:h=300:color=yellow:t=fill,setsar=4/3",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", base])
    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error",
          "-display_rotation:v", "90", "-i", base, "-c", "copy", "-y", master])

    # 忠实交付：保留旋转矩阵（-noautorotate 防止被烘焙进像素）与非方形像素，
    # 仅改编码尺寸
    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error",
          "-noautorotate", "-display_rotation:v", "90", "-i", master,
          "-vf", "scale=360:-2,setsar=4/3", "-c:v", "libx264",
          "-pix_fmt", "yuv420p", "-y", faithful])

    # widened：剥掉旋转并加 pillarbox，几何与边界都不同
    _run([_ffmpeg(), "-hide_banner", "-loglevel", "error", "-i", master,
          "-vf",
          "scale=480:360,pad=640:360:(ow-iw)/2:(oh-ih)/2:black,setsar=1",
          "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", widened])

    return FixtureSet(master, faithful, widened,
                      "90° 旋转 + SAR=4/3 非方形像素")


def generate_all(out_dir: str) -> dict[str, FixtureSet]:
    """生成全部场景，返回场景名 → FixtureSet。"""
    base = Path(out_dir)
    return {
        "constant_bars": generate_constant_bars(str(base / "constant_bars")),
        "aspect_switch": generate_aspect_switch(str(base / "aspect_switch")),
        "all_black": generate_all_black(str(base / "all_black")),
        "rotated_sar": generate_rotated_sar(str(base / "rotated_sar")),
    }
