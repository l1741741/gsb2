"""生成 HTML 审片报告：每条边界两侧画面 + 判断依据，被抑制候选单独列出。"""

import html
import json
import os

from . import media

_STATUS_LABEL = {
    "candidate": "候选",
    "confirmed": "已确认",
    "deleted": "已删除",
    "added": "人工补录",
    "suppressed": "已抑制",
}
_TYPE_LABEL = {"cut": "硬切", "gradual": "渐变", "flash": "闪光/短遮挡"}


def _thumbs_for(rec, video_path, img_dir, fps):
    """按记录类型抽代表性画面，返回 [(label, 相对路径), ...]。"""
    rid = rec["id"]
    out = []

    def grab(t, tag, label):
        name = "%s_%s.jpg" % (rid, tag)
        media.grab_frame(video_path, max(t, 0.0), os.path.join(img_dir, name))
        out.append((label, "img/" + name))

    t = rec["time"]
    if rec["type"] == "cut":
        grab(t - 2 / fps, "before", "切前 %.2fs" % (t - 2 / fps))
        grab(t + 1 / fps, "after", "切后 %.2fs" % (t + 1 / fps))
    elif rec["type"] == "gradual":
        grab(rec["start"] - 2 / fps, "before", "渐变前 %.2fs" % (rec["start"] - 2 / fps))
        grab(t, "mid", "渐变中 %.2fs" % t)
        grab(rec["end"] + 2 / fps, "after", "渐变后 %.2fs" % (rec["end"] + 2 / fps))
    else:  # flash：前 / 中 / 后，展示“回到原画面”
        grab(rec["start"] - 1 / fps, "before", "闪光前 %.2fs" % (rec["start"] - 1 / fps))
        grab(t, "mid", "闪光 %.2fs" % t)
        grab(rec["end"] + 1 / fps, "after", "闪光后 %.2fs" % (rec["end"] + 1 / fps))
    return out


def _record_html(rec, thumbs):
    esc = html.escape
    imgs = "".join(
        '<figure><img src="%s" loading="lazy"><figcaption>%s</figcaption></figure>'
        % (esc(src), esc(label))
        for label, src in thumbs
    )
    basis = rec.get("basis") or {}
    basis_txt = "，".join("%s=%s" % (k, v) for k, v in basis.items()) or "（人工补录，无自动判据）"
    flags = []
    if rec.get("edge"):
        flags.append("位于重扫边缘，请人工核对")
    if rec.get("stale"):
        flags.append("素材已替换，需重审")
    if rec.get("suppressed_by_gap") is not None:
        flags.append("与相邻候选间隔 %.2fs 被抑制" % rec["suppressed_by_gap"])
    if rec.get("note"):
        flags.append("备注：" + rec["note"])
    flag_txt = "；".join(flags)
    return """
<section class="rec status-{status}">
  <h3>{rid} · {typ} · {time:.2f}s <span class="badge">{status_label}</span></h3>
  <div class="imgs">{imgs}</div>
  <p class="basis">判断依据：{basis}</p>
  {flags}
</section>""".format(
        rid=esc(rec["id"]), typ=_TYPE_LABEL.get(rec["type"], rec["type"]),
        time=rec["time"], status=esc(rec["status"]),
        status_label=_STATUS_LABEL.get(rec["status"], rec["status"]),
        imgs=imgs, basis=esc(basis_txt),
        flags='<p class="flags">%s</p>' % esc(flag_txt) if flag_txt else "",
    )


def build_report(project, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    img_dir = os.path.join(out_dir, "img")
    os.makedirs(img_dir, exist_ok=True)

    video = project.data["video"]
    fps = video["fps"]
    records = sorted(project.data["records"], key=lambda r: r["time"])

    active = [r for r in records if r["status"] != "suppressed"]
    suppressed = [r for r in records if r["status"] == "suppressed"]

    def render(recs):
        parts = []
        for rec in recs:
            thumbs = _thumbs_for(rec, video["path"], img_dir, fps)
            parts.append(_record_html(rec, thumbs))
        return "\n".join(parts) or "<p>（无）</p>"

    params = project.data.get("params") or {}
    page = """<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<title>镜头边界审片报告</title>
<style>
 body {{ font-family: -apple-system, sans-serif; margin: 2em; background: #fafafa; }}
 section.rec {{ background: #fff; border: 1px solid #ddd; border-radius: 8px;
   padding: 1em; margin-bottom: 1.2em; }}
 section.status-deleted {{ opacity: .55 }}
 section.status-suppressed {{ border-style: dashed }}
 .imgs {{ display: flex; gap: .8em; flex-wrap: wrap; }}
 figure {{ margin: 0 }} img {{ max-width: 300px; border: 1px solid #ccc }}
 figcaption {{ font-size: .85em; color: #555 }}
 .badge {{ font-size: .7em; background: #eef; border-radius: 4px; padding: 2px 6px }}
 .basis {{ color: #333 }} .flags {{ color: #a33 }}
</style></head><body>
<h1>镜头边界审片报告</h1>
<p>素材：<code>{video}</code>　时长 {duration:.2f}s　{fps:.3f} fps<br>
检测参数：<code>{params}</code></p>
<h2>边界与事件（{n_active} 条）</h2>
{active}
<h2>被抑制的临近候选（{n_supp} 条，可恢复）</h2>
{supp}
</body></html>""".format(
        video=html.escape(video["path"]), duration=video["duration"], fps=fps,
        params=html.escape(json.dumps(params, ensure_ascii=False, sort_keys=True)),
        n_active=len(active), active=render(active),
        n_supp=len(suppressed), supp=render(suppressed),
    )
    out_path = os.path.join(out_dir, "report.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(page)
    return out_path
