"""Synthetic demo takes with known ground truth.

``make_demo`` writes a small set of 16-bit stereo WAV files that exercise the
tool honestly:

``demo-take.wav``
    A realistic-ish instrumental take: a continuously changing pitch line
    (two gliding voices) plus periodic drum hits. Punched into it are the
    kinds of artifacts a buffered recorder leaves behind:
    * one-sample positive click,
    * one-sample negative click,
    * a two-sample spike,
    * a short silent dropout,
    * a short stuck (repeated) run.

``demo-take.repair.wav`` ... are produced by the demo script, not here.

``normal-transients.wav``
    The same continuous pitch line and drum pattern with no artifacts, used to
    show that the detector does not propose repairs for legitimate attacks.

Because the generator is seeded deterministically and uses only the standard
library, the files and the ground-truth JSON are reproducible.
"""

from __future__ import annotations

import json
import math
import os
import random

from .wavio import Audio, write_wav

SAMPLE_RATE = 44_100
CHANNELS = 2
DURATION_SECONDS = 2.4
CLICK_AMPLITUDE = 0.92       # normalised
DRUM_AMPLITUDE = 0.35


def _frame_count() -> int:
    return int(SAMPLE_RATE * DURATION_SECONDS)


def _pitch_voice(t: float, index: int) -> float:
    """Continuous gliding pitch: phase is the integral of frequency.

    A chirp whose instantaneous frequency sweeps smoothly, so sample-to-sample
    deltas stay small everywhere. This is the "normal continuous pitch change"
    that must NOT be cut out.
    """
    if index == 0:
        f0, f1 = 110.0, 330.0
        base_phase = 0.0
        amplitude = 0.22
    else:
        f0, f1 = 220.0, 176.0
        base_phase = math.pi / 3
        amplitude = 0.16
    # Linear frequency sweep; phase = 2*pi*(f0*t + (f1-f0)*t^2/(2*T)).
    duration = DURATION_SECONDS
    phase = 2 * math.pi * (f0 * t + (f1 - f0) * t * t / (2 * duration)) + base_phase
    # A little vibrato so it is not a pure exponential chirp.
    phase += 0.8 * math.sin(2 * math.pi * 5.0 * t)
    return amplitude * math.sin(phase)


def _drum_hit(local_t: float, seed_value: float, rng: random) -> float:
    """A short percussive envelope with a noisy broadband attack.

    The first few samples carry genuine broadband noise (a snare-like crack).
    Those samples are *legitimate* isolated outliers: a naive impulse detector
    will flag them, but they sit inside a rising RMS envelope, which is the
    signal the detector uses to tell them apart from a buffered glitch.
    """
    if local_t < 0:
        return 0.0
    decay = math.exp(-local_t / 0.010)
    body = math.sin(2 * math.pi * 95.0 * local_t + seed_value) * decay
    if local_t < 4.0 / SAMPLE_RATE:  # ~4-sample crack
        crack = rng.uniform(-1.0, 1.0) * math.exp(-local_t / (1.2 / SAMPLE_RATE))
    else:
        crack = 0.0
    return DRUM_AMPLITUDE * (body + crack + (seed_value - 0.5) * decay * 0.6)


def _base_signal(frame: int, rng: random) -> tuple:
    """Return (left, right) before any injected artifact."""
    t = frame / SAMPLE_RATE
    left = _pitch_voice(t, 0)
    right = _pitch_voice(t, 1)
    # Drum hits every 0.3 s, offset between channels to emulate a real kit.
    period = 0.3
    for hit_index in range(int(DURATION_SECONDS / period) + 1):
        hit_time = hit_index * period
        seed_value = 0.5 + 0.5 * math.sin(hit_index * 1.7)
        # Seed the crack noise per (hit, channel) so the file stays reproducible
        # and the two channels are not identical.
        local = t - hit_time
        left += _drum_hit(local, seed_value, random.Random(10_000 + hit_index)) * 0.6
        right += _drum_hit(local - 0.004, seed_value, random.Random(20_000 + hit_index)) * 0.6
    return left, right


def build_normal_take() -> Audio:
    frames = _frame_count()
    rng = random.Random(20261125)
    samples = []
    for frame in range(frames):
        left, right = _base_signal(frame, rng)
        samples.append(_to_code(left, rng, noise=0.004))
        samples.append(_to_code(right, rng, noise=0.004))
    return Audio(
        channels=CHANNELS,
        sample_rate=SAMPLE_RATE,
        codec="pcm_s16le",
        samples=samples,
        source_path="normal-transients.wav",
    )


def build_demo_take(normal: Audio) -> tuple:
    """Punch known artifacts into a copy of the normal take.

    Returns ``(audio, ground_truth)``. Ground truth records every injected
    range so the demo can check that the detector found it and that a
    deliberately *unconfirmed* injection survives a repair run.
    """
    audio = normal.clone()
    samples = audio.samples
    scale = audio.code_unit_scale()

    injected = []

    def code(value: float) -> int:
        return max(-32768, min(32767, int(round(value * scale))))

    def punch(kind: str, channel: int, start: int, end: int, values: list) -> None:
        for offset, value in enumerate(values):
            index = (start + offset) * audio.channels + channel
            samples[index] = code(value)
        injected.append(
            {
                "kind": kind,
                "channel": channel,
                "start": start,
                "end": end,
                "values": values,
            }
        )

    # Positions chosen to fall between drum hits so the drum pattern itself is
    # untouched; each is a short range, as a buffer glitch would be.
    frame_positions = [
        ("positive_click", 0, 0.62, [CLICK_AMPLITUDE]),
        ("negative_click", 1, 1.13, [-CLICK_AMPLITUDE]),
        ("two_sample_spike", 0, 1.58, [CLICK_AMPLITUDE, -CLICK_AMPLITUDE]),
        ("silent_dropout", 1, 1.86, [0.0, 0.0, 0.0]),
        ("stuck_run", 0, 2.09, [samples[int(2.09 * SAMPLE_RATE) * 2 + 0] for _ in range(5)]),
    ]
    for kind, channel, seconds, values in frame_positions:
        start = int(seconds * SAMPLE_RATE)
        punch(kind, channel, start, start + len(values), values)

    ground_truth = {
        "sample_rate": SAMPLE_RATE,
        "channels": CHANNELS,
        "frames": audio.frames,
        "injected": injected,
        # The stuck_run injection sits on channel 0; record the exact frames so
        # the demo can leave it unconfirmed and later prove it was not touched.
        "values": [{"frame": item["start"] + offset, "channel": item["channel"], "value": value}
                   for item in injected for offset, value in enumerate(item["values"])],
    }
    return audio, ground_truth


def _to_code(value: float, rng: random, noise: float) -> int:
    scale = 2 ** 15
    value = value + rng.uniform(-noise, noise)
    value = max(-1.0, min(1.0 - 1.0 / scale, value))
    return int(round(value * scale))


def make_demo(out_dir: str) -> dict:
    """Generate the demo WAV files and ground truth. Returns a descriptor."""
    os.makedirs(out_dir, exist_ok=True)
    normal = build_normal_take()
    normal_path = os.path.join(out_dir, "normal-transients.wav")
    write_wav(normal_path, normal)

    demo, ground_truth = build_demo_take(normal)
    demo_path = os.path.join(out_dir, "demo-take.wav")
    write_wav(demo_path, demo)

    truth_path = os.path.join(out_dir, "demo-ground-truth.json")
    with open(truth_path, "w", encoding="utf-8") as handle:
        json.dump(ground_truth, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")

    return {
        "normal_path": normal_path,
        "demo_path": demo_path,
        "ground_truth_path": truth_path,
        "ground_truth": ground_truth,
    }


if __name__ == "__main__":  # pragma: no cover - tiny convenience entry
    import sys

    target = sys.argv[1] if len(sys.argv) > 1 else "."
    make_demo(target)
