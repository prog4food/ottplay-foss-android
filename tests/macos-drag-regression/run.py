#!/usr/bin/env python3
"""Run only the vendored, fixed callbacks. Never intentionally crash a baseline."""

import argparse
import itertools
import json
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--offline", action="store_true", help="Use only cached Cargo dependencies")
parser.add_argument("--output", type=Path, help="Write detailed synthetic results as JSON")
args = parser.parse_args()
if sys.platform != "darwin":
    parser.error("This regression requires a macOS graphical login session and Apple SDK")
root = Path(__file__).resolve().parent
repo = root.parent.parent
# Refuse to exercise stale or unpatched sources before launching a native process.
for checker in ["check-macos-drag-backport.cjs", "check-glib-backport.cjs"]:
    subprocess.run(["node", str(repo / "scripts" / checker)], check=True, timeout=30)
cargo_options = ["--locked", "--manifest-path", str(root / "Cargo.toml")]
if args.offline:
    cargo_options.append("--offline")
rustc_info = subprocess.run(["rustc", "-vV"], check=True, capture_output=True, text=True, timeout=30).stdout
host = next(line.removeprefix("host: ") for line in rustc_info.splitlines() if line.startswith("host: "))
metadata_result = subprocess.run(
    ["cargo", "metadata", *cargo_options, "--format-version", "1", "--filter-platform", host],
    check=False,
    capture_output=True,
    text=True,
    timeout=120,
)
if metadata_result.returncode:
    raise SystemExit(metadata_result.stderr)
metadata = json.loads(metadata_result.stdout)
for name, version in [("wry", "0.55.1"), ("tao", "0.35.3")]:
    packages = [package for package in metadata["packages"] if package["name"] == name]
    expected_manifest = repo / "vendor" / f"{name}-{version}" / "Cargo.toml"
    if (
        len(packages) != 1
        or packages[0]["version"] != version
        or packages[0]["source"] is not None
        or Path(packages[0]["manifest_path"]).resolve() != expected_manifest.resolve()
    ):
        raise SystemExit(f"Refusing to test an unexpected {name} dependency")
subprocess.run(["cargo", "build", *cargo_options], check=True, timeout=600)
target = Path(metadata["target_directory"])
binary = target / "debug" / "ottplay-macos-drag-regression"
fixtures = [
    "valid",
    "empty",
    "missing",
    "invalid-file-url",
    "synthetic-root",
    "synthetic-entry",
    "synthetic-mixed",
    "synthetic-unencodable",
]
results = []
for surface, action, fixture in itertools.product(["wry", "tao"], ["enter", "drop"], fixtures):
    result = subprocess.run(
        [str(binary), surface, action, fixture],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=15,
    )
    expected = (
        ["/tmp/synthetic-fixture.txt"]
        if fixture == "valid"
        else ["/tmp/синтетика-a.txt", "/tmp/日本語-b.txt"]
        if fixture == "synthetic-mixed"
        else []
    )
    lines = result.stdout.splitlines()
    actual = [line[5:] for line in lines if line.startswith("PATH ")]
    events = [line[6:] for line in lines if line.startswith("EVENT ")]
    expected_events = [action] if surface == "wry" else [action] * len(expected)
    operation = "0" if surface == "tao" and fixture in ["missing", "invalid-file-url", "synthetic-root"] else "1"
    passed = (
        result.returncode == 0
        and actual == expected
        and events == expected_events
        and lines.count(f"CALLBACK {operation}") == 1
    )
    results.append(
        {
            "surface": surface,
            "action": action,
            "fixture": fixture,
            "passed": passed,
            "returncode": result.returncode,
            "paths": actual,
            "events": events,
            "stdout": result.stdout,
            "stderr": result.stderr,
        }
    )
    if not passed:
        print(json.dumps(results[-1], indent=2), file=sys.stderr)
        break
if args.output:
    args.output.write_text(json.dumps(results, indent=2) + "\n")
passed_count = sum(result["passed"] for result in results)
case_count = 4 * len(fixtures)
print(f"Native drag regression: {passed_count}/{case_count} cases passed")
sys.exit(0 if passed_count == case_count else 1)
