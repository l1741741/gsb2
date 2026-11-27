# shotindex — 离线镜头边界审片工具

给长素材做镜头索引：用本机 ffmpeg 抽帧，纯 Python（仅标准库，无第三方依赖）检测
候选镜头边界，人工确认后导出镜头区间、代表画面缩略图和人工修改记录。

## 环境要求

- Python 3.8+（不需要 numpy / PIL 等任何第三方包）
- 本机 `ffmpeg` / `ffprobe` 在 PATH 中

## 快速开始

```bash
cd shotindex

# 1. 生成样例素材（硬切 / 渐变 / 单帧闪光 / 0.6s 短镜头）和真值表
python3 -m shotindex samples --out /tmp/si/samples

# 2. 全片扫描，建立项目文件
python3 -m shotindex scan /tmp/si/samples/mixed.mp4 --project /tmp/si/proj.json

# 3. 用真值表核对检测结果（样例专用）
python3 -m shotindex check --project /tmp/si/proj.json /tmp/si/samples/ground_truth.json

# 4. 生成 HTML 审片报告：每条边界两侧画面 + 判断依据，浏览器打开翻看
python3 -m shotindex report --project /tmp/si/proj.json --out /tmp/si/report

# 5. 人工编辑（记录 ID 见报告或 status）
python3 -m shotindex status  --project /tmp/si/proj.json
python3 -m shotindex confirm --project /tmp/si/proj.json b0001
python3 -m shotindex delete  --project /tmp/si/proj.json b0004 --reason "实测不是切镜"
python3 -m shotindex restore --project /tmp/si/proj.json b0007   # 恢复被抑制的短镜头
python3 -m shotindex add     --project /tmp/si/proj.json --time 5.5 --type cut --note "补录"
python3 -m shotindex note    --project /tmp/si/proj.json b0002 "待复核"

# 6. 只重扫一段（段外人工编辑保留，落在重扫边缘的记录打 edge 标记）
python3 -m shotindex scan --project /tmp/si/proj.json --start 8 --end 15

# 7. 导出镜头区间（覆盖首尾）、代表画面、人工修改记录
python3 -m shotindex export --project /tmp/si/proj.json --out /tmp/si/export
```

## 检测逻辑

对缩小灰度帧（128×72）计算 64 bin 亮度直方图，以相邻帧直方图差为变化量，
先把间隔 ≤2 帧的相邻超限段合并成“变化窗口”，再分类：

| 类型 | 判定 | 记录 |
|---|---|---|
| 硬切 `cut` | 窗口 ≤2 帧且峰值 ≥ `t_hard`，且前后画面不同 | 发生时刻 |
| 渐变 `gradual` | 窗口持续 ≥ `min_gradual_frames` 帧 | 起止范围 |
| 闪光/短遮挡 `flash` | 短促突变，但窗口前后两帧画面相似（差 < `t_same`），即画面很快回到原样 | 单独标识，不当作切镜 |

单帧闪光会产生“去程+回程”两个尖峰，窗口合并保证它被当作一个事件整体判断。

## 可调参数（scan 命令）

`--t-hard`（0.45）硬切阈值；`--t-soft`（0.12）渐变持续阈值；
`--t-same`（0.15）“回到原画面”相似阈值；`--min-gradual-frames`（3）渐变最少帧数；
`--min-gap`（1.0）临近候选抑制窗口（秒）。

**临近抑制**：`min_gap` 秒内只保留分数最高的候选，其余标记 `suppressed`。
被抑制的记录不删除——报告里单独列出（含两侧画面），可用 `restore` 恢复，
因此真正相邻的两个短镜头（如样例中 0.6s 一个的短镜头）仍可检查。

## 人工编辑与重扫

- 记录状态：`candidate`（候选）/ `confirmed` / `deleted` / `added`（人工补录）/ `suppressed`。
- 重扫一段时：范围内未被人工碰过的旧自动记录被新结果替换；
  **人工记录（confirmed / deleted / added）即使落在范围内也保留可见**；
  落在重扫范围边缘 ±0.5s 内的旧记录不删除，打 `edge` 标记提示人工核对。
- 每次人工操作都写入审计日志，随 `export` 导出为 `edits.csv`。

## 导出内容（export）

- `shots.csv` / `shots.json`：按时间排序的镜头区间，**首段从 0 开始、末段到片尾结束**；
- `thumbs/shot_XXXX.jpg`：每个区间中点的代表画面；
- `edits.csv`：人工修改记录；`audit.json`：完整审计日志（含扫描参数）。

## 素材替换

每次打开项目都会校验素材指纹（大小 + mtime + 头部 1MB 的 sha1）。
素材被替换时，所有记录（含人工确认/补录）自动标记 `stale` 并提醒重审，
`status` 会列出受影响的记录 ID。

## 样例与核对

`samples` 生成的 `ground_truth.json` 给出每类事件的实际发生位置（秒）：
硬切 4.0s、渐变 9.0–10.0s、单帧白闪 14.0s、0.6s 短镜头连切 16.04/16.64/17.24/17.84s。
`check` 命令按容差（默认 ±0.25s）逐条比对扫描结果，漏检时退出码为 1。

## 目录结构

```
shotindex/
├── shotindex/
│   ├── __main__.py   # 命令行入口
│   ├── media.py      # ffprobe/ffmpeg 封装：信息、指纹、抽帧、缩略图
│   ├── detect.py     # 直方图检测：硬切/渐变/闪光 + 临近抑制
│   ├── project.py    # 项目文件、人工编辑、重扫合并、素材替换检测
│   ├── export.py     # 镜头区间/代表画面/人工修改记录导出
│   ├── report.py     # HTML 审片报告
│   └── samples.py    # 样例素材生成（含真值表）
└── README.md
```
