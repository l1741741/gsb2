# lightstrip — 异形灯带三维预览与导出工具

沿一条带宽度变化的三维路线扫掠闭合横截面，生成灯带网格。离线运行，无第三方依赖：
浏览器预览用 Canvas 2D 软渲染，导出为带法线和纹理坐标的 OBJ，几何问题（自相交、
退化段、折叠风险）如实报告，不静默吞掉。

## 使用

```sh
npm test                          # node:test 单元测试（几何内核 + 导出 + CLI）
npm run preview                   # 起本地服务后打开 http://localhost:4187/preview/
npm run export -- cases/u-turn.json out/u-turn.obj
```

导出同时写出 `<名字>.obj` 和 `<名字>.report.json`（诊断报告）。网格总是导出；
有问题时在报告和终端输出里标明。

## 案例文件格式

```json
{
  "name": "my-strip",
  "profile": "flat-strip",            // 内置: flat-strip / beveled-strip / t-profile
                                      // 或内联 { "points": [[x, y], ...] }（逆时针闭合）
  "closed": false,                    // true = 闭环（首尾相接，无端盖）
  "samplesPerSegment": 24,            // 每控制段的重采样密度
  "uvScale": 1,                       // v 坐标 = 弧长 / uvScale
  "points": [
    { "position": [0, 0, 0], "width": 0.3 },
    { "position": [1.6, 0, 0], "width": 0.45 }
  ]
}
```

- 截面局部坐标：x = 横向（乘以该处 width），y = 厚度方向（绝对值，不随宽度缩放）。
- 宽度沿路线在控制点间连续插值，经过中途接点尺寸必然连续。
- 路线用向心 Catmull-Rom 重采样，控制点本身会被样条穿过，并在预览中以序号标出。

## 几何保证与诊断

- **标架**：平行传输（parallel transport），竖直段、路径回头都不会翻面；
  唯一退化情形（切线恰好跳到法线上）会记为 `frameEvents` 并按确定规则重建，绝不静默。
- **闭环**：接缝处的扭转差被测量（`twistDegrees`）并均摊到整圈，首尾精确接上。
- **开口线**：两端生成耳切三角化的端盖（凹截面如 t-profile 也不会扇出界外），
  OBJ 中为独立 `usemtl cap`，预览里以不同颜色显示。
- **报告**：退化控制段、急转弯、弯曲半径小于截面半宽（折叠风险）、
  非有限顶点、自相交三角形对（AABB 宽相 + 精确三角形相交，相邻面除外）。

## 自带验证案例（cases/）

| 案例 | 验证点 |
| --- | --- |
| `spatial-bend` | 空间弯 + 竖直段 + 中途变宽，应无告警 |
| `closed-loop` | 非平面闭环，接缝扭转均摊，网格水密 |
| `u-turn` | 反例：急弯半径远小于条宽，应报告自相交与折叠风险 |
| `straight-joint` | 直段 + 90° 圆角弯头 + 接点变宽，应无告警 |

## 目录

```
src/    几何内核（采样、标架、扫掠、诊断、OBJ）
cases/  上述四个案例
bin/    导出 CLI
preview/ 浏览器预览（拖拽旋转、滚轮缩放、线框切换、诊断面板）
tests/  node:test
out/    导出产物（不入库）
```
