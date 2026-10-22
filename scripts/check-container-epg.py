#!/usr/bin/env python3
"""Verify and exercise the exact native OCI before it becomes a release input."""
import argparse
import importlib.util
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("container_benchmark", Path(__file__).with_name("benchmark-container-build.py"))
    benchmark = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(benchmark)
    result = {"passed": False, "platform": args.platform, "phase": "native-architecture"}
    try:
        benchmark.require_native(args.platform)
        result["phase"] = "inspect-archive"
        inspected = benchmark.inspect_archive(args.archive, args.platform, args.version, args.revision)
        result["phase"] = "exercise-image"
        result.update(benchmark.smoke_archive(args.archive, args.platform, inspected))
        result.update(passed=True, phase="complete")
    except Exception as error:
        result["error"] = {"type": type(error).__name__, "message": benchmark.safe_diagnostic(str(error))}
        raise
    finally:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(result, indent=2) + "\n")



if __name__ == "__main__":
    main()
