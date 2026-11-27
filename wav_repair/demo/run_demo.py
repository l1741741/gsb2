"""End-to-end demonstration runner for wavrepair.

Run from the tool directory::

    python3 demo/run_demo.py --out /tmp/wavrepair-demo

The runner is deliberately broken into small, printable phases so it works as
both a demonstration and a self-check:

1. generate a clean take (continuous pitch glide + drum hits) and a copy with
   five injected buffer artifacts, plus ground truth;
2. scan the clean take and the damaged take, showing that the clean take yields
   no suspects and that the drum attacks are not proposed;
3. write a confirmation file that deliberately leaves one injection
   unconfirmed;
4. repair, then check with an independent byte-level comparison that every
   sample outside the confirmed ranges is unchanged;
5. show that a re-run of the same confirmation on the same input produces
   byte-identical output;
6. show that a confirmation file for a different input is refused.

Any failed check exits non-zero, so the demo doubles as a regression test.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from wavrepair.demo import make_demo  # noqa: E402
from wavrepair.detect import DetectionSettings, scan_audio  # noqa: E402
from wavrepair.wavio import read_wav  # noqa: E402


def sha256(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def cli(*arguments: str) -> int:
    """Run the CLI in-process-equivalent subprocess so exit codes are real."""
    command = [sys.executable, os.path.join(ROOT, "wavrepair.py"), *arguments]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.stderr.strip():
        print("  " + result.stderr.strip())
    return result.returncode


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Run the wavrepair end-to-end demo.")
    parser.add_argument("--out", default=os.path.join(ROOT, "demo", "out"),
                        help="output directory (default: demo/out)")
    args = parser.parse_args(argv)
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    failures = []

    def check(name: str, condition: bool) -> None:
        mark = "PASS" if condition else "FAIL"
        print(f"[{mark}] {name}")
        if not condition:
            failures.append(name)

    print("=" * 78)
    print("1. Generating demo takes")
    print("=" * 78)
    info = make_demo(out)
    normal = info["normal_path"]
    damaged = info["demo_path"]
    truth = info["ground_truth"]
    print(f"  clean take : {normal}")
    print(f"  damaged    : {damaged}")
    print(f"  ground truth: {os.path.join(out, 'demo-ground-truth.json')}")
    for item in truth["injected"]:
        print(f"  · {item['kind']:<18} channel {item['channel']}  "
              f"frames {item['start']}..{item['end']}")

    print()
    print("=" * 78)
    print("2. Scanning both takes (default criteria)")
    print("=" * 78)
    settings = DetectionSettings()

    clean_report = scan_audio(read_wav(normal), settings).as_dict()
    clean_path = os.path.join(out, "report-clean.json")
    _write_json(clean_path, clean_report)
    print(f"  clean take : {clean_report['summary']}")
    check("clean take has no suspect candidates", clean_report["summary"]["suspects"] == 0)

    # A deliberately over-sensitive pass is used to show how legitimate drum
    # transients are handled: the detector is allowed to notice noise peaks at
    # the drum attacks, and the envelope guard labels them rejected transients
    # instead of repair candidates.
    sensitive_settings = DetectionSettings(floor=0.06, envelope_rise=2.0)
    sensitive = scan_audio(read_wav(normal), sensitive_settings).as_dict()
    sensitive_path = os.path.join(out, "report-clean-sensitive.json")
    _write_json(sensitive_path, sensitive)
    print(f"  clean take (sensitive floor=0.06, envelope_rise=2.0): "
          f"{sensitive['summary']}")
    rejected = sensitive["candidates"]
    drum_rejected = [c for c in rejected if c["classification"] != "suspect"]
    check("sensitive scan sends drum attacks to rejected_transients",
          len(drum_rejected) >= 2 and all("envelope" in c["reason"] for c in drum_rejected))
    for candidate in drum_rejected:
        print(f"    rejected transient: ch {candidate['channel']} "
              f"{candidate['start']}..{candidate['end']} "
              f"(rising_fraction {candidate['rising_fraction']:.0%})")

    # No edits at all on a clean take must be a byte-for-byte no-op.
    zero_confirm = {
        "format": "wavrepair-confirm", "version": 1,
        "input": {"sha256": sha256(normal), "frames": clean_report["source"]["frames"],
                  "sample_rate": clean_report["source"]["sample_rate"],
                  "channels": clean_report["source"]["channels"]},
        "overlap_policy": "merge", "edits": [], "ignored_candidates": [],
    }
    zero_path = os.path.join(out, "confirmation-empty.json")
    _write_json(zero_path, zero_confirm)
    zero_out = os.path.join(out, "clean-noop.wav")
    code = cli("repair", normal, "--confirm", zero_path, "--output", zero_out,
               "--manifest", os.path.join(out, "manifest-empty.json"))
    check("empty confirmation succeeded", code == 0)
    check("empty confirmation leaves a clean take byte-identical",
          sha256(zero_out) == sha256(normal))

    damaged_report = scan_audio(read_wav(damaged), settings).as_dict()
    damaged_path = os.path.join(out, "report-damaged.json")
    _write_json(damaged_path, damaged_report)
    print(f"  damaged    : {damaged_report['summary']}")
    suspects = damaged_report["candidates"]
    print("  proposed suspect ranges:")
    found_kinds = set()
    for candidate in suspects:
        found_kinds.add(candidate["kind"])
        if candidate["kind"] in {"dropout", "stuck"}:
            found_kinds.add(candidate["kind"])
        print(f"    #{candidate['id']} {candidate['kind']:<8} ch {candidate['channel']} "
              f"{candidate['start']}..{candidate['end']} "
              f"({candidate['start_seconds']:.4f}s)")
    expected_kinds = {"impulse", "dropout", "stuck"}
    check("all three artifact classes were proposed",
          expected_kinds <= found_kinds)

    # Every injected range must be covered by some suspect range on its channel.
    covered = 0
    for item in truth["injected"]:
        if any(c["channel"] == item["channel"]
               and c["start"] <= item["start"] and c["end"] >= item["end"]
               for c in suspects):
            covered += 1
    check(f"all {len(truth['injected'])} injected artifacts are covered by a suspect range",
          covered == len(truth["injected"]))

    print()
    print("=" * 78)
    print("3. Writing a confirmation file that leaves one injection unconfirmed")
    print("=" * 78)
    # Confirm everything except the stuck run on channel 0.
    confirmed = []
    left_out = None
    for item in truth["injected"]:
        if item["kind"] == "stuck_run":
            left_out = item
            continue
        confirmed.append({
            "channel": item["channel"],
            "start": item["start"],
            "end": item["end"],
            "method": "interpolate",
        })
    # The dropout is a short silent gap; the operator prefers muting it.
    for edit in confirmed:
        for item in truth["injected"]:
            if item["kind"] == "silent_dropout" and edit["channel"] == item["channel"] \
                    and edit["start"] == item["start"]:
                edit["method"] = "silence"

    confirm = {
        "format": "wavrepair-confirm",
        "version": 1,
        "input": {
            "path": damaged,
            "sha256": sha256(damaged),
            "frames": truth["frames"],
            "sample_rate": truth["sample_rate"],
            "channels": truth["channels"],
        },
        "overlap_policy": "merge",
        "edits": confirmed,
        "ignored_candidates": [],
    }
    confirm_path = os.path.join(out, "confirmation.json")
    _write_json(confirm_path, confirm)
    print(f"  confirmation: {confirm_path}")
    print(f"  confirmed {len(confirmed)} range(s); left unconfirmed: "
          f"{left_out['kind']} at frames {left_out['start']}..{left_out['end']} "
          f"channel {left_out['channel']}")

    print()
    print("=" * 78)
    print("4. Repairing and checking that unconfirmed audio is untouched")
    print("=" * 78)
    repaired_path = os.path.join(out, "repaired.wav")
    manifest_path = os.path.join(out, "manifest.json")
    excerpts_dir = os.path.join(out, "excerpts")
    code = cli("repair", damaged, "--confirm", confirm_path,
               "--output", repaired_path, "--manifest", manifest_path,
               "--excerpts-out", excerpts_dir)
    check("repair command succeeded", code == 0)

    manifest = json.load(open(manifest_path, encoding="utf-8"))
    verification = manifest["verification"]
    check("frame count preserved",
          manifest["output"]["frames"] == manifest["input"]["frames"])
    check("sample rate preserved",
          manifest["output"]["sample_rate"] == manifest["input"]["sample_rate"])
    check("channel layout preserved",
          manifest["output"]["channels"] == manifest["input"]["channels"])
    check("no unconfirmed sample changed",
          verification["unconfirmed_samples_changed"] == 0)

    # Independently re-derive the byte-level comparison.
    original_audio = read_wav(damaged)
    repaired_audio = read_wav(repaired_path)
    untouched = _independent_diff(original_audio, repaired_audio, manifest["repairs"]["ranges"])
    check("independent byte-level check agrees that only confirmed samples changed",
          untouched["changed_outside"] == 0 and untouched["changed_inside"] > 0)
    print(f"  changed samples: {untouched['changed_inside']} inside confirmed ranges, "
          f"{untouched['changed_outside']} outside")
    print(f"  unconfirmed stuck run: {_describe_range(original_audio, repaired_audio, left_out)}")

    print()
    print("=" * 78)
    print("5. Re-running the same confirmation on the same input")
    print("=" * 78)
    first_wav_sha = sha256(repaired_path)
    first_manifest = json.load(open(manifest_path, encoding="utf-8"))
    # Re-run with the *same* output path and excerpt directory. The manifest
    # records those paths, so identical output paths are required for a fair
    # byte-for-byte comparison of the manifest itself.
    rerun_manifest = os.path.join(out, "manifest-rerun.json")
    code = cli("repair", damaged, "--confirm", confirm_path,
               "--output", repaired_path, "--manifest", rerun_manifest,
               "--excerpts-out", excerpts_dir)
    check("re-run repair command succeeded", code == 0)
    check("re-run produced a byte-identical WAV", sha256(repaired_path) == first_wav_sha)
    check("re-run manifest is identical",
          json.load(open(rerun_manifest, encoding="utf-8")) == first_manifest)

    print()
    print("=" * 78)
    print("6. Refusing a confirmation file made for a different input")
    print("=" * 78)
    foreign = dict(confirm)
    foreign["input"] = dict(confirm["input"])
    foreign["input"]["sha256"] = "0" * 64
    foreign_path = os.path.join(out, "confirmation-foreign.json")
    _write_json(foreign_path, foreign)
    code = cli("repair", damaged, "--confirm", foreign_path,
               "--output", os.path.join(out, "should-not-exist.wav"))
    check("foreign confirmation is refused (nonzero exit)", code != 0)
    check("foreign confirmation produced no output file",
          not os.path.exists(os.path.join(out, "should-not-exist.wav")))

    print()
    print("=" * 78)
    print("Demo artifacts")
    print("=" * 78)
    for entry in sorted(os.listdir(excerpts_dir))[:8]:
        print(f"  excerpts/{entry}")
    print(f"  manifest : {manifest_path}")
    print(f"  reports  : {clean_path}")
    print(f"             {damaged_path}")

    print()
    if failures:
        print(f"DEMO FAILED: {len(failures)} check(s) failed")
        return 1
    print("DEMO PASSED: all checks succeeded")
    return 0


def _write_json(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def _independent_diff(original, repaired, ranges) -> dict:
    allowed = set()
    for entry in ranges:
        for frame in range(entry["start"], entry["end"]):
            allowed.add((frame, entry["channel"]))
    changed_inside = 0
    changed_outside = 0
    for frame in range(original.frames):
        for channel in range(original.channels):
            index = frame * original.channels + channel
            if original.samples[index] != repaired.samples[index]:
                if (frame, channel) in allowed:
                    changed_inside += 1
                else:
                    changed_outside += 1
    return {"changed_inside": changed_inside, "changed_outside": changed_outside}


def _describe_range(original, repaired, item) -> str:
    frames = []
    for offset in range(item["end"] - item["start"]):
        frame = item["start"] + offset
        index = frame * original.channels + item["channel"]
        frames.append(original.samples[index] == repaired.samples[index])
    same = all(frames)
    return (f"frames {item['start']}..{item['end']} channel {item['channel']} "
            f"{'still bit-identical' if same else 'CHANGED (unexpected)'}")


if __name__ == "__main__":
    sys.exit(main())
