# gsb2
gsb2 任务工作仓库

## 目录

- `renderer/`：原有的零依赖 Canvas 2D 场景渲染器示例（保留不动，`cd renderer && npm test`）。
- `page-corrector/`：离线批量档案整页校正工具（四角透视校正、统一纸面坐标、保留/遮挡区、逐页 PNG + 坐标转换信息导出、自生成核对页）。见 `page-corrector/README.md`；运行：`cd page-corrector && npm run demo` 后打开 http://localhost:4180/ 。
