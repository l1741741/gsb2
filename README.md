# gsb2
gsb2 任务工作仓库

## 目录

- `renderer/`：原有的零依赖 Canvas 2D 场景渲染示例（保持不变，`npm test` 6/6 通过）。
- `bg-recolor-tool/`：产品图批量 PNG 背景换色工具（取色点 / 保护区域 / 连通选择 /
  透明边缘深浅底回看 / 变化区域图 / 逐图与 HTML 报告 / 坏图隔离）。
  核心仅需 Python 3.9+ 标准库，详见 `bg-recolor-tool/README.md`；
  快速验证：`cd bg-recolor-tool && python3 -m unittest discover -s tests && bash run_demo.sh`。

