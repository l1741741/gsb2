"""把批次报告渲染成 Markdown 与自包含导航的 HTML（图片用相对路径引用）。"""

from __future__ import annotations

import html
from typing import Dict


def render_markdown(batch: Dict) -> str:
    s = batch["summary"]
    lines = []
    lines.append("# 背景换色批处理报告")
    lines.append("")
    lines.append("- 生成时间: %s" % batch.get("generated_at"))
    lines.append("- 工具版本: %s（numpy 加速: %s）" % (
        batch.get("version"),
        "开" if batch.get("engine", {}).get("numpy_accelerated") else "关/不可用"))
    if batch.get("config_path"):
        lines.append("- 配置: `%s`" % batch["config_path"])
    lines.append("- 输出目录: `%s`" % batch["output_dir"])
    lines.append("")
    lines.append("## 批次摘要")
    lines.append("")
    lines.append("| 总数 | 成功 | 隔离/失败 | 实际变化像素合计 | 断开同色域合计 |")
    lines.append("|---:|---:|---:|---:|---:|")
    lines.append("| %d | %d | %d | %d | %d |" % (
        s["total"], s["ok"], s["error"],
        s["changed_pixels_total"], s["disconnected_components_total"]))
    lines.append("")

    for it in batch["items"]:
        lines.append("---")
        lines.append("")
        if it.get("status") != "ok":
            err = it.get("error", {})
            lines.append("## ❌ `%s` —— 已隔离（%s）" % (it["id"], err.get("reason_cn", "失败")))
            lines.append("")
            lines.append("- 源文件: `%s`" % it.get("source"))
            lines.append("- 原因代码: `%s`" % err.get("reason_code"))
            lines.append("- 详细信息: %s" % err.get("message"))
            if it.get("quarantined_source"):
                lines.append("- 源文件已隔离到: `%s`" % it["quarantined_source"])
            if it.get("error_record"):
                lines.append("- 错误记录: `%s`" % it["error_record"])
            lines.append("- 已有的合法产物保持不变，不会被覆写成坏文件。")
            lines.append("")
            continue

        c = it["counts"]
        lines.append("## ✅ `%s`" % it["id"])
        lines.append("")
        lines.append("- 源文件: `%s`（%dx%d）" % (
            it.get("source"), it["image"]["width"], it["image"]["height"]))
        lines.append("- 背景取色: `%s` → 新背景: `%s`；连通: `%s`/%d 邻接；"
                     "容差 %s，过渡 %s，metric `%s`" % (
                         it["background_color"], it["target_color"],
                         it["params"]["connectivity"], it["params"]["neighborhood"],
                         it["params"]["tolerance"], it["params"]["feather"],
                         it["params"]["metric"]))
        for info in it.get("sample_infos", []):
            lines.append("  - 取色点 %s 邻域采用 %d 像素，颜色 `%s`" % (
                info["point"], info["patch_pixels_used"], info["sampled_color"]))
        for w in it.get("warnings", []):
            lines.append("- ⚠️ %s" % w)
        lines.append("")
        lines.append("| 总像素 | 完全透明(不计外观统计) | 半透明 | 不透明 | 实际变化像素 | 其中半透明边缘 | 受保护相似像素 | 断开同色像素 |")
        lines.append("|---:|---:|---:|---:|---:|---:|---:|---:|")
        lines.append("| %d | %d | %d | %d | %d | %d | %d | %d |" % (
            c["total_pixels"], c["fully_transparent_pixels"],
            c["semitransparent_pixels"], c["opaque_pixels"],
            c["changed_pixels_exact"], c["changed_semitransparent_pixels"],
            c["protected_similar_pixels"], c["disconnected_similar_pixels"]))
        lines.append("")
        el, ed = it["edge_shift_on_light"], it["edge_shift_on_dark"]
        lines.append("- 半透明背景近似边缘带 %d 像素；合成色平均偏移：浅底 %.2f / 深底 %.2f"
                     "（最大 %.1f / %.1f）" % (
                         el["edge_band_pixels"],
                         el["edge_mean_shift"], ed["edge_mean_shift"],
                         el["edge_max_shift"], ed["edge_max_shift"]))
        lines.append("- 可见像素平均 RGB（不含完全透明）：%s → %s" % (
            c["mean_rgb_visible_before"], c["mean_rgb_visible_after"]))
        lines.append("- 连通域：共 %d 个相似域，选中 %d，断开记录 %d 个" % (
            c["similar_component_count"], c["selected_component_count"],
            c["disconnected_component_count"]))
        if it.get("disconnected_components"):
            lines.append("")
            lines.append("  断开的相似色区域（单独记录，未修改）：")
            lines.append("")
            lines.append("  | # | 面积 | bbox [x0,y0,x1,y1) | 质心 | 触边 | 含种子 |")
            lines.append("  |---:|---:|---|---|:--:|:--:|")
            for comp in it["disconnected_components"][:20]:
                lines.append("  | %d | %d | %s | %s | %s | %s |" % (
                    comp["id"], comp["area"], comp["bbox_xyxy"], comp["centroid"],
                    "是" if comp["touches_edge"] else "否",
                    "是" if comp["contains_seed"] else "否"))
            if len(it["disconnected_components"]) > 20:
                lines.append("")
                lines.append("  …其余 %d 个见 report.json" % (
                    len(it["disconnected_components"]) - 20))
        o = it["outputs"]
        lines.append("")
        lines.append("**产物**：[新 PNG](%s) ｜ [变化区域图](%s) ｜ "
                     "[浅底预览](%s) ｜ [深底预览](%s) ｜ [2×2 对比](%s) ｜ [逐图 JSON](%s)" % (
                         o["new_png"], o["change_map"], o["preview_light"],
                         o["preview_dark"], o["compare_sheet"], o["item_report"]))
        lines.append("")

    lines.append("")
    return "\n".join(lines)


_HTML_HEAD = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>背景换色报告 · bg-recolor-tool</title>
<style>
:root{--bd:#d8dbe2;--mut:#6b7280;--red:#eb4034;--blue:#2e75eb;--amber:#f5b21a;--green:#2ecc71;--cyan:#40e0ff;}
*{box-sizing:border-box} body{font:14px/1.6 -apple-system,"PingFang SC","Segoe UI",sans-serif;margin:0;background:#f4f5f8;color:#1f2430}
header{background:#1f2430;color:#fff;padding:20px 28px} header h1{margin:0 0 6px;font-size:20px}
header .meta{color:#b8bfd0;font-size:13px} header code{color:#cfd8ff}
.wrap{max-width:1280px;margin:0 auto;padding:20px 28px 80px}
.cards{display:flex;gap:14px;flex-wrap:wrap;margin:18px 0}
.card{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:14px 18px;min-width:130px}
.card .n{font-size:26px;font-weight:700}.card .l{color:var(--mut);font-size:12px}
.item{background:#fff;border:1px solid var(--bd);border-radius:12px;margin:18px 0;overflow:hidden}
.item > .hd{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--bd);background:#fafbfd;flex-wrap:wrap}
.badge{font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;color:#fff}
.badge.ok{background:#1a9e57}.badge.err{background:#d33}
.item h2{font-size:16px;margin:0}
.item .bd{padding:16px 18px}
.grid4{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
figure{margin:0;border:1px solid var(--bd);border-radius:8px;overflow:hidden;background:#fafafa}
figure img{display:block;width:100%;height:auto}
figure figcaption{font-size:12px;color:var(--mut);padding:6px 10px;border-top:1px solid var(--bd);background:#fff}
table{border-collapse:collapse;font-size:13px;margin:8px 0}
th,td{border:1px solid var(--bd);padding:4px 10px;text-align:right}
th:first-child,td:first-child{text-align:left} th{background:#f0f2f7}
.kv{color:var(--mut);font-size:13px}.kv code{background:#eef1f6;padding:1px 6px;border-radius:4px}
.warn{background:#fff8e6;border:1px solid #f0d488;border-radius:8px;padding:8px 12px;margin:8px 0;font-size:13px}
.errbox{background:#fdecec;border:1px solid #f0b4b4;border-radius:8px;padding:10px 14px}
.legend{display:flex;gap:18px;flex-wrap:wrap;margin:6px 0 2px;font-size:13px}
.legend span{display:inline-flex;align-items:center;gap:7px}
.dot{width:13px;height:13px;border-radius:3px;display:inline-block;border:1px solid rgba(0,0,0,.25)}
a{color:#1b5fd0}
.swatches{display:inline-flex;gap:6px;vertical-align:middle}
.sw{width:16px;height:16px;border-radius:4px;border:1px solid rgba(0,0,0,.25);display:inline-block}
</style></head><body>
<header><h1>背景换色批处理报告</h1>
<div class="meta">bg-recolor-tool v__VERSION__ · __GENERATED_AT__ · numpy 加速：__NUMPY__ · 输出目录 <code>__OUTPUT_DIR__</code></div></header>
<div class="wrap">
<div class="cards">
<div class="card"><div class="n">__TOTAL__</div><div class="l">图片总数</div></div>
<div class="card"><div class="n" style="color:#1a9e57">__OK__</div><div class="l">成功</div></div>
<div class="card"><div class="n" style="color:#d33">__ERROR__</div><div class="l">隔离 / 失败</div></div>
<div class="card"><div class="n">__CHANGED_TOTAL__</div><div class="l">实际变化像素合计</div></div>
<div class="card"><div class="n">__DISC_TOTAL__</div><div class="l">断开同色域合计</div></div>
</div>
<div class="legend">
<span><i class="dot" style="background:var(--red)"></i>实际受影响 CHANGED（红色越深替换越强）</span>
<span><i class="dot" style="background:var(--blue)"></i>颜色相似但被保护区拦下</span>
<span><i class="dot" style="background:var(--amber)"></i>相似但与图边/种子不连通（单独记录，未修改）</span>
<span><i class="dot" style="background:var(--green);border-radius:50%"></i>背景取色点</span>
<span><i class="dot" style="background:var(--cyan)"></i>保护区边界</span>
</div>
"""


def render_html(batch: Dict) -> str:
    s = batch["summary"]
    e = html.escape
    engine_on = "开" if batch.get("engine", {}).get("numpy_accelerated") else "关"
    head = _HTML_HEAD.replace("__VERSION__", e(batch.get("version", "")))
    head = head.replace("__GENERATED_AT__", e(batch.get("generated_at", "")))
    head = head.replace("__NUMPY__", engine_on)
    head = head.replace("__OUTPUT_DIR__", e(batch.get("output_dir", "")))
    head = head.replace("__TOTAL__", str(s["total"]))
    head = head.replace("__OK__", str(s["ok"]))
    head = head.replace("__ERROR__", str(s["error"]))
    head = head.replace("__CHANGED_TOTAL__", str(s["changed_pixels_total"]))
    head = head.replace("__DISC_TOTAL__", str(s["disconnected_components_total"]))
    parts = [head]

    for it in batch["items"]:
        if it.get("status") != "ok":
            err = it.get("error", {})
            parts.append("""
<section class="item"><div class="hd"><span class="badge err">ERROR · 已隔离</span><h2>%s</h2></div>
<div class="bd"><div class="errbox">
<p><b>%s</b>（<code>%s</code>）</p><p>%s</p>
<p class="kv">源文件：<code>%s</code></p>
%s%s
<p class="kv">该 id 之前已生成的合法 PNG / 报告不会被覆写。</p>
</div></div></section>""" % (
                e(it["id"]), e(err.get("reason_cn", "失败")), e(err.get("reason_code", "")),
                e(err.get("message", "")), e(str(it.get("source"))),
                ('<p class="kv">源文件隔离副本：<code>%s</code></p>' % e(it["quarantined_source"]))
                if it.get("quarantined_source") else "",
                ('<p class="kv">错误记录：<code>%s</code></p>' % e(it["error_record"]))
                if it.get("error_record") else "",
            ))
            continue

        c = it["counts"]
        o = it["outputs"]
        p = it["params"]

        def swatch(hexcolor):
            return '<span class="sw" style="background:%s"></span>' % e(hexcolor)

        rows = "".join(
            "<tr><td>%s</td><td>%s</td></tr>" % (e(k), e(str(v)))
            for k, v in [
                ("总像素", c["total_pixels"]),
                ("完全透明（不计外观统计）", c["fully_transparent_pixels"]),
                ("半透明像素", c["semitransparent_pixels"]),
                ("不透明像素", c["opaque_pixels"]),
                ("实际变化像素", c["changed_pixels_exact"]),
                ("其中半透明边缘变化", c["changed_semitransparent_pixels"]),
                ("受保护相似像素", c["protected_similar_pixels"]),
                ("断开同色像素 / 域数", "%s / %s" % (
                    c["disconnected_similar_pixels"],
                    c["disconnected_component_count"])),
                ("可见像素平均 RGB 前→后", "%s → %s" % (
                    c["mean_rgb_visible_before"], c["mean_rgb_visible_after"])),
            ])
        warnings_html = "".join('<div class="warn">⚠️ %s</div>' % e(w)
                                for w in it.get("warnings", []))
        comp_rows = "".join(
            "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>" % (
                cp["id"], cp["area"], e(str(cp["bbox_xyxy"])), e(str(cp["centroid"])),
                "✓" if cp["touches_edge"] else "—",
                "✓" if cp["contains_seed"] else "—")
            for cp in it.get("disconnected_components", [])[:30])
        comp_table = ""
        if comp_rows:
            comp_table = """
<h3>断开的相似色区域（未修改）</h3>
<table><tr><th>域 id</th><th>面积</th><th>bbox [x0,y0,x1,y1)</th><th>质心</th><th>触边</th><th>含种子</th></tr>
%s</table>""" % comp_rows

        el, ed = it["edge_shift_on_light"], it["edge_shift_on_dark"]
        parts.append("""
<section class="item"><div class="hd"><span class="badge ok">OK</span><h2>%s</h2>
<span class="kv">%s×%s · 背景 %s%s → 新色 %s%s · %s/%s 邻接 · 容差 %s 过渡 %s · metric %s</span></div>
<div class="bd">
%s
<div class="grid4">
<figure><a href="%s" target="_blank"><img loading="lazy" src="%s" alt="compare"></a><figcaption>原图/新图 × 浅底/深底 2×2 对比（点击看大图）</figcaption></figure>
<figure><a href="%s" target="_blank"><img loading="lazy" src="%s" alt="change map"></a><figcaption>实际受影响范围 / 保护拦截 / 断开同色记录</figcaption></figure>
<figure><a href="%s" target="_blank"><img loading="lazy" src="%s" alt="light"></a><figcaption>新 PNG 置于浅底 %s</figcaption></figure>
<figure><a href="%s" target="_blank"><img loading="lazy" src="%s" alt="dark"></a><figcaption>新 PNG 置于深底 %s</figcaption></figure>
</div>
<div style="display:flex;gap:26px;flex-wrap:wrap;margin-top:14px">
<div><table>%s</table></div>
<div class="kv" style="max-width:420px">
<p>半透明背景近似边缘带：<b>%s</b> 像素<br>
合成色平均偏移：浅底 <b>%.2f</b>（最大 %.1f）／深底 <b>%.2f</b>（最大 %.1f）</p>
<p>产物：<a href="%s">新 PNG</a> · <a href="%s">变化区域图</a> · <a href="%s">浅底</a> · <a href="%s">深底</a> · <a href="%s">逐图 JSON</a></p>
</div></div>
%s
</div></section>""" % (
            e(it["id"]),
            it["image"]["width"], it["image"]["height"],
            swatch(it["background_color"]), e(it["background_color"]),
            swatch(it["target_color"]), e(it["target_color"]),
            e(p["connectivity"]), p["neighborhood"],
            p["tolerance"], p["feather"], e(p["metric"]),
            warnings_html,
            e(o["compare_sheet"]), e(o["compare_sheet"]),
            e(o["change_map"]), e(o["change_map"]),
            e(o["preview_light"]), e(o["preview_light"]), e(p["light_color"]),
            e(o["preview_dark"]), e(o["preview_dark"]), e(p["dark_color"]),
            rows,
            el["edge_band_pixels"],
            el["edge_mean_shift"], el["edge_max_shift"],
            ed["edge_mean_shift"], ed["edge_max_shift"],
            e(o["new_png"]), e(o["change_map"]),
            e(o["preview_light"]), e(o["preview_dark"]), e(o["item_report"]),
            comp_table,
        ))

    parts.append("</div></body></html>")
    return "".join(parts)
