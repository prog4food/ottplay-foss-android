#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Derive OCI labels from the checked package inputs and exact source revision."""

from __future__ import annotations

import argparse
import json
# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
from pathlib import Path

if __package__:
    from . import version_plan
    from .release_version_adapter import checked_version, resolve_plan_path
else:
    import version_plan
    from release_version_adapter import checked_version, resolve_plan_path


def labels(root: Path) -> dict[str, str]:
    """Validate the current overlay before labelling any container image."""
    policy = json.loads((root / ".release-policy.json").read_text(encoding="utf-8"))
    plan_path = resolve_plan_path(root)
    if plan_path.exists():
        identity = json.loads(plan_path.read_text(encoding="utf-8"))
        package = checked_version(root, identity["base_version"], identity["channel"])
    else:
        package = version_plan.read_base_version(root, policy)
        version_plan.check_base_versions(root, policy, base=package)
    # Developer/CI toolchain selected by the invoking operator via PATH.
    revision = subprocess.check_output(  # nosec B603, B607
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    return {
        "org.opencontainers.image.version": package,
        "org.opencontainers.image.revision": revision,
    }


def main() -> None:
    """Print buildx JSON labels, shell-safe values, or named GitHub step outputs."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--shell", action="store_true")
    mode.add_argument("--github-output", type=Path)
    args = parser.parse_args()
    values = labels(args.root.resolve(strict=True))
    package = values["org.opencontainers.image.version"]
    revision = values["org.opencontainers.image.revision"]
    if args.github_output:
        with args.github_output.open("a", encoding="utf-8") as output:
            output.write(f"version={package}\nrevision={revision}\n")
    elif args.shell:
        print(f"{package} {revision}")
    else:
        print(json.dumps(values, sort_keys=True))


if __name__ == "__main__":
    main()
