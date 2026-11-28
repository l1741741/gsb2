#!/bin/bash
# 端到端演示：错序输入、拆句、合句、缺行、孤立行、人工锚点与挤不下警告。
# 用法: bash examples/run_demo.sh
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="${TMPDIR:-/tmp}/srt_align_demo"
mkdir -p "$OUT"

echo "### 1) 正常运行（带人工锚点）"
python3 -I align_srt.py \
    examples/original.srt examples/translation.srt \
    --anchors examples/anchors.txt \
    --output "$OUT/aligned.srt" \
    --report "$OUT/report.json" \
    --text-report "$OUT/report.txt"
echo "对齐后 SRT 已写出: $OUT/aligned.srt"
echo

echo "### 2) 冲突锚点必须被拒绝（原版位置 2 与 2+3 交叉）"
printf '1 = 1\n2+3 = 3\n2 = 5\n' > "$OUT/bad_anchors.txt"
if python3 -I align_srt.py \
        examples/original.srt examples/translation.srt \
        --anchors "$OUT/bad_anchors.txt" \
        --output "$OUT/should_not_exist.srt"; then
    echo "ERROR: 冲突锚点未被拒绝"
    exit 1
else
    echo "-> 已按预期拒绝，退出码非 0"
fi
echo

echo "### 3) 挤不下场景：原文只有 400ms，译文文字很长"
cat > "$OUT/tight_orig.srt" <<'EOF'
1
00:00:01,000 --> 00:00:01,400
Go!
EOF
cat > "$OUT/tight_trans.srt" <<'EOF'
1
00:00:01,000 --> 00:00:01,400
所有人立刻撤离现场并清点人数注意安全
EOF
python3 -I align_srt.py "$OUT/tight_orig.srt" "$OUT/tight_trans.srt" \
    --output "$OUT/tight_aligned.srt" --strict || true
echo

echo "产物目录: $OUT"
