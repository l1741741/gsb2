"""配色 JSON 的数据模型、加载与校验。

JSON 结构示例见 examples/palettes.json。设计要点:

- 规则字段: id / source / tolerance / target / priority / enabled / metric。
- 方案通过 ``rule_refs`` 引用规则池, 每条引用可覆盖 target / enabled / priority,
  这样同一组规则可以快速派生多个试样。
- 保护区域支持矩形、圆形和外部蒙版 PNG(其 alpha>0 处受保护)。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

from .color_math import ColorSpecError, parse_color, parse_matte
from .pngio import read_png

DEFAULT_METRIC = "euclidean"
VALID_METRICS = ("euclidean", "chebyshev")


class ConfigError(ValueError):
    """配色 JSON 结构或字段不合法。"""


@dataclass(frozen=True)
class Rule:
    id: str
    source: tuple[int, int, int]
    target: tuple[int, int, int]
    tolerance: float
    priority: int
    enabled: bool = True
    metric: str = DEFAULT_METRIC

    @property
    def tolerance_sq(self) -> float:
        """与 color_math.distance2 同尺度的阈值: euclidean 为容差平方,
        chebyshev 为容差本身(最大通道差)。"""
        from .color_math import tolerance_sq

        return tolerance_sq(self.tolerance, self.metric)


@dataclass(frozen=True)
class RuleRef:
    rule_id: str
    target: tuple[int, int, int] | None = None
    enabled: bool | None = None
    priority: int | None = None


@dataclass(frozen=True)
class ProtectedRegion:
    kind: str  # rect / circle / mask
    # rect: (x0, y0, x1, y1) 闭区间; circle: (cx, cy, radius)
    geometry: tuple[int, ...] = ()
    mask_path: str | None = None


@dataclass(frozen=True)
class Scheme:
    id: str
    name: str
    rule_refs: tuple[RuleRef, ...]
    # 解析后的有效规则 (已应用覆盖项、已过滤禁用项), 按 (-priority, id) 排序
    rules: tuple[Rule, ...] = field(default=())


@dataclass(frozen=True)
class PaletteConfig:
    matte: tuple[int, int, int] | None
    default_metric: str
    rules: dict[str, Rule]
    schemes: dict[str, Scheme]
    protected: tuple[ProtectedRegion, ...]


def _require(obj: dict, key: str, ctx: str):
    if key not in obj:
        raise ConfigError(f"{ctx} 缺少必填字段 {key!r}")
    return obj[key]


def _parse_rule(raw: dict) -> Rule:
    rid = str(_require(raw, "id", "规则"))
    try:
        source = parse_color(
            _require(raw, "source", f"规则 {rid}"), f"规则 {rid}.source"
        )
        target = parse_color(
            _require(raw, "target", f"规则 {rid}"), f"规则 {rid}.target"
        )
    except ColorSpecError as exc:
        raise ConfigError(str(exc)) from exc
    tol = _require(raw, "tolerance", f"规则 {rid}")
    if not isinstance(tol, (int, float)) or tol < 0:
        raise ConfigError(f"规则 {rid}.tolerance 必须为非负数字")
    priority = raw.get("priority", 0)
    if not isinstance(priority, int):
        raise ConfigError(f"规则 {rid}.priority 必须为整数")
    metric = raw.get("metric", DEFAULT_METRIC)
    if metric not in VALID_METRICS:
        raise ConfigError(
            f"规则 {rid}.metric 只能是 {VALID_METRICS}, 得到 {metric!r}"
        )
    enabled = raw.get("enabled", True)
    if not isinstance(enabled, bool):
        raise ConfigError(f"规则 {rid}.enabled 必须为布尔值")
    return Rule(
        id=rid,
        source=source,
        target=target,
        tolerance=float(tol),
        priority=priority,
        enabled=enabled,
        metric=metric,
    )


def _parse_rule_ref(raw) -> RuleRef:
    if isinstance(raw, str):
        return RuleRef(rule_id=raw)
    if not isinstance(raw, dict) or "id" not in raw:
        raise ConfigError(f"方案 rule_refs 项应为字符串或含 id 的对象, 得到 {raw!r}")
    rid = str(raw["id"])
    try:
        target = (
            parse_color(raw["target"], f"引用 {rid}.target")
            if "target" in raw else None
        )
    except ColorSpecError as exc:
        raise ConfigError(str(exc)) from exc
    enabled = raw.get("enabled")
    if enabled is not None and not isinstance(enabled, bool):
        raise ConfigError(f"引用 {rid}.enabled 必须为布尔值")
    priority = raw.get("priority")
    if priority is not None and not isinstance(priority, int):
        raise ConfigError(f"引用 {rid}.priority 必须为整数")
    return RuleRef(rule_id=rid, target=target, enabled=enabled, priority=priority)


def _parse_protected(raw: dict, base_dir: str) -> ProtectedRegion:
    kind = raw.get("type")
    if kind == "rect":
        for key in ("x0", "y0", "x1", "y1"):
            if not isinstance(raw.get(key), int):
                raise ConfigError(f"保护矩形缺少整数字段 {key!r}")
        x0, y0, x1, y1 = raw["x0"], raw["y0"], raw["x1"], raw["y1"]
        if x1 < x0 or y1 < y0:
            raise ConfigError("保护矩形要求 x1>=x0 且 y1>=y0")
        return ProtectedRegion(kind="rect", geometry=(x0, y0, x1, y1))
    if kind == "circle":
        for key in ("cx", "cy", "radius"):
            if not isinstance(raw.get(key), int) or raw["radius"] < 0:
                raise ConfigError(f"保护圆形字段 {key!r} 非法")
        return ProtectedRegion(
            kind="circle", geometry=(raw["cx"], raw["cy"], raw["radius"])
        )
    if kind == "mask":
        rel = raw.get("path")
        if not isinstance(rel, str):
            raise ConfigError("蒙版保护区域需要字符串字段 path")
        path = rel if os.path.isabs(rel) else os.path.normpath(os.path.join(base_dir, rel))
        return ProtectedRegion(kind="mask", mask_path=path)
    raise ConfigError(f"未知保护区域类型 {kind!r}, 可选 rect/circle/mask")


def load_config(path: str) -> PaletteConfig:
    with open(path, "r", encoding="utf-8") as f:
        try:
            data = json.load(f)
        except json.JSONDecodeError as exc:
            raise ConfigError(f"配色 JSON 解析失败: {exc}") from exc
    if not isinstance(data, dict):
        raise ConfigError("配色 JSON 顶层必须是对象")
    base_dir = os.path.dirname(os.path.abspath(path))

    default_metric = data.get("default_metric", DEFAULT_METRIC)
    if default_metric not in VALID_METRICS:
        raise ConfigError(f"default_metric 只能是 {VALID_METRICS}")

    matte = parse_matte(data.get("matte", "#FFFFFF"))

    rules: dict[str, Rule] = {}
    for raw in data.get("rules", []):
        rule = _parse_rule(raw)
        if rule.id in rules:
            raise ConfigError(f"规则 id 重复: {rule.id!r}")
        rules[rule.id] = rule

    protected = tuple(
        _parse_protected(raw, base_dir) for raw in data.get("protected", [])
    )

    schemes: dict[str, Scheme] = {}
    for raw_scheme in data.get("schemes", []):
        sid = str(_require(raw_scheme, "id", "方案"))
        if sid in schemes:
            raise ConfigError(f"方案 id 重复: {sid!r}")
        refs = tuple(_parse_rule_ref(x) for x in raw_scheme.get("rule_refs", []))
        effective = []
        for ref in refs:
            base = rules.get(ref.rule_id)
            if base is None:
                raise ConfigError(f"方案 {sid} 引用了不存在的规则 {ref.rule_id!r}")
            enabled = base.enabled if ref.enabled is None else ref.enabled
            if not enabled:
                continue
            effective.append(
                Rule(
                    id=base.id,
                    source=base.source,
                    target=ref.target if ref.target is not None else base.target,
                    tolerance=base.tolerance,
                    priority=base.priority if ref.priority is None else ref.priority,
                    enabled=True,
                    metric=base.metric,
                )
            )
        # 排序键与输入顺序无关: 优先级降序, 同优先级按规则 id 字典序
        effective.sort(key=lambda r: (-r.priority, r.id))
        ids = [r.id for r in effective]
        if len(set(ids)) != len(ids):
            raise ConfigError(f"方案 {sid} 内规则引用重复")
        schemes[sid] = Scheme(
            id=sid,
            name=str(raw_scheme.get("name", sid)),
            rule_refs=refs,
            rules=tuple(effective),
        )

    if not schemes:
        raise ConfigError("配色 JSON 至少要定义一个 scheme")
    return PaletteConfig(
        matte=matte,
        default_metric=default_metric,
        rules=rules,
        schemes=schemes,
        protected=protected,
    )


def build_protection_mask(
    protected: tuple[ProtectedRegion, ...], width: int, height: int
) -> bytearray:
    """返回长度 w*h 的掩码, 1 表示受保护。蒙版 PNG 尺寸须与原图一致。"""
    mask = bytearray(width * height)
    for region in protected:
        if region.kind == "rect":
            x0, y0, x1, y1 = region.geometry
            for y in range(max(0, y0), min(height, y1 + 1)):
                start = y * width + max(0, x0)
                end = y * width + min(width, x1 + 1)
                for i in range(start, end):
                    mask[i] = 1
        elif region.kind == "circle":
            cx, cy, radius = region.geometry
            r2 = radius * radius
            for y in range(max(0, cy - radius), min(height, cy + radius + 1)):
                dy = y - cy
                for x in range(max(0, cx - radius), min(width, cx + radius + 1)):
                    dx = x - cx
                    if dx * dx + dy * dy <= r2:
                        mask[y * width + x] = 1
        elif region.kind == "mask":
            assert region.mask_path is not None
            img = read_png(region.mask_path)
            if img.width != width or img.height != height:
                raise ConfigError(
                    f"蒙版 {region.mask_path} 尺寸 {img.width}x{img.height} "
                    f"与原图 {width}x{height} 不一致"
                )
            for i in range(width * height):
                if img.rgba[i * 4 + 3] > 0:
                    mask[i] = 1
    return mask
