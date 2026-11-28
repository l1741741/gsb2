#!/usr/bin/env sh
# 一键跑通三种合成场景，展示正常配准、无重叠报错、坏控制点拦截与恢复。
# 用法：./scripts/demo.sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PY="$ROOT/.venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "未找到 $PY，请先创建虚拟环境并安装依赖：" >&2
  echo "  python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt" >&2
  exit 1
fi
export PYTHONPATH="$ROOT"
WORK="${TMPDIR:-/tmp}/thermal_align_demo"
rm -rf "$WORK"
mkdir -p "$WORK"

echo "########## 1) 生成三种合成样例 ##########"
for sc in normal no-overlap bad-point; do
  "$PY" -m thermal_align sample --out-dir "$WORK/sample" --scenario "$sc"
done

echo
echo "########## 2) normal：正常配准 + holdout 独立检查 ##########"
"$PY" -m thermal_align align \
  --visible "$WORK/sample/visible_normal.png" \
  --thermal "$WORK/sample/thermal_normal.png" \
  --points  "$WORK/sample/points_normal.csv" \
  --out-dir "$WORK/out_normal" --name pair

echo
echo "########## 3) no-overlap：应明确失败、退出码 4、零产出 ##########"
set +e
"$PY" -m thermal_align align \
  --visible "$WORK/sample/visible_no-overlap.png" \
  --thermal "$WORK/sample/thermal_no-overlap.png" \
  --points  "$WORK/sample/points_no-overlap.csv" \
  --out-dir "$WORK/out_nooverlap"
echo "退出码=$?（预期 4），输出目录存在？$(if [ -e "$WORK/out_nooverlap" ]; then echo 是; else echo 否; fi)"
set -e

echo
echo "########## 4) bad-point：默认拦截（退出码 3），--drop-outliers 恢复 ##########"
set +e
"$PY" -m thermal_align align \
  --visible "$WORK/sample/visible_bad-point.png" \
  --thermal "$WORK/sample/thermal_bad-point.png" \
  --points  "$WORK/sample/points_bad-point.csv" \
  --out-dir "$WORK/out_bad"
echo "默认退出码=$?（预期 3）"
set -e
"$PY" -m thermal_align align \
  --visible "$WORK/sample/visible_bad-point.png" \
  --thermal "$WORK/sample/thermal_bad-point.png" \
  --points  "$WORK/sample/points_bad-point.csv" \
  --out-dir "$WORK/out_recovered" --name pair --drop-outliers

echo
echo "########## 5) 调预览热值范围（对齐 16 位图不变） ##########"
"$PY" -m thermal_align preview \
  --aligned "$WORK/out_normal/pair_aligned_uint16.png" \
  --meta    "$WORK/out_normal/pair_meta.json" \
  --mask    "$WORK/out_normal/pair_coverage_mask.png" \
  --visible "$WORK/sample/visible_normal.png" \
  --output  "$WORK/out_normal/pair_overlay_narrow.png" \
  --vmin 3000 --vmax 3500

echo
echo "全部产物位于: $WORK"
ls -1 "$WORK/out_normal"
