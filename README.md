# gsb2

gsb2 任务工作仓库

## 目录

- `renderer/` -- 独立的 Canvas 2D 场景渲染示例（既有内容，未改动）。
- `focusstack/` -- 本地 PNG 焦点合成工具（纯标准库，含复核实例与样例）。

## focusstack 快速入口

```sh
cd focusstack
python3 -m focusstack samples --out samples
python3 -m focusstack stack --out ./result --reference 0 \
    samples/01-near.png samples/02-mid.png samples/03-far.png samples/04-near-moved.png
python3 -m unittest discover -s tests
```

详见 `focusstack/README.md`（功能、CLI 参数、工作流）与
`focusstack/docs/ALGORITHM.md`（算法取舍）、`focusstack/docs/EDIT-FORMAT.md`（手工覆盖文件格式）。
