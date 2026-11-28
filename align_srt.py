#!/usr/bin/env python3
"""命令行启动器，兼容 `python3 -I` 隔离模式。

隔离模式下 cwd 与 PYTHONPATH 都不会进入 sys.path，这里把本脚本所在
目录显式追加到末尾，使 stdlib 仍优先于工作目录中的同名模块。
"""

import os
import sys

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from srt_align.cli import run  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(run())
