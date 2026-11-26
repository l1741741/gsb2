#!/bin/sh
# 运行全部单元测试（仅标准库）。
set -e
cd "$(dirname "$0")"
exec python3 -m unittest discover -s tests -v
