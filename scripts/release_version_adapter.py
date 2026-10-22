#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Validate a committed base or its frozen build overlay without allocating versions."""

from __future__ import annotations

import argparse
import json
import os
import re
# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
from pathlib import Path

if __package__:
    from . import version_plan
else:
    import version_plan


def resolve_plan_path(root: Path) -> Path:
    """Resolve the optional override while rejecting a missing explicit plan."""
    configured = os.environ.get("RELEASE_VERSION_PLAN")
    plan_path = Path(configured) if configured else root / ".release-plan.json"
    if not plan_path.is_absolute():
        plan_path = root / plan_path
    if configured and not plan_path.exists():
        raise ValueError("RELEASE_VERSION_PLAN does not exist")
    return plan_path


def checked_version(root: Path, base: str, channel: str) -> str:
    """Check every declared input and return the actual SemVer package version."""
    if not re.fullmatch(
        r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", base, re.ASCII
    ):
        raise ValueError("Release version must be a numeric base X.Y.Z")
    if channel not in {"nightly", "beta", "rc", "stable"}:
        raise ValueError("Unknown release channel")
    root = root.resolve(strict=True)
    policy = json.loads((root / ".release-policy.json").read_text(encoding="utf-8"))
    if (
        channel == "stable"
        and policy.get("versioning", {}).get("promotion", "promote-bytes")
        != "final-build"
    ):
        raise ValueError("Stable must promote verified RC bytes")
    plan_path = resolve_plan_path(root)
    if not plan_path.exists():
        if channel == "stable":
            raise ValueError(
                "A frozen release plan is required for a stable final build"
            )
        version_plan.check_base_versions(root, policy, base=base)
        return base
    if plan_path.is_symlink() or not plan_path.is_file():
        raise ValueError("Release plan must be a regular file")
    # Developer/CI toolchain selected by the invoking operator via PATH.
    source_sha = subprocess.check_output(  # nosec B603, B607
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    plan = version_plan.validate_plan(
        json.loads(plan_path.read_text(encoding="utf-8")),
        policy=policy,
        source_sha=source_sha,
    )
    if plan["base_version"] != base or plan["channel"] != channel:
        raise ValueError("Release inputs differ from the frozen plan")
    version_plan.sync_versions(root, policy, plan, check=True)
    return str(version_plan.projections(plan)["package"])


def main() -> None:
    """Validate the requested channel without allocating release identity."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base")
    parser.add_argument("channel")
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    args = parser.parse_args()
    print(checked_version(args.root, args.base, args.channel))


if __name__ == "__main__":
    main()
