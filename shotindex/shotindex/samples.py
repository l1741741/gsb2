"""生成检测样例素材：硬切、渐变、单帧闪光、短镜头，并输出实际发生位置。

生成的 ground_truth.json 给出每类事件的真实时刻，供扫描结果核对定位。
"""

import json
import os
import subprocess

FPS = 25
SIZE = "640x360"


def _src(spec):
    """给 lavfi 源补上 rate/size 参数（源本身可能已带 = 选项）。"""
    sep = ":" if "=" in spec else "="
    return "%s%srate=%d:size=%s" % (spec, sep, FPS, SIZE)


def _run(cmd):
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "命令失败: %s\n%s" % (" ".join(cmd), proc.stderr.decode("utf-8", "replace"))
        )


def _lavfi_segment(out, src, dur):
    _run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", _src(src),
        "-t", "%.3f" % dur,
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        out,
    ])


def _dissolve_segment(out, src_a, src_b, dur_a, dur_b, xfade_dur, offset):
    """A 播放到 offset 后开始与 B 淡变，过渡 xfade_dur 秒。总长 offset + dur_b。"""
    _run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-t", "%.3f" % dur_a, "-i", _src(src_a),
        "-f", "lavfi", "-t", "%.3f" % dur_b, "-i", _src(src_b),
        "-filter_complex",
        "[0][1]xfade=transition=fade:duration=%.3f:offset=%.3f" % (xfade_dur, offset),
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        out,
    ])


def build_samples(out_dir):
    """在 out_dir 下生成 mixed.mp4 与 ground_truth.json，返回真值表。"""
    os.makedirs(out_dir, exist_ok=True)
    seg_dir = os.path.join(out_dir, "segments")
    os.makedirs(seg_dir, exist_ok=True)

    # (文件名, 时长) —— 顺序拼接，硬切位置由累计时长得出
    plan = []
    truth = []

    def add_segment(name, dur, make):
        path = os.path.join(seg_dir, name)
        make(path)
        plan.append((path, dur))
        return path

    t = 0.0
    add_segment("01_testsrc2.mp4", 4.0,
                lambda p: _lavfi_segment(p, "testsrc2", 4.0))
    t += 4.0
    truth.append({"type": "cut", "time": round(t, 3), "note": "testsrc2 -> 红"})
    add_segment("02_red.mp4", 3.0, lambda p: _lavfi_segment(p, "color=c=red", 3.0))
    t += 3.0

    # 渐变：testsrc 2s 后开始 1s 淡变到蓝，再纯蓝 2s，整段 5s
    truth.append({"type": "gradual", "start": round(t + 2.0, 3),
                  "end": round(t + 3.0, 3), "note": "testsrc 淡变到蓝"})
    add_segment("03_dissolve.mp4", 5.0,
                lambda p: _dissolve_segment(p, "testsrc", "color=c=blue",
                                            3.0, 3.0, 1.0, 2.0))
    t += 5.0

    add_segment("04_green.mp4", 2.0, lambda p: _lavfi_segment(p, "color=c=green", 2.0))
    t += 2.0
    # 单帧闪光：1 帧白，前后都是绿
    truth.append({"type": "flash", "time": round(t, 3), "note": "单帧白闪"})
    add_segment("05_white_1f.mp4", 1.0 / FPS,
                lambda p: _lavfi_segment(p, "color=c=white", 1.0 / FPS))
    t += 1.0 / FPS
    add_segment("06_green.mp4", 2.0, lambda p: _lavfi_segment(p, "color=c=green", 2.0))
    t += 2.0

    # 连续短镜头：0.6s 一个，用于验证临近抑制与恢复
    short_colors = ["cyan", "magenta", "yellow"]
    for idx, color in enumerate(short_colors):
        truth.append({"type": "cut", "time": round(t, 3),
                      "note": "短镜头 -> %s（0.6s 短镜头）" % color})
        add_segment("07_short_%d.mp4" % idx, 0.6,
                    lambda p, c=color: _lavfi_segment(p, "color=c=%s" % c, 0.6))
        t += 0.6
    truth.append({"type": "cut", "time": round(t, 3), "note": "短镜头 -> 黑"})
    add_segment("08_black.mp4", 2.0, lambda p: _lavfi_segment(p, "color=c=black", 2.0))
    t += 2.0

    concat_list = os.path.join(seg_dir, "concat.txt")
    with open(concat_list, "w", encoding="utf-8") as f:
        for path, _ in plan:
            f.write("file '%s'\n" % os.path.abspath(path))
    out_video = os.path.join(out_dir, "mixed.mp4")
    # 重编码拼接（而非 -c copy）：保证 1 帧的闪光段不会因时间戳取整被丢掉
    _run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
          "-i", concat_list,
          "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
          out_video])

    truth_path = os.path.join(out_dir, "ground_truth.json")
    with open(truth_path, "w", encoding="utf-8") as f:
        json.dump({
            "video": os.path.abspath(out_video),
            "fps": FPS,
            "duration": round(t, 3),
            "note": "各事件实际发生位置（秒），供扫描结果核对",
            "events": truth,
        }, f, ensure_ascii=False, indent=2)
    return out_video, truth_path
