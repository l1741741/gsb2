"""Command line interface for inkproof.

    python3 -m inkproof run project.json --out out/
    python3 -m inkproof verify project.json --against out/
    python3 -m inkproof table-rename colors.json --from old --to new
    python3 -m inkproof table-order colors.json --order name,name,...
    python3 -m inkproof sample samples/
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile

from .colors import ColourError
from .manifest import TOOL_NAME, TOOL_VERSION, sha256_file
from .project import ConfigError, colour_table_to_json, load_colour_table, load_project
from .regions import ValidationError
from .runner import run_project


def _fail(message: str, code: int = 2) -> int:
    print(f"{TOOL_NAME}: error: {message}", file=sys.stderr)
    return code


def cmd_run(args: argparse.Namespace) -> int:
    try:
        project = load_project(args.project)
    except (ConfigError, ValidationError) as error:
        return _fail(str(error))
    try:
        manifest = run_project(project, args.out, write_manifest_file=not args.no_manifest)
    except ValidationError as error:
        return _fail(str(error))
    except OSError as error:
        return _fail(f"cannot write outputs: {error}")

    print(
        f"{TOOL_NAME}: wrote {len(manifest['outputs'])} files to {os.path.abspath(args.out)}"
    )
    print(f"  config fingerprint: {manifest['config_fingerprint']}")
    for image in manifest["config"]["images"]:
        print(f"  {image['name']}: {image['width']}x{image['height']}")
    print(f"  report: {os.path.join(args.out, 'report.md')}")
    if not args.no_manifest:
        print(f"  manifest: {os.path.join(args.out, 'manifest.json')}")
    return 0


def _compare_trees(against: dict, fresh: dict) -> list[str]:
    problems: list[str] = []
    if against.get("config_fingerprint") != fresh.get("config_fingerprint"):
        problems.append(
            "configuration differs from the previous run "
            f"(recorded {against.get('config_fingerprint')}, now {fresh.get('config_fingerprint')})"
        )
        old_sources = {
            entry.get("name"): entry.get("source_sha256")
            for entry in against.get("config", {}).get("images", [])
        }
        for entry in fresh.get("config", {}).get("images", []):
            name = entry.get("name")
            if old_sources.get(name) != entry.get("source_sha256"):
                problems.append(
                    f"image {name!r}: source artwork changed or was added since the previous run"
                )
    old_outputs = {entry["path"]: entry["sha256"] for entry in against.get("outputs", [])}
    new_outputs = {entry["path"]: entry["sha256"] for entry in fresh.get("outputs", [])}
    for path in sorted(set(old_outputs) - set(new_outputs)):
        problems.append(f"output {path} was in the previous run but is not produced now")
    for path in sorted(set(new_outputs) - set(old_outputs)):
        problems.append(f"output {path} is produced now but was not in the previous run")
    for path in sorted(set(old_outputs) & set(new_outputs)):
        if old_outputs[path] != new_outputs[path]:
            problems.append(f"output {path} differs byte-for-byte from the previous run")
    return problems


def cmd_verify(args: argparse.Namespace) -> int:
    manifest_path = os.path.join(args.against, "manifest.json")
    if not os.path.isfile(manifest_path):
        return _fail(f"no manifest.json in {args.against}; run the project first")
    try:
        with open(manifest_path, "r", encoding="utf-8") as handle:
            previous = json.load(handle)
    except OSError as error:
        return _fail(f"cannot read {manifest_path}: {error}")
    except json.JSONDecodeError as error:
        return _fail(f"{manifest_path} is not valid JSON: {error}")
    if not isinstance(previous, dict) or "config_fingerprint" not in previous:
        return _fail(f"{manifest_path} is not an inkproof manifest")

    try:
        project = load_project(args.project)
    except (ConfigError, ValidationError) as error:
        return _fail(str(error))

    temporary = tempfile.mkdtemp(prefix="inkproof-verify-")
    try:
        try:
            fresh = run_project(project, temporary)
        except (ValidationError, OSError) as error:
            return _fail(f"re-run failed: {error}")
        problems = _compare_trees(previous, fresh)
        if problems:
            print(
                f"{TOOL_NAME}: verification FAILED "
                f"({len(problems)} difference(s)):",
                file=sys.stderr,
            )
            for problem in problems:
                print(f"  - {problem}", file=sys.stderr)
            return 1
        print(
            f"{TOOL_NAME}: verification OK — {len(fresh['outputs'])} outputs "
            f"reproduced identically from the same configuration"
        )
        print(f"  config fingerprint: {fresh['config_fingerprint']}")
        return 0
    finally:
        shutil.rmtree(temporary, ignore_errors=True)


def cmd_table_rename(args: argparse.Namespace) -> int:
    path = args.table
    try:
        loaded = load_colour_table(path)
        payload = colour_table_to_json(loaded.table)
    except (ConfigError, ColourError) as error:
        return _fail(str(error))
    old_name = args.old
    new_name = args.new
    inks = payload["inks"]
    matches = [
        entry
        for entry in inks
        if new_name in entry.get("previous_names", []) or entry["name"] == old_name
    ]
    if old_name == new_name:
        return _fail("--from and --to are the same name")
    if not any(entry["name"] == old_name or old_name in entry.get("previous_names", []) for entry in inks):
        return _fail(f"no ink named {old_name!r} in {path}")
    if any(entry["name"] == new_name for entry in inks):
        return _fail(f"an ink named {new_name!r} already exists in {path}")
    for entry in inks:
        aliases = entry.setdefault("previous_names", [])
        if entry["name"] == old_name or old_name in aliases:
            entry["name"] = new_name
            aliases[:] = [alias for alias in aliases if alias != new_name]
            if old_name != new_name and old_name not in aliases:
                aliases.append(old_name)
            if not aliases:
                entry.pop("previous_names", None)
    order = payload.get("order")
    if isinstance(order, list) and old_name in order:
        order[:] = [new_name if value == old_name else value for value in order]
    _write_colour_table(path, payload)
    print(f"{TOOL_NAME}: renamed {old_name!r} -> {new_name!r} in {path}")
    if matches:
        print("  existing regions or crop proofs that used the old name still resolve via previous_names")
    return 0


def cmd_table_order(args: argparse.Namespace) -> int:
    path = args.table
    try:
        loaded = load_colour_table(path)
    except (ConfigError, ColourError) as error:
        return _fail(str(error))
    names = [name.strip() for name in args.order.split(",") if name.strip()]
    aliases = loaded.table.alias_map()
    resolved = []
    for name in names:
        ink = aliases.get(name)
        if ink is None:
            known = ", ".join(ink.name for ink in loaded.table.inks)
            return _fail(f"unknown ink {name!r} in --order; known inks: {known}")
        if ink.name in resolved:
            return _fail(f"ink {ink.name!r} is listed more than once")
        resolved.append(ink.name)
    missing = [ink.name for ink in loaded.table.inks if ink.name not in resolved]
    if missing:
        return _fail("--order must list every ink; missing: " + ", ".join(missing))
    payload = colour_table_to_json(loaded.table)
    payload["order"] = resolved
    _write_colour_table(path, payload)
    print(f"{TOOL_NAME}: display order in {path} is now {', '.join(resolved)}")
    return 0


def _write_colour_table(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def cmd_sample(args: argparse.Namespace) -> int:
    from .samples import generate_samples

    try:
        manifest = generate_samples(args.directory)
    except OSError as error:
        return _fail(f"cannot write samples: {error}")
    print(f"{TOOL_NAME}: wrote sample group to {os.path.abspath(args.directory)}")
    for name in manifest["images"]:
        print(f"  {name}")
    print(f"  project: {os.path.join(args.directory, 'project.json')}")
    print("  run:     python3 -m inkproof run " + os.path.join(args.directory, "project.json") + " --out <dir>")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=TOOL_NAME,
        description="Turn RGBA PNG artwork into spot-ink plates and crop proofs.",
    )
    parser.add_argument("--version", action="version", version=f"{TOOL_NAME} {TOOL_VERSION}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_parser = subparsers.add_parser("run", help="separate a project into plates and previews")
    run_parser.add_argument("project", help="project.json describing the image group")
    run_parser.add_argument("--out", required=True, help="output directory")
    run_parser.add_argument("--no-manifest", action="store_true", help="skip manifest.json")
    run_parser.set_defaults(handler=cmd_run)

    verify_parser = subparsers.add_parser(
        "verify", help="re-run a project and compare against an earlier output tree"
    )
    verify_parser.add_argument("project", help="project.json describing the image group")
    verify_parser.add_argument("--against", required=True, help="earlier output directory")
    verify_parser.set_defaults(handler=cmd_verify)

    rename_parser = subparsers.add_parser(
        "table-rename", help="rename an ink, keeping the old name as an alias"
    )
    rename_parser.add_argument("table", help="colors.json")
    rename_parser.add_argument("--from", dest="old", required=True, help="current ink name")
    rename_parser.add_argument("--to", dest="new", required=True, help="new ink name")
    rename_parser.set_defaults(handler=cmd_table_rename)

    order_parser = subparsers.add_parser(
        "table-order", help="set the display order of inks"
    )
    order_parser.add_argument("table", help="colors.json")
    order_parser.add_argument("--order", required=True, help="comma-separated ink names")
    order_parser.set_defaults(handler=cmd_table_order)

    sample_parser = subparsers.add_parser(
        "sample", help="write the re-runnable sample group (artwork, table, project)"
    )
    sample_parser.add_argument("directory", help="directory to create sample files in")
    sample_parser.set_defaults(handler=cmd_sample)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except BrokenPipeError:
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
