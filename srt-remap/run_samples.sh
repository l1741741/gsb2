#!/usr/bin/env bash
# 用自带样例跑一遍：trim（默认）与 keep 两种冲突模式。
# 输出到 samples/output/，无参数、无第三方依赖。
set -euo pipefail

cd "$(dirname "$0")"

echo "== trim 模式（按轨道优先级裁剪） =="
python3 -m srt_remap \
  --edl samples/edit_list.json \
  -o samples/output --stem timeline --mode trim

echo
echo "== keep 模式（全部保留，冲突写入报告；退出码 1 表示存在冲突） =="
python3 -m srt_remap \
  --edl samples/edit_list.json \
  -o samples/output --stem timeline-keep --mode keep || true

echo
echo "== 坏清单的错误定位 =="
python3 -m srt_remap \
  --edl samples/bad_edit_list.json \
  -o samples/output --stem bad || true
