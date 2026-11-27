#!/usr/bin/env python3
"""生成三组合成 PCM WAV 录音与配套清单, 用于离线取样验证。

录音设计 (采样率 8000 Hz, 项目帧即绝对时间帧):

  segA (2 声道, 16 bit): 项目帧 [0, 8000)     = 0.0s - 1.0s
  segB (1 声道, 16 bit): 项目帧 [6000, 14000) = 0.75s - 1.75s  (与 A 搭接 0.25s)
  segC (4 声道, 24 bit): 项目帧 [18000, 26000) = 2.25s - 3.25s (与 B 之间留 0.5s 空洞)

时间轴上因此包含:
  - 两个搭接点 (A/B 重叠 [6000,8000), B/C 之间 [14000,18000) 空洞)
  - 起点前与终点后的空洞
  - 三种声道数 (2 / 1 / 4), 输出固定为 2 声道, 可验证完整声道映射

样本编码 (每帧每声道可反查来源):
  value(seg, ch, frame_in_file) = SEG_MARKER[seg] + 100 * ch + (frame_in_file % 97)

另有整点版清单 manifest-hour.json: 同样的三个文件被映射到 3600s (1h)
整点前后, 用于验证整点附近的取样。文件本身不变, 只改清单里的 start。

用法:
  python3 tools/make_fixtures.py <输出目录>
"""

from __future__ import annotations

import json
import os
import sys
import wave

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from wav_sampler.pcm import encode_samples  # noqa: E402

RATE = 8000
SEG_MARKER = {"segA": 10000, "segB": 20000, "segC": 30000}


def write_wav(path: str, channels: int, sample_width: int, frames: int, marker: int) -> None:
    samples: list[int] = []
    for frame in range(frames):
        for ch in range(channels):
            samples.append(marker + 100 * ch + (frame % 97))
    with wave.open(path, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(RATE)
        wf.writeframes(encode_samples(samples, sample_width))


def build_manifest(starts: dict[str, int]) -> dict:
    segments = [
        {
            "id": "segA",
            "path": "wav/segA.wav",
            "start": {"frames": starts["segA"]},
            "duration": {"frames": 8000},
            "priority": 1,
        },
        {
            "id": "segB",
            "path": "wav/segB.wav",
            "start": {"frames": starts["segB"]},
            "duration": {"frames": 8000},
            "priority": 5,
        },
        {
            "id": "segC",
            "path": "wav/segC.wav",
            "start": {"frames": starts["segC"]},
            "duration": {"frames": 8000},
            "priority": 2,
        },
    ]
    ranges = [
        {
            "id": "r1",
            "start": {"frames": 2000},
            "end": {"frames": 12000},
            "output": "r1.wav",
        },
        {
            "id": "r2",
            "start": {"frames": 10000},
            "end": {"frames": 22000},
            "output": "r2.wav",
        },
        {
            "id": "r3",
            "start": {"frames": 0},
            "end": {"frames": 28000},
            "output": "r3.wav",
        },
    ]
    return {
        "sample_rate": RATE,
        "output_channels": 2,
        "segments": segments,
        "ranges": ranges,
    }


def main(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    wav_dir = os.path.join(out_dir, "wav")
    os.makedirs(wav_dir, exist_ok=True)

    write_wav(os.path.join(wav_dir, "segA.wav"), channels=2, sample_width=2, frames=8000, marker=SEG_MARKER["segA"])
    write_wav(os.path.join(wav_dir, "segB.wav"), channels=1, sample_width=2, frames=8000, marker=SEG_MARKER["segB"])
    write_wav(os.path.join(wav_dir, "segC.wav"), channels=4, sample_width=3, frames=8000, marker=SEG_MARKER["segC"])

    # 基础版: 搭接 + 空洞
    base_starts = {"segA": 0, "segB": 6000, "segC": 18000}
    manifest = build_manifest(base_starts)
    # 清单里的相对路径基于清单所在目录
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    # 整点版: 三个文件平移到 3600s 整点前后, 范围也平移
    hour = 3600 * RATE
    hour_starts = {
        "segA": hour - 4000,
        "segB": hour + 2000,
        "segC": hour + 14000,
    }
    hour_manifest = build_manifest(hour_starts)
    for spec in hour_manifest["ranges"]:
        shift = hour - 4000  # 与基础版保持相同的相对结构
        spec["start"] = {"frames": spec["start"]["frames"] + shift}
        spec["end"] = {"frames": spec["end"]["frames"] + shift}
    with open(os.path.join(out_dir, "manifest-hour.json"), "w", encoding="utf-8") as fh:
        json.dump(hour_manifest, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print(f"fixtures written to {out_dir}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: make_fixtures.py <output_dir>")
    main(sys.argv[1])
