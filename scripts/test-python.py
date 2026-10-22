#!/usr/bin/env python3
"""One Python suite entry point; portable runtime coverage and explicit native profiles."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", choices=("portable", "android", "ios"), default="portable")
    args = parser.parse_args()
    suites = json.loads((ROOT / "tests/python-suites.json").read_text())
    listed = {case[0] for cases in suites.values() for case in cases}
    discovered = {str(path.relative_to(ROOT)) for path in (ROOT / "tests").glob("test*.py")}
    if listed != discovered:
        raise SystemExit(f"Python suite inventory mismatch: {sorted(listed ^ discovered)}")
    report = ROOT / "reports/python"
    report.mkdir(parents=True, exist_ok=True)
    coverage = [sys.executable, "-m", "coverage"]
    covered = args.profile == "portable"
    if covered:
        subprocess.run([*coverage, "erase"], cwd=ROOT, check=True)
    results = []
    for case in suites[args.profile]:
        command = [*coverage, "run", "--parallel-mode", *case] if covered else [sys.executable, *case]
        started = time.monotonic()
        logfile = report / (Path(case[0]).stem + ".log")
        with logfile.open("w") as log:
            try:
                result = subprocess.run(command, cwd=ROOT, env=os.environ | {"PYTHONDONTWRITEBYTECODE": "1"},
                                        stdout=log, stderr=subprocess.STDOUT, timeout=600, check=False)
                code = result.returncode
            except subprocess.TimeoutExpired:
                code = 124
        results.append({"case": case, "exit_code": code, "seconds": round(time.monotonic() - started, 2)})
        print(f"{'PASS' if code == 0 else 'FAIL'} {' '.join(case)}", flush=True)
        if code:
            print(logfile.read_text()[-6000:])
    failures = any(result["exit_code"] for result in results)
    if covered:
        subprocess.run([*coverage, "combine"], cwd=ROOT, check=True)
        subprocess.run([*coverage, "json", "-o", "reports/python/coverage.json"], cwd=ROOT, check=False)
        measured = json.loads((report / "coverage.json").read_text())["files"]
        required = {"local_proxy.py", "archive/proxy_security.py", "scripts/smoke-xmltv-cache-refresh.py", "scripts/prepare-container-workspace.py"}
        if not required.issubset(measured):
            failures = True
            print("Missing runtime coverage:", sorted(required - set(measured)))
        gate = subprocess.run([*coverage, "report"], cwd=ROOT, check=False)
        subprocess.run([*coverage, "xml"], cwd=ROOT, check=False)
        failures |= gate.returncode != 0
    (report / f"{args.profile}-results.json").write_text(json.dumps(results, indent=2) + "\n")
    return int(failures)


if __name__ == "__main__":
    raise SystemExit(main())
