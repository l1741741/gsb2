"""命令行入口。

  python -m stitcher align A.png B.png [--rough DX,DY] [--radius N]
  python -m stitcher build CONFIG.json --out OUTDIR
  python -m stitcher init CONFIG.json --images a.png b.png ... [--rough x,y ...]
"""

import argparse
import json
import sys

from . import align
from .pngio import read_png
from .project import build


def _parse_xy(s):
    x, y = s.split(",")
    return (int(x), int(y))


def main(argv=None):
    ap = argparse.ArgumentParser(prog="stitcher",
                                 description="扫描件本地拼接工具")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_align = sub.add_parser("align", help="对齐一对图片并列出候选位移")
    p_align.add_argument("image_a")
    p_align.add_argument("image_b")
    p_align.add_argument("--rough", default="0,0",
                         help="b 相对 a 的粗略位移，格式 dx,dy（默认 0,0）")
    p_align.add_argument("--radius", type=int, default=12,
                         help="搜索半径（像素，默认 12）")

    p_build = sub.add_parser("build", help="按配置构建整片并输出诊断")
    p_build.add_argument("config")
    p_build.add_argument("--out", required=True, help="输出目录")

    p_init = sub.add_parser("init", help="生成初始配置文件")
    p_init.add_argument("config")
    p_init.add_argument("--images", nargs="+", required=True)
    p_init.add_argument("--rough", nargs="*", default=[],
                        help="每张图的粗略位置 x,y；缺省为 0,0")
    p_init.add_argument("--radius", type=int, default=12)

    args = ap.parse_args(argv)

    if args.cmd == "align":
        a = read_png(args.image_a)
        b = read_png(args.image_b)
        rough = _parse_xy(args.rough)
        groups = align.find_candidates(a, b, rough, args.radius)
        if not groups:
            print("未找到可行对齐（重叠不足或窗口内无解）")
            return 1
        for i, g in enumerate(groups):
            mark = ""
            if i > 0 and align.is_ambiguous(groups):
                mark = "  <- 与最优解得分接近（重复纹理多解，需人工选定）"
            print("候选 %d: offset (%d, %d)  得分 %.3f  采样 %d%s"
                  % (i, g["offset"][0], g["offset"][1], g["score"],
                     g["samples"], mark))
        if align.is_ambiguous(groups):
            print("存在多个相近解，工具不擅自采用；请人工核查后用 "
                  "\"chosen\" 写入配置。")
        return 0

    if args.cmd == "build":
        outputs = build(args.config, args.out)
        with open(args.out + "/seams.txt", encoding="utf-8") as f:
            sys.stdout.write(f.read())
        return 1 if outputs["problems"] else 0

    if args.cmd == "init":
        roughs = [_parse_xy(s) for s in args.rough]
        images = []
        for i, f in enumerate(args.images):
            r = roughs[i] if i < len(roughs) else (0, 0)
            images.append({"file": f, "rough": list(r)})
        cfg = {"images": images,
               "options": {"search_radius": args.radius, "checker": 16}}
        with open(args.config, "w", encoding="utf-8") as fp:
            json.dump(cfg, fp, ensure_ascii=False, indent=2)
        print("已写入 %s（edges 省略，构建时按 rough 自动生成）" % args.config)
        return 0


if __name__ == "__main__":
    sys.exit(main())
