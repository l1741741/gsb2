# wavrepair

A local, dependency-free Python tool for finding short sample jumps left by
buffer interruptions in recorded instrument takes, then repairing **only** the
short ranges a human has confirmed. Detection is advisory; nothing is written
unless a confirmation file names the range.

Everything is standard library only. It was developed and tested on Python
3.14; no third-party packages and no numpy.

## Requirements

- Python 3.10 or newer (uses only long-stable standard library APIs; tested on
  3.14).
- No third-party packages. From this directory, run `python3 -m unittest` and
  `python3 demo/run_demo.py`.

## Workflow

```sh
# 1. Inspect: propose suspicious short ranges, never edit audio.
python3 wavrepair.py scan take.wav --report report.json --draft-confirm confirm.draft.json

# 2. Review report.json / confirm.draft.json by hand. Delete the edits you do
#    not want, keep the ones you do, and save as confirm.json. Renaming
#    confirm.draft.json -> confirm.json is a complete confirmation file as-is
#    if you accept every proposal.

# 3. Repair only the confirmed ranges.
python3 wavrepair.py repair take.wav --confirm confirm.json \
    --output take.repaired.wav --excerpts-out excerpts/

# 4. Independently verify that nothing outside the confirmed ranges changed.
python3 wavrepair.py verify take.wav take.repaired.wav --confirm confirm.json
```

`scan` exits 1 when it proposes at least one suspect, 0 when it proposes none,
and 2 on an error. `repair` exits 0 on success and 2 on any expected failure
(bad input, mismatched confirmation, invalid overlap). `verify` exits 0 when
the output differs only inside the confirmed ranges, 1 otherwise, 2 on error.

## 1. Detection criteria

All levels are **full-scale normalised** (1.0 = the loudest code unit the
format can represent, whether the file is 16-bit PCM or 32-bit float).
Detection runs per channel. Three artifact classes are searched:

| class     | what it looks for |
|-----------|-------------------|
| `impulse` | a sample (or a few adjacent samples) lying outside the value interval spanned by its immediate neighbours, with no rising local RMS envelope |
| `dropout` | a short run of near-silent samples entered and left by a clear jump (a buffered source that momentarily produced nothing) |
| `stuck`   | a short run of bit-identical samples entered and left by a clear jump (a buffer that repeated its last value) |

The `impulse` class is deliberately a **local hull test**, not a plain
amplitude threshold: a drum attack moves the waveform a long way, but every
sample of it stays within the interval its immediate neighbours span, so it is
not flagged. A one- or two-sample click sits far outside that interval. The
reported `peak` is the hull excess in full-scale units.

Every candidate is classified as either:

- `suspect` — proposed for human review (and used by `--draft-confirm`);
- `rejected_transient` — considered and *deliberately not proposed*, either
  because the anomaly is wider than `--max-width` frames or because the local
  RMS envelope rises sharply across it (a percussion attack). These are listed
  in the report so you can see what the tool looked at and set aside.

Each candidate carries `channel`, `start`/`end` frame indices, seconds, the
`peak`, the `rising_fraction`, a human `reason`, and a `context` block with the
sample values immediately **before**, **during** and **after** the range (raw
code units plus normalised values) so you can inspect it without a WAV editor.

### Adjustable options (`scan`)

| option | default | meaning |
|---|---|---|
| `--floor` | 0.120 | absolute hull-excess floor for `impulse` |
| `--sensitivity` | 6.0 | hull excess must also exceed this multiple of the block MAD |
| `--radius` | 4 | median-filter radius (frames) used for the MAD estimate |
| `--mad-block` | 256 | frames per robust-MAD block |
| `--hull-span` | 3 | neighbours each side used for the hull test |
| `--merge-gap` | 24 | merge flagged frames closer than this many frames |
| `--max-width` | 12 | widest range proposed as `suspect`; wider becomes `rejected_transient` |
| `--envelope-window` | 48 | frames either side for the RMS-envelope guard |
| `--envelope-rise` | 3.0 | after/before RMS ratio that marks an attack |
| `--envelope-rise-min` | 0.050 | minimum after-RMS for the guard to apply |
| `--silence-floor` | 0.0005 | sample magnitude treated as silent for `dropout` |
| `--dropout-min` / `--dropout-max` | 2 / 2048 | accepted dropout run length |
| `--stuck-min` / `--stuck-max` | 4 / 2048 | accepted stuck run length |
| `--boundary-jump` | 0.050 | jump required on both edges of a dropout/stuck run |
| `--channel` | all | scan only this channel (repeatable) |
| `--excerpt-before` / `--excerpt-after` | 12 / 12 | context frames in the report |

The criteria are a starting point. If your take is quieter or noisier, lower or
raise `--floor` and `--sensitivity` and re-scan; the report always states which
criteria produced it (`report["settings"]`).

## 2. Confirmation file (public schema)

JSON, UTF-8. `start` is inclusive, `end` exclusive, in frame indices.

```json
{
  "format": "wavrepair-confirm",
  "version": 1,
  "input": {
    "path": "take.wav",
    "sha256": "<sha256 of the exact input bytes>",
    "frames": 105840,
    "sample_rate": 44100,
    "channels": 2
  },
  "overlap_policy": "merge",
  "edits": [
    {"channel": 0, "start": 27342, "end": 27343, "method": "interpolate"},
    {"channel": 0, "start": 92169, "end": 92174, "method": "silence"}
  ],
  "ignored_candidates": [3, 7]
}
```

- `edits[].channel` is the channel the range is described on.
- `edits[].method` is `interpolate` (default) or `silence`.
- `edits[].apply_to` is optional; a list of channels. When present, the same
  `start`/`end`/`method` is applied to every listed channel. When absent the
  edit applies only to `channel`. This is how one confirmed range is mirrored
  onto both stereo channels.
- `ignored_candidates` is report-only: it never changes audio. Use it to record
  candidate IDs from a scan report that you reviewed and decided to leave
  alone, so a re-scan can be diffed against your decisions.

The tool refuses to run when `input.sha256`, `input.frames`,
`input.sample_rate` or `input.channels` do not match the supplied WAV. A
confirmation file cannot be pointed at a different take, and a corrupted or
stale file fails loudly instead of repairing the wrong samples.

### Overlap rules (fixed and public)

After `apply_to` expansion, ranges are resolved per channel:

- **`merge` (default).** Ranges on the same channel that overlap (share at
  least one frame) are merged into one range. Adjacent ranges such as
  `[10,20)` and `[20,30)` share no frame and stay separate. The merged range
  uses `interpolate` if any member asks for interpolation (the less destructive
  method), otherwise `silence`. If a merged span exceeds the maximum repair
  width (4096 frames, or `--max-merge-width`), the file is **rejected** rather
  than silently repairing far more audio than was asked for.
- **`reject`.** Any overlapping ranges on the same channel stop the run with an
  error naming both edits. Ranges on different channels that would repair the
  same frame with *different* methods are also rejected, because that is
  ambiguous.

Resolved ranges are canonicalised to `(channel, start, end)` order. The same
resolution function is used for the written manifest and for the audio, so the
manifest can never describe a different range than the one applied.

## 3. Repair methods

- `interpolate` — a straight line between the last unaffected sample before the
  range and the first unaffected sample after it. The two endpoints are **not**
  modified. If a range touches frame 0 or the last frame (no neighbour on one
  side), the single known neighbour's value is held across the range; the
  manifest records this as `edge_hold: true`.
- `silence` — the range is set to the format's zero code unit (0 for integer
  PCM, +0.0 for float). This is "mute a short buffered segment", not a fade.

Both methods change only the confirmed frames on the confirmed channels. The
frame count, sample rate, channel count and sample codec are asserted unchanged
before anything is written.

Output WAVs are written in a canonical header layout (a fixed RIFF/`fmt `/`data`
arrangement) so two runs of the same confirmation on the same input are
**byte-identical**, not merely sample-identical.

## 4. Exports and determinism

`repair` writes:

- the repaired WAV (`--output`);
- a manifest JSON (`--manifest`, default `<output>.manifest.json`) containing
  the input and output SHA-256 hashes, the confirmation-file hash and policy,
  every applied range (with the original and replacement samples, `edge_hold`,
  and which source edits merged into it), the excerpt hashes, and a
  `verification` block;
- when `--excerpts-out DIR` is given, one `<label>-before.wav` and
  `<label>-after.wav` short excerpt per applied range, padded by
  `EXCERPT_PADDING` (24) frames either side, plus the excerpt sample values in
  the manifest.

**Determinism.** The manifest is serialised with sorted keys and fixed
indentation, and contains no timestamps or random values. Re-running the same
confirmation file against the same input, with the same output path and excerpt
directory, produces a byte-identical WAV and an identical manifest (the demo
checks both). The manifest records paths, so changing the output path changes
the manifest's `output.path` — expected, and the only difference.

**Verification.** The manifest's `verification` block compares the input with
the *re-read* output sample by sample. It reports
`confirmed_samples_changed`, `unconfirmed_samples_changed`,
`unconfirmed_untouched`, and a SHA-256 digest over every sample that is
identical in input and output. `unconfirmed_samples_changed` is always 0 on
success, and the `verify` subcommand recomputes this independently from the
repaired WAV and the confirmation file. The digest covers the unchanged samples
only, so changing a *confirmed* range can change it if the new value happens to
equal the original — the binding check is `unconfirmed_samples_changed == 0`,
not the digest.

## 5. Demo

```sh
python3 demo/run_demo.py --out /tmp/wavrepair-demo
```

Generates, under `--out`:

- `normal-transients.wav` — a 2.4 s stereo take with a continuously gliding
  pitch in both channels and drum hits (including a noisy broadband attack)
  every 0.3 s, and **no artifacts**;
- `demo-take.wav` — the same take with five injected artifacts (positive
  click, negative click, two-sample spike, silent dropout, stuck run) plus
  `demo-ground-truth.json` recording their exact frames;
- `report-clean.json`, `report-clean-sensitive.json`, `report-damaged.json`;
- `confirmation.json` (deliberately leaves the stuck run unconfirmed),
  `repaired.wav`, `manifest.json`, and `excerpts/`.

The runner prints PASS/FAIL for each demonstration and exits non-zero if any
check fails, so it doubles as an end-to-end regression test. In particular it
shows:

1. the clean take yields **no** suspect proposals, and a deliberately
   over-sensitive scan labels drum attacks `rejected_transient`;
2. an empty confirmation on the clean take is a **byte-identical** no-op;
3. all five injected artifacts are proposed;
4. after repair, the four confirmed ranges changed only their own samples, the
   unconfirmed stuck run is still bit-identical, and an independent byte-level
   diff agrees;
5. a re-run produces a byte-identical WAV and identical manifest;
6. a confirmation file whose `input.sha256` does not match is refused with no
   output written.

The excerpts are the "short before/after intervals" export: each is a
`<n>-ch<channel>-<start>-<end>` pair of WAVs spanning the repaired range plus
24 frames of context, so the preserved transients just outside a repair can be
inspected directly.

## Layout

```
wavrepair/
  wavrepair.py            # python wavrepair.py <command>
  wavrepair/
    __init__.py
    __main__.py           # python -m wavrepair
    cli.py                # scan / repair / verify command line
    wavio.py              # PCM WAV read/write (16/24/32-bit int, 32-bit float)
    detect.py             # adjustable detection criteria
    confirm.py            # confirmation schema and overlap policies
    repair.py             # interpolate / silence application
    export.py             # excerpts, manifest, verification
    demo.py               # synthetic takes with ground truth
  demo/
    run_demo.py           # end-to-end demonstration / regression runner
  tests/
    test_wavrepair.py     # unittest suite
```

### Supported sample formats

16-bit signed PCM, 24-bit signed PCM, 32-bit signed PCM, and 32-bit IEEE float
WAV. `WAVE_FORMAT_EXTENSIBLE` headers are accepted when they carry one of those
sub-formats. Other depths (8-bit, 64-bit float, ADPCM, etc.) are refused with
a clear message rather than converted. 24-bit samples are round-tripped
bit-exactly; 32-bit float is stored and rewritten as the nearest float32 value,
which is exact for every float32 input.

## Tests

```sh
python3 -m unittest discover -s tests
```

Covers WAV round-trips in all four formats, truncated/malformed headers,
detection of injected clicks/dropouts/stuck runs, the clean glide not being
flagged, merge vs reject overlap handling, `apply_to`, input-mismatch refusal,
both repair methods and geometry preservation, determinism, and the CLI error
paths.
