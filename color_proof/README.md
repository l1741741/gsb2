# color_proof — 本地 PNG 配色试样工具

插画校场用: 从一张 RGBA PNG 和一份配色 JSON, 一次生成多个配色方案,
并输出每个方案的命中范围图与统计。**纯 Python 标准库实现, 无第三方依赖**,
自带 PNG 编解码(8 位 RGB/RGBA, 非隔行)。

## 快速开始

```bash
# 1. 生成样例图与配色 JSON(双色相近 + 半透明软边 + 规则重叠 + 保护区)
python examples/make_sample.py

# 2. 生成全部方案
PYTHONPATH=. python -P -m color_proof.cli examples/sample.png examples/palettes.json examples/output

# 3. 跑测试
python -m unittest discover -s tests -v
```

> 注: `-P` 只屏蔽当前目录的隐式导入, 配合 `PYTHONPATH=.` 即可在不安装包的
> 情况下运行, 同时不会加载任何用户站点包。普通环境直接
> `python -m color_proof.cli ...` 也可以。

输出目录内容(每个方案一组):

| 文件 | 内容 |
| --- | --- |
| `<scheme>.png` | 替色结果, alpha 通道与原图逐字节一致 |
| `<scheme>_hitmap.png` | 命中范围: 未命中像素压暗, 各规则命中区染标记色, 多规则重叠点染白 |
| `stats.json` | 每规则替换/被抢像素数、原色范围、命中包围盒、重叠采样、透明与保护区计数 |

CLI 选项: `--only s1,s2` 只跑指定方案; `--overlap-limit N` 控制重叠明细采样数
(全量 `contested` 计数不受上限影响)。

## 配色 JSON 结构

```json
{
  "matte": "#FFFFFF",
  "default_metric": "euclidean",
  "rules": [
    {
      "id": "red-coat",
      "source": "#E8503A",
      "target": "#32AA5A",
      "tolerance": 25,
      "priority": 10,
      "metric": "euclidean",
      "enabled": true
    }
  ],
  "protected": [
    {"type": "rect",   "x0": 95, "y0": 70, "x1": 130, "y1": 100},
    {"type": "circle", "cx": 40, "cy": 40, "radius": 12},
    {"type": "mask",   "path": "protect.png"}
  ],
  "schemes": [
    {"id": "spring", "name": "春芽", "rule_refs": ["red-coat"]},
    {"id": "autumn", "rule_refs": [
      {"id": "red-coat", "target": "#8A5A2B"},
      {"id": "blue-coat", "enabled": false}
    ]}
  ]
}
```

- 规则字段: `source`(源色, `#RRGGBB`)、`tolerance`(非负容差)、`target`、
  `priority`(整数, 大者优先)、`metric`(`euclidean` 或 `chebyshev`, 可省略)、
  `enabled`(独立开关, 默认 true)。
- 容差语义: euclidean 按 RGB 空间欧氏半径; chebyshev 按最大单通道差。
  边界距离恰好等于容差时算命中。
- 方案通过 `rule_refs` 引用规则池, 引用项可覆盖 `target` / `enabled` /
  `priority`, 便于从同一组规则派生多套试样。
- `protected` 支持矩形、圆形和外部蒙版 PNG(其 alpha>0 处受保护,
  蒙版尺寸须与原图一致); 保护区内像素不参与任何规则匹配。
- `matte`: PNG 存储色预合成时假定的背景色, 默认白; 设为 `null` 表示输入
  本身就是直色(关闭 unmatte/rematte 工作流)。

## 关键语义(与需求逐条对应)

1. **只对原图取样。** 每个像素的直色只从原始 PNG 计算一次, 全部规则共享这份
   取样; 上一条规则的替换结果绝不进入下一条的匹配, 不存在链式污染。
2. **冲突裁决确定且可查。** 一像素命中多条规则时取 `priority` 最大者;
   同优先级按规则 `id` 字典序。引擎内部按 `(-priority, id)` 重排规则,
   因此 JSON 里规则排列如何变化, 只要优先关系不变, 输出逐字节一致
   (样例的 `order-check-a/b` 两个方案即自检)。被抢像素计入负方规则的
   `contested`, 并在 `overlaps_sample` 与 hitmap 白点中可查。
3. **alpha 原样保留, 软边不串背景色。** 替换只改 RGB。对 `0 < alpha < 255`
   的像素先按 matte 解出直色, 在直色空间匹配和替色, 输出前用同一 matte
   重新合成, 透明边不会露出旧背景色。`alpha = 0` 的像素不参与匹配与统计,
   其存储字节(可能含无意义的 RGB)原样保留。
4. **保护区与独立开关。** 保护区逐像素跳过; `enabled: false` 的规则在配置
   加载阶段即从方案中剔除, 引用处也可单独关闭或重新开启。
5. **完整统计。** 每条规则的替换数、被抢数、实际命中原色的 min/max 范围、
   命中包围盒, 加上全透明像素数、保护区像素数、未命中像素数与重叠采样。

## 作为库调用

```python
from color_proof import load_config, read_png, write_png, apply_scheme

cfg = load_config("palettes.json")
image = read_png("input.png")
result = apply_scheme(
    image,
    cfg.schemes["spring"].rules,
    cfg.matte,
    protected_regions=cfg.protected,
)
write_png("spring.png", result.image)
print(result.stats["red-coat"].matched, result.hit_bbox)
```

## 模块布局

```
color_proof/
  pngio.py       # 标准库 PNG 解码(五种行过滤器)/编码
  color_math.py  # 颜色解析、距离度量、unmatte/matte
  config.py      # JSON 模型、校验、保护区域蒙版
  engine.py      # 原始取样、优先级裁决、替色与统计
  cli.py         # 命令行入口与 hitmap 渲染
examples/        # 可运行样例(含样例生成器)
tests/           # 24 个 unittest 用例
```
