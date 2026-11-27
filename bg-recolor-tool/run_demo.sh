#!/usr/bin/env bash
# 一键演示：生成合成验证图 -> 跑干净示例 -> 跑含坏图/无效取色点的隔离批次。
# 优先使用目录内 .venv（若已建），否则用系统 python3（纯标准库也可完整运行）。
set -u
cd "$(dirname "$0")"

if [ -x ".venv/bin/python" ]; then
  PY=".venv/bin/python"
else
  PY="python3"
fi

echo "== 使用解释器: $PY =="
$PY -m bg_recolor make-fixtures --dir examples

echo
echo "== 干净示例（2 张都应成功，退出码 0）=="
$PY -m bg_recolor batch examples/config.example.json
CLEAN_RC=$?

echo
echo "== 隔离演示（2 成功 / 3 隔离，预期退出码 2）=="
$PY -m bg_recolor batch examples/batch/batch_config.json
BAD_RC=$?

echo
echo "完成。用浏览器打开以下报告回看每张图的实际影响范围："
echo "  examples/out-example/report.html"
echo "  examples/batch/output/report.html"
echo "(clean rc=${CLEAN_RC}, isolation rc=${BAD_RC}; exit code 2 means some images were quarantined)"
