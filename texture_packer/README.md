# texture_packer

本地纹理图集打包工具：把零散的透明 PNG 裁掉透明外边、留边（边缘颜色外扩）、
装箱到固定尺寸的图集页，并输出足够还原单图的 JSON 元数据。**纯 Python 标准库
实现，无第三方依赖**（自带 PNG 编解码器，见 `texturepacker/png.py`）。

## 快速开始

```bash
# 端到端演示：生成样例 -> 打包 -> 还原（输出在 ./demo_output）
./demo.sh

# 或手动执行
python3 -m texturepacker make-samples /tmp/sample          # 生成样例素材与锚点
python3 -m texturepacker pack <素材目录> <输出目录> \
    --anchors anchors.json --page-width 48 --page-height 64 \
    --max-pages 2 --padding 2
python3 -m texturepacker unpack <输出目录> <还原目录>
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `pack <input> <output>` | 递归读取 input 下的 PNG，输出 `atlas_0.png …` 和 `atlas.json` |
| `unpack <atlas> <output>` | 按 `atlas.json` 把每张图按原始尺寸/透明形状/锚点还原 |
| `make-samples <output>` | 生成内置样例素材（含锚点定义） |

`pack` 参数：`--page-width`、`--page-height`、`--max-pages`、`--padding`
（每侧留边像素数，默认 1）、`--no-rotation`（禁止 90° 旋转）、`--anchors`。

打包存在放不下的图时，退出码为 `1` 并在 stderr 与元数据中给出**具体原因**
（`oversized`：自身超过页面；`no space`：页面剩余区域放不下）。

## 锚点文件格式

```json
{
  "images": [
    {"name": "icon_slim_margin.png", "anchor": [6.5, 26.0]}
  ]
}
```

`anchor` 是原图坐标系（左上角原点）下的浮点坐标，允许半像素。打包后元数据同时
保留原锚点和它在图集页上的实际落点 `atlas_anchor`（已随旋转换算），程序端可直接
按对齐点把精灵摆回场景。

## 元数据如何区分真实内容与填充

每张精灵的处理链：原图 → 裁透明外边 → 四周加 `padding` 像素边缘外扩 →
（可选）90° 顺时针旋转 → 装箱。

`atlas.json` 中每个 sprite 记录：

- `source_size`：原始尺寸；`trim_offset`：内容框相对原图左上角的偏移；
  `trimmed_size`：裁剪后真实内容尺寸 —— 三者可精确还原透明外边。
- `padding` 与 `settings.padding_policy: "edge_extrude"`：frame 内边一圈是
  **clamp-to-edge 复制出的填充色**（缩放采样防串色用），不是源图内容；真实内容
  位于 frame 内缩 `padding` 的矩形中。还原时填充边会被剥掉。
- `frame`：页号、x/y/w/h、`rotated90`。
- `status`：`placed` / `fully_transparent` / `rejected`。
  - 全透明图不占图集空间，但显式记录原始尺寸，还原时得到同尺寸的空画布。
  - 被拒绝的图带 `rejection_reason`，还原时跳过。

## 确定性

装箱顺序按面积、最长边、名称排序，与文件遍历/输入顺序无关。相同素材无论以什么
顺序输入，都会得到一致的页号、坐标和旋转结果（有测试覆盖）。

## 防重叠保证

装箱采用 MaxRects（Best Short Side Fit），每次放置后重建自由矩形；放置完成后
`verify_no_overlap` 做一次同页矩形两两不重叠断言，任何内部冲突都会直接报错而不是
产出坏图集。

## 测试

```bash
cd texture_packer
python3 -m unittest discover -s tests -v
```

覆盖：PNG 编解码往返与全 filter/色彩类型、透明裁剪与全透明记录、边缘外扩、
90° 旋转后锚点换算与字节级还原、输入顺序无关性、超尺寸/空间不足的溢出诊断。

## 目录结构

```
texture_packer/
├── demo.sh                     # 端到端演示
├── README.md
├── texturepacker/
│   ├── __init__.py
│   ├── __main__.py             # python -m texturepacker 入口
│   ├── atlas.py                # 裁剪/留边/元数据/还原流水线
│   ├── cli.py                  # 命令行
│   ├── image.py                # RGBA 原语：裁剪、旋转、外扩、blit
│   ├── packer.py               # MaxRects 装箱、旋转、多页、诊断
│   ├── png.py                  # 纯标准库 PNG 读写
│   └── samplegen.py            # 内置样例素材生成
└── tests/test_packer.py
```
