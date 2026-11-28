#!/usr/bin/env python3
"""离线画幅巡检命令行入口。

用法示例：
    python3 aspect_inspect.py 母版.mp4 交付版.mp4 \
        --windows "w1=0-2,w2=5-8" --out report_dir
    python3 aspect_inspect.py 母版.mp4 交付版.mp4 --config windows.json
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from aspect_inspector.inspector import main

if __name__ == "__main__":
    raise SystemExit(main())
