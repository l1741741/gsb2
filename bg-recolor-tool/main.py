#!/usr/bin/env python3
"""免 ``-m`` 的便捷入口：``python3 main.py batch examples/config.example.json``。"""

from bg_recolor.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
