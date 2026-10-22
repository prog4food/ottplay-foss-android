#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Stage only declared final upload files and bind them to frozen version inputs."""

from __future__ import annotations

import argparse
import contextlib
import fnmatch
import glob
import hashlib
import json
import re
import shutil

# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
import sys
from pathlib import Path
from typing import cast

if __package__:
    from . import version_plan
    from .release_version_adapter import resolve_plan_path
else:
    import version_plan
    from release_version_adapter import resolve_plan_path


DETACHED_PROVENANCE_REQUIRED = False

def checked_payload_path(root: Path, matched: str) -> Path:
    """Reject payload paths that escape the checkout or contain symlinks."""
    path = Path(matched)
    path.resolve(strict=True).relative_to(root)
    if any(
        parent.is_symlink()
        for parent in path.parents
        if parent != root and root in parent.parents
    ):
        raise ValueError("Release payload path contains a symlink")
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"Release payload must be a regular file: {matched}")
    return path


def collect_payloads(root: Path, patterns: list[str]) -> dict[str, Path]:
    """Expand explicit patterns and keep one source for each flat asset name."""
    files: dict[str, Path] = {}
    for pattern in patterns:
        if Path(pattern).is_absolute() or ".." in Path(pattern).parts:
            raise ValueError("Release asset patterns must stay inside the checkout")
        matches = sorted(glob.glob(str(root / pattern), recursive=True))
        if not matches:
            raise ValueError(f"Release asset pattern matched no files: {pattern}")
        for matched in matches:
            path = checked_payload_path(root, matched)
            key = path.name.casefold()
            if key in files and files[key] != path:
                raise ValueError(f"Duplicate release payload basename: {path.name}")
            files[key] = path
    return files


def verify_staged_inputs(
    root: Path, policy: dict[str, object], inputs: dict[str, object]
) -> None:
    """Check complete version-source coverage and unchanged prepared bytes."""
    declared_paths = {
        item["path"]
        for item in cast(
            list[dict[str, object]],
            cast(dict[str, object], policy["versioning"])["files"],
        )
    }
    input_paths = [
        item["path"] for item in cast(list[dict[str, object]], inputs["files"])
    ]
    if len(set(input_paths)) != len(input_paths) or set(input_paths) != declared_paths:
        raise ValueError(
            "Build inputs must cover every declared version source exactly once"
        )
    for entry in cast(list[dict[str, object]], inputs["files"]):
        current = root / cast(str, entry["path"])
        if hashlib.sha256(current.read_bytes()).hexdigest() != entry["after_sha256"]:
            raise ValueError(
                f"Version input changed after plan preparation: {entry['path']}"
            )


def inspect_staged_artifacts(
    output: Path,
    files: dict[str, Path],
    policy: dict[str, object],
    identity: dict[str, object],
) -> list[dict[str, object]]:
    """Inspect the declared metadata only after payloads and inputs are checked."""
    metadata = []
    for declaration in cast(
        list[dict[str, object]],
        cast(dict[str, object], policy["versioning"]).get("artifacts", []),
    ):
        for path in files.values():
            if fnmatch.fnmatchcase(path.name, cast(str, declaration["path"])):
                inspected = version_plan.verify_artifact(
                    output / path.name, declaration, identity
                )
                inspected["path"] = path.name
                metadata.append(inspected)
    return metadata


def write_staged_files(
    root: Path,
    output: Path,
    files: dict[str, Path],
    policy: dict[str, object],
    identity: dict[str, object],
    plan: Path,
) -> None:
    """Copy checked inputs and write the receipt into our new target directory."""
    for path in files.values():
        shutil.copy2(path, output / path.name)
    if DETACHED_PROVENANCE_REQUIRED or policy.get("detached_provenance"):
        if __package__:
            from .release_provenance import verify_staged  # pylint: disable=import-outside-toplevel
        else:
            from release_provenance import verify_staged  # pylint: disable=import-outside-toplevel

        verify_staged(output, policy, identity)
    metadata = inspect_staged_artifacts(output, files, policy, identity)
    receipt = output / f"release-inputs-{output.name}.json"
    # Repository-controlled argv; no shell interpolation or external command text.
    subprocess.run(  # nosec B603
        [
            sys.executable,
            str(root / "scripts/version_receipt.py"),
            "create",
            "--plan",
            str(plan),
            "--inputs",
            str(root / ".release-inputs.json"),
            "--assets",
            str(output),
            "--output",
            str(receipt),
        ],
        check=True,
    )
    evidence = json.loads(receipt.read_text(encoding="utf-8"))
    evidence["artifact_metadata"] = metadata
    receipt.write_text(
        json.dumps(evidence, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )


def stage(root: Path, target: str, patterns: list[str]) -> Path:
    """Use an empty target directory and refuse ambiguous or non-file payloads."""
    # Keep validation and receipt creation in one ordered, fail-closed operation.
    # pylint: disable=too-many-locals,too-many-branches,too-many-statements
    root = root.resolve(strict=True)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", target):
        raise ValueError("Unsafe release target name")
    output = root / "release-assets" / target
    if (root / "release-assets").is_symlink():
        raise ValueError("Release staging parent must not be a symlink")
    if output.exists():
        raise ValueError("Release staging directory must not already exist")
    files = collect_payloads(root, patterns)
    plan = resolve_plan_path(root)
    if not plan.exists():
        raise ValueError(
            "A frozen release plan is required to stage publishable assets"
        )
    if plan.is_symlink() or not plan.is_file():
        raise ValueError("Release plan must be a regular file")
    policy = json.loads((root / ".release-policy.json").read_text(encoding="utf-8"))
    # Developer/CI toolchain selected by the invoking operator via PATH.
    source_sha = subprocess.check_output(  # nosec B603, B607
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    identity = version_plan.validate_plan(
        json.loads(plan.read_text(encoding="utf-8")),
        policy=policy,
        source_sha=source_sha,
    )
    version_plan.sync_versions(root, policy, identity, check=True)
    inputs = json.loads((root / ".release-inputs.json").read_text(encoding="utf-8"))
    verify_staged_inputs(root, policy, inputs)
    parent_existed = output.parent.exists()
    output.mkdir(parents=True)
    try:
        write_staged_files(root, output, files, policy, identity, plan)
    except BaseException:
        shutil.rmtree(output)
        if not parent_existed:
            # Remove only an empty parent we created; preserve sibling job output.
            with contextlib.suppress(OSError):
                output.parent.rmdir()
        raise
    return output


def main() -> None:
    """Stage the explicit payload patterns for one platform target."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True)
    parser.add_argument("--pattern", action="append", required=True)
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    args = parser.parse_args()
    print(stage(args.root, args.target, args.pattern))


if __name__ == "__main__":
    main()
