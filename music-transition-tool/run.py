#!/usr/bin/env python3
"""便捷入口：python3 run.py <command> ...

等价于在本目录执行 python3 -m mtp。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mtp.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
