# Manual override file format

An override file makes "draw a region here, use this photo" survive reruns.
It is a small JSON document read by every `stack` and `editor` invocation.
Shapes are stored in canvas coordinates -- the pixel grid of the reference
photo -- and rasterised on each run, so the full frame and a block export
produce the same override pixels at the same coordinates.

```json
{
  "version": 1,
  "edits": [
    {
      "id": "moved-fastener",
      "image": 1,
      "note": "fastener unshifted in shot 2",
      "enabled": true,
      "shapes": [ ... ]
    }
  ]
}
```

## Edit object

| field | type | required | meaning |
| --- | --- | --- | --- |
| `id` | string | no (defaults to `edit-N`) | stable label echoed in the review list |
| `image` | integer | yes | zero-based photo index the region must come from |
| `note` | string | no | free text for the retoucher |
| `enabled` | boolean | no (default `true`) | disabled edits stay in the file but paint nothing |
| `shapes` | list | yes, non-empty | one or more shapes; all use the same source photo |

## Shapes

All coordinates are floats in canvas pixels; fractional edges are snapped to
the nearest covered pixels.  Each shape accepts an optional `strength` in
`(0, 1]`; at 1.0 the region is a full replacement (`manual_override`), below
1.0 it becomes a partial mix reported as `manual_override_partial`.

### rect

```json
{"kind": "rect", "x": 40, "y": 60, "width": 30, "height": 24}
```

Covers `x .. x+width-1` and `y .. y+height-1` for integer bounds.

### ellipse

```json
{"kind": "ellipse", "cx": 157, "cy": 196, "rx": 26, "ry": 28}
```

Filled axis-aligned ellipse.  The outer pixel is softly weighted, giving a
half-covered rim rather than a stair-step; the resulting mask is a byte
plane where 255 is fully replaced.

### polygon

```json
{"kind": "polygon", "points": [[70, 60], [95, 70], [88, 90]]}
```

At least three `[x, y]` points, even-odd fill.  Concave shapes are fine as
long as the fill rule is what you want; self-intersecting outlines fill their
odd winding regions.

### brush

```json
{"kind": "brush", "points": [[10, 10], [12, 14], [20, 20]], "radius": 3}
```

A polyline stroke with round joins.  `radius` is in canvas pixels.  Each
pixel within `radius-1` is fully painted; the outer pixel is soft.  A single
point paints a dot.

## Rules and diagnostics

- Every enabled shape must name a valid photo index; otherwise the file is
  rejected with a message.
- If the target photo did not record a canvas pixel (offset or transparent
  alpha), the override is skipped there: the stacker never invents pixels.
  The edit's record then reports `skipped_uncovered`.
- Edits are applied before one-pixel speckle cleanup and before seam
  blending, so an override participates in seam handling like any other
  source decision.
- The review list's `manual_edits[]` mirrors the file: `painted` is the total
  canvas area affected and `in_window` the part inside the exported block.
  A rerun that keeps the override reports the same `painted` value every
  time.

## Hand-editing workflow

1. Run a stack, open `review-overlay.png`, find a numbered box.
2. Read its `bbox` from `review.json`.
3. Add an edit whose shape roughly covers that box and whose `image` is the
   photo that holds the correct detail.
4. Rerun; check `manual_edits` in the new review and the composite.

The editor writes exactly this format; nothing else needs to be generated.
