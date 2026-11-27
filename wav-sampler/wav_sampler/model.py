"""核心数据模型: 清单、段落、取样范围、运行段与诊断。"""

from __future__ import annotations

from dataclasses import dataclass, field

# 运行段种类
KIND_SOURCE = "source"       # 由某个源文件提供样本
KIND_OVERLAP = "overlap"     # 多段重叠, 按优先级选出获胜段
KIND_SILENCE = "silence"     # 时间轴空洞, 补静音

# 诊断级别
LEVEL_ERROR = "error"
LEVEL_WARNING = "warning"


@dataclass(frozen=True)
class SegmentSpec:
    """段落清单中的一行: 一个 WAV 文件在项目时间轴上的位置。"""

    segment_id: str
    path: str
    start_frame: int          # 文件首帧对应的项目帧
    declared_frames: int | None  # 清单声明的有效帧数; None 表示以文件实际长度为准
    priority: int = 0         # 越大越优先
    channel_map: tuple[int, ...] | None = None  # 每输出声道取哪个源声道; None 用默认映射


@dataclass(frozen=True)
class RangeSpec:
    """一个导出范围 (半开区间 [start_frame, end_frame))。"""

    range_id: str
    start_frame: int
    end_frame: int
    output_name: str


@dataclass(frozen=True)
class Manifest:
    sample_rate: int
    output_channels: int
    segments: tuple[SegmentSpec, ...]
    ranges: tuple[RangeSpec, ...]
    output_sample_width: int | None = None


@dataclass(frozen=True)
class ResolvedSegment:
    """段落与实际 WAV 头信息核对后的结果。"""

    spec: SegmentSpec
    actual_frames: int
    channels: int
    sample_width: int
    effective_start: int          # 有效区间起点 (项目帧)
    effective_end: int            # 有效区间终点 (项目帧, 半开)
    declared_end: int | None      # 清单声明的终点
    channel_map: tuple[int, ...]  # 实际生效的每输出声道 -> 源声道映射


@dataclass(frozen=True)
class Run:
    """一次导出范围内连续同质的一段 (provenance 最小单元)。

    帧坐标均为项目时间轴上的绝对帧, 区间半开 [start_frame, end_frame)。
    """

    start_frame: int
    end_frame: int
    kind: str
    segment_id: str | None = None
    # 当来自源文件时, 源文件内的起始帧 (含) 与结束帧 (不含)
    source_start_frame: int | None = None
    source_end_frame: int | None = None
    # 该段内实际参与竞争的所有段落 (重叠时多于 1 个), 按优先级排序
    contenders: tuple[str, ...] = ()


@dataclass(frozen=True)
class Diagnostic:
    """定位到源文件与项目时间的诊断条目。

    affected_interval 为该问题在项目时间轴上的无数据/失效区间 (半开, 帧);
    None 表示无法用区间界定 (如整文件不可读), 保守视为影响全部范围。
    """

    level: str
    code: str
    segment_id: str | None
    path: str | None
    project_frame: int | None
    message: str
    affected_interval: tuple[int, int] | None = None


@dataclass
class RangeResult:
    """单个导出范围的处理结果。"""

    range_id: str
    output_name: str
    start_frame: int
    end_frame: int
    runs: tuple[Run, ...] = ()
    diagnostics: list[Diagnostic] = field(default_factory=list)
    output_path: str | None = None
    status: str = "pending"      # delivered / rejected / skipped_exists
    frames_written: int = 0


@dataclass
class ExportRecord:
    """一次完整导出的汇总结果。"""

    sample_rate: int
    output_channels: int
    output_sample_width: int
    results: list[RangeResult] = field(default_factory=list)
    diagnostics: list[Diagnostic] = field(default_factory=list)
    segments: list[ResolvedSegment] = field(default_factory=list)

    @property
    def delivered(self) -> list[RangeResult]:
        return [r for r in self.results if r.status == "delivered"]

    @property
    def rejected(self) -> list[RangeResult]:
        # 仅含真正不合法而被拒绝的范围; skipped_exists 是有意保护已有文件
        return [r for r in self.results if r.status == "rejected"]

    @property
    def skipped(self) -> list[RangeResult]:
        return [r for r in self.results if r.status == "skipped_exists"]
