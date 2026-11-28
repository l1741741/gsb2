# 离线画幅巡检工具（aspect_inspector）

对比**母版**与**转码交付文件**的有效画面边界，定位持续的画幅变化和双片差异，
输出结构化 JSON 报告、可离线打开的 HTML 报告，以及带双方边界框的并排截图。

- 纯 Python 标准库实现，**零第三方依赖**（无需 numpy/PIL，不联网安装包）；
- 所有解码、旋转/SAR 校正、截图均通过本机 `ffmpeg`/`ffprobe` 子进程完成；
- 只读输入素材，**绝不修改原文件**；所有产物写到指定输出目录。

## 适用问题

视频巡检里，画面明明有同一套测试标记，报告却常把这些误算成画幅错误：

- 片头黑场、整段全黑窗；
- 淡入淡出过程中的暗帧；
- 烧录在大黑边上的少量文字/时间码；
- 单个孤立全黑帧。

本工具通过黑帧剔除、自适应亮度阈值、时间维中值滤波和证据门槛，
避免上述情况把整段结论带偏；采样证据不足时一律标为**待确认**，不下确定性结论。

## 目录结构

```
aspect_inspect.py              # CLI 入口
aspect_inspector/
  probe.py                     # ffprobe 元数据：旋转(Display Matrix)、SAR、显示坐标
  ffmpeg_runner.py             # 灰度帧解码、显示校正、边界框/并排截图
  analysis.py                  # 黑帧判定、内容边界提取、时序分段
  compare.py                   # 双片逐窗对比、持续差异/待确认判定
  report.py                    # JSON + 离线 HTML 报告
  inspector.py                 # 编排与 CLI 参数
  synth_fixtures.py            # 用 ffmpeg 自生成测试小视频
tests/run_selftest.py          # 离线自验（标准库 unittest）
```

## 使用

### 基本用法

```bash
# 命令行直接给抽检时间窗：id=开始秒-结束秒
python3 aspect_inspect.py 母版.mp4 交付版.mp4 \
    --windows "w1=0-2,w2=5-8" --out report_dir

# 或用 JSON 配置文件
python3 aspect_inspect.py 母版.mp4 交付版.mp4 \
    --config windows.json --out report_dir
```

`windows.json` 格式：

```json
[
  {"id": "片头", "start": 0.0, "end": 2.0},
  {"id": "正片", "start": 10.0, "end": 18.0}
]
```

不提供时间窗时，按片长每 10 秒自动切窗。

### 主要参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--sample-fps` | 10 | 窗内采样帧率 |
| `--analysis-width` | 480 | 分析用缩放宽度（像素，越小越快） |
| `--bbox-tolerance` | 0.03 | 归一化边界差异容差（0~1） |
| `--out` | aspect_report | 报告输出目录 |

### 输出产物

```
report_dir/
  report.html        # 离线单文件报告，无任何外部网络引用
  report.json        # 结构化结果，含源片绝对路径，可定位回原片
  screenshots/       # 差异/切换/待确认窗的并排截图（左母版绿框，右交付橙框）
```

## 判定口径

每个时间窗输出一个结论（`diff_type`）：

| 结论 | 含义 |
| --- | --- |
| `match` | 双方有效画面边界一致 |
| `bounds_diff` | 边界存在**持续**差异（超过容差且持续足够多帧） |
| `aspect_switch` | 至少一方在窗内发生画幅切换（分段数 ≥ 2） |
| `all_black` | 双方整窗全黑，无画面可比，**不计为错误** |
| `insufficient` | 采样/有效帧不足，**待确认** |
| `geometry_mismatch` | 显示几何（旋转/SAR/DAR）元数据不一致 |

每条结论带 `confirmed` 字段；证据不足时为 `false`（待人工确认）。

## 关键设计

### 旋转与非方形像素 → 显示坐标

- 用 `-noautorotate` 关闭 ffmpeg 自动旋转，读取 Display Matrix side data
  的 `rotation`（ffmpeg 9 的 ffprobe compact 输出）与水平翻转标记；
- 在滤镜链里显式 `transpose` 应用旋转，再按显示宽高比 `scale` 做 SAR 校正、
  强制 `setsar=1`，后续所有边界都在统一的**方形像素显示坐标**里比较；
- ffprobe 的比例用冒号（`4:3`），解析时统一转成斜杠再交给 `Fraction`。

### 抗干扰

- **黑帧**：均值与峰值都低于阈值才判黑，黑帧不参与边界统计，只汇总成黑场区间；
- **暗帧/淡入淡出**：阈值以全帧亮度中位数为锚，暗内容仍能检出完整边界；
- **黑边文字**：要求内容行/列具备最小连续带宽度，孤立细亮条（字幕、时间码）
  无法把边界撑开；内容内部的暗列/暗行通过小间隙桥接合回主内容块；
- **瞬时抖动**：bbox 时间序列先中值滤波，分段后再做合并轮询，
  1~3 帧的抖动被吸收，持续的真画幅切换（两个长且差距明显的段）保留。

## 离线自验

自验会用 ffmpeg **自生成**小型测试视频（落在临时目录，不读取/修改任何既有素材），
覆盖恒定边框、片中画幅切换、全黑窗/片头黑场/孤立黑帧、90° 旋转 + 非方形像素：

```bash
python3 tests/run_selftest.py            # 自动建临时目录
python3 tests/run_selftest.py /path/dir # 指定目录，便于查看生成的素材与报告
```

18 个用例全部通过即表示安装与核心逻辑正常。

## 环境要求

- Python 3.10+（仅标准库）；
- 本机 `ffmpeg` 与 `ffprobe`（需含 `drawbox`、`hstack`、`transpose`、`scale`、
  `overlay`、`concat` 等常用滤镜；不依赖 `drawtext`）。
