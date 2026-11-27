"""人工配置加载与整片构建。

配置文件 (JSON) 示例:
{
  "images": [
    {"file": "a.png", "rough": [0, 0]},
    {"file": "b.png", "rough": [396, 3]}
  ],
  "edges": [
    {"a": 0, "b": 1},                      // 自动对齐
    {"a": 1, "b": 2, "chosen": [398, 1]},  // 多解时人工选定
    {"a": 0, "b": 2, "pinned": [12, 402]}  // 手工固定位移
  ],
  "options": {"search_radius": 12, "checker": 16}
}

- edges 省略时按 rough 位置自动生成所有重叠对。
- 同一份配置重复构建结果完全一致（无随机、无时间戳）。
- 位移约定: offset = pos_b - pos_a（b 左上角在 a 坐标系中的位置）。
"""

import json
import os

from . import align, compose, layout
from .pngio import Image, read_png, write_png

MIN_OVERLAP = 8  # 自动生成边时要求的最小重叠像素


def load_config(path):
    with open(path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not cfg.get("images"):
        raise ValueError("配置中缺少 images")
    return cfg


def auto_edges(images_meta):
    """按 rough 位置生成所有重叠对的边。"""
    edges = []
    n = len(images_meta)
    for i in range(n):
        for j in range(i + 1, n):
            xi, yi = images_meta[i]["rough"]
            xj, yj = images_meta[j]["rough"]
            wi, hi = images_meta[i]["size"]
            wj, hj = images_meta[j]["size"]
            ox = min(xi + wi, xj + wj) - max(xi, xj)
            oy = min(yi + hi, yj + hj) - max(yi, yj)
            if ox >= MIN_OVERLAP and oy >= MIN_OVERLAP:
                edges.append({"a": i, "b": j})
    return edges


def _seam_diagnostic(img_a, img_b, offset):
    """生成接缝对照小图: [A的重叠区 | B的重叠区 | 放大差异]。

    返回 (Image, rect_a, rect_b)；无重叠返回 (None, None, None)。
    """
    rect_a = align.overlap_rect(img_a.w, img_a.h, img_b.w, img_b.h, *offset)
    if rect_a is None:
        return None, None, None
    x0, y0, x1, y1 = rect_a
    w, h = x1 - x0, y1 - y0
    crop_a = img_a.crop(x0, y0, x1, y1)
    crop_b = img_b.crop(x0 - offset[0], y0 - offset[1],
                        x1 - offset[0], y1 - offset[1])
    gap = 4
    out = Image(w * 3 + gap * 2, h)
    op = out.pix
    for y in range(h):
        for x in range(w):
            ia = (y * w + x) * 4
            pa = crop_a.pix[ia:ia + 4]
            pb = crop_b.pix[ia:ia + 4]
            op[(y * out.w + x) * 4:(y * out.w + x) * 4 + 4] = pa
            op[(y * out.w + w + gap + x) * 4:(y * out.w + w + gap + x) * 4 + 4] = pb
            o = (y * out.w + 2 * (w + gap) - gap + x) * 4
            if pa[3] == 0 or pb[3] == 0:
                continue  # 任一侧透明: 差异图留透明
            for c in range(3):
                d = abs(pa[c] - pb[c]) * 4
                op[o + c] = 255 if d > 255 else d
            op[o + 3] = 255
    rect_b = (x0 - offset[0], y0 - offset[1], x1 - offset[0], y1 - offset[1])
    return out, rect_a, rect_b


def build(config_path, outdir):
    """按配置构建整片。返回报告 dict（同时写入 outdir）。"""
    cfg = load_config(config_path)
    base = os.path.dirname(os.path.abspath(config_path))
    opts = cfg.get("options", {})
    radius = int(opts.get("search_radius", 12))
    checker = int(opts.get("checker", 16))

    images = []
    meta = []
    for entry in cfg["images"]:
        img = read_png(os.path.join(base, entry["file"]))
        images.append(img)
        meta.append({"file": entry["file"],
                     "rough": list(entry.get("rough", [0, 0])),
                     "size": [img.w, img.h]})
    n = len(images)

    edges_cfg = cfg.get("edges") or auto_edges(meta)

    # ---- 逐条边确定位移 ----
    resolved_edges = {}   # (a,b) -> (dx,dy) 可用于布局
    seam_reports = []
    problems = []
    for e in edges_cfg:
        a, b = e["a"], e["b"]
        rep = {"a": a, "b": b,
               "file_a": meta[a]["file"], "file_b": meta[b]["file"]}
        if "pinned" in e:
            off = tuple(int(v) for v in e["pinned"])
            resolved_edges[(a, b)] = off
            rep.update(status="pinned", offset=list(off))
            r = align._score(images[a], images[b], off[0], off[1], 1)
            if r:
                rep["score"], rep["samples"] = round(r[0], 3), r[1]
        elif "chosen" in e:
            off = tuple(int(v) for v in e["chosen"])
            resolved_edges[(a, b)] = off
            rep.update(status="chosen", offset=list(off))
            r = align._score(images[a], images[b], off[0], off[1], 1)
            if r:
                rep["score"], rep["samples"] = round(r[0], 3), r[1]
        else:
            rough = (meta[b]["rough"][0] - meta[a]["rough"][0],
                     meta[b]["rough"][1] - meta[a]["rough"][1])
            groups = align.find_candidates(images[a], images[b], rough, radius)
            rep["candidates"] = [
                {"offset": list(g["offset"]), "score": round(g["score"], 3),
                 "samples": g["samples"]} for g in groups]
            if not groups:
                rep["status"] = "failed"
                problems.append("边 %d-%d 对齐失败（重叠不足或窗口内无解）" % (a, b))
            elif align.is_ambiguous(groups):
                rep["status"] = "ambiguous"
                problems.append(
                    "边 %d-%d 有 %d 个相近对齐解（重复纹理），请在配置中用 "
                    "\"chosen\" 选定后再构建" % (a, b, len(groups)))
            else:
                off = groups[0]["offset"]
                resolved_edges[(a, b)] = off
                rep.update(status="auto", offset=list(off),
                           score=round(groups[0]["score"], 3),
                           samples=groups[0]["samples"])
        seam_reports.append(rep)

    # ---- 全局布局与闭环矛盾 ----
    positions, residuals, unreachable = layout.compute_layout(n, resolved_edges)
    for i in unreachable:
        problems.append("图片 %d (%s) 无法通过已确定的边连通"
                        % (i, meta[i]["file"]))
    for rep in seam_reports:
        key = (rep["a"], rep["b"])
        if key in residuals:
            rx, ry = residuals[key]
            rep["loop_residual"] = [rx, ry]
            if (rx, ry) != (0, 0):
                problems.append(
                    "接缝 %d-%d 闭环矛盾 (%+d,%+d) px：沿其他接缝累积的位置"
                    "与该缝测量值不一致，相关接缝可能需要重扫"
                    % (rep["a"], rep["b"], rx, ry))

    os.makedirs(outdir, exist_ok=True)
    seams_dir = os.path.join(outdir, "seams")
    os.makedirs(seams_dir, exist_ok=True)

    # ---- 接缝诊断图（带原图坐标） ----
    for rep in seam_reports:
        key = (rep["a"], rep["b"])
        if key not in resolved_edges:
            continue
        off = resolved_edges[key]
        diag, rect_a, rect_b = _seam_diagnostic(
            images[rep["a"]], images[rep["b"]], off)
        if diag is None:
            rep["overlap"] = None
            continue
        name = "seam_%02d_%02d.png" % key
        write_png(os.path.join(seams_dir, name), diag)
        rep["overlap"] = {
            "in_%s" % rep["file_a"]: list(rect_a),
            "in_%s" % rep["file_b"]: list(rect_b),
        }
        rep["diagnostic"] = "seams/" + name

    # ---- 成片与坐标 ----
    outputs = {"problems": problems, "seams": seam_reports}
    if not unreachable and not any(r["status"] in ("failed", "ambiguous")
                                   for r in seam_reports):
        blend, compare, (minx, miny, W, H) = compose.compose(
            images, positions, checker)
        write_png(os.path.join(outdir, "composite_blend.png"), blend)
        write_png(os.path.join(outdir, "composite_compare.png"), compare)
        coords = []
        for i, m in enumerate(meta):
            coords.append({"file": m["file"],
                           "x": positions[i][0] - minx,
                           "y": positions[i][1] - miny,
                           "w": m["size"][0], "h": m["size"][1]})
        canvas = {"width": W, "height": H, "images": coords}
        with open(os.path.join(outdir, "coords.json"), "w",
                  encoding="utf-8") as f:
            json.dump(canvas, f, ensure_ascii=False, indent=2)
        outputs["canvas"] = canvas
    else:
        problems.append("存在未解决的接缝，未生成成片（先解决上述问题）")

    # ---- 报告与解析后配置 ----
    with open(os.path.join(outdir, "seams.json"), "w", encoding="utf-8") as f:
        json.dump({"seams": seam_reports, "problems": problems},
                  f, ensure_ascii=False, indent=2)
    with open(os.path.join(outdir, "seams.txt"), "w", encoding="utf-8") as f:
        f.write(_format_report(seam_reports, problems))

    resolved_cfg = {
        "images": [{"file": m["file"], "rough": m["rough"]} for m in meta],
        "edges": [],
        "options": {"search_radius": radius, "checker": checker},
    }
    for rep in seam_reports:
        e = {"a": rep["a"], "b": rep["b"]}
        if "offset" in rep:
            e["chosen" if rep["status"] != "pinned" else "pinned"] = rep["offset"]
        resolved_cfg["edges"].append(e)
    with open(os.path.join(outdir, "stitch.resolved.json"), "w",
              encoding="utf-8") as f:
        json.dump(resolved_cfg, f, ensure_ascii=False, indent=2)

    return outputs


def _format_report(seam_reports, problems):
    lines = ["接缝诊断报告", "=" * 60]
    for rep in seam_reports:
        lines.append("")
        lines.append("接缝 %d-%d: %s <-> %s  [%s]"
                     % (rep["a"], rep["b"], rep["file_a"], rep["file_b"],
                        rep["status"]))
        if "offset" in rep:
            lines.append("  位移 pos_b-pos_a = (%d, %d)"
                         % tuple(rep["offset"]))
        if "score" in rep:
            lines.append("  重叠区平均色差 %.2f（%d 个采样像素）"
                         % (rep["score"], rep.get("samples", 0)))
        if rep.get("candidates"):
            lines.append("  候选位移（不擅自采用，请人工选定）:")
            for c in rep["candidates"]:
                lines.append("    offset (%d, %d)  得分 %.2f"
                             % (c["offset"][0], c["offset"][1], c["score"]))
        if rep.get("overlap"):
            for k, rect in rep["overlap"].items():
                lines.append("  重叠区在原图 %s 中的位置: x %d..%d, y %d..%d"
                             % (k, rect[0], rect[2], rect[1], rect[3]))
        if "loop_residual" in rep:
            rx, ry = rep["loop_residual"]
            lines.append("  闭环残差: (%+d, %+d) px%s"
                         % (rx, ry, "  <-- 矛盾，建议检查/重扫"
                            if (rx, ry) != (0, 0) else ""))
        if rep.get("diagnostic"):
            lines.append("  对照图: %s（左: A重叠区 中: B重叠区 右: 差异×4）"
                         % rep["diagnostic"])
    if problems:
        lines.append("")
        lines.append("待处理问题")
        lines.append("-" * 60)
        for p in problems:
            lines.append("  * " + p)
    return "\n".join(lines) + "\n"
