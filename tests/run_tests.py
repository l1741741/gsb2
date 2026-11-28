#!/usr/bin/env python3
"""把仓库根目录加入 sys.path 后运行 unittest，无需安装包。"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.discover(str(Path(__file__).parent), pattern="test_*.py")
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
