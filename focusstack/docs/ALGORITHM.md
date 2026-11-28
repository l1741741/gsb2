# Algorithm notes

This file records the decisions behind `focusstack` so they can be audited
or changed deliberately rather than by accident.

## 1. Geometry

Photos must share dimensions.  Each has an integer offset expressed in one
common frame; choosing `--reference i` subtracts photo *i*'s offset from
every offset, making the reference's coordinate system the output canvas.

For a normalised offset `(dx, dy)`, canvas pixel `(cx, cy)` corresponds to
photo pixel `(cx - dx, cy - dy)` *before* the canvas origin is moved.

The canvas is the bounding box of all shifted photos, not the reference
photo's frame.  With placements `px = dx - min(dx)`, `py = dy - min(dy)`, a
photo covers `[px, px+W) x [py, py+H)`.  This lets content nudged outside
the reference frame survive in `keep` mode instead of being discarded.

- **common region**: intersection of all placements.  `--coverage crop`
  exports this.
- **union region**: the whole canvas.  `--coverage keep` exports it and
  paints unrecorded pixels as a checkerboard.
- **holes**: the union's bounding box can contain empty corners when two
  photos are shifted diagonally apart.  `--coverage error` walks each row
  and unions covered x-intervals to detect them; the naive bounding-box test
  would pass such a window.
- Pixels no photo recorded at all (union holes or transparent input) become
  `uncovered` review regions.

## 2. Focus measure

For each photo:

```
E = |Lap4(luma)| + 0.5 * |LapDiag(luma)|     per pixel
C = sqrt(boxblur(E^2, r))                     per pixel, r = --focus-window
F = low_percentile(C)  (default 20th, stride 3)
score = C / max(F * noise_scale, 0.35)
confidence = clamp((C - 1.35F) / (4.0F - 1.35F), 0, 1)
```

The 4-neighbour and diagonal Laplacians see horizontal/vertical and 45-degree
structure respectively, so thin diagonal lines are not missed.

Squaring before the window average is essential.  A sharp step concentrates
Laplacian energy in 2-3 rows; a defocused version spreads the same total
energy over 8-10 rows.  Mean-of-absolute response therefore *rewards* blur
near strong edges (observed on the sample card border, where the blurred far
photo outscored the sharp mid photo).  The RMS measure ranks the sharp photo
correctly at the same locations, which is the reason for the change.

The floor is per-photo because photos differ in noise/grain; dividing by it
makes scores comparable across the stack.  `confidence` tracks distance from
the noise floor, not absolute sharpness, so low-texture areas reliably end up
below the threshold.

## 3. Selection rules

Order per pixel, first match wins:

1. no valid photo -> label `UNCOVERED`, flag `uncovered`;
2. one valid photo -> that photo, no flag;
3. max confidence < threshold -> reference if valid, else best index.
   The pixel is always flagged `low_confidence` so the checklist covers flat
   areas (requirement 5); if another valid photo differs by more than
   `low_conf_visual_diff` it is promoted to `low_confidence_divergent`, which
   is tinted in the overlay because the invisible arbitrary choice there can
   actually matter;
4. best score within `tie_fraction` of runner-up -> lowest index among the
   tied photos; flag `ambiguous_near_tie` only if that choice differs from
   the raw best photo visibly *and* confidence is at least
   `tie_flag_confidence` (truncated windows at the canvas border otherwise
   produce false ties);
5. otherwise the best score wins.

Rule 3 is what makes flat areas stable: with no signal, the reference photo
wins everywhere, so the label map cannot flicker.  Rule 4 is what makes
reruns and block exports identical: the tie-break never depends on sub-tile
state.

`remove_isolated` then replaces any pixel none of whose 8 neighbours share
its label with the local majority label.  A one-pixel line keeps its line
neighbours and survives; a noise island disappears.

## 4. Seam blend

Weights are per-photo box-filtered indicator planes at radius
`--seam-radius`.  For each pixel with owner `o`:

```
prot = ridge_protection(owner)   in [0,1]
w[o] = 1 - (1 - wbox[o]) * prot
w[k] = wbox[k] * (1 - prot)   for k != o
output = sum_k w[k] * photo_k  / sum_k w[k]
```

`ridge_protection` is derived from the owner photo's own Laplacian energy
relative to that photo's percentile floor, grown one pixel and softened.
This keeps a thin line unmixed without drawing on labels, which is why it
does not re-introduce a hard seam elsewhere.

Detection of `seam_conflict` is separate from blending: any covered pixel
with a different-label neighbour whose luma differs by more than
`--seam-conflict-threshold` is flagged.  It says "a reviewer should look",
not "the blend is wrong".

## 5. Manual overrides

Applied after selection, before speckle cleanup and seam detection.  A
shape's mask value v (0..255) replaces the label with the target photo;
v >= 128 gets `manual_override`, otherwise `manual_override_partial`.  If
the target photo has no valid pixel there, the override is skipped and
counted in `skipped_uncovered`.

Because geometry lives in canvas coordinates and is re-rasterised every run,
a block export applies the same pixels as the full export.  Reporting only
adds `in_window`.

## 6. Export

Labels, flags, composite and focus planes are always full-canvas.  The
export window crops them.  This is why requirement 4 holds by construction
rather than by engineering a matching tile mode: there is only one result,
and blocks are views of it.  The consistency tests verify composite and
source map byte equality between a block export and the matching rectangle
of a full export.

## 7. Determinism

No clock, random, or float accumulation order varies between runs:
- sample generation uses a fixed LCG seed;
- sorting uses explicit tie-breaks;
- every plane operation is elementwise;
- the PNG encoder emits fixed Paeth filtering.

The determinism and block-consistency tests run the pipeline twice and
compare planes directly.
