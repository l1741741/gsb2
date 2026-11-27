# 背景换色批处理报告

- 生成时间: 2026-11-27T06:40:45
- 工具版本: 1.0.0（numpy 加速: 开）
- 配置: `examples/batch/batch_config.json`
- 输出目录: `/Users/lichao/works/gsb2/tasks/15085/repo/bg-recolor-tool/examples/batch/output`

## 批次摘要

| 总数 | 成功 | 隔离/失败 | 实际变化像素合计 | 断开同色域合计 |
|---:|---:|---:|---:|---:|
| 5 | 2 | 3 | 217554 | 6 |

---

## ✅ `scene_a_edge`

- 源文件: `inputs/scene_a.png`（480x360）
- 背景取色: `#EEECE4` → 新背景: `#2F6FDB`；连通: `edge`/4 邻接；容差 90.0，过渡 36.0，metric `redmean`
  - 取色点 [18, 18] 邻域采用 25 像素，颜色 `#EEECE4`

| 总像素 | 完全透明(不计外观统计) | 半透明 | 不透明 | 实际变化像素 | 其中半透明边缘 | 受保护相似像素 | 断开同色像素 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 172800 | 846 | 8071 | 163883 | 108769 | 3903 | 4712 | 5153 |

- 半透明背景近似边缘带 3903 像素；合成色平均偏移：浅底 18.57 / 深底 18.62（最大 70.3 / 70.3）
- 可见像素平均 RGB（不含完全透明）：[172.3, 188.19, 185.99] → [53.87, 111.29, 181.98]
- 连通域：共 4 个相似域，选中 1，断开记录 3 个

  断开的相似色区域（单独记录，未修改）：

  | # | 面积 | bbox [x0,y0,x1,y1) | 质心 | 触边 | 含种子 |
  |---:|---:|---|---|:--:|:--:|
  | 2 | 441 | [111, 61, 132, 82] | [121.0, 71.0] | 否 | 否 |
  | 3 | 4712 | [140, 120, 216, 182] | [177.5, 150.5] | 否 | 否 |
  | 4 | 4712 | [264, 120, 340, 182] | [301.5, 150.5] | 否 | 否 |

**产物**：[新 PNG](processed/scene_a_edge.new.png) ｜ [变化区域图](changes/scene_a_edge.change.png) ｜ [浅底预览](review/scene_a_edge.light.png) ｜ [深底预览](review/scene_a_edge.dark.png) ｜ [2×2 对比](review/scene_a_edge.compare.png) ｜ [逐图 JSON](reports/scene_a_edge.json)

---

## ✅ `scene_b_seeds`

- 源文件: `inputs/scene_b.png`（480x360）
- 背景取色: `#E2E8EE` → 新背景: `#0E7C66`；连通: `seeds`/4 邻接；容差 90.0，过渡 36.0，metric `redmean`
  - 取色点 [18, 18] 邻域采用 25 像素，颜色 `#E2E8EE`

| 总像素 | 完全透明(不计外观统计) | 半透明 | 不透明 | 实际变化像素 | 其中半透明边缘 | 受保护相似像素 | 断开同色像素 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 172800 | 846 | 8071 | 163883 | 108785 | 3919 | 4712 | 5153 |

- 半透明背景近似边缘带 3967 像素；合成色平均偏移：浅底 19.46 / 深底 19.47（最大 86.1 / 86.1）
- 可见像素平均 RGB（不含完全透明）：[174.87, 183.38, 198.6] → [42.95, 117.13, 114.74]
- 连通域：共 4 个相似域，选中 1，断开记录 3 个

  断开的相似色区域（单独记录，未修改）：

  | # | 面积 | bbox [x0,y0,x1,y1) | 质心 | 触边 | 含种子 |
  |---:|---:|---|---|:--:|:--:|
  | 2 | 441 | [111, 61, 132, 82] | [121.0, 71.0] | 否 | 否 |
  | 3 | 4712 | [140, 120, 216, 182] | [177.5, 150.5] | 否 | 否 |
  | 4 | 4712 | [264, 120, 340, 182] | [301.5, 150.5] | 否 | 否 |

**产物**：[新 PNG](processed/scene_b_seeds.new.png) ｜ [变化区域图](changes/scene_b_seeds.change.png) ｜ [浅底预览](review/scene_b_seeds.light.png) ｜ [深底预览](review/scene_b_seeds.dark.png) ｜ [2×2 对比](review/scene_b_seeds.compare.png) ｜ [逐图 JSON](reports/scene_b_seeds.json)

---

## ❌ `corrupt_file` —— 已隔离（坏图 / 无法解码的 PNG）

- 源文件: `inputs/corrupt.png`
- 原因代码: `unreadable_image`
- 详细信息: PngError: 不是合法的 PNG 文件（签名不匹配）: /Users/lichao/works/gsb2/tasks/15085/repo/bg-recolor-tool/examples/batch/inputs/corrupt.png
- 源文件已隔离到: `quarantine/files/corrupt_file__corrupt.png`
- 错误记录: `quarantine/errors/corrupt_file.error.json`
- 已有的合法产物保持不变，不会被覆写成坏文件。

---

## ❌ `bad_sample_oob` —— 已隔离（无效取色点）

- 源文件: `inputs/scene_a.png`
- 原因代码: `invalid_sample_point`
- 详细信息: 背景取色点 (9999, 18) 超出图片范围 480x360
- 源文件已隔离到: `quarantine/files/bad_sample_oob__scene_a.png`
- 错误记录: `quarantine/errors/bad_sample_oob.error.json`
- 已有的合法产物保持不变，不会被覆写成坏文件。

---

## ❌ `bad_sample_transparent` —— 已隔离（取色区域完全透明，无法取色）

- 源文件: `inputs/scene_b.png`
- 原因代码: `invalid_sample_transparent`
- 详细信息: 取色点 (424,42) 周围 2px 邻域全部透明，无法取得背景色
- 源文件已隔离到: `quarantine/files/bad_sample_transparent__scene_b.png`
- 错误记录: `quarantine/errors/bad_sample_transparent.error.json`
- 已有的合法产物保持不变，不会被覆写成坏文件。

