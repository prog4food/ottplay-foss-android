#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Replay an Atheris harness after proving declared production instrumentation.

This helper runs with the consumer's hash-locked interpreter. It never imports
production modules itself: the harness retains control of its offline adapters.
"""
from __future__ import annotations

import argparse
from importlib.metadata import version
import json
from pathlib import Path
import runpy
import sys


def verify_function(module, name, root, atheris):
    """Prove a loaded function belongs to this checkout and already has hooks."""
    function = module
    for part in name.split("."):
        function = getattr(function, part)
    function = getattr(function, "__func__", function)
    original = getattr(function, "__code__", None)
    if original is None or not Path(original.co_filename).resolve().is_relative_to(root):
        raise ValueError("Declared instrumentation must refer to project-local Python code")
    source = Path(original.co_filename).resolve().relative_to(root)
    if any(part in {".fuzz-venv", ".venv", "venv", "site-packages", ".fuzz-toolkit"} for part in source.parts):
        raise ValueError("Dependency instrumentation cannot substitute for project-local code")
    atheris.instrument_func(function)
    if function.__code__ is not original:
        raise ValueError(f"Missing production instrumentation: {name}")
    return str(source)


def verify_instrumentation(declarations, root, atheris):
    """Require already-instrumented Python functions from the source checkout."""
    if not declarations:
        raise ValueError("Python preflight requires production instrumentation declarations")
    verified = []
    for declaration in declarations:
        module = sys.modules.get(declaration["module"])
        if module is None:
            raise ValueError("Declared production module was not loaded by the harness")
        for name in declaration["functions"]:
            source = verify_function(module, name, root, atheris)
            verified.append({"module": declaration["module"], "function": name, "source": source})
    return verified


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    root = args.root.resolve()
    manifest = json.loads((root / ".github/fuzz.json").read_text())
    target = next(target for target in manifest["targets"] if target["name"] == args.target)
    command = args.arguments[1:] if args.arguments[:1] == ["--"] else args.arguments
    if not command or not command[0].endswith(".py"):
        raise ValueError("Python preflight requires an explicit harness .py path")
    harness = Path(command[0]).resolve()
    if not harness.is_relative_to(root):
        raise ValueError("Fuzz harness must be inside the source checkout")
    import atheris  # Installed by the consumer's hash-locked requirements.

    setup = atheris.Setup
    def checked_setup(*setup_args, **setup_kwargs):
        verified = verify_instrumentation(target.get("instrumentation"), root, atheris)
        # Write evidence before the native engine terminates the interpreter.
        args.output.write_text(json.dumps({"target": args.target, "engine": "atheris",
            "version": version("atheris"), "instrumentation": verified}, indent=2) + "\n")
        return setup(*setup_args, **setup_kwargs)

    atheris.Setup = checked_setup
    sys.argv = command
    sys.path.insert(0, str(harness.parent))
    runpy.run_path(str(harness), run_name="__main__")


if __name__ == "__main__":
    main()
