"""项目文件：候选记录、人工编辑、审计日志、重扫合并、素材替换检测。"""

import json
import os
import sys
from datetime import datetime

from . import media

SCHEMA_VERSION = 1
EDGE_BAND = 0.5  # 重扫范围边缘的保护带（秒）：落在带内的旧记录不删，只打 edge 标记

# 人工动作会写入审计日志，并随 export 导出
HUMAN_ACTIONS = ("confirm", "delete", "add", "restore", "note")


class Project:
    def __init__(self, path):
        self.path = path
        self.data = None
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                self.data = json.load(f)

    # ---------- 生命周期 ----------

    def create(self, video_path):
        info = media.ffprobe_info(video_path)
        self.data = {
            "version": SCHEMA_VERSION,
            "video": {
                "path": os.path.abspath(video_path),
                "fps": info["fps"],
                "duration": info["duration"],
                "width": info["width"],
                "height": info["height"],
                "fingerprint": media.fingerprint(video_path),
            },
            "params": {},
            "records": [],
            "audit": [],
            "scan_counter": 0,
            "record_counter": 0,
        }
        self._audit("create", None, "video=%s" % video_path)

    def save(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)

    def _audit(self, action, record_id, detail):
        self.data["audit"].append({
            "ts": datetime.now().isoformat(timespec="seconds"),
            "action": action,
            "record": record_id,
            "detail": detail,
        })

    # ---------- 素材替换检测 ----------

    def check_media(self):
        """素材被替换时，把所有记录标记为 stale 并提醒重审。返回是否发生过替换。"""
        video = self.data["video"]
        path = video["path"]
        if not os.path.exists(path):
            print("警告：素材文件不存在：%s" % path, file=sys.stderr)
            return False
        current = media.fingerprint(path)
        if current == video["fingerprint"]:
            return False
        n = 0
        for rec in self.data["records"]:
            if not rec.get("stale"):
                rec["stale"] = True
                n += 1
        video["fingerprint"] = current
        info = media.ffprobe_info(path)
        video.update({"fps": info["fps"], "duration": info["duration"],
                      "width": info["width"], "height": info["height"]})
        self._audit("media-changed", None,
                    "素材已替换，%d 条记录被标记为 stale，需重审" % n)
        print("警告：素材已替换，%d 条记录（含人工确认/补录）已标记 stale，"
              "请重新扫描并重审。" % n, file=sys.stderr)
        return True

    # ---------- 扫描合并 ----------

    def _new_record(self, event, scan_id, origin="auto"):
        self.data["record_counter"] += 1
        rec = {
            "id": "b%04d" % self.data["record_counter"],
            "type": event["type"],
            "time": round(event["time"], 3),
            "score": round(event.get("score", 0.0), 4),
            "status": event.get("status", "candidate"),
            "origin": origin,
            "scan_id": scan_id,
            "edge": False,
            "stale": False,
            "note": event.get("note", ""),
        }
        for key in ("start", "end", "basis", "suppressed_by_gap"):
            if key in event:
                rec[key] = event[key]
        return rec

    def merge_scan(self, events, params, start=None, end=None):
        """把一次（重）扫描结果合并进项目。

        - 范围外记录一律不动；
        - 范围内未被人工碰过的旧自动记录（candidate/suppressed）被新结果替换；
        - 人工记录（confirmed/deleted/added/restored）即使落在范围内也保留可见；
        - 落在范围边缘 ±EDGE_BAND 内的旧记录不删除，打 edge 标记，提示人工核对。
        """
        self.data["scan_counter"] += 1
        scan_id = self.data["scan_counter"]
        duration = self.data["video"]["duration"]
        t0 = 0.0 if start is None else float(start)
        t1 = duration if end is None else float(end)
        is_partial = start is not None or end is not None

        kept, removed = [], 0
        for rec in self.data["records"]:
            t = rec["time"]
            inside = t0 <= t <= t1
            if not inside:
                kept.append(rec)
                continue
            human_touched = rec["origin"] == "manual" or rec["status"] in (
                "confirmed", "deleted", "added",
            )
            if human_touched:
                kept.append(rec)  # 人工编辑保持可见，不被重扫覆盖
                continue
            near_edge = is_partial and (
                abs(t - t0) <= EDGE_BAND or abs(t - t1) <= EDGE_BAND
            )
            if near_edge:
                rec["edge"] = True  # 明确处理：保留并标记，由人工决定去留
                kept.append(rec)
                continue
            removed += 1

        new_records = [self._new_record(e, scan_id) for e in events]
        self.data["records"] = kept + new_records
        self.data["params"] = params
        self._audit(
            "rescan" if is_partial else "scan", None,
            "range=[%.2f, %.2f] removed_auto=%d new=%d params=%s"
            % (t0, t1, removed, len(new_records), json.dumps(params, sort_keys=True)),
        )
        return scan_id, removed, len(new_records)

    # ---------- 人工编辑 ----------

    def find(self, record_id):
        for rec in self.data["records"]:
            if rec["id"] == record_id:
                return rec
        raise KeyError("没有这条记录：%s" % record_id)

    def confirm(self, record_id):
        rec = self.find(record_id)
        rec["status"] = "confirmed"
        rec["stale"] = False
        self._audit("confirm", record_id, "type=%s time=%.3f" % (rec["type"], rec["time"]))

    def delete(self, record_id, reason=""):
        rec = self.find(record_id)
        rec["status"] = "deleted"
        self._audit("delete", record_id,
                    "type=%s time=%.3f reason=%s" % (rec["type"], rec["time"], reason))

    def restore(self, record_id):
        """把 suppressed / deleted 的记录恢复为候选。"""
        rec = self.find(record_id)
        rec["status"] = "candidate"
        rec["stale"] = False
        self._audit("restore", record_id, "type=%s time=%.3f" % (rec["type"], rec["time"]))

    def add(self, time, rtype="cut", note=""):
        event = {"type": rtype, "time": float(time), "score": 0.0, "note": note,
                 "status": "added"}
        rec = self._new_record(event, self.data["scan_counter"], origin="manual")
        self.data["records"].append(rec)
        self._audit("add", rec["id"], "type=%s time=%.3f note=%s" % (rtype, time, note))
        return rec["id"]

    def note(self, record_id, text):
        rec = self.find(record_id)
        rec["note"] = text
        self._audit("note", record_id, text)

    # ---------- 查询 ----------

    def boundaries(self, include_suppressed=False):
        """有效边界（用于切分镜头区间）：candidate/confirmed/added 的 cut/gradual。"""
        ok = ("candidate", "confirmed", "added")
        recs = [
            r for r in self.data["records"]
            if r["type"] != "flash" and r["status"] in ok
            and (include_suppressed or r["status"] != "suppressed")
        ]
        return sorted(recs, key=lambda r: r["time"])

    def human_edits(self):
        return [a for a in self.data["audit"] if a["action"] in HUMAN_ACTIONS]
