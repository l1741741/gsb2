#!/bin/sh
# 一键重建 examples/ 下的全部样例、清单、音频并核对第一拍落点，最后跑测试。
set -e
cd "$(dirname "$0")"

echo "== 生成合成 WAV =="
python3 run.py generate-samples

echo "== 校验计划 =="
python3 run.py validate --plan examples/plan.json

echo "== 转场清单 md/csv/json =="
python3 run.py list --plan examples/plan.json --format md  --out examples/output/transitions.md
python3 run.py list --plan examples/plan.json --format csv --out examples/output/transitions.csv

echo "== 全程试听 + JSON 报告 + 落点核对 =="
python3 run.py render --plan examples/plan.json \
  --out examples/output/full_preview.wav \
  --report examples/output/transitions.json \
  --verify --strict-verify

echo "== 每个切点的单独预听 =="
for t in t_garden_to_market t_market_to_harbor t_harbor_to_garden; do
  python3 run.py render --plan examples/plan.json --only "$t" \
    --out "examples/output/cue_${t}.wav" --verify --strict-verify
done

echo "== 从导出的 16-bit WAV 再核对一次落点 =="
python3 run.py verify-beats --plan examples/plan.json \
  --wav examples/output/full_preview.wav \
  --json examples/output/landings.json

echo "== 缺素材计划应报错并定位到 t_sting_to_market =="
if python3 run.py render --plan examples/plan_missing_material.json \
    --out examples/output/should_not_exist.wav; then
  echo "ERROR: 缺素材计划竟然渲染成功" >&2
  exit 1
else
  echo "(已按预期失败，退出码 $?)"
fi
rm -f examples/output/should_not_exist.wav

echo "== 单元测试 =="
python3 -m unittest discover -s tests

echo "全部完成。产物见 examples/output/"
