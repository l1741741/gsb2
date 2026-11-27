"""Report generation: an offline HTML contact sheet and a Markdown summary.

The HTML report is self-contained and works from a local folder with no server
and no network: images are linked by relative path so the originals stay
accessible exactly where they are.  Each candidate pair gets a side-by-side
preview, the reasons it was proposed, and the archive advice.
"""

from __future__ import annotations

import html
import os

from .pipeline import Photo, PairEvidence, find_chains, group_candidates

RELATION_LABELS = {
    "identical": "完全相同",
    "same-image": "同一张图（重新压缩/另存）",
    "resized": "缩放副本",
    "cropped": "裁剪副本",
    "cropped-heavily": "大幅裁剪副本（保留部分画面）",
    "recoloured": "调色副本",
    "look-alike": "相似但可能不是同一张（需人工判断）",
    "weak": "关联较弱",
    "candidate": "候选",
}

RELATION_ADVICE = {
    "identical": "建议保留其中一份，其余归档为重复项。",
    "same-image": "建议合并归档，保留像素更多的版本。",
    "resized": "建议合并，保留分辨率更高的版本。",
    "cropped": "建议合并，但确认裁剪是否丢失了重要内容。",
    "cropped-heavily": "画面差异较大：若不需完整构图可合并，否则分别保留。",
    "recoloured": "同一张图的不同调色：按用途决定保留哪一版。",
    "look-alike": "不建议自动合并；请人工核对是否为同一张照片。",
    "weak": "不建议合并。",
}


def _rel_link(from_file: str, to_file: str) -> str:
    return html.escape(os.path.relpath(to_file.replace("/", os.sep),
                                       os.path.dirname(from_file) or "."))


def _make_thumb(img_path: str, thumbs_dir: str, cache: dict[str, str]) -> str:
    """Render (once) a small thumbnail next to the report and return its
    relative link.  Thumbnails are written to disk rather than inlined, so the
    contact sheet stays small while remaining fully offline."""
    key = os.path.abspath(img_path)
    if key in cache:
        return cache[key]
    try:
        from .analysis import resize_rgb
        from .imaging import load_image
        img = load_image(img_path, external_tools=False)
        scale = min(1.0, 200 / max(1, img.width))
        small = resize_rgb(img.to_rgb(), max(1, int(img.width * scale)),
                           max(1, int(img.height * scale)))
        os.makedirs(thumbs_dir, exist_ok=True)
        name = _thumb_name(img_path)
        out = os.path.join(thumbs_dir, name)
        with open(out, "wb") as fh:
            _write_png(small, fh)
        rel = os.path.relpath(out, os.path.dirname(thumbs_dir))
        cache[key] = rel
        return rel
    except Exception:  # noqa: BLE001 - thumbnails are best effort
        cache[key] = ""
        return ""


def _thumb_name(path: str) -> str:
    import hashlib
    digest = hashlib.sha1(os.path.abspath(path).encode("utf-8")).hexdigest()[:12]
    base = os.path.splitext(os.path.basename(path))[0]
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in base)[:40]
    return f"{safe}-{digest}.png"


def _write_png(img, fh) -> None:
    import struct
    import zlib
    width, height = img.width, img.height
    raw = bytearray()
    px = img.pixels
    for y in range(height):
        raw.append(0)
        base = y * width * 3
        raw += px[base:base + width * 3]

    def chunk(tag, body):
        return (struct.pack(">I", len(body)) + tag + body
                + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF))

    fh.write(b"\x89PNG\r\n\x1a\n"
             + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
             + chunk(b"IDAT", zlib.compress(bytes(raw), 6))
             + chunk(b"IEND", b""))


def _esc(text: str) -> str:
    return html.escape(text, quote=True)


def displayable_pairs(pairs: list[PairEvidence]) -> list[PairEvidence]:
    """Pairs worth putting in front of a person.

    Pairs judged "weak" are unrelated noise; keep them in the JSON for audit but
    keep the contact sheet focused on real candidates.
    """
    return [p for p in pairs if p.relation != "weak"]


def render_html(root: str, photos: list[Photo], pairs: list[PairEvidence],
                chains: list[dict], notices: list[dict],
                decisions: dict[tuple[str, str], str], out_path: str,
                *, report_dir: str | None = None) -> None:
    report_dir = report_dir or os.path.dirname(os.path.abspath(out_path))
    by_rel = {p.relpath: p for p in photos}
    groups = group_candidates(pairs)
    pairs = displayable_pairs(pairs)
    thumbs_dir = os.path.join(report_dir, "thumbs")
    thumb_cache: dict[str, str] = {}
    # Clear stale thumbnails from a previous run so the folder matches the report.
    if os.path.isdir(thumbs_dir):
        for name in os.listdir(thumbs_dir):
            if name.endswith(".png"):
                try:
                    os.remove(os.path.join(thumbs_dir, name))
                except OSError:
                    pass

    sections: list[str] = []
    sections.append("<!DOCTYPE html><html lang=\"zh-CN\"><head>"
                    "<meta charset=\"utf-8\">"
                    "<title>照片目录候选整理</title>")
    sections.append("""<style>
body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
 margin:0;background:#f4f4f6;color:#222}
header{background:#1f2733;color:#fff;padding:20px 28px}
header h1{margin:0 0 4px;font-size:22px;font-weight:600}
header p{margin:0;opacity:.8;font-size:13px}
main{padding:20px 28px;max-width:1180px;margin:0 auto}
h2{font-size:18px;margin:32px 0 10px;border-bottom:2px solid #d7dbe2;padding-bottom:6px}
.panel{background:#fff;border:1px solid #e2e5ea;border-radius:8px;padding:16px 18px;margin:10px 0}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.pair .side{border:1px solid #e6e8ec;border-radius:6px;overflow:hidden;background:#fafbfc}
.pair .side img{display:block;width:100%;height:auto;background:#fff}
.pair .side .meta{padding:8px 10px;font-size:12px;color:#555;word-break:break-all}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:10px;
 background:#e8eefb;color:#274a92;margin-left:6px}
.tag.warn{background:#fdeaea;color:#a12d2d}
.badge{display:inline-block;font-weight:600;padding:2px 9px;border-radius:6px;font-size:13px}
.badge.copy{background:#dff3e4;color:#1f6b37}
.badge.review{background:#fdf1d8;color:#8a5a05}
.badge.weak{background:#eceef2;color:#59606b}
ul.reasons{margin:8px 0 0;padding-left:20px;font-size:13px;color:#444}
ul.reasons li{margin:1px 0}
.advice{margin-top:8px;padding:8px 10px;background:#f2f7f4;border-left:3px solid #47a86a;font-size:13px}
.advice.review{background:#fdf6e7;border-color:#e0a93b}
.advice.weak{background:#f4f5f7;border-color:#aab;color:#555}
table{border-collapse:collapse;width:100%;font-size:13px;background:#fff}
th,td{border:1px solid #e4e7ec;padding:6px 9px;text-align:left;vertical-align:top}
th{background:#f0f2f6;font-weight:600}
code{background:#eef0f3;padding:1px 5px;border-radius:3px;font-size:12px;word-break:break-all}
.group{margin:8px 0;padding:10px 12px;border:1px solid #dfe3ea;border-radius:6px;background:#fbfcfe}
.group.incomplete{border-color:#e6c26a;background:#fffaf0}
.small{font-size:12px;color:#777}
.err{color:#a12d2d}
footer{padding:24px 28px;color:#888;font-size:12px}
</style></head><body>""")

    ok_count = sum(1 for p in photos if p.ok)
    err_count = len(photos) - ok_count
    sections.append("<header><h1>照片目录候选整理</h1>"
                    f"<p>扫描目录 <code>{_esc(root)}</code> · "
                    f"{len(photos)} 个文件，可分析 {ok_count}，读取失败 {err_count} · "
                    f"{len(pairs)} 组候选对比 · 本报告为离线静态文件</p></header><main>")

    # Problem files first — they are the ones that need action.
    errors = [p for p in photos if not p.ok]
    if errors:
        sections.append("<h2>读取失败的文件</h2>"
                        "<div class=\"panel\"><p class=\"small\">这些文件已跳过，"
                        "不影响其余扫描。请检查路径或格式后重新扫描。</p>"
                        "<table><tr><th>路径</th><th>原因</th></tr>")
        for p in errors:
            sections.append(f"<tr><td><code>{_esc(p.relpath)}</code></td>"
                            f"<td class=\"err\">{_esc(p.error or '未知错误')}</td></tr>")
        sections.append("</table></div>")

    if notices:
        sections.append("<h2>需要重新审核</h2><div class=\"panel\"><table>"
                        "<tr><th>路径</th><th>情况</th></tr>")
        for n in notices:
            sections.append(f"<tr><td><code>{_esc(n['path'])}</code></td>"
                            f"<td>{_esc(n['reason'])}</td></tr>")
        sections.append("</table></div>")

    # Proposed groups.
    sections.append("<h2>建议合并的分组</h2>"
                    "<div class=\"panel\"><p class=\"small\">以下分组在组内两两都被"
                    "判为同一张照片，可考虑合并归档；仍请逐组确认。"
                    "\"不完整\"的分组表示组内存在一对并未被判为同一张，"
                    "因此没有把整组视为可直接合并。</p>")
    if not groups:
        sections.append("<p class=\"small\">没有发现可安全合并的分组。</p>")
    for gi, g in enumerate(groups, 1):
        cls = "group" if g["complete"] else "group incomplete"
        sections.append(f"<div class=\"{cls}\"><b>分组 {gi}</b> "
                        f"{'' if g['complete'] else '<span class=\"tag warn\">不完整</span>'}"
                        "<ul>")
        for member in g["members"]:
            photo = by_rel.get(member)
            dims = f"{photo.width}×{photo.height}" if photo else ""
            sections.append(f"<li><code>{_esc(member)}</code> "
                            f"<span class=\"small\">{dims}</span></li>")
        sections.append("</ul>")
        if not g["complete"]:
            sections.append("<p class=\"small\">其中这些配对未被判为同一张，"
                            "未并入该组：</p><ul class=\"reasons\">")
            for fp in g["failed_pairs"]:
                sections.append(f"<li>{_esc(fp['a'])} ↔ {_esc(fp['b'])}："
                                f"{_esc(RELATION_LABELS.get(fp['relation'], fp['relation']))}"
                                f"（置信 {fp['confidence']:.2f}）</li>")
            sections.append("</ul>")
        sections.append("</div>")

    # Chains.
    if chains:
        sections.append("<h2>链式关系（不应默认合并）</h2><div class=\"panel\">"
                        "<p class=\"small\">中介照片同时像两端，但两端彼此差异明显。"
                        "这类关系最容易在自动合并时出错，因此单独列出，请逐对判断。</p>")
        for chain in chains:
            sections.append(f"<div class=\"group incomplete\"><p>{_esc(chain['explanation'])}</p>")
            sections.append(_render_pair_preview(chain["left_link"], by_rel, root,
                                                 report_dir, out_path, thumb_cache,
                                                 thumbs_dir))
            sections.append(_render_pair_preview(chain["right_link"], by_rel, root,
                                                 report_dir, out_path, thumb_cache,
                                                 thumbs_dir))
            sections.append("</div>")
        sections.append("</div>")

    # All candidate pairs, sorted by confidence.
    sections.append("<h2>候选对照</h2>"
                    "<p class=\"small\">按置信度从高到低。绿色为建议合并，"
                    "黄色为需人工判断，灰色为不建议合并。"
                    "每对都给出相似原因与并排预览。</p>")
    if not pairs:
        sections.append("<div class=\"panel\"><p class=\"small\">未发现候选配对。</p></div>")
    ordered = sorted(pairs, key=lambda p: (-p.merge_fit, -p.same_photo, p.a))
    for pair in ordered:
        sections.append(_render_pair_preview(pair, by_rel, root, report_dir, out_path,
                                             thumb_cache, thumbs_dir,
                                             decisions=decisions))

    sections.append("</main><footer>"
                    "由 photo-catalog 生成。原图保持原路径可访问；"
                    "本报告不修改任何文件。</footer></body></html>")

    os.makedirs(report_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(sections))


def _badge_for(pair: PairEvidence) -> tuple[str, str]:
    if pair.merge_fit >= 0.80:
        return "copy", "建议合并"
    if pair.same_photo >= 0.5 or pair.relation == "look-alike":
        return "review", "需人工判断"
    return "weak", "不建议合并"


def _render_pair_preview(pair: PairEvidence, by_rel: dict[str, Photo], root: str,
                         report_dir: str, report_path: str,
                         thumb_cache: dict[str, str], thumbs_dir: str,
                         decisions: dict[tuple[str, str], str] | None = None) -> str:
    badge_cls, badge_text = _badge_for(pair)
    label = RELATION_LABELS.get(pair.relation, pair.relation)
    advice = RELATION_ADVICE.get(pair.relation, "")
    advice_cls = ("copy" if badge_cls == "copy"
                  else "review" if badge_cls == "review" else "weak")
    decision_text = ""
    if decisions:
        key = tuple(sorted((pair.a, pair.b)))
        if key in decisions:
            decision_text = (f"<span class=\"tag\">已记录："
                             f"{'合并' if decisions[key] == 'merge' else '排除'}</span>")

    sides = []
    for rel in (pair.a, pair.b):
        photo = by_rel.get(rel)
        thumb = _make_thumb(photo.path, thumbs_dir, thumb_cache) if photo and photo.path else ""
        dims = f"{photo.width}×{photo.height}" if photo else "?"
        title = os.path.basename(rel)
        link = os.path.relpath(photo.path if photo else rel,
                               report_dir) if report_dir else rel
        sides.append(
            f"<div class=\"side\"><img src=\"{thumb}\" alt=\"{_esc(title)}\">"
            f"<div class=\"meta\"><a href=\"{_esc(link)}\">{_esc(rel)}</a><br>"
            f"{dims}</div></div>")

    reason_items = "".join(f"<li>{_esc(r)}</li>" for r in pair.reasons)
    warning_items = "".join(
        f"<li class=\"err\">{_esc(w)}</li>" for w in pair.warnings)
    crop_note = ""
    if pair.crop and pair.crop != (0.0, 0.0, 1.0, 1.0):
        x0, y0, x1, y1 = pair.crop
        crop_note = (f"<span class=\"tag\">对应区域：x {x0:.0%}–{x1:.0%}，"
                     f"y {y0:.0%}–{y1:.0%}</span>")

    return (
        "<div class=\"panel\">"
        f"<p><span class=\"badge {badge_cls}\">{badge_text}</span> "
        f"<b>{_esc(label)}</b> "
        f"<span class=\"small\">置信 {pair.same_photo:.2f} · 可合并度 "
        f"{pair.merge_fit:.2f}</span>{decision_text}{crop_note}</p>"
        f"<div class=\"pair\">{''.join(sides)}</div>"
        f"<ul class=\"reasons\">{reason_items}{warning_items}</ul>"
        f"<div class=\"advice {advice_cls}\">{_esc(advice)}</div>"
        "</div>"
    )


def render_markdown(root: str, photos: list[Photo], pairs: list[PairEvidence],
                    chains: list[dict], notices: list[dict],
                    decisions: dict[tuple[str, str], str], out_path: str) -> None:
    groups = group_candidates(pairs)
    pairs = displayable_pairs(pairs)
    ok_count = sum(1 for p in photos if p.ok)
    lines = ["# 照片目录候选整理报告", ""]
    lines.append(f"- 扫描目录：`{root}`")
    lines.append(f"- 文件数：{len(photos)}（可分析 {ok_count}，读取失败 "
                 f"{len(photos) - ok_count}）")
    lines.append(f"- 候选配对：{len(pairs)}")
    lines.append(f"- 建议合并分组：{len(groups)}")
    lines.append(f"- 链式关系：{len(chains)}")
    lines.append("")

    errors = [p for p in photos if not p.ok]
    if errors:
        lines.append("## 读取失败的文件")
        lines.append("")
        lines.append("| 路径 | 原因 |")
        lines.append("| --- | --- |")
        for p in errors:
            lines.append(f"| `{p.relpath}` | {p.error} |")
        lines.append("")

    if notices:
        lines.append("## 需要重新审核")
        lines.append("")
        lines.append("| 路径 | 情况 |")
        lines.append("| --- | --- |")
        for n in notices:
            lines.append(f"| `{n['path']}` | {n['reason']} |")
        lines.append("")

    lines.append("## 建议合并的分组")
    lines.append("")
    if not groups:
        lines.append("没有发现可安全合并的分组。")
    for gi, g in enumerate(groups, 1):
        status = "完整" if g["complete"] else "不完整（组内存在未确认的配对）"
        lines.append(f"### 分组 {gi}（{status}）")
        lines.append("")
        for member in g["members"]:
            lines.append(f"- `{member}`")
        if not g["complete"]:
            lines.append("")
            lines.append("未并入该组的配对：")
            for fp in g["failed_pairs"]:
                relation = RELATION_LABELS.get(fp["relation"], fp["relation"])
                lines.append(f"- {fp['a']} ↔ {fp['b']}：{relation}"
                             f"（置信 {fp['confidence']:.2f}）")
        lines.append("")

    if chains:
        lines.append("## 链式关系（不应默认合并）")
        lines.append("")
        for chain in chains:
            lines.append(f"- {chain['explanation']}")
        lines.append("")

    lines.append("## 候选对照")
    lines.append("")
    lines.append("| A | B | 关系 | 同图置信 | 可合并度 | 对应区域 |")
    lines.append("| --- | --- | --- | --- | --- | --- |")
    ordered = sorted(pairs, key=lambda p: (-p.merge_fit, -p.same_photo, p.a))
    for pair in ordered:
        crop = ""
        if pair.crop and pair.crop != (0.0, 0.0, 1.0, 1.0):
            x0, y0, x1, y1 = pair.crop
            crop = f"x {x0:.0%}–{x1:.0%}, y {y0:.0%}–{y1:.0%}"
        relation = RELATION_LABELS.get(pair.relation, pair.relation)
        lines.append(f"| `{pair.a}` | `{pair.b}` | {relation} | "
                     f"{pair.same_photo:.2f} | {pair.merge_fit:.2f} | {crop} |")
    lines.append("")

    lines.append("## 说明")
    lines.append("")
    lines.append("本工具只提出候选，不自动合并任何文件；原图保持原路径可访问。"
                 "相似度不具有传递性：A、B 相似且 B、C 相似，并不代表 A、C 可合并，"
                 "报告中单列此类链式关系。")
    lines.append("")

    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
