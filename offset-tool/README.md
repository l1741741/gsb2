# 二维轮廓外扩/内缩预览与导出工具（offset-tool）

面向木工制图的本地二维闭合轮廓工具：对带孔洞的板件做**外扩/内缩（offset）**，
正确处理凹角自交、细通道消失、孔洞合并与实体拆分，并提供浏览器预览、
PNG 出图与可核对的稳定 JSON 坐标。

- 语言：TypeScript（strict），编译为 ES2020 ESM
- 几何内核：[Clipper1](http://www.angusj.com/delphi/clipper.php) 的成熟 JS 移植
  [`clipper-lib` 6.4.2](https://www.npmjs.com/package/clipper-lib)（BSL，零原生依赖），
  源码同时内置于 `vendor/` 供离线/浏览器直接使用
- 渲染：浏览器 Canvas 2D 与 Node 端自实现离屏画布**共用同一条绘制代码**；
  Node 端 PNG 编码仅依赖内置 `node:zlib`，无需任何原生图形库

> 本目录是独立工具，与仓库根目录既有的 `renderer/` 示例互不影响。

## 快速开始

```sh
cd offset-tool
npm install
npm test          # 编译并运行 15 个几何/渲染测试
npm run examples  # 生成 examples/generated/ 下的 PNG 与 results.json
npm run demo      # 静态服务器，浏览器打开 http://localhost:4175/demo/
```

## 它解决的核心问题

直接沿每条边做等距线，在凹角处会互相穿过。本工具把轮廓当作**有方向的实体区域**
交给 Clipper 的多边形偏移（`etClosedPolygon`），由其自交清理保证输出永远是
简单环——凹角附近穿过的线段**不会被当成零件外边**。输入若本身带自交，
则在偏移前被校验器拦截并给出可定位坐标，而不是静默产出错误结果。

### 五个内置示例（`src/geometry/examples.ts`）

| 示例 | 现象 |
| --- | --- |
| `slit-plate` 狭缝（细颈双孔） | 内缩 3 后宽 6 的实体细颈被吃掉，两个孔**合并为一个**，删除的颈作为 removed 细片单独给出 |
| `edge-hole-plate` 贴边孔 | 距边 4 的孔先于居中孔与外边界融合，孔洞连通关系变化可见 |
| `dumbbell-plate` 哑铃板 | 颈部内缩断裂，一块实体**拆成两个独立组件** |
| `concave-l-plate` 凹角 L 板 | 大距离外扩时凹角自交被清理，结果仍为简单环 |
| `self-intersecting-bowtie` | 自交反例：校验拦截，红叉定位交点，不产生偏移结果 |

## 功能与需求对照

1. **原形、方向、包含关系显示**：外环/孔洞分色，方向箭头标注绕向；
   嵌套深度按点包含自动判定（偶数深度=外环，奇数=孔洞），并规范为
   Clipper 要求的外环逆时针、孔洞顺时针。
2. **连通关系明确、自交不外溢**：结果以 PolyTree 还原为「组件 → 外环 → 孔洞」
   层级；通道闭合表现为孔洞数下降/合并，颈部断裂表现为组件数增加。
3. **同轮廓多间距批量导出**：一次导出多组距离；`results.json` 用固定键序、
   固定 6 位小数，**同输入同参数两次生成字节一致**（测试覆盖）。
   位置、孔洞、删除细片都带完整坐标，可独立复核。
4. **确定性与自交提示**：纯整数坐标空间（内部 1e6 放大）运算，无随机、
   无时间戳影响结果；撤销/重做/重载只重放同一管线。自交、共线重叠、
   退化环、非法包含都会报出环下标、边下标与交点坐标。
5. **示例与可复用坐标**：`examples/generated/<名称>/` 下每个距离一张 PNG，
   加一份 `results.json`；几何坐标也可直接从库 API 取得。

## 目录结构

```
offset-tool/
├── src/
│   ├── geometry/
│   │   ├── types.ts       公共类型
│   │   ├── primitives.ts  容差、线段相交、点包含、方向、包围盒
│   │   ├── validate.ts    自交/退化/包含校验（可定位诊断）
│   │   ├── hierarchy.ts   嵌套深度、方向规范化、整数缩放
│   │   ├── offset.ts      偏移引擎 + PolyTree 层级 + 细片差异
│   │   ├── export.ts      稳定 JSON 序列化
│   │   └── examples.ts    五个内置轮廓
│   ├── render/
│   │   ├── canvas-draw.ts 环境无关的 Canvas 2D 绘制
│   │   └── png.ts         离屏画布 + 零依赖 PNG 编码器
│   ├── cli/
│   │   ├── generate-examples.ts  Node 批处理 CLI
│   │   └── app.ts                浏览器交互应用
│   ├── tests/             node:test 测试
│   ├── index.ts           Node/库入口（含 PNG）
│   └── browser.ts         浏览器入口（不含 node:zlib）
├── demo/index.html        无构建步骤的交互页面
├── vendor/clipper-6.4.2.js 几何内核离线副本
└── examples/              输入样例与生成产物
```

## 库 API 速览

```ts
import {
  validateContour,   // 校验，返回带坐标的 issues
  describeInputs,    // 每个环的角色/方向/点数
  offsetContours,    // 偏移，返回组件、孔洞、removedSlivers
  drawScene,         // 画到任意 Canvas 2D 上下文
  HeadlessCanvas,    // Node 离屏画布，toPng() 出图
  buildBatchExport, stableStringify,
} from './dist/index.js';

const validation = validateContour(input);      // input: { name, loops: [[{x,y}...]] }
if (!validation.valid) throw new Error(/* 用 validation.issues 定位 */);
const result = offsetContours(input.loops, {
  distance: -4,          // 正=外扩，负=内缩
  join: 'miter',         // 'miter' | 'round' | 'square'
  miterLimit: 2,
  arcTolerance: 0,
  cleanTolerance: 0,
});
// result.components / result.loops / result.removedSlivers / result.stats
```

### 自定义轮廓的命令行批处理

```sh
node dist/cli/generate-examples.js \
  --file examples/input-sample.json \
  --distances 0,-3,-6 --join round
```

## 坐标与数值约定

- 输入坐标单位不做假设（按毫米理解即可）；送入 Clipper 前统一放大 1e6 倍取整，
  导出缩回并保留 6 位小数。
- 所有浮点比较集中在 `primitives.ts` 的 `EPS`，避免各处自造容差。
- 角度/面积符号：有向面积 >0 为逆时针；y 轴在渲染时翻转使数学坐标向上为正。

## 已知边界

- PNG 预览为轻量自实现光栅化（2x2 超采样），不渲染文字标签；环身份通过
  颜色/线型与同名 JSON 对应。需要文字请使用浏览器预览（完整 Canvas 文字）。
- 校验为边对边 O(n²)，针对板件级轮廓（数百点以内）设计；超大规模轮廓需先分块。
