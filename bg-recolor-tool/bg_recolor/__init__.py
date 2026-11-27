"""bg_recolor —— 本地批量 PNG 背景换色 / 影响范围回看工具。

设计要点
--------
* 核心管线只依赖 Python 3.9+ 标准库（``bg_recolor.pngcodec`` 自带常用 PNG 编解码），
  因此直接用系统 ``python3`` 也可以运行；
* 安装了 numpy 时自动走向量化加速（可用环境变量 ``BG_RECOLOR_NO_NUMPY=1`` 关闭）；
* 安装了 Pillow 时，变化区域图会额外渲染英文图例文字，没有 Pillow 也不影响出图，
  图例始终可以在 HTML / Markdown 报告中看到。

公开的高层入口：

* ``bg_recolor.engine.analyze`` / ``bg_recolor.engine.recolor``
* ``bg_recolor.pipeline.run_batch``
* ``bg_recolor.synthetic.generate_all``
"""

from __future__ import annotations

__version__ = "1.0.0"

# 变化区域图中的像素类别编号（同时作为报告 / HTML 图例的稳定 key）
CAT_NONE = 0
CAT_CHANGED = 1
CAT_PROTECTED_SIMILAR = 2
CAT_DISCONNECTED_SIMILAR = 3

CATEGORY_KEYS = {
    CAT_CHANGED: "changed",
    CAT_PROTECTED_SIMILAR: "protected_similar",
    CAT_DISCONNECTED_SIMILAR: "disconnected_similar",
}
