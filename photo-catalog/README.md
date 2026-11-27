# 照片目录候选整理工具（photo-catalog）

为资料馆的照片目录提供一个**本地、离线、只提建议不自动合并**的候选整理工具。
它扫描一个目录，找出可能是同一张照片的不同版本（缩放、裁边、调色），
把相似原因、并排预览和归档建议写进报告，最终由人决定哪些合并。

原图始终保持原路径可访问，工具从不移动、改名或删除任何文件。

## 环境要求

- Python 3.11 及以上。
- **无需任何第三方包**：图像解码、相似度计算、报告生成都用标准库实现。
- 可选：若系统已安装 `ffmpeg` 或 macOS 的 `sips`，工具会用它们解码纯 Python
  解码器不支持的格式（如 WEBP、HEIC）；没有也不影响主要功能。

## 快速开始

```sh
# 生成自带的样例照片集（见下文“样例”一节）
python3 -m photocatalog.samples_cli --out samples

# 扫描目录并生成报告（默认输出到 ./photo-catalog-report）
python3 -m photocatalog scan samples -o report
```

产物（都在输出目录内）：

- `report.html` —— 离线相册对照，双击即可打开，无需服务器；
- `report.md` —— 简明摘要，含建议分组、链式关系、候选对照表；
- `report.json` —— 机器可读的完整结果，便于二次处理；
- `thumbs/` —— 报告使用的缩略图（只用于新版本报告，不含原图）。

`scan` 不会修改原图，也不改写人工决定文件。

## 人工确认与排除（可跨扫描保留）

决定按**文件内容**（SHA-256）记录，而不是只按路径，因此文件改名或移动后
判断仍然跟随原图。

```sh
# 确认合并一对、排除一对
python3 -m photocatalog decide report/decisions.json --merge   a.jpg b.jpg
python3 -m photocatalog decide report/decisions.json --exclude a.jpg c.jpg

# 查看已保存的决定
python3 -m photocatalog list report/decisions.json

# 再次扫描时带上同一个决定文件，已确认/排除的关系会保留
python3 -m photocatalog scan samples -o report --decisions report/decisions.json
```

如果某个**路径**上原来记录过决定、但现在文件内容已经不同（例如同路径换成了
另一张照片），工具不会沿用旧判断，而是在报告的“需要重新审核”一节明确列出该路径。

## 工具如何判断相似（以及如何避免误合并）

每个候选配对都给出：

- **相似原因**：尺寸差异、感知哈希距离、颜色分布差异、结构相关度、对齐结果等；
- **对应区域**：若一张是另一张裁剪后的版本，报告给出大致区域（归一化坐标）；
- **并排预览**：原图缩略图，便于人工比对。

判断分两层，均为“局部对齐到同一区域后”的比较：

1. **同图置信（same_photo）**：先在较大的图中找到较小图的最佳位置（支持整体缩放、
   裁边、以及先缩放再裁切），然后在匹配区域上拟合整体的明暗/对比度变化，
   再看**残余差异**。真副本经过整体调色/缩放后残余很小；两张不同的照片即使
   背景相同，主体处的残余仍会很突出。
   - 关键指标是“平滑区域的最大残余”：重采样误差集中在边缘，而主体变化会波及
     平滑区域，因此这一指标把“缩放副本”与“同背景不同照片”分开。
2. **可合并度（merge_fit）**：在“同图”的前提下，再看两者的画面重叠程度。
   只裁掉一点边框不影响；裁掉很大一块画面的副本仍算同图，但会降低可合并度，
   避免把只剩局部画面的文件当作可直接合并的替身。

**相似度不具有传递性。** 若 A 像 B、B 像 C，但 A 与 C 明显不同，工具不会把三张
默认归为一组：

- 建议合并的分组只在“组内两两都是同图”时才成立（按团/clique 判定）；
- 上述链式关系单独列为“链式关系（不应默认合并）”，并说明哪两条像、哪两条不像，
  请逐对确认。
- 若某组并非完整相连，会标注“不完整”并列出未确认的具体配对。

## 报告中的归档建议

- **建议合并**（绿色）：同图且重叠充分，建议合并归档、保留像素/分辨率更高的版本；
- **需人工判断**（黄色）：相似但差异集中在一处（典型是主体不同），不要自动合并；
- **不建议合并**（灰色）：关联弱。

报告开头先列出**读取失败的文件及其路径与原因**。单个坏文件只会被记录，不会中断整批扫描。

## 支持的格式

- 完整支持：PNG（全部位深/颜色类型，含交错）、基线/渐进 JPEG（含灰度、4:2:0/4:2:2、
  重启标记、EXIF 方向）、BMP、PPM/PGM、TGA、GIF（首帧）、基线 TIFF。
- 其他格式（WEBP、HEIC 等）在装有 `ffmpeg` 或 `sips` 时可用外部解码器解码。

## 样例照片集

`samples/` 由脚本生成（`python3 -m photocatalog.samples_cli --out samples`），
用来演示和验收各类关系：

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `originals/walker_day.png` | 原件 | 后续缩放/裁剪/调色的基准 |
| `originals/walker_day.jpg` | 原件（JPEG） | 同一场景的普通 JPEG 另存 |
| `originals/dog_day.png` | 不同照片 | 同一地点、不同主体，不应与 walker 合并 |
| `originals/bench_dusk.png` | 不同照片 | 不同光线与主体 |
| `duplicates/walker_day_copy.png` | 完全相同 | walker_day.png 的字节级副本 |
| `duplicates/dog_day_copy.png` | 完全相同 | dog_day.png 的副本 |
| `variants/walker_large.png` | 缩放 | 2 倍放大 |
| `variants/walker_small.jpg` | 缩放 | 半尺寸 JPEG |
| `variants/walker_trimmed.png` | 裁边 | 四边各裁数像素 |
| `variants/walker_warm.png` | 调色 | 偏暖 |
| `variants/walker_trimmed_cool.png` | 裁边+调色 | 裁剪后偏冷 |
| `chain/panorama_b.png` | 链式中介 | 完整全景 |
| `chain/left_a.png` | 链式一端 | 全景左侧 60% |
| `chain/right_c.png` | 链式另一端 | 全景右侧 60% |
| `broken/truncated.jpg` | 故意损坏 | 用于验证坏文件被记录而不中断 |

在自带样例上的预期结果：

- 两个建议合并分组：walker 一家的 8 个版本、dog 的原图与副本；
- 一个链式关系：`left_a` 与 `panorama_b` 像、`panorama_b` 与 `right_c` 像，
  但 `left_a` 与 `right_c` 不像——因此三张不默认合并；
- 两个不同照片（dog、bench）不会被并入 walker；
- `broken/truncated.jpg` 出现在“读取失败”一节。

## 测试

```sh
python3 -m unittest discover -s tests -v
```

测试覆盖：解码往返与损坏输入、完全相同/缩放/裁剪/调色副本识别、
同背景不同照片不合并、链式关系检出且不被并入一组、人工决定的持久化/
改名跟随/内容变更重审，以及命令行端到端（报告落盘且不改动原图）。

## 目录结构

```
photo-catalog/
├── photocatalog/
│   ├── imaging/        # 纯 Python 图像解码（PNG/JPEG/BMP/TGA/GIF/TIFF）
│   ├── analysis.py     # 缩略图、灰度、感知哈希、颜色/结构签名
│   ├── similarity.py   # 区域对齐、差异图、对比度校正后的残余
│   ├── pipeline.py     # 扫描、评分、分组、链式检测、决定库
│   ├── report.py       # 离线 HTML 相册 + Markdown 摘要
│   ├── samples.py      # 合成照片渲染器
│   ├── samples_cli.py  # 样例集生成
│   ├── jpeg_encode.py  # 基线 JPEG 编码（样例与测试用）
│   └── cli.py          # 命令行入口
├── samples/            # 自带样例照片集
└── tests/              # 单元与端到端测试
```

## 局限

- 纯 Python 解码大图较慢；工具解码时按需缩放，比较用较小分辨率，但仍建议对
  非常大的照片集分批扫描。
- 目前按目录批量扫描，不做跨目录去重；如需可多次运行并汇总 `report.json`。
- 判断是“建议”，不替代人工；尤其是黄色“需人工判断”的条目应由人逐对确认。
