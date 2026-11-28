# thermal_align — 红外/可见光对应点配准与叠图工具

一个**纯本地、只依赖 numpy + Pillow** 的 Python 命令行工具。它不做任何自动
特征提取，**只处理用户在点表中亲手给出的对应点**，把红外 16 位热图对齐到
可见光参考图，并交付彩色叠图、对齐后的 16 位图和有效覆盖掩模。

## 设计原则（对应需求）

1. **输入与原值**：可见光普通 PNG、红外 **16 位灰度 PNG**、对应点表（CSV/TSV）。
   热图读出后全程保持 `uint16` 原始热值，伪彩色和阈值只作用于预览副本。
2. **显式失败，不静默错位**：仿射拟合覆盖旋转、缩放、平移、轻微倾斜（剪切）。
   点数不足、近乎共线、条件数过大、矩阵退化或坏控制点时，带可读诊断直接失败，
   **不产出任何错位文件**。
3. **范围外与有效零值严格区分**：输出画布与可见光同尺寸。范围外像素在掩模中为
   `False`，在 16 位图中写**哨兵值**（默认自动挑选热图中未出现的值，优先 65535）；
   掩模为 `True` 的 `0` 才是真实采集到的零值。掩模是判定有效性的唯一权威。
4. **热值范围只改预览**：`--vmin/--vmax` 仅决定伪彩归一化；`preview` 子命令可
   反复重渲染，对齐 16 位图逐位不变（有 md5 测试守护）。
5. **自带合成样例与独立检查**：`sample` 生成棋盘/角标样例，点表含 `fit` 与
   `holdout` 两组；`holdout` 点不参与拟合，专门报告独立偏差。内置
   `normal` / `no-overlap` / `bad-point` 三种场景。

## 安装

需要 Python 3.10+。建议用虚拟环境（仓库内 `.venv/` 已被 git 忽略）：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
# 若处于 TLS 拦截代理后，可加：
#   --trusted-host pypi.org --trusted-host files.pythonhosted.org
```

运行测试与命令时把仓库根目录加入 `PYTHONPATH`（无需安装包）：

```sh
export PYTHONPATH="$PWD"
.venv/bin/python tests/run_tests.py
```

## 对应点表怎么填

UTF-8 文本，逗号分隔（`.tsv` 后缀则按制表符分隔），`#` 注释、空行忽略，
首行可以是表头。固定五列，可选第六列：

```
label, vis_x, vis_y, ir_x, ir_y, use
P01, 120, 88, 47.25, 31.10, fit
P02, 400, 88, 196.40, 33.70, fit
P03, 400, 360, 198.10, 174.20, holdout
```

**坐标约定（两张图一致）**：

- 单位是**像素**，原点在图像**左上角**；
- `x` 沿列向右增大，`y` 沿行向下增大；允许小数（亚像素）；
- `vis_x,vis_y` 填可见光图上的位置，`ir_x,ir_y` 填红外图上**同一个物理位置**；
- 两列不要填反——填反通常表现为覆盖率为 0 的「无重叠」报错；
- `use=fit`（默认）参与拟合；`use=holdout` 只做独立偏差检查、不参与拟合。
  建议至少留 2~4 个散开的 holdout 点。

控制点请**散开覆盖画面、不要共线**；仿射至少需要 3 个不共线 fit 点，
实际建议 8 个以上，坏点检测才有足够冗余。

## 三个子命令

### 1. 生成合成样例

```sh
.venv/bin/python -m thermal_align sample --out-dir sample_data --scenario normal
# scenario: normal（正常）| no-overlap（无重叠）| bad-point（一个坏控制点）
```

### 2. 配准并导出全部产物

```sh
.venv/bin/python -m thermal_align align \
  --visible sample_data/visible_normal.png \
  --thermal sample_data/thermal_normal.png \
  --points  sample_data/points_normal.csv \
  --out-dir output --name pair
```

输出（`--name pair` 为前缀）：

| 文件 | 内容 |
| --- | --- |
| `pair_aligned_uint16.png` | 对齐到可见光画布的 **16 位**热图，范围外写哨兵值 |
| `pair_coverage_mask.png`  | 8 位掩模，有效覆盖=255，范围外=0 |
| `pair_overlay.png`        | 可见光 + 伪彩热图的彩色叠图 |
| `pair_preview.png`        | 黑底伪彩预览 |
| `pair_meta.json`          | 仿射参数、逐点残差、holdout 偏差、覆盖率、哨兵值等 |

常用开关：`--vmin/--vmax`（仅预览热值范围）、`--alpha`（叠图透明度 0~1）、
`--sentinel`（手动指定哨兵值）、`--drop-outliers`（自动剔除坏控制点后重拟合）。

### 3. 只调预览，不动对齐图

```sh
.venv/bin/python -m thermal_align preview \
  --aligned output/pair_aligned_uint16.png \
  --mask    output/pair_coverage_mask.png \
  --meta    output/pair_meta.json \
  --visible sample_data/visible_normal.png \
  --output  output/pair_overlay_narrow.png \
  --vmin 3000 --vmax 3500
```

`--mask` 给出时以掩模为准；不给掩模时按**哨兵值**推断范围外。哨兵值优先级：
`--sentinel` 显式指定 > `--meta` 中 `meta.json` 记录的真实哨兵 > 默认 65535。
注意 align 自动挑选的哨兵不一定是 65535，因此省略 `--mask` 时建议同时给 `--meta`，
否则若真实哨兵不是 65535 会把有效像素误判成范围外。`--points` 在 preview 中
仅用于留档、可省略。

## 失败语义与退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 输入错误（点表/图像无法读取、坐标非法） |
| 3 | 配准失败（点数不足、共线、病态、坏控制点） |
| 4 | 叠图失败（变换后完全无重叠等） |

任何非 0 退出都**不会写出对齐文件**，避免把错位结果当成交付物。

## 保原值与零值区分的验证

- 重采样采用**最近邻**，不插值、不平均；测试断言对齐图有效区的取值集合是
  源热值集合的子集。
- 16 位 PNG 无损往返有单元测试（含 0 与 65535 边界值）。
- `meta.json` 记录 `effective_zero_pixels`（掩模内真实零值个数）、
  `outside_pixels`（范围外个数）与 `sentinel_value`。

## 目录结构

```
thermal_align/
  points.py    点表读写、坐标约定与校验
  geometry.py  仿射拟合、共线/病态诊断、残差与坏点检测、holdout 偏差
  imaging.py   16 位灰度 PNG / 普通 PNG 读写（保原值）
  warp.py      最近邻重采样、覆盖掩模、哨兵选择
  colormap.py  仅用于预览的铁红伪彩色
  overlay.py   彩色叠图与可调热值范围（不改热值）
  samplegen.py 棋盘/角标合成样例与三种场景
  cli.py       命令行入口
tests/         unittest 测试（28 个），tests/run_tests.py 运行
```
