# WAV Silence Trimmer

A local, dependency-free Python tool for editorial teams who record field
interviews and need to find long pauses, shorten them selectively, and still
trace every frame of the finished clip back to the original recording.

It uses only the Python standard library (Python 3.10+). No audio is ever sent
anywhere; everything runs against local WAV files.

## What it does

1. **Finds long pauses** by amplitude threshold and minimum duration. Frames
   are analysed with a configurable window/hop; small noisy gaps are merged and
   short runs are discarded so borderline noise and brief gaps never become a
   string of fragments. Multi-channel recordings follow a selectable joint
   rule (`all` channels quiet / `any` channel quiet / channel average).
2. **Lets the editor decide per pause**: keep it, shorten it to a chosen
   duration (anchored at the start, end or centre), delete it, or replace the
   boundaries by hand. Every cut junction gets a controllable linear or
   equal-power crossfade so splices do not click.
3. **Publishes a full time map**: an original↔output interval correspondence,
   the deleted ranges, and bidirectional point lookup. Any time point maps to
   its counterpart or is explicitly reported as deleted.
4. **Carries an external marker table** through the same mapping; markers that
   land inside a deletion are reported separately. All outputs are published
   atomically — a failed export leaves no half-written "successful" clip and
   preserves any previously good output.

## Layout

```
silence_trimmer/
├── trimmer/            # importable library
│   ├── wavio.py        # PCM 8/16/24/32-bit + 32-bit float WAV IO
│   ├── detect.py       # frame analysis, joint channel rule, merging/filtering
│   ├── edit.py         # decisions, segment planning, crossfaded rendering
│   ├── map.py          # interval map, bidirectional lookup, marker mapping
│   ├── reports.py      # CSV/JSON reports and atomic publication
│   ├── pipeline.py     # end-to-end flow + decision-file IO
│   └── cli.py          # command-line entry point
└── tests/              # unittest suite and the synthetic stereo fixture
```

## Quick start

From this directory:

```sh
# 1. Inspect candidates and write an editable decision file
python3 -m trimmer detect interview.wav --decisions decisions.json

# 2. Edit decisions.json (action: keep | shorten | delete | manual), then apply
python3 -m trimmer apply interview.wav edit/final.wav \
    --decisions decisions.json --markers markers.csv --fade-ms 10

# Or do it in one shot, shortening every long pause to 0.3 s
python3 -m trimmer trim interview.wav edit/final.wav --keep-pause 0.3

# 3. Trace a time point either direction using the published map
python3 -m trimmer locate edit/final.map.json 12.45
python3 -m trimmer locate edit/final.map.json 8.10 \
    --direction output-to-original
```

If the package is not on `PYTHONPATH`, prefix commands with
`PYTHONPATH=/path/to/silence_trimmer`.

## Detection parameters

| Flag | Default | Meaning |
| --- | --- | --- |
| `--threshold-dbfs` | `-40` | frame is quiet when its amplitude is below this dBFS level |
| `--min-pause` | `0.8` | keep only silent runs at least this many seconds long |
| `--frame-ms` | `20` | analysis frame length |
| `--hop-ms` | half frame | analysis hop |
| `--merge-gap-ms` | `200` | noisy gaps strictly shorter than this merge neighbouring runs |
| `--amplitude` | `peak` | `peak` (max absolute sample) or `rms` |
| `--channel-rule` | `all` | `all` / `any` / `avg` joint rule for multi-channel audio |

Merging uses a **strictly less-than** comparison against `merge-gap-ms`: a gap
exactly at the limit stays separate, so a real word between two pauses is never
silently swallowed. When a run is formed by merging across a short noisy blip,
the reported per-channel peak exposes that the region was not perfectly silent,
which is the editor's signal to listen before deleting it wholesale.

## Decision file

`detect --decisions` writes one row per candidate with its measured bounds and
per-channel peak. Set `action` per row:

```json
{
  "pause_index": 0,
  "action": "shorten",
  "keep_sec": 0.3,
  "anchor": "start",
  "new_start_sec": null,
  "new_end_sec": null
}
```

* `keep` — leave the pause untouched (the default).
* `shorten` — retain `keep_sec` seconds; `anchor` is `start`, `end` or
  `center`.
* `delete` — remove the whole pause.
* `manual` — replace the boundaries with `new_start_sec` / `new_end_sec`
  (original-timeline seconds). Overlapping or out-of-range manual bounds are
  rejected before anything is rendered.

## Outputs

For an output named `edit/final.wav` the run writes:

| File | Contents |
| --- | --- |
| `final.wav` | rendered clip, same sample rate / channel count / sample format as the input |
| `final.map.json` | full map incl. frame-exact kept/deleted bookkeeping and mapped markers |
| `final.intervals.csv` | original↔output interval correspondence (human-readable) |
| `final.deleted.csv` | every deleted original-timeline range |
| `final.markers.csv` | marker table with `mapped` / `deleted` status (only with `--markers`) |

### Boundary convention

Frame intervals are half-open `[start, end)`. A time point landing exactly on a
deletion boundary is attributed to the surviving side and is **not** reported
as deleted; only points strictly inside a removed range return `DELETED`.
`locate` exits `0` for a mapped point and `2` for a deleted one, so the status
is usable in scripts.

## Marker tables

CSV (with a `time_sec,label` header, or header-less `time,label` rows) and JSON
(`[{"time_sec": 1.2, "label": "q1"}]` or `{"markers": [...]}`) are accepted.
Markers inside deleted ranges appear both in `final.markers.csv` with status
`deleted` and under `deleted_markers` in the JSON, and are printed as a
warning at the end of the run.

## Atomic export

The WAV is encoded and re-read for validation (format plus exact frame count)
before any target path is touched. All outputs are staged as temporary files,
then renamed into place together. On any failure the staging files are removed
and pre-existing targets are restored from backup — there is no state in which
a failed run looks like a complete, successful export.

## Tests

```sh
python3 -m unittest discover -s tests -v
```

The suite builds a synthetic stereo fixture containing:

* a pause where the two channels differ (left dead, right carrying quiet room
  tone), exercising the joint channel rule;
* two long pauses separated by a 250 ms speech blip that must keep them apart;
* a 120 ms noisy blip inside silence that must be absorbed, not fragmented;
* a 1.5 s trailing pause at end of file;
* markers in kept speech, on a boundary, and inside deletions.

It asserts total output length, marker placement, the natural pause that
remains after shortening, crossfade behaviour, bidirectional lookup, atomic
rollback, and round-trips for every supported sample format.
