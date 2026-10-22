#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Record the package version and hashes of the web files actually being packaged."""

import hashlib
import json
import sys
from pathlib import Path


def main() -> None:
    """Write metadata for the final output paths selected by the packager."""
    root = Path(__file__).resolve().parents[1]
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    for target in sys.argv[1:]:
        directory = (root / target).resolve(strict=True)
        directory.relative_to(root)
        if not directory.is_dir():
            raise ValueError("Web output must be a directory")
        files = []
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise ValueError("Web output must not contain symlinks")
            if path.is_file() and path.name != "build-info.json":
                files.append(
                    {
                        "path": path.relative_to(directory).as_posix(),
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    }
                )
        if not files:
            raise ValueError("Web build output is empty")
        metadata = {
            "package": package["name"],
            "version": package["version"],
            "files": files,
        }
        (directory / "build-info.json").write_text(
            json.dumps(metadata, indent=2) + "\n", encoding="utf-8"
        )


if __name__ == "__main__":
    main()
