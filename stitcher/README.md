# stitcher — 扫描件本地拼接工具

修复旧插画时，一张大图常被拆成有重叠边的几块分别扫描。本工具把已经
大体同向的扫描 PNG 拼回整图，并用接缝诊断告诉操作员哪条缝需要重扫。

**纯 Python 标准库实现**（自带 PNG 读写），无需安装任何依赖，Python 3.8+。

## 快速开始

```bash
cd stitcher
python3 demo.py          # 生成样例并跑通 普通/重复纹理/闭环矛盾 三种场景
```

## 命令

```bash
# 对齐一对图片，列出候选位移（含重复纹理多解）
python3 -m stitcher align A.png B.png --rough 396,3 --radius 12

# 生成初始配置
python3 -m stitcher init stitch.json --images a.png b.png c.png \
    --rough 0,0 396,3 110,402

# 按配置构建整片 + 诊断
python3 -m stitcher build stitch.json --out out/
```

## 配置（人工可编辑，重复加载结果一致）

```json
{
  "images": [
    {"file": "a.png", "rough": [0, 0]},
    {"file": "b.png", "rough": [396, 3]}
  ],
  "edges": [
    {"a": 0, "b": 1},
    {"a": 1, "b": 2, "chosen": [398, 1]},
    {"a": 0, "b": 2, "pinned": [12, 402]}
  ],
  "options": {"search_radius": 12, "checker": 16}
}
```

- `rough`：该块在整片上的粗略位置（可带几像素误差，搜索半径内自动修正）。
- `edges` 省略时按 rough 重叠自动生成。位移约定：`offset = pos_b - pos_a`。
- 边三种状态：缺省自动对齐；多解时用 `chosen` 人工选定；`pinned` 完全
  手工固定位移（用于固定某条缝后重算其余位置）。

## 输出（out/）

| 文件 | 内容 |
|---|---|
| `composite_blend.png` | 融合成片：重叠区按 alpha 加权平均，透明像素不算有效颜色，无覆盖区域保持透明 |
| `composite_compare.png` | 对照成片：重叠区棋盘格交替显示各来源块，肉眼查接缝 |
| `coords.json` | 每块图在成片上的坐标 (x, y, w, h) |
| `seams.txt` / `seams.json` | 接缝诊断：位移、色差、闭环残差、重叠区在**各原图中的坐标** |
| `seams/seam_XX_YY.png` | 接缝对照小图：左=A 重叠区，中=B 重叠区，右=差异×4 |
| `stitch.resolved.json` | 填入实测位移的配置，可复制为 `chosen`/`pinned` |

## 工作流

1. **对齐与多解**：重复纹理产生多个等分候选时，状态为 `ambiguous`，
   工具列出全部候选、不生成成片；人工对照原图后用 `chosen` 选定重建。
2. **闭环矛盾**：三块及以上成环时，`seams.txt` 报告每条缝的闭环残差
   （沿其他缝累积的位置与该缝测量值之差）。残差非零说明相关缝对不上，
   可用 `pinned` 固定信任的一条缝再重算，观察矛盾如何重新分配，
   据此判断哪条缝需要重扫。
3. **回查原图**：每条缝的诊断给出重叠区在每块原图中的像素范围，
   直接打开对应 PNG 的该区域即可核对。

## 样例（samples/）

`make_samples.py` 从程序生成的原画裁出扫描块（含透明圆角与扫描噪声）：

- `normal/` — 三块闭环，干净拼合，残差全 0；
- `repeat/` — 周期 48px 重复纹样，对齐出现 6 个等分候选；
- `conflict/` — C 块模拟 2px 纵向扫描错位，闭环残差暴露矛盾。

`demo.py` 演示完整流程并校验：坐标与真实裁剪位置一致、同一配置两次
构建产物逐字节相同。
