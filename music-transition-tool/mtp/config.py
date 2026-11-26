"""素材库配置与加载。

assets.json 结构见 examples/assets.json。每个素材可配置：
- file:         本地 WAV（相对 assets.json 所在目录）
- loop:         [loop_start, loop_end) 采样，右端开区间；不填表示一次性素材
- entry_sample: 入场点（与计划转场同步点对齐的源采样）
- beats:        拍点采样列表（仅用于核对/报告，不参与拉伸）
- verify:       可选，第一拍落点检测模板配置
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .errors import AssetError, PlanError
from .source import LoopSource
from .wavio import WavData, read_wav


@dataclass
class AssetConfig:
    id: str
    file: str
    path: Path
    loop_start: int | None
    loop_end: int | None
    entry_sample: int
    beats: list = field(default_factory=list)
    verify: dict = field(default_factory=dict)
    raw: dict = field(default_factory=dict)

    @property
    def has_loop(self) -> bool:
        return self.loop_start is not None

    @property
    def loop_length(self) -> int | None:
        if self.loop_start is None:
            return None
        return self.loop_end - self.loop_start


@dataclass
class LoadedAsset:
    cfg: AssetConfig
    wav: WavData
    source: LoopSource


def load_json(path) -> dict:
    p = Path(path)
    try:
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError as exc:
        raise PlanError("文件不存在: %s" % p) from exc
    except json.JSONDecodeError as exc:
        raise PlanError("JSON 解析失败 %s: %s (line %d col %d)"
                        % (p, exc.msg, exc.lineno, exc.colno)) from exc


def parse_asset_config(aid: str, raw: dict, base_dir: Path) -> AssetConfig:
    if "file" not in raw:
        raise AssetError("素材缺少 file 字段", asset_id=aid)
    rel = raw["file"]
    path = (base_dir / rel).resolve()

    loop = raw.get("loop")
    l0 = l1 = None
    if loop is not None:
        if not (isinstance(loop, list) and len(loop) == 2):
            raise AssetError("loop 必须是 [start, end] 两元素数组", asset_id=aid)
        l0, l1 = int(loop[0]), int(loop[1])
        if not (0 <= l0 < l1):
            raise AssetError("loop 需满足 0 <= start < end，实际 %r" % loop, asset_id=aid)

    if "entry_sample" in raw:
        entry = int(raw["entry_sample"])
    elif l0 is not None:
        entry = l0
    else:
        entry = 0

    beats = [int(x) for x in raw.get("beats", [])]
    beats = sorted(set(beats))

    return AssetConfig(
        id=aid,
        file=rel,
        path=path,
        loop_start=l0,
        loop_end=l1,
        entry_sample=entry,
        beats=beats,
        verify=dict(raw.get("verify", {})),
        raw=raw,
    )


def load_asset_configs(assets_path) -> tuple[dict, Path, dict]:
    """返回 (configs_by_id, base_dir, assets_doc)。"""
    p = Path(assets_path).resolve()
    doc = load_json(p)
    base_dir = p.parent
    raw_assets = doc.get("assets")
    if not isinstance(raw_assets, dict) or not raw_assets:
        raise PlanError("assets 文件需要非空的 \"assets\" 对象: %s" % p)
    configs = {}
    for aid, raw in raw_assets.items():
        if not isinstance(raw, dict):
            raise PlanError("素材 %r 配置必须是对象" % aid)
        configs[aid] = parse_asset_config(aid, raw, base_dir)
    return configs, base_dir, doc


class Registry:
    """按 id 懒加载 WAV，并把素材错误包装到请求它的转场上下文上。"""

    def __init__(self, configs: dict, expected_sample_rate: int | None = None,
                 sample_rate_from_doc: int | None = None):
        self.configs = configs
        self.expected_sample_rate = expected_sample_rate or sample_rate_from_doc
        self._loaded: dict[str, LoadedAsset] = {}

    def sample_rate(self) -> int:
        if self.expected_sample_rate is not None:
            return self.expected_sample_rate
        # 没指定就用第一个素材的采样率
        first_id = next(iter(self.configs))
        return self.get(first_id).wav.sample_rate

    def get(self, asset_id: str, transition_id: str | None = None,
            cue_id: str | None = None) -> LoadedAsset:
        if asset_id not in self.configs:
            raise PlanError(
                "计划引用了未在 assets 中配置的素材 %r" % asset_id,
                transition_id=transition_id, cue_id=cue_id,
            )
        if asset_id in self._loaded:
            return self._loaded[asset_id]
        cfg = self.configs[asset_id]
        try:
            if not cfg.path.is_file():
                raise AssetError("WAV 文件不存在: %s" % cfg.path,
                                 asset_id=asset_id, path=str(cfg.path))
            wav = read_wav(str(cfg.path))
            if self.expected_sample_rate is not None and \
                    wav.sample_rate != self.expected_sample_rate:
                raise AssetError(
                    "采样率不一致：计划/首个素材为 %d Hz，该 WAV 为 %d Hz"
                    "（本工具不做重采样，请先转换素材）"
                    % (self.expected_sample_rate, wav.sample_rate),
                    asset_id=asset_id, path=str(cfg.path),
                )
            self._validate_against_wav(cfg, wav)
            loaded = LoadedAsset(cfg=cfg, wav=wav, source=LoopSource(cfg, wav))
        except AssetError as exc:
            # 让错误能定位到正在等待该素材的转场
            raise PlanError(
                "素材 %r 不可用：%s" % (asset_id, exc),
                transition_id=transition_id, cue_id=cue_id,
            ) from exc
        except ValueError as exc:
            raise PlanError(
                "素材 %r 的 WAV 无法读取：%s" % (asset_id, exc),
                transition_id=transition_id, cue_id=cue_id,
            ) from exc
        self._loaded[asset_id] = loaded
        return loaded

    @staticmethod
    def _validate_against_wav(cfg: AssetConfig, wav: WavData):
        n = wav.n_frames
        if cfg.entry_sample < 0 or cfg.entry_sample >= n:
            raise AssetError(
                "entry_sample=%d 超出 WAV 范围 [0,%d)" % (cfg.entry_sample, n),
                asset_id=cfg.id,
            )
        if cfg.has_loop:
            if cfg.loop_end > n:
                raise AssetError(
                    "loop 右端 %d 超过 WAV 帧数 %d" % (cfg.loop_end, n),
                    asset_id=cfg.id,
                )
            if not (cfg.loop_start <= cfg.entry_sample < cfg.loop_end):
                raise AssetError(
                    "entry_sample=%d 必须落在 loop [%d,%d) 内，循环回头时才能对齐"
                    % (cfg.entry_sample, cfg.loop_start, cfg.loop_end),
                    asset_id=cfg.id,
                )
        for b in cfg.beats:
            if b < 0 or b >= n:
                raise AssetError(
                    "拍点 %d 超出 WAV 范围 [0,%d)" % (b, n), asset_id=cfg.id
                )

    def transition_using_asset_ids(self, asset_id: str) -> list:
        """辅助：哪些已解析转场用到某素材（timeline 构建后填充更准确）。"""
        return []
