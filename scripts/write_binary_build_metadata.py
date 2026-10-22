#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Record the exact version input and digest of a completed native binary."""

import hashlib
import json
import sys
from pathlib import Path

import tomllib
if __package__:
    from .version_receipt import confined_cli_path
else:
    from version_receipt import confined_cli_path


def main() -> None:
    """Write metadata for the final output paths selected by the packager."""
    root = Path(__file__).resolve().parents[1]
    binary = confined_cli_path(root, Path(sys.argv[1]), "file")
    output = confined_cli_path(root, Path(sys.argv[2]), "new")
    if (root / "VERSION").is_file():
        version = (root / "VERSION").read_text(encoding="utf-8").strip()
    else:
        version = tomllib.loads((root / "Cargo.toml").read_text(encoding="utf-8"))[
            "package"
        ]["version"]
    metadata = {
        "version": version,
        "binary": binary.name,
        "binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
    }
    with output.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    main()
