# Source origin

This focus-stacking tool was written for this GSB2 task set on 2026-11-28.
It is original code in this repository and is not copied or forked from an
upstream focus-stacking package.  It intentionally uses only the Python
standard library; the PNG codec, focus metrics, seam blending and review
reporting are all implemented here.

The sample stack in `samples/` is a generated vector scene, not a photograph
of a real object or location.  It is produced deterministically by
`python3 -m focusstack samples`.

The existing `renderer/` JavaScript demo at the repository root is unrelated
and was left untouched.
