# 背景换色批处理报告

- 生成时间: 2026-11-27T06:40:44
- 工具版本: 1.0.0（numpy 加速: 开）
- 配置: `examples/config.example.json`
- 输出目录: `/Users/lichao/works/gsb2/tasks/15085/repo/bg-recolor-tool/examples/out-example`

## 批次摘要

| 总数 | 成功 | 隔离/失败 | 实际变化像素合计 | 断开同色域合计 |
|---:|---:|---:|---:|---:|
| 2 | 2 | 0 | 222691 | 3 |

---

## ✅ `synthetic_scene`

- 源文件: `synthetic_scene.png`（480x360）
- 背景取色: `#EEECE4` → 新背景: `#2F6FDB`；连通: `edge`/4 邻接；容差 90.0，过渡 36.0，metric `redmean`
  - 取色点 [18, 18] 邻域采用 25 像素，颜色 `#EEECE4`
  - 取色点 [462, 338] 邻域采用 25 像素，颜色 `#EEECE4`

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

**产物**：[新 PNG](processed/synthetic_scene.new.png) ｜ [变化区域图](changes/synthetic_scene.change.png) ｜ [浅底预览](review/synthetic_scene.light.png) ｜ [深底预览](review/synthetic_scene.dark.png) ｜ [2×2 对比](review/synthetic_scene.compare.png) ｜ [逐图 JSON](reports/synthetic_scene.json)

---

## ✅ `synthetic_scene_global`

- 源文件: `synthetic_scene.png`（480x360）
- 背景取色: `#EEECE4` → 新背景: `#7A3FF0`；连通: `off`/4 邻接；容差 90.0，过渡 36.0，metric `redmean`
  - 取色点 [18, 18] 邻域采用 25 像素，颜色 `#EEECE4`
  - 取色点 [462, 338] 邻域采用 25 像素，颜色 `#EEECE4`

| 总像素 | 完全透明(不计外观统计) | 半透明 | 不透明 | 实际变化像素 | 其中半透明边缘 | 受保护相似像素 | 断开同色像素 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 172800 | 846 | 8071 | 163883 | 113922 | 3903 | 4712 | 0 |

- 半透明背景近似边缘带 3903 像素；合成色平均偏移：浅底 18.16 / 深底 18.09（最大 64.8 / 64.8）
- 可见像素平均 RGB（不含完全透明）：[172.3, 188.19, 185.99] → [97.68, 75.84, 195.58]
- 连通域：共 4 个相似域，选中 4，断开记录 0 个

**产物**：[新 PNG](processed/synthetic_scene_global.new.png) ｜ [变化区域图](changes/synthetic_scene_global.change.png) ｜ [浅底预览](review/synthetic_scene_global.light.png) ｜ [深底预览](review/synthetic_scene_global.dark.png) ｜ [2×2 对比](review/synthetic_scene_global.compare.png) ｜ [逐图 JSON](reports/synthetic_scene_global.json)

