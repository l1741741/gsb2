"""ffprobe/ffmpeg 封装：媒体信息、指纹、抽帧、缩略图。"""

import hashlib
import json
import os
import subprocess

# 检测用缩放宽高：足够区分画面内容，又保证纯 Python 直方图的速度
PROBE_WIDTH = 128
PROBE_HEIGHT = 72


def _run(cmd):
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "命令失败: %s\n%s" % (" ".join(cmd), proc.stderr.decode("utf-8", "replace"))
        )
    return proc.stdout


def ffprobe_info(path):
    """返回 {fps, duration, width, height}。"""
    out = _run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-show_format", "-show_streams", path,
    ])
    data = json.loads(out)
    stream = next(s for s in data["streams"] if s["codec_type"] == "video")
    num, den = stream["avg_frame_rate"].split("/")
    fps = float(num) / float(den) if float(den) else 0.0
    duration = float(data["format"].get("duration") or stream.get("duration") or 0.0)
    return {
        "fps": fps,
        "duration": duration,
        "width": int(stream["width"]),
        "height": int(stream["height"]),
    }


def fingerprint(path):
    """素材指纹：大小 + mtime + 头部 1MB 的 sha1。用于发现素材被替换。"""
    st = os.stat(path)
    h = hashlib.sha1()
    with open(path, "rb") as f:
        h.update(f.read(1 << 20))
    return {
        "size": st.st_size,
        "mtime": int(st.st_mtime),
        "head_sha1": h.hexdigest(),
    }


def _read_exact(stream, n):
    chunks = []
    got = 0
    while got < n:
        chunk = stream.read(n - got)
        if not chunk:
            return None
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


def decode_frames(path, start=None, end=None):
    """把 [start, end) 解码成缩小灰度帧序列，yield (time, bytes)。

    time 为该帧在原片中的近似时刻（秒）。返回 (frames, fps)。
    """
    info = ffprobe_info(path)
    fps = info["fps"]
    cmd = ["ffmpeg", "-v", "error"]
    if start is not None:
        cmd += ["-ss", "%.3f" % start]
    if end is not None:
        cmd += ["-to", "%.3f" % end]
    cmd += [
        "-i", path,
        "-vf", "scale=%d:%d" % (PROBE_WIDTH, PROBE_HEIGHT),
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    frame_size = PROBE_WIDTH * PROBE_HEIGHT
    base = float(start or 0.0)
    frames = []
    idx = 0
    while True:
        buf = _read_exact(proc.stdout, frame_size)
        if buf is None:
            break
        frames.append((base + idx / fps, buf))
        idx += 1
    proc.wait()
    return frames, fps


def grab_frame(path, t, out_path, width=320):
    """在时刻 t 抽一张缩略图（JPEG）。"""
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    _run([
        "ffmpeg", "-v", "error", "-y",
        "-ss", "%.3f" % max(t, 0.0),
        "-i", path,
        "-frames:v", "1",
        "-vf", "scale=%d:-1" % width,
        out_path,
    ])
