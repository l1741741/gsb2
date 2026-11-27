#!/usr/bin/env bash
# End-to-end demo: generate sample material, pack it, restore the sprites.
# Works with a plain system Python 3 — no third-party packages needed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-$HERE/demo_output}"
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"

echo "== 1. generate sample material (narrow margins, asymmetric anchors, =="
echo "==    fully transparent image, oversized image, rotation case)      =="
python3 -m texturepacker make-samples "$WORK/samples"

echo
echo "== 2. pack into a 48x64 page, 2 pages max, 2px edge-extrude padding =="
python3 -m texturepacker pack "$WORK/samples/src" "$WORK/atlas" \
  --anchors "$WORK/samples/anchors.json" \
  --page-width 48 --page-height 64 --max-pages 2 --padding 2 || true

echo
echo "== 3. same run with rotation disabled to show the rejection reasons =="
python3 -m texturepacker pack "$WORK/samples/src" "$WORK/atlas_no_rotation" \
  --anchors "$WORK/samples/anchors.json" \
  --page-width 48 --page-height 64 --max-pages 2 --padding 2 --no-rotation || true

echo
echo "== 4. restore single PNGs from the atlas (exact pixel match)        =="
python3 -m texturepacker unpack "$WORK/atlas" "$WORK/restored"

echo
echo "Done. Inspect $WORK/atlas/atlas.json for the full metadata."
