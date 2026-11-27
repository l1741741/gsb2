#!/usr/bin/env python3
"""端到端演示：生成样例 -> 构建 -> 诊断 -> 人工干预 -> 重建。

在 stitcher/ 目录下运行:  python3 demo.py
输出目录:                  samples/out/
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from samples import make_samples          # noqa: E402
from stitcher.project import build        # noqa: E402

ROOT = os.path.dirname(os.path.abspath(__file__))
S = os.path.join(ROOT, "samples")
OUT = os.path.join(S, "out")


def show(path):
    with open(path, encoding="utf-8") as f:
        print(f.read())


def case_normal():
    print("=" * 64)
    print("样例 1: 普通纹理，三块闭环")
    print("=" * 64)
    out = build(os.path.join(S, "normal", "stitch.json"),
                os.path.join(OUT, "normal"))
    show(os.path.join(OUT, "normal", "seams.txt"))
    assert not out["problems"], "普通样例不应有问题"
    coords = {c["file"]: (c["x"], c["y"]) for c in out["canvas"]["images"]}
    # 真实相对位置: B-A=(220,0) C-A=(110,200)
    dx = coords["tile_b.png"][0] - coords["tile_a.png"][0]
    dy = coords["tile_b.png"][1] - coords["tile_a.png"][1]
    assert (dx, dy) == (220, 0), (dx, dy)
    dx = coords["tile_c.png"][0] - coords["tile_a.png"][0]
    dy = coords["tile_c.png"][1] - coords["tile_a.png"][1]
    assert (dx, dy) == (110, 200), (dx, dy)
    print(">> 闭环残差全为 0，坐标与真实裁剪位置一致")

    # 同一份配置重复构建 -> 结果一致
    out2 = build(os.path.join(S, "normal", "stitch.json"),
                 os.path.join(OUT, "normal_again"))
    for name in ("coords.json", "seams.json"):
        with open(os.path.join(OUT, "normal", name), "rb") as f:
            b1 = f.read()
        with open(os.path.join(OUT, "normal_again", name), "rb") as f:
            b2 = f.read()
        assert b1 == b2, "%s 两次构建不一致" % name
    print(">> 同一配置重复构建，coords.json / seams.json 完全一致")


def case_repeat():
    print("=" * 64)
    print("样例 2: 重复纹理，多对齐解")
    print("=" * 64)
    out = build(os.path.join(S, "repeat", "stitch.json"),
                os.path.join(OUT, "repeat"))
    show(os.path.join(OUT, "repeat", "seams.txt"))
    assert any("重复纹理" in p for p in out["problems"])
    assert not os.path.exists(os.path.join(OUT, "repeat", "coords.json")), \
        "存在歧义时不应生成成片"
    print(">> 工具列出候选但未擅自采用，也未生成成片")

    # 人工核查原图后选定真实位移 (250, 0)，写入配置重建
    with open(os.path.join(S, "repeat", "stitch.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["edges"] = [{"a": 0, "b": 1, "chosen": [250, 0]}]
    chosen = os.path.join(S, "repeat", "stitch.chosen.json")
    with open(chosen, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    out = build(chosen, os.path.join(OUT, "repeat_chosen"))
    assert not out["problems"]
    coords = {c["file"]: (c["x"], c["y"]) for c in out["canvas"]["images"]}
    dx = coords["tile_b.png"][0] - coords["tile_a.png"][0]
    assert dx == 250, dx
    print(">> 人工选定 chosen=[250,0] 后重建成功，B 位于 x=%d" % dx)


def case_conflict():
    print("=" * 64)
    print("样例 3: 闭环矛盾（C 块扫描纵向错位 2px）")
    print("=" * 64)
    out = build(os.path.join(S, "conflict", "stitch.json"),
                os.path.join(OUT, "conflict"))
    show(os.path.join(OUT, "conflict", "seams.txt"))
    assert any("闭环矛盾" in p for p in out["problems"])

    # 从诊断回查原图局部：打印每条接缝重叠区在各原图中的坐标
    with open(os.path.join(OUT, "conflict", "seams.json"),
              encoding="utf-8") as f:
        seams = json.load(f)["seams"]
    print(">> 从诊断回查原图局部：")
    for rep in seams:
        if not rep.get("overlap"):
            continue
        for key, rect in rep["overlap"].items():
            print("   接缝 %d-%d: 打开 %s 查看 x %d..%d, y %d..%d"
                  "（对照图 %s）"
                  % (rep["a"], rep["b"], key, rect[0], rect[2], rect[1],
                     rect[3], rep.get("diagnostic", "-")))

    # 固定一条手工位移后重算：把 A-C 缝按测量值固定，残差转移到其他缝
    measured = next(rep["offset"] for rep in seams
                    if (rep["a"], rep["b"]) == (0, 2))
    with open(os.path.join(S, "conflict", "stitch.json"),
              encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["edges"] = [{"a": 0, "b": 1},
                    {"a": 0, "b": 2, "pinned": measured},
                    {"a": 1, "b": 2}]
    pinned = os.path.join(S, "conflict", "stitch.pinned.json")
    with open(pinned, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print(">> 固定接缝 0-2 为手工位移 %s 后重新计算：" % measured)
    out2 = build(pinned, os.path.join(OUT, "conflict_pinned"))
    show(os.path.join(OUT, "conflict_pinned", "seams.txt"))
    assert any("闭环矛盾" in p for p in out2["problems"])
    print(">> 矛盾随固定方式重新分配，操作员据此判断哪条缝需要重扫")


def main():
    make_samples.main()
    case_normal()
    case_repeat()
    case_conflict()
    print("=" * 64)
    print("全部演示完成，产物见 %s/" % OUT)


if __name__ == "__main__":
    main()
