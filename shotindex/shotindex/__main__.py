"""命令行入口：python3 -m shotindex <命令> ..."""

import argparse
import json
import sys

from . import detect, export, media, project as proj_mod, report, samples


def _params_from_args(args):
    params = dict(detect.DEFAULTS)
    for key in params:
        val = getattr(args, key, None)
        if val is not None:
            params[key] = val
    return params


def _open_project(path, need=True):
    p = proj_mod.Project(path)
    if p.data is None:
        if need:
            sys.exit("项目不存在：%s（先用 scan 创建）" % path)
        return p
    p.check_media()
    return p


def cmd_samples(args):
    video, truth = samples.build_samples(args.out)
    print("样例素材：%s" % video)
    print("真值表：%s" % truth)


def cmd_scan(args):
    p = _open_project(args.project, need=False)
    if p.data is None:
        p.create(args.video)
    elif args.video and media.fingerprint(args.video) != p.data["video"]["fingerprint"]:
        sys.exit("指定素材与项目记录不一致；如确认替换素材，"
                 "请直接用原项目路径重新 scan（记录会被标记 stale）")
    params = _params_from_args(args)
    frames, fps = media.decode_frames(
        p.data["video"]["path"], start=args.start, end=args.end)
    if len(frames) < 2:
        sys.exit("解码帧数不足，检查时间范围")
    events, _ = detect.detect_events(frames, params)
    events = detect.suppress_close(events, params["min_gap"])
    scan_id, removed, added = p.merge_scan(events, params, args.start, args.end)
    p.save()
    n_flash = sum(1 for e in events if e["type"] == "flash")
    n_supp = sum(1 for e in events if e.get("status") == "suppressed")
    print("扫描 #%d 完成：解码 %d 帧，新候选 %d 条（含闪光 %d、被抑制 %d），"
          "替换旧自动记录 %d 条" % (scan_id, len(frames), added, n_flash, n_supp, removed))


def cmd_status(args):
    p = _open_project(args.project)
    p.save()  # 固化可能的 stale 标记
    v = p.data["video"]
    print("素材：%s（%.2fs，%.3f fps）" % (v["path"], v["duration"], v["fps"]))
    by = {}
    for r in p.data["records"]:
        key = (r["type"], r["status"])
        by[key] = by.get(key, 0) + 1
    for (typ, status), n in sorted(by.items()):
        print("  %-8s %-10s %d" % (typ, status, n))
    stale = [r["id"] for r in p.data["records"] if r.get("stale")]
    edge = [r["id"] for r in p.data["records"] if r.get("edge")]
    if stale:
        print("stale（素材已替换，需重审）：%s" % ", ".join(stale))
    if edge:
        print("edge（位于重扫边缘，需人工核对）：%s" % ", ".join(edge))
    print("镜头区间数（按当前有效边界）：%d" % (len(p.boundaries()) + 1))


def _edit(args, fn):
    p = _open_project(args.project)
    for rid in args.ids:
        fn(p, rid)
    p.save()


def cmd_confirm(args):
    _edit(args, lambda p, rid: p.confirm(rid))
    print("已确认：%s" % ", ".join(args.ids))


def cmd_delete(args):
    _edit(args, lambda p, rid: p.delete(rid, reason=args.reason or ""))
    print("已删除：%s" % ", ".join(args.ids))


def cmd_restore(args):
    _edit(args, lambda p, rid: p.restore(rid))
    print("已恢复：%s" % ", ".join(args.ids))


def cmd_add(args):
    p = _open_project(args.project)
    rid = p.add(args.time, rtype=args.type, note=args.note or "")
    p.save()
    print("已补录：%s（%s @ %.3fs）" % (rid, args.type, args.time))


def cmd_note(args):
    p = _open_project(args.project)
    p.note(args.id, args.text)
    p.save()
    print("已备注：%s" % args.id)


def cmd_export(args):
    p = _open_project(args.project)
    p.save()
    shots, edits = export.export(p, args.out)
    print("导出 %d 个镜头区间、%d 张代表画面、%d 条人工修改记录 → %s"
          % (len(shots), len(shots), len(edits), args.out))


def cmd_report(args):
    p = _open_project(args.project)
    p.save()
    out = report.build_report(p, args.out)
    print("报告已生成：%s" % out)


def cmd_check(args):
    """用样例真值表核对扫描结果。"""
    p = _open_project(args.project)
    with open(args.truth, "r", encoding="utf-8") as f:
        truth = json.load(f)["events"]
    recs = p.data["records"]
    tol = args.tol
    ok = True
    for ev in truth:
        t = ev["time"] if "time" in ev else (ev["start"] + ev["end"]) / 2
        cands = [r for r in recs
                 if r["type"] == ev["type"] and abs(r["time"] - t) <= tol
                 and r["status"] != "deleted"]
        if ev["type"] == "gradual":
            cands = [r for r in cands
                     if abs(r.get("start", 0) - ev["start"]) <= tol
                     and abs(r.get("end", 0) - ev["end"]) <= tol]
        mark = "OK  " if cands else "MISS"
        if not cands:
            ok = False
        where = ("%.2fs" % t) if "time" in ev else "%.2f-%.2fs" % (ev["start"], ev["end"])
        extra = ""
        if cands and cands[0]["status"] == "suppressed":
            extra = "（被抑制，可 restore）"
        print("%s %-7s %-14s %s %s" % (mark, ev["type"], where, ev.get("note", ""), extra))
    print("核对结果：%s" % ("全部命中" if ok else "存在漏检"))
    sys.exit(0 if ok else 1)


def main(argv=None):
    ap = argparse.ArgumentParser(
        prog="shotindex", description="离线镜头边界审片工具（ffmpeg + 纯 Python）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("samples", help="生成检测样例素材与真值表")
    sp.add_argument("--out", required=True)
    sp.set_defaults(fn=cmd_samples)

    sp = sub.add_parser("scan", help="扫描（或重扫一段）视频，生成候选边界")
    sp.add_argument("video", nargs="?", help="素材路径（首次扫描必填）")
    sp.add_argument("--project", required=True)
    sp.add_argument("--start", type=float, help="只重扫该时刻之后（秒）")
    sp.add_argument("--end", type=float, help="只重扫该时刻之前（秒）")
    for key, default in detect.DEFAULTS.items():
        sp.add_argument("--" + key.replace("_", "-"), type=float, default=None,
                        help="默认 %s" % default)
    sp.set_defaults(fn=cmd_scan)

    sp = sub.add_parser("status", help="查看项目概况")
    sp.add_argument("--project", required=True)
    sp.set_defaults(fn=cmd_status)

    for name, fn, helptext in [
        ("confirm", cmd_confirm, "确认候选边界"),
        ("delete", cmd_delete, "删除候选边界"),
        ("restore", cmd_restore, "恢复被抑制/已删除的记录"),
    ]:
        sp = sub.add_parser(name, help=helptext)
        sp.add_argument("--project", required=True)
        sp.add_argument("ids", nargs="+")
        if name == "delete":
            sp.add_argument("--reason", default="")
        sp.set_defaults(fn=fn)

    sp = sub.add_parser("add", help="人工补录边界")
    sp.add_argument("--project", required=True)
    sp.add_argument("--time", type=float, required=True)
    sp.add_argument("--type", choices=["cut", "gradual"], default="cut")
    sp.add_argument("--note", default="")
    sp.set_defaults(fn=cmd_add)

    sp = sub.add_parser("note", help="给记录加备注")
    sp.add_argument("--project", required=True)
    sp.add_argument("id")
    sp.add_argument("text")
    sp.set_defaults(fn=cmd_note)

    sp = sub.add_parser("export", help="导出镜头区间、代表画面与人工修改记录")
    sp.add_argument("--project", required=True)
    sp.add_argument("--out", required=True)
    sp.set_defaults(fn=cmd_export)

    sp = sub.add_parser("report", help="生成 HTML 审片报告（边界两侧画面+判断依据）")
    sp.add_argument("--project", required=True)
    sp.add_argument("--out", required=True)
    sp.set_defaults(fn=cmd_report)

    sp = sub.add_parser("check", help="用样例真值表核对扫描结果")
    sp.add_argument("--project", required=True)
    sp.add_argument("truth")
    sp.add_argument("--tol", type=float, default=0.25, help="容差（秒），默认 0.25")
    sp.set_defaults(fn=cmd_check)

    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
