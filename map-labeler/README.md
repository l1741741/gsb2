# 图面标注排版工具 · Map Labeler

用 TypeScript + Canvas 2D 从零实现的**本地**平面图标注排版工具。读入一份描述地图范围、
禁放区和带优先级锚点的 JSON，自动为展签安排位置，尽量避开禁放区、其它标签和关键锚点，
并保留能看出归属关系的连线；画面过挤时按优先级折叠标签并在边栏列出原因。

核心排版逻辑是纯函数、确定性的，不依赖 DOM，可同时在浏览器与 Node（CLI/测试）中运行。
与仓库里既有的 `renderer/` 示例完全独立，互不影响。

## 目录结构

```
map-labeler/
├── src/
│   ├── core/
│   │   ├── geometry.ts        # 矩形/线段几何与相交判定
│   │   ├── model.ts           # 输入 JSON 数据模型与严格校验
│   │   ├── text-measurer.ts   # 文本测量/换行（Canvas 实现 + Node 启发式实现）
│   │   ├── camera.ts          # 地图↔屏幕坐标、缩放与旋转
│   │   ├── conflicts.ts       # 全局冲突检测与连线计算
│   │   ├── layout.ts          # 标签自动排版引擎（候选位、打分、折叠）
│   │   └── design.ts          # 设计存档的恢复与差异核对
│   ├── render/
│   │   ├── canvas-renderer.ts # Canvas 2D 绘制与命中测试
│   │   └── export.ts          # PNG 渲染、坐标清单、设计文档
│   ├── cli/index.ts           # 无第三方依赖的命令行入口
│   ├── demo/main.ts           # 浏览器演示应用
│   └── tests/                 # node:test 单元与冒烟测试
├── demo/
│   ├── index.html             # 演示页（构建后打开）
│   └── sample-floorplan.json  # 密集入口 + 长短标签混排样例
└── tsconfig.json
```

## 快速开始

```sh
npm install
npm test      # 类型检查 + 32 个 node:test 测试
npm run demo  # 构建后在 http://localhost:4180/demo/ 打开演示页
```

命令行（无需浏览器，输出可核对的坐标清单）：

```sh
npm run build
node dist/cli/index.js layout demo/sample-floorplan.json --width 1280 --height 720
node dist/cli/index.js layout demo/sample-floorplan.json --width 420 --height 900 --out narrow.json
node dist/cli/index.js restore floorplan-design.json --width 960 --height 540
```

## 输入 JSON 格式

```jsonc
{
  "map": { "bounds": { "x": 0, "y": 0, "width": 1000, "height": 640 } },
  "forbidden": [
    { "id": "entrance-a", "x": 40, "y": 600, "width": 48, "height": 40, "reason": "入口A 禁放" }
  ],
  "anchors": [
    { "id": "entrance-a", "x": 64, "y": 590, "text": "入口 A", "priority": 5 },
    { "id": "hall", "x": 200, "y": 250, "text": "常设展厅\n含定时讲解", "priority": 5, "pinned": false }
  ],
  "canvas": { "width": 1280, "height": 720 },
  "style": { "fontSize": 13, "maxTextWidth": 220 }
}
```

- `priority` 数字越大越重要，容量不足时低优先级先折叠。
- `pinned: true` 或演示页里拖拽过的标签成为人工固定标签，重新排版时位置锁定，
  只做冲突检测；冲突用红色虚线框和边栏徽章显式标出，不静默处理。

## 排版策略（layout.ts）

1. **测量与换算**：标签先按屏幕像素测量，再按相机 `scale` 换算成地图单位，
   因此同一份设计换画布规格后，地图坐标保持不变。
2. **候选位**：每个锚点生成八方向 × 三圈 + 轴向微移的确定性候选矩形，全部夹回地图范围。
3. **硬约束打分**：压禁放区、与已放置标签重叠、盖住其它锚点、连线穿禁放区或与其它连线交叉、
   飘出可视范围、连线超过局部性上限都会累积硬罚分。
4. **软约束排序**：连线短、标签位于锚点上方、水平对齐。
5. **折叠**：没有干净候选且不满足“轻微擦碰”折中时折叠，记录
   `no-space / forbidden-zone / overlap / out-of-view / low-priority-budget` 结构化原因；
   全局标签面积超过视口阈值时按优先级预算淘汰。
6. **全局复检**：放置结束后再跑一次全量冲突检测，人工固定标签之间的冲突也会被标出。

## 交互（演示页）

- 滚轮缩放、Shift + 滚轮旋转、拖空白处平移。
- 拖动标签即人工固定（黄色底 + 图钉），双击或点边栏行折叠/展开。
- 工具栏可切换横版（1280×720、960×540）与窄版（420×900、360×740）或自定义规格；
  切换后保留相机中心与缩放，可视范围随新规格重算。
- 导出：PNG 位图、坐标清单 JSON（框/线/锚点的地图坐标与屏幕像素双份）、
  设计存档 JSON（含人工改动与相机快照）。

## 保存与恢复的一致性

设计存档以**地图坐标**为唯一事实来源，保存 `manualOverrides`、`manualFolds` 与相机快照。
恢复时重新排版并与存档逐项比对：位置或折叠状态无法复现时，差异以 `restoreWarnings`
显式返回（演示页顶部黄框、CLI 输出 `恢复核对警告`），而不是静默吞掉。同输入多次排版
结果完全确定，测试中有逐字段比对覆盖。

## 导出清单（可核对坐标）

`导出坐标清单` 产出的 JSON 包含：

- `anchors`：每个锚点的 `map` 与 `screen` 坐标、优先级、折叠状态；
- `labelBoxes`：每张标签的地图矩形、屏幕像素矩形、固定/折叠状态、冲突明细；
- `leaderLines`：每条连线起止点的地图与屏幕坐标；
- `forbidden`：禁放区几何；
- `summary`：总数、显示数、折叠数、冲突数。

## 运行环境

- Node.js 20+（开发与测试使用 22），仅开发依赖 TypeScript 与 @types/node，运行时零依赖。
- 浏览器需支持 Canvas 2D（演示页使用 ES module，需通过 http 服务访问而非 file://）。
