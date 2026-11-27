# bg-recolor-tool · 产品图批量背景换色 + 影响范围回看

一套**本地、可离线、核心零第三方依赖**的 Python PNG 工具。针对“背景色和产品边缘 /
产品内同色块 / 透明反光难以区分”的场景，提供：

- 每张图独立的**背景取色点**（多点取邻域中位数）与**保护区域**（矩形 / 多边形 / 椭圆）；
- 可选择只影响与**图边**或**指定种子点****连通**的相似像素；连不通的相似色区域
  **单独记录**（JSON / Markdown / HTML + 变化图上琥珀色标出）；
- 区分**完全透明像素 / 半透明像素 / 不透明像素**，按“合成到旧背景后的外观颜色”
  计算相似度，并输出新图置于**浅底 / 深底**的预览与 2×2 对比图，方便检查边缘；
- **相似范围 `tolerance` + 过渡区间 `feather`** 两个参数；保护区是硬闸门，
  无论容差 / 过渡多大都不会被侵入；`alpha=0` 像素逐字节保留且不进入外观统计；
- 每张图产出**新 PNG、变化区域图、浅/深底预览、2×2 对比、逐图 JSON**，
  批次产出 `report.json / report.md / report.html`（HTML 图集可逐张回看影响范围）；
- **坏图、越界 / 全透明取色点一律隔离**到 `quarantine/`，两阶段原子写入，
  已有的合法结果绝不会被后续失败运行覆写成坏文件；
- 附带一张确定性**合成验证图**，同时包含同色产品块、透明阴影、透明反光、
  1px 细窄连通桥、仅对角接触块、全透明洞和半透明“污染边缘”，可据此核对保护与批处理行为。

> 仓库原有的 `renderer/` Canvas 示例与本工具完全独立，未做任何改动。

---

## 0. 运行环境

- Python **3.9+**；核心只用标准库（自带常用 PNG 编解码，无需 Pillow）。
- 可选：`pip install -r requirements.txt` 安装 `numpy`（加速）与 `pillow`
  （更平滑的标注字体；不装时自动使用内置 5×7 位图字体）。
- 仓库内已建过虚拟环境时，下列命令可把 `python3` 换成 `.venv/bin/python`。

```bash
cd bg-recolor-tool
python3 -m unittest discover -s tests     # 33 个测试，纯标准库可跑
bash run_demo.sh                          # 生成合成图并跑两个示例批次
```

---

## 1. 60 秒上手

```bash
# 1) 生成合成验证图 + 两份示例配置（含一个故意损坏文件、两个无效取色点）
python3 -m bg_recolor make-fixtures --dir examples

# 2) 干净批次：2 张都成功
python3 -m bg_recolor batch examples/config.example.json
open examples/out-example/report.html      # macOS；沙箱里可手动用浏览器打开

# 3) 隔离演示：2 成功 / 3 隔离，命令退出码为 2（表示“有图片被隔离”）
python3 -m bg_recolor batch examples/batch/batch_config.json
```

处理自己的单张图：

```bash
python3 main.py process shot.png \
  --sample 18,18 --sample 462,338 \
  --protect-rect 258,114,346,188 \
  --connectivity edge --neighborhood 4 \
  --metric redmean --tolerance 90 --feather 36 \
  --target '#2F6FDB' \
  --out out --id product-a
```

---

## 2. 配置文件

顶层：

```jsonc
{
  "output_dir": "output",          // 相对路径相对于本配置文件所在目录
  "defaults": { /* 下列任意参数，作为每张图的默认值 */ },
  "images": [ /* 每张图一个条目 */ ]
}
```

每个 `images[]` 条目：

| 字段 | 说明 |
|---|---|
| `id` | 可选，产物文件名前缀；缺省用图片文件名（重名自动加 `-2`） |
| `path` / `file` | PNG 路径，相对路径相对于配置文件目录 |
| `sample_points` / `samples` | `[[x,y], ...]` 背景取色点；坐标为原图像素，越界即判无效并隔离 |
| `background_color` | 可选，直接指定背景色（`#rrggbb` / `[r,g,b]`）；给了取色点时仍会校验点的合法性 |
| `protect` / `protection` / `regions` | 保护区域数组，见下 |
| `connectivity` | `edge`（默认，只影响触边连通域）/ `seeds`（只影响含种子的域）/ `edge_or_seeds` / `off`（全局，不做连通限制） |
| `seeds` / `seed_points` | `seeds` 模式的种子；缺省复用 `sample_points` |
| `neighborhood` | `4`（默认）或 `8`，决定对角接触算不算连通 |
| `metric` | `redmean`（默认，感知加权）/ `rgb`（欧氏距离）/ `max`（最大通道差） |
| `tolerance` | 相似范围外边界（距离单位随 `metric`；`rgb` 满量程 ≈441，`redmean` ≈720） |
| `feather` | 过渡区间宽度；`d ≤ tolerance-feather` 全替换，其间线性过渡，`d = tolerance` 权重为 0 |
| `sample_radius` | 取色点邻域半径，默认 2（5×5），对邻域通道取中位数 |
| `sample_min_alpha` | 邻域中优先采用 `alpha ≥ 该值` 的像素，默认 200；没有时退而使用任意可见像素 |
| `strict_seed` | `true` 时种子没落在相似掩码内直接判该图无效；默认只告警 |
| `target_color` | 新背景色，默认 `#2E6FDB` |
| `light_color` / `dark_color` | 回看用浅/深底色，默认 `#FFFFFF` / `#1A1A1A` |
| `enabled` | 设为 `false` 可在批次中临时跳过 |

保护区域写法（可任意混用、多个并集）：

```jsonc
"protect": [
  { "type": "rect", "xyxy": [258, 114, 346, 188] },   // [x0,y0,x1,y1)
  { "type": "rect", "xywh": [10, 10, 120, 60] },
  { "type": "rect", "x": 0, "y": 0, "width": 40, "height": 30 },
  [0, 0, 100, 40],                                     // 裸四元组 = xyxy 矩形
  { "type": "ellipse", "cx": 60, "cy": 60, "rx": 30, "ry": 18 },
  { "type": "circle", "cx": 60, "cy": 60, "r": 24 },
  { "type": "polygon", "points": [[0,0],[80,10],[40,70]] }
]
```

CLI 里可重复使用 `--protect-rect x0,y0,x1,y1` 与
`--protect-poly x,y;x,y;...`。

---

## 3. 判定与换色语义（为什么边缘更干净、保护区不会被侵入）

对每个像素：

1. **跳过 `alpha = 0`**：权重恒为 0，RGBA 逐字节保留，且不计入任何外观平均值。
2. **半透明像素先合成到取样背景色**再算颜色距离：
   `外观 = (α·RGB + (255-α)·背景色) / 255`。这样“存的是脏边缘色、但视觉上
   融进背景”的抗锯齿 / 反光 / 阴影像素也能被正确识别，而不会因为 RGB 本身偏深被漏掉。
3. 距离 `d` 与 `tolerance / feather` 给出 0..255 的替换权重：
   - `d ≤ tolerance-feather`：权重 255（背景中心区被精确换成目标色）；
   - `tolerance-feather < d < tolerance`：线性过渡，避免硬锯齿；
   - `d ≥ tolerance`：不替换（`d = tolerance` 仍计入“相似连通掩码”，保证边界连通完整）。
4. **连通域过滤**：在 `d ≤ tolerance` 的二值掩码上做两遍扫描 + union-find，
   按 `connectivity` 只保留触边 / 含种子的域。未选中的相似域就是
   “断开的相似颜色”，记录面积、`bbox_xyxy`、质心、是否触边 / 含种子。
5. **保护硬闸门最后执行**：保护掩码内权重一律清零。容差、过渡、连通、全局模式
   都无法改动保护区一个像素（有极端参数的自动化测试守护）。
6. 输出时按整数权重把原 RGB 与目标色混合，**alpha 通道原样保留**。
   因此半透明阴影 / 反光在新底色上依然自然，而不是被填成死色块。

> 优先级：实际修改（红）> 保护拦截的相似色（蓝）> 断开未连通的相似色（琥珀）。

---

## 4. 输出物

```
<output_dir>/
├─ report.html                 # ★ 图集式报告：每张图的 2×2 对比 + 变化图 + 深浅底
├─ report.md                   # 同样信息的 Markdown 版（含断开区域表）
├─ report.json                 # 批次完整机器可读报告
├─ processed/<id>.new.png      # 新 PNG（保留原 alpha）
├─ changes/<id>.change.png     # 变化区域图（红=实际影响，蓝=保护拦下，琥珀=断开同色）
├─ review/<id>.light.png       # 新 PNG 置于浅底
├─ review/<id>.dark.png        # 新 PNG 置于深底
├─ review/<id>.compare.png     # 原图/新图 × 浅底/深底 2×2 对比
├─ reports/<id>.json           # 逐图报告
└─ quarantine/
   ├─ files/<id>__<原文件名>   # 坏图 / 无效样本的源文件隔离副本
   └─ errors/<id>.error.json   # 失败原因代码 + 完整条目配置
```

逐图报告里值得重点看的字段：

- `counts`：`fully_transparent_pixels`、`semitransparent_pixels`、`opaque_pixels`、
  `changed_semitransparent_pixels`、`protected_similar_pixels`、
  `disconnected_similar_pixels`、`mean_rgb_visible_before/after`
  （均值只统计 `alpha>0`）、`changed_transparent_violations`（测试要求恒为 0）；
- `edge_shift_on_light / edge_shift_on_dark`：半透明且近似背景的边缘带，
  在浅 / 深底上合成色的平均与最大偏移，用来量化“边缘变化”；
- `components / disconnected_components`：每个相似连通域的面积、包围盒、质心等；
- `sample_infos`：每个取色点实际采用了邻域内多少像素、采到什么颜色。

### 失败原因代码

| `reason_code` | 含义 |
|---|---|
| `file_not_found` | 路径不存在 / 不可读 |
| `unreadable_image` | 不是合法 PNG 或解码失败（坏图） |
| `invalid_sample_point` | 取色 / 种子坐标越界或格式错 |
| `invalid_sample_transparent` | 取色邻域内没有任何可见像素（全透明） |
| `seed_not_in_similar` | 严格模式下种子没落在相似掩码内 |
| `invalid_config` | 参数 / 保护区域配置非法 |
| `processing_error` | 其他未预期错误（仍会隔离，不影响批次内其他图） |

CLI 退出码：`0` 全部成功；`2` 存在被隔离图片；`1` 配置 / 命令本身错误。

### 写入安全

每张图的 6 个产物先在内存里编码 → 写到同目录临时文件 → 两阶段 `os.replace`
提交；批次报告同样原子替换。失败路径**完全不会触碰** `processed/<id>.new.png`
等合法产物，因此“上一次成功结果”不会被这一次的坏图 / 坏取色点覆写
（有专门的回归测试：成功 → 同 id 越界取色点重跑 → 旧 PNG 字节级不变且仍可解码）。
此时 `reports/<id>.json` 也保留为与那张旧 PNG 对应的成功报告；本次失败以批次
`report.json` 中的 `error` 条目和 `quarantine/errors/<id>.error.json` 为准。

---

## 5. 合成验证图（需求 5）

`make-fixtures` 生成的 `examples/synthetic_scene.png`（480×360，无随机数）刻意布置：

| 元素 | 位置（中心 / 区域） | 用来验证 |
|---|---|---|
| 同色产品块 **P** | `[140,120,216,182]` | 被产品色包围 → edge 模式下琥珀“断开记录”，不改 |
| 同色产品块 **Q** | `[264,120,340,182]` | 落在保护矩形 `[258,114,346,188]` 内 → 蓝色，任何参数下不改 |
| 同色块 **R** | `[150,214,212,266]` | 经一条 **1px 高**的同色桥 `y=239, x∈[212,373)` 连到外部背景 → 连通替换 |
| 对角接触块 **S** | `[111,61,132,82]` | 仅通过角点 `(110,60)` 与背景对角相接：4 邻接断开、8 邻接连通 |
| 透明阴影 | 椭圆中心 `(242,306)` | 黑色 alpha 径向渐变（真 alpha 通道），深浅底表现不同 |
| 透明反光 | 椭圆中心 `(72,330)` | 低 alpha 白色 |
| 全透明洞 | 圆心 `(424,42), r=15` | RGB 故意为 `(255,0,255)` 脏色；必须逐字节保留且不影响均值 |
| 半透明污染边缘 | `x=370, y=120..199` | 存“与旧背景混合后的色 + 部分 alpha”，检验边缘识别 / 深浅底变化 |

`examples/batch/batch_config.json` 是 5 条目的批次：两张合法图（分别演示
`edge` 与 `seeds` 模式）、一个文本伪装的 `corrupt.png`、一个越界取色点、
一个点在全透明洞中心的取色点。预期 **2 成功 / 3 隔离，退出码 2**。

---

## 6. 测试

```bash
python3 -m unittest discover -s tests -v
# 或在 .venv 中：
.venv/bin/python -m pytest tests -q
```

33 个用例覆盖：PNG 往返 / 损坏与截断拒绝 / Pillow 多变体互通（装了 Pillow 才跑）、
容差与过渡边界、numpy 与纯 Python 双实现逐像素一致、全透明保留与统计排除、
半透明分类、保护区域在极端参数下零侵入、edge/seeds/off 连通、4/8 邻接对角差异、
取色点校验、全部产物可回读、坏图 / 无效样本隔离、**合法旧产物不被覆写**、
无临时文件残留、CLI 与合成图几何断言。已在 Python 3.9（纯标准库）与
Python 3.14（含 numpy/Pillow）下分别跑通。

---

## 7. 目录结构

```
bg-recolor-tool/
├─ bg_recolor/
│  ├─ pngcodec.py      # 标准库 PNG 解码(多色型/位深/tRNS) + RGBA 编码
│  ├─ colors.py        # 颜色解析、redmean/rgb/max 距离、alpha 合成
│  ├─ accel.py         # 像素热循环：纯 Python 参考实现 + 可选 numpy
│  ├─ masks.py         # rect/polygon/ellipse 解析与光栅化、点校验
│  ├─ connectivity.py  # 两遍 union-find 连通域（4/8 邻接）
│  ├─ engine.py        # 取色 / 相似度权重 / 分析 / 换色 / 统计
│  ├─ artifacts.py     # 变化图、深浅底预览、2×2 对比（可选 Pillow 标注）
│  ├─ mini_font.py     # 无 Pillow 时的内置位图字体
│  ├─ report.py        # report.md / report.html
│  ├─ pipeline.py      # 配置合并、逐图隔离、原子提交、批次 report.json
│  ├─ synthetic.py     # 合成验证图 + 示例配置生成
│  └─ cli.py           # batch / process / make-fixtures
├─ tests/              # 33 个 unittest（pytest 也可直接跑）
├─ examples/           # make-fixtures 生成；当前已含一份生成好的结果可直接看
├─ main.py             # 免 -m 的入口
├─ run_demo.sh
└─ requirements.txt    # 可选项 numpy / pillow
```
