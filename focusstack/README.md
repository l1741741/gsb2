# focusstack

A local, dependency-free PNG focus stacker for macro/product photography.
You shoot several photos at one angle with different focus distances and get
back a composite preview, a source map you can audit, and a short list of
regions a retoucher must look at.  Nothing is silently smeared: flat areas
fall back to the reference photo, ambiguous choices are deterministic and
listed, and every manual override is stored in a JSON file that reruns reuse.

The tool uses only the Python standard library (3.9+, including 3.14 without
numpy).  The existing `renderer/` demo in this repository is untouched.

## Why this exists

A naive "pick the sharpest pixel and paste" stack has three failure modes:

1. **Flat areas flip.**  In low-contrast regions every photo's focus score
   is essentially noise, so the winner changes from run to run and from tile
   to tile.  The result looks mottled and a block export can disagree with
   the full frame.
2. **Hard seams destroy thin lines.**  A one-pixel wire crossing a focus
   transition gets cut in half at the seam.  Averaging the two photos turns
   it into a grey ghost.
3. **Moved parts are averaged.**  When a part visibly shifts between shots
   (subject settling, hand tremor), no per-pixel focus choice can reconcile
   it; someone has to say "use this photo here".

`focusstack` addresses each explicitly: normalised scores plus a confidence
floor for (1), ridge-protecting seam blends for (2), persisted overrides for
(3).

## Requirements

- Python 3.9 or newer. No third-party packages.
- The optional drawing editor needs a Python build that includes tkinter.
  Homebrew's `python3` usually does not; `/usr/bin/python3` on macOS does.

## Quick start

```sh
cd focusstack
python3 -m focusstack samples --out samples
python3 -m focusstack stack --out ./result --reference 0 \
    samples/01-near.png samples/02-mid.png samples/03-far.png samples/04-near-moved.png
```

The result directory contains:

| file | what it is |
| --- | --- |
| `composite.png` | the blended preview |
| `sources.png` | colour-coded map of which photo each pixel came from |
| `seams.png` | source boundaries drawn over a dimmed composite |
| `review-overlay.png` | the composite tinted by review reason, numbered boxes |
| `review.json` | the review list, legend, usage shares, override records |
| `masks/source-NN.png` | optional per-photo masks (`--masks`) |

Then check `review.json`.  On the samples you should find `seam_conflict`
regions around the moved fastener, a handful of `ambiguous_near_tie` spots,
and two large `low_confidence` areas (the flat card and background), which
are always listed so a retoucher can confirm they are genuinely featureless.
Fix the fastener with the supplied override:

```sh
python3 -m focusstack stack --out ./result-edited --edits samples/edits.json \
    samples/01-near.png samples/02-mid.png samples/03-far.png samples/04-near-moved.png
```

`manual_edits` in the new `review.json` will report `painted: 2292`, and the
fastener now comes from the photo named in the override.

## Command summary

```sh
python3 -m focusstack stack   [options] PHOTO...
python3 -m focusstack inspect [options] PHOTO...   # prints review as JSON
python3 -m focusstack samples [--out DIR]
python3 -m focusstack editor  --edits FILE PHOTO... # tkinter window
```

Photo indices in options are zero-based in argument order.  `inspect` runs
the same pipeline and writes nothing.

### Alignment and coverage

```sh
# photo 1 moved 4 px right / 3 px up relative to photo 0; use photo 2 as the base
python3 -m focusstack stack --reference 2 --offsets "4,-3; 8,-3; 0,0" a.png b.png c.png
```

* `--reference i` re-expresses the same geometry from photo *i*'s
  viewpoint.  All offsets are rebased so that photo sits at `(0, 0)`.
* `--offsets "dx,dy; dx,dy; ..."` gives one integer offset per photo, all
  in a single common frame.  Positive `dx` moves that photo's content right.
* The **canvas is the union** of every shifted photo, so it can be larger
  than the reference photo; content nudged past the reference frame is kept.
  Canvas (0, 0) is the union's top-left corner; `origin` in `review.json`
  records where that corner sits in the common frame.
* `--coverage crop` (default) exports only the region every photo recorded
  (the intersection).  This is usually the safe choice.
* `--coverage keep` exports the whole union; pixels no photo recorded -- the
  gaps between diagonally shifted frames, or transparent input pixels --
  are drawn as a grey checkerboard and listed as `uncovered`.
* `--coverage error` refuses a window that reaches any unrecorded pixel.

### Choosing an export block

```sh
python3 -m focusstack stack --out ./block --window 110,160,90,80 ...
```

The window only selects what is written.  Focus measurement, source
selection, overrides and blending always run on the full canvas, then the
block is cropped from those planes.  A block export is therefore pixel
identical to the same rectangle of a full export; the test suite asserts
this for composite and source map, with and without overrides.

### Selection and seam tuning

| flag | default | effect |
| --- | --- | --- |
| `--confidence-threshold` | 0.25 | below this local confidence, flat pixels keep the reference photo |
| `--tie-fraction` | 0.12 | relative score gap treated as a tie |
| `--tie-visual-diff` | 8 | RGB difference that makes a tie worth reviewing |
| `--tie-flag-confidence` | 0.5 | ties below this confidence are merged silently |
| `--low-conf-visual-diff` | 8 | RGB difference that upgrades flat areas to `low_confidence_divergent` |
| `--seam-radius` | 2 | blend radius around a source change |
| `--no-edge-protection` | off | disable ridge protection (comparison only) |
| `--seam-conflict-threshold` | 26 | luma difference across a seam that gets flagged |
| `--speckle-passes` | 1 | 0 disables one-pixel label cleanup |
| `--min-review-area` / `--max-regions` | 4 / 400 | review list size controls |

## How selection works

For each photo, on luma:

1. Second-derivative energy is computed with both axis-aligned and diagonal
   Laplacians, so diagonal one-pixel lines register too.
2. That energy is squared, averaged over a small window (default radius 2)
   and square-rooted -- an RMS focus measure.  Squaring matters: a blurred
   step edge spreads its response over many pixels and would otherwise beat
   a sharp edge in a mean-of-magnitude measure.
3. A per-photo noise floor is the low percentile of that response
   (`noise_scale` tunes it); the raw score is response divided by floor.
4. Confidence is 0 at the floor and rises to 1 at several times it.

Per pixel, the selector:

- restricts candidates to photos that actually recorded the pixel (offsets,
  alpha);
- if confidence is below `--confidence-threshold`, all scores are noise,
  so it keeps the reference photo (or the lowest valid index) and flags the
  pixel only if the photos visibly disagree there;
- if the top two scores are within `--tie-fraction`, it picks the lowest
  index in the tied set (deterministic) and flags it when the two photos
  also differ visibly and confidence is high enough to trust the reading;
- otherwise the sharpest photo wins.

Then labelled one-pixel speckle is removed, manual overrides are painted
from the edit file, and seam conflicts are detected (different photos on both
sides of a boundary that disagree in luma).

## How seams are blended

Source weights are box-filtered label indicators.  Where the owning photo has
a strong ridge response -- a thin line or a hard edge -- mixing is suppressed,
so the line stays with one photo instead of being averaged to grey.  Every
output pixel remains a normalised weighted average of pixels that were
actually recorded.  Regions where blended photos disagree visibly are listed
as `seam_conflict` for review; they are not hidden.

## Manual overrides (drawing a region)

An edit file is plain JSON, so it can be hand-written or generated:

```json
{
  "version": 1,
  "edits": [
    {
      "id": "moved-part",
      "image": 1,
      "note": "fastener in its original position",
      "enabled": true,
      "shapes": [
        {"kind": "ellipse", "cx": 157, "cy": 196, "rx": 26, "ry": 28, "strength": 1.0},
        {"kind": "rect", "x": 40, "y": 60, "width": 30, "height": 24},
        {"kind": "polygon", "points": [[70, 60], [95, 70], [88, 90]]},
        {"kind": "brush", "points": [[10, 10], [12, 14], [20, 20]], "radius": 3}
      ]
    }
  ]
}
```

Geometry is in canvas pixels (the reference photo's grid).  Shapes are read
and rasterised on every run, so reruns and block exports reuse exactly the
stored geometry.  `strength` below 1 records a partial override
(`manual_override_partial` in the review list).  See `docs/EDIT-FORMAT.md`.

Graphical editing:

```sh
/usr/bin/python3 -m focusstack editor --edits edits.json \
    samples/01-near.png samples/02-mid.png samples/03-far.png samples/04-near-moved.png
```

Draw with the left button (`r` rectangle, `e` ellipse, `p` polygon, right
click finishes a polygon, `b` brush, digits `1`..`9` pick the source photo),
then **Save + rerun** to persist and preview in one step.  Windowed editing
(`--window x,y,w,h`) restricts the displayed area but geometry stays global.

## Review output

`review.json` is the checklist a retoucher works from:

- `regions[]` -- connected flagged areas, lowest priority number first.  Each
  has `id` (matching the overlay box), `reason`, `secondary_reasons`, `bbox`,
  `area`, `owner_photos`, `mean_owner_confidence`, and plain-language
  `guidance`.  Reasons are `seam_conflict`, `ambiguous_near_tie`,
  `low_confidence`, `low_confidence_divergent`, `uncovered`,
  `manual_override_partial`.

  Ordinary `low_confidence` regions are boxed and listed but not tinted:
  they are a normal property of a stack and would otherwise cover most of
  the frame.  `low_confidence_divergent` (flat *and* the photos visibly
  differ there) is tinted like the other defects.
- `reasons_legend` -- the colour used for each reason in the overlay.
- `usage` -- per-photo pixel share and uncovered count for the exported block.
- `manual_edits[]` -- every override with `painted`, `in_window` (how much
  of it fell inside the exported block), `skipped_uncovered`, and its bbox.
- `common_region` / `union_region` -- the intersection and the full union,
  both in canvas coordinates; `canvas` and `origin` describe the union frame.

A suggested pass: open `composite.png` at 100%, walk the top regions, compare
`sources.png` for stability, check `seams.png` for doubled outlines, and
confirm edits via `manual_edits`.

## Samples

`samples/` contains four 360x270 PNGs of one vector-ish scene:

- `01-near.png` -- thin wires, rings, tick marks and a slanted dark shape
  sharp;
- `02-mid.png` -- a flat card with a low-contrast drawing and tick row
  sharp;
- `03-far.png` -- a slanted far edge, a large soft circle and two simple
  shapes sharp;
- `04-near-moved.png` -- near focus, with the red fastener shifted 7 px and
  a slanted near piece straddling the card.

Each depth carries its own fine texture so the correct source for a region
is unambiguous, while wide flat areas deliberately have none: those are the
low-confidence regions the checklist is meant to surface.

`edits.json` is a ready-made override for the fastener.  Generation is
deterministic (`--seed`); regenerating produces byte-identical files.

## Tests

```sh
cd focusstack
python3 -m unittest discover -s tests -v
```

Coverage includes PNG format variants and CRC rejection, geometry
rasterisation, the sharp-depth selection contract, low-contrast stability,
thin-line preservation through seams, override persistence and reporting,
and block-vs-full pixel identity.

## Layout

```
focusstack/
  focusstack/          package (CLI, pipeline, pngio, focus, select, seam, ...)
  focusstack/editor/   tkinter drawing editor
  samples/             generated sample photos and edit file
  tests/               unittest suite
  docs/                algorithm and edit-format notes
```

## Limits

- 8-bit output; 16-bit input is read at 8-bit depth.
- Integer offsets only; there is no automatic alignment or sub-pixel shift.
- Interlaced PNGs are rejected rather than silently mishandled.
- Pure-Python processing; an 800x600 three-photo stack takes a few seconds.
- The editor cannot be exercised headlessly; its geometry is covered by the
  rasteriser tests, but the window itself needs a manual check on a desktop.
