"""批处理管线：配置合并、逐图处理、坏图/无效取色点隔离、原子提交。

安全保证
--------
1. 每张图的全部产物先在内存中计算并编码，然后写入同目录临时文件，
   最后 ``os.replace`` 两阶段提交 —— 不会出现写了一半的 PNG/报告；
2. 单图失败只进入 ``quarantine/``，绝不会用坏结果替换该 id 已有的合法产物；
3. 一张图失败不影响其他图片，批次最后统一写出 report.json/md/html。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import time
import traceback
from datetime import datetime
from typing import Dict, List, Optional

from . import __version__
from .accel import using_numpy
from .artifacts import build_change_map, build_compare_sheet, flatten_preview
from .colors import parse_color, rgb_hex
from .engine import (InvalidSampleError, analyze, compute_counts,
                     compute_edge_metrics, normalize_params, render_recolor)
from .pngcodec import PngError, decode_png_bytes, encode_png

PARAM_KEYS = {
    "metric", "tolerance", "feather", "connectivity", "neighborhood",
    "sample_radius", "sample_min_alpha", "strict_seed", "target_color",
    "light_color", "dark_color",
}

_STRUCTURAL_KEYS = {
    "id", "path", "file", "sample_points", "samples", "protect", "protection",
    "regions", "seeds", "seed_points", "background_color", "enabled", "note",
}

_REASON_CN = {
    "file_not_found": "文件不存在",
    "unreadable_image": "坏图 / 无法解码的 PNG",
    "invalid_sample_point": "无效取色点",
    "invalid_sample_transparent": "取色区域完全透明，无法取色",
    "seed_not_in_similar": "连通种子未落在相似区域",
    "invalid_config": "参数 / 保护区配置非法",
    "processing_error": "处理时发生未预期错误",
}


class ItemProcessingError(Exception):
    def __init__(self, reason_code: str, message: str):
        super().__init__(message)
        self.reason_code = reason_code


def slugify(value: str, fallback: str = "image") -> str:
    s = str(value).strip()
    s = re.sub(r"[^\w.\-]+", "_", s, flags=re.UNICODE).strip("._")
    return s or fallback


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def atomic_write_bytes(path: str, data: bytes) -> None:
    """同目录临时文件 + os.replace，保证目标路径要么是旧文件要么是完整新文件。"""
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(prefix=".tmp-%s-" % os.path.basename(path),
                                    dir=directory)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    except BaseException:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def commit_files(files: Dict[str, bytes]) -> None:
    """先把所有文件写成临时文件，再统一 replace，缩小版本错位窗口。"""
    staged = []
    try:
        for final_path, data in files.items():
            directory = os.path.dirname(os.path.abspath(final_path))
            os.makedirs(directory, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(
                prefix=".tmp-%s-" % os.path.basename(final_path), dir=directory)
            with os.fdopen(fd, "wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            staged.append((tmp_path, final_path))
        for tmp_path, final_path in staged:
            os.replace(tmp_path, final_path)
    except BaseException:
        for tmp_path, _ in staged:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        raise


# --------------------------------------------------------------------------- #
# 配置
# --------------------------------------------------------------------------- #

def load_config(config_path: str) -> Dict:
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    if not isinstance(cfg, dict):
        raise ValueError("配置文件顶层必须是 JSON 对象")
    if "images" not in cfg or not isinstance(cfg["images"], list):
        raise ValueError("配置缺少 images 数组")
    cfg["_config_dir"] = os.path.dirname(os.path.abspath(config_path))
    cfg["_config_path"] = os.path.abspath(config_path)
    return cfg


def merge_item_params(cfg: Dict, item: Dict) -> Dict:
    merged = dict(cfg.get("defaults") or {})
    for k, v in item.items():
        if k in PARAM_KEYS:
            merged[k] = v
    return merged


def _item_field(item: Dict, *names, default=None):
    for n in names:
        if n in item and item[n] is not None:
            return item[n]
    return default


# --------------------------------------------------------------------------- #
# 单图
# --------------------------------------------------------------------------- #

def process_item(item: Dict, item_id: str, base_dir: str, out_dir: str,
                 defaults: Optional[Dict] = None) -> Dict:
    """处理单张图。成功返回 ok 报告并提交全部产物；失败做隔离并返回 error 报告。"""
    t0 = time.perf_counter()
    source = _item_field(item, "path", "file")
    report: Dict = {
        "id": item_id,
        "source": source,
        "status": "error",
        "outputs": {},
        "warnings": [],
    }
    source_abs = None
    source_bytes: Optional[bytes] = None

    if not source or not isinstance(source, str):
        return _quarantine_failure(
            out_dir, item_id, item, report,
            ItemProcessingError("invalid_config", "图片条目缺少 path/file"))

    source_abs = source if os.path.isabs(source) else os.path.join(base_dir, source)
    report["source_abs"] = source_abs

    try:
        if not os.path.exists(source_abs) or not os.path.isfile(source_abs):
            raise ItemProcessingError("file_not_found", "找不到文件: %s" % source_abs)
        try:
            with open(source_abs, "rb") as f:
                source_bytes = f.read()
        except OSError as exc:
            raise ItemProcessingError("file_not_found", "无法读取文件: %s" % exc)

        report["source_bytes"] = len(source_bytes)
        report["source_sha256"] = sha256_hex(source_bytes)

        try:
            img = decode_png_bytes(source_bytes, source_name=source_abs)
        except Exception as exc:
            raise ItemProcessingError(
                "unreadable_image",
                "%s: %s" % (type(exc).__name__, exc))

        # 合并 / 校验参数
        merged_defaults = defaults if defaults is not None else {}
        params = merge_item_params({"defaults": merged_defaults}, item)
        try:
            params = normalize_params(params)
        except Exception as exc:
            raise ItemProcessingError("invalid_config", str(exc))

        sample_points = _item_field(item, "sample_points", "samples")
        protect = _item_field(item, "protect", "protection", "regions", default=[])
        seeds = _item_field(item, "seeds", "seed_points")
        bg_color = _item_field(item, "background_color")

        try:
            analysis = analyze(
                img, params=params, sample_points=sample_points,
                protect_regions=protect, seed_points=seeds,
                background_color=bg_color)
        except InvalidSampleError as exc:
            raise ItemProcessingError(exc.reason_code, str(exc))
        except (ValueError, TypeError) as exc:
            # RegionConfigError / EngineConfigError 都是 ValueError
            msg = str(exc)
            code = "invalid_config"
            if "取色点" in msg or "种子" in msg:
                code = "invalid_sample_point"
            raise ItemProcessingError(code, msg)

        report["warnings"].extend(analysis["warnings"])
        after = render_recolor(img, analysis)
        counts = compute_counts(img, after, analysis)

        light = parse_color(params["light_color"])[:3]
        dark = parse_color(params["dark_color"])[:3]

        comp_before_light = _safe_composite(img, light)
        comp_after_light = _safe_composite(after, light)
        comp_before_dark = _safe_composite(img, dark)
        comp_after_dark = _safe_composite(after, dark)
        edge_light = compute_edge_metrics(
            comp_before_light, comp_after_light, img, analysis)
        edge_dark = compute_edge_metrics(
            comp_before_dark, comp_after_dark, img, analysis)

        # ---- 在内存中编码全部产物 ----
        new_png = encode_png(after)
        change_png = encode_png(build_change_map(img, analysis))
        light_png = encode_png(flatten_preview(after, light))
        dark_png = encode_png(flatten_preview(after, dark))
        compare_png = encode_png(build_compare_sheet(
            img, after, light=light, dark=dark))

        components_brief = [_component_brief(c) for c in analysis["components"]]
        target_hex = rgb_hex(parse_color(params["target_color"]))

        item_report = {
            "id": item_id,
            "status": "ok",
            "source": source,
            "source_abs": source_abs,
            "source_bytes": len(source_bytes),
            "source_sha256": report["source_sha256"],
            "image": {"width": img.width, "height": img.height,
                      "decoded_source": img.source_info},
            "background_color": analysis["background_hex"],
            "target_color": target_hex,
            "params": _jsonable_params(params),
            "sample_infos": analysis["sample_infos"],
            "sample_points": analysis["sample_points"],
            "seed_points": analysis["seed_points"],
            "warnings": analysis["warnings"],
            "counts": counts,
            "edge_shift_on_light": edge_light,
            "edge_shift_on_dark": edge_dark,
            "components": components_brief,
            "disconnected_components": [
                _component_brief(c) for c in analysis["disconnected_components"]],
            "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
        }

        rel = {
            "new_png": "processed/%s.new.png" % item_id,
            "change_map": "changes/%s.change.png" % item_id,
            "preview_light": "review/%s.light.png" % item_id,
            "preview_dark": "review/%s.dark.png" % item_id,
            "compare_sheet": "review/%s.compare.png" % item_id,
            "item_report": "reports/%s.json" % item_id,
        }
        item_report["outputs"] = rel

        binary_outputs = {
            "new_png": new_png,
            "change_map": change_png,
            "preview_light": light_png,
            "preview_dark": dark_png,
            "compare_sheet": compare_png,
        }
        # 先算好各图像产物哈希，使逐图 JSON 与批次 JSON 内容一致
        item_report["output_sha256"] = {
            key: sha256_hex(data) for key, data in binary_outputs.items()}

        item_json = json.dumps(
            item_report, ensure_ascii=False, indent=2).encode("utf-8")
        files = {
            os.path.join(out_dir, rel[key]): data
            for key, data in binary_outputs.items()
        }
        files[os.path.join(out_dir, rel["item_report"])] = item_json
        commit_files(files)

        report.update(item_report)
        return report

    except ItemProcessingError as exc:
        return _quarantine_failure(out_dir, item_id, item, report, exc,
                                   source_bytes=source_bytes,
                                   source_name=os.path.basename(source_abs or source or "item"),
                                   trace=traceback.format_exc())
    except Exception as exc:  # 单图隔离的最后防线
        err = ItemProcessingError(
            "processing_error", "%s: %s" % (type(exc).__name__, exc))
        return _quarantine_failure(out_dir, item_id, item, report, err,
                                   source_bytes=source_bytes,
                                   source_name=os.path.basename(source_abs or source or "item"),
                                   trace=traceback.format_exc())


# --------------------------------------------------------------------------- #
# 批次
# --------------------------------------------------------------------------- #


def _safe_composite(img, bg):
    from .accel import composite_over
    return composite_over(img.rgba, bg)


def _component_brief(c: Dict) -> Dict:
    return {
        "id": c["id"],
        "area": c["area"],
        "bbox_xyxy": c["bbox_xyxy"],
        "centroid": c["centroid"],
        "touches_edge": c["touches_edge"],
        "contains_seed": c["contains_seed"],
        "seed_points": c.get("seed_points", []),
    }


def _jsonable_params(params: Dict) -> Dict:
    out = dict(params)
    return out


def _quarantine_failure(out_dir, item_id, item, report,
                        exc: ItemProcessingError, source_bytes=None,
                        source_name="item", trace=None) -> Dict:
    report["status"] = "error"
    report["error"] = {
        "reason_code": exc.reason_code,
        "reason_cn": _REASON_CN.get(exc.reason_code, "处理失败"),
        "message": str(exc),
    }
    if trace:
        report["error"]["traceback_tail"] = "\n".join(trace.splitlines()[-6:])

    quarantine_files_dir = os.path.join(out_dir, "quarantine", "files")
    quarantine_err_dir = os.path.join(out_dir, "quarantine", "errors")
    safe_name = slugify(source_name, "item")
    quarantined_source = None
    if source_bytes is not None:
        try:
            os.makedirs(quarantine_files_dir, exist_ok=True)
            qpath = os.path.join(quarantine_files_dir, "%s__%s" % (item_id, safe_name))
            atomic_write_bytes(qpath, source_bytes)
            quarantined_source = os.path.relpath(qpath, out_dir)
        except OSError:
            pass
    report["quarantined_source"] = quarantined_source

    try:
        err_record = {
            "id": item_id,
            "failed_at": datetime.now().isoformat(timespec="seconds"),
            "item_config": item,
            "error": report["error"],
            "quarantined_source": quarantined_source,
        }
        epath = os.path.join(quarantine_err_dir, "%s.error.json" % item_id)
        atomic_write_bytes(
            epath, json.dumps(err_record, ensure_ascii=False, indent=2).encode("utf-8"))
        report["error_record"] = os.path.relpath(epath, out_dir)
    except OSError:
        pass
    return report


# --------------------------------------------------------------------------- #
# 批次
# --------------------------------------------------------------------------- #

def run_batch(config_path: Optional[str] = None, *,
              config_dict: Optional[Dict] = None,
              output_override: Optional[str] = None,
              only: Optional[str] = None) -> Dict:
    if config_dict is not None:
        cfg = config_dict
        base_dir = cfg.get("_config_dir") or os.getcwd()
        config_path = cfg.get("_config_path")
    else:
        if not config_path:
            raise ValueError("需要 config_path 或 config_dict")
        cfg = load_config(config_path)
        base_dir = cfg["_config_dir"]

    if output_override:
        out_dir = os.path.abspath(output_override)
    else:
        od = cfg.get("output_dir") or "bg_recolor_output"
        out_dir = od if os.path.isabs(od) else os.path.join(base_dir, od)
    os.makedirs(out_dir, exist_ok=True)

    defaults = cfg.get("defaults") or {}
    items = cfg["images"]
    used_ids = set()
    item_reports: List[Dict] = []
    for idx, item in enumerate(items):
        if not isinstance(item, dict):
            item_reports.append(_quarantine_failure(
                out_dir, "item-%03d" % idx, {"raw": item}, {},
                ItemProcessingError("invalid_config", "条目必须是 JSON 对象")))
            continue
        raw_id = item.get("id") or os.path.splitext(
            os.path.basename(str(item.get("path") or item.get("file") or "item")))[0]
        item_id = slugify(raw_id, "item-%03d" % idx)
        base_id = item_id
        k = 2
        while item_id in used_ids:
            item_id = "%s-%d" % (base_id, k)
            k += 1
        used_ids.add(item_id)

        if only and item_id != only and raw_id != only:
            continue
        if item.get("enabled") is False:
            continue
        item_reports.append(process_item(
            item, item_id, base_dir, out_dir, defaults=defaults))

    ok = [r for r in item_reports if r.get("status") == "ok"]
    bad = [r for r in item_reports if r.get("status") == "error"]
    batch = {
        "tool": "bg-recolor-tool",
        "version": __version__,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "config_path": config_path,
        "output_dir": out_dir,
        "engine": {"numpy_accelerated": using_numpy()},
        "summary": {
            "total": len(item_reports),
            "ok": len(ok),
            "error": len(bad),
            "changed_pixels_total": sum(r.get("counts", {}).get("changed_pixels_exact", 0) for r in ok),
            "disconnected_components_total": sum(
                r.get("counts", {}).get("disconnected_component_count", 0) for r in ok),
            "quarantine_dir": "quarantine/",
        },
        "items": item_reports,
    }

    # 报告渲染（延迟导入避免循环依赖），与批次报告一起原子提交
    from .report import render_html, render_markdown
    files = {
        os.path.join(out_dir, "report.json"):
            json.dumps(batch, ensure_ascii=False, indent=2).encode("utf-8"),
        os.path.join(out_dir, "report.md"):
            render_markdown(batch).encode("utf-8"),
        os.path.join(out_dir, "report.html"):
            render_html(batch).encode("utf-8"),
    }
    commit_files(files)
    return batch
