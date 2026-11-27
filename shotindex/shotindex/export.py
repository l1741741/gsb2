"""导出：镜头区间（覆盖首尾）、代表画面缩略图、人工修改记录。"""

import csv
import json
import os

from . import media


def export(project, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    thumbs_dir = os.path.join(out_dir, "thumbs")
    os.makedirs(thumbs_dir, exist_ok=True)

    video = project.data["video"]
    duration = video["duration"]
    bounds = project.boundaries()

    # 由有效边界切出区间，首尾未切段也包含在内
    points = [0.0] + [b["time"] for b in bounds] + [duration]
    shots = []
    for i in range(len(points) - 1):
        start, end = points[i], points[i + 1]
        if end - start <= 0:
            continue
        shots.append({
            "index": len(shots) + 1,
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "end_boundary": bounds[i]["id"] if i < len(bounds) else "",
            "end_type": bounds[i]["type"] if i < len(bounds) else "",
        })

    # 代表画面：区间中点抽帧
    for shot in shots:
        mid = (shot["start"] + shot["end"]) / 2
        name = "shot_%04d.jpg" % shot["index"]
        media.grab_frame(video["path"], mid, os.path.join(thumbs_dir, name))
        shot["thumbnail"] = os.path.join("thumbs", name)

    with open(os.path.join(out_dir, "shots.json"), "w", encoding="utf-8") as f:
        json.dump({
            "video": video["path"],
            "duration": duration,
            "shot_count": len(shots),
            "shots": shots,
        }, f, ensure_ascii=False, indent=2)

    with open(os.path.join(out_dir, "shots.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["index", "start", "end", "duration", "end_boundary", "end_type", "thumbnail"])
        for s in shots:
            w.writerow([s["index"], "%.3f" % s["start"], "%.3f" % s["end"],
                        "%.3f" % s["duration"], s["end_boundary"], s["end_type"],
                        s["thumbnail"]])

    # 人工修改记录
    edits = project.human_edits()
    with open(os.path.join(out_dir, "edits.csv"), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["ts", "action", "record", "detail"])
        for a in edits:
            w.writerow([a["ts"], a["action"], a["record"] or "", a["detail"]])

    with open(os.path.join(out_dir, "audit.json"), "w", encoding="utf-8") as f:
        json.dump(project.data["audit"], f, ensure_ascii=False, indent=2)

    return shots, edits
