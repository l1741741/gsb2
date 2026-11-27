"""Generate the synthetic stereo fixture used by the test suite.

The fixture is deliberately constructed around the edge cases the trimmer
must handle:

* a long pause where the two channels differ (left silent, right carrying
  quiet room tone), so the multi-channel joint rule can be exercised;
* two long pauses separated by a short speech blip (adjacent boundaries that
  must not merge across the blip);
* a short sub-threshold silent gap inside speech that must be absorbed rather
  than reported as its own fragment;
* a long trailing pause at end of file;
* markers landing in kept speech, on a cut boundary and inside a deletion.
"""

from __future__ import annotations

import array
import math
import os

from trimmer.wavio import WaveData, write_wav

SR = 16000
CHANNELS = 2
DURATION_SEC = 6.0
TOTAL_FRAMES = int(SR * DURATION_SEC)


def _tone(frame: int, freq: float, amplitude: float) -> float:
    return amplitude * math.sin(2.0 * math.pi * freq * frame / SR)


def build_sample() -> WaveData:
    """Return the interleaved stereo sample described in the module docstring."""
    samples = array.array("d", [0.0]) * (TOTAL_FRAMES * CHANNELS)

    # Timeline (seconds):
    # 0.00-1.00 speech, loud on both channels
    # 1.00-2.00 pause A: left silent, right quiet tone (~ -50 dBFS room tone)
    # 2.00-2.25 speech blip (250 ms) separating two long pauses; wider than
    #            the 200 ms merge gap so the pauses must stay separate
    # 2.25-3.20 pause B: fully silent
    # 3.20-3.32 short noisy blip (120 ms) inside silence; narrower than the
    #            200 ms merge gap so the surrounding silence absorbs it
    # 3.32-3.40 silence completing the merged run around the blip
    # 3.40-4.50 speech
    # 4.50-6.00 trailing pause C (1.5 s), fully silent
    regions = [
        (0.00, 1.00, "speech"),
        (1.00, 2.00, "pause_lopsided"),
        (2.00, 2.25, "speech"),
        (2.25, 3.20, "pause_silent"),
        (3.20, 3.32, "blip_short"),
        (3.32, 3.40, "pause_silent"),
        (3.40, 4.50, "speech"),
        (4.50, 6.00, "pause_trailing"),
    ]

    for start_sec, end_sec, kind in regions:
        start = int(start_sec * SR)
        end = int(end_sec * SR)
        for f in range(start, end):
            li = f * CHANNELS
            if kind == "speech" or kind == "blip_short":
                samples[li] = _tone(f, 220.0, 0.5)
                samples[li + 1] = _tone(f, 330.0, 0.4)
            elif kind == "pause_lopsided":
                # Left channel dead; right channel carries 0.003 amplitude
                # (~ -50 dBFS), below the -40 dBFS detection threshold.
                samples[li] = 0.0
                samples[li + 1] = _tone(f, 80.0, 0.003)
            else:
                # Full silence: pause B, the absorbed-run tail, trailing C.
                samples[li] = 0.0
                samples[li + 1] = 0.0

    return WaveData(
        samples=samples,
        sample_rate=SR,
        channels=CHANNELS,
        sampwidth=2,
        is_float=False,
    )


def marker_rows():
    """(time_sec, label, expected_outcome) markers for mapping tests."""
    return [
        (0.5, "speech-mid", "mapped"),
        (1.0, "boundary-a-start", "mapped"),  # boundary maps to the junction
        (1.5, "inside-pause-a", "deleted"),
        (2.12, "between-pauses", "mapped"),   # inside the 250 ms speech blip
        (5.0, "inside-trailing", "deleted"),
    ]


def write_sample_wav(path: str) -> WaveData:
    audio = build_sample()
    write_wav(path, audio)
    return audio


if __name__ == "__main__":  # pragma: no cover - manual fixture regeneration
    out = os.path.join(os.getcwd(), "sample.wav")
    write_sample_wav(out)
    print(f"wrote {out}")
