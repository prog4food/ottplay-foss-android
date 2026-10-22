#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Bind the frozen version inputs to the exact payloads of one platform build."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import shutil
import stat

# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
import sys
from pathlib import Path
from typing import cast

if __package__:
    from . import version_plan
    from .release_control import stream_identity
else:
    import version_plan
    from release_control import stream_identity

DETACHED_PROVENANCE_REQUIRED = False
MAX_RECEIPT_BYTES = 2_000_000


def sha256(data: bytes) -> str:
    """Hash an immutable build input or payload."""
    return hashlib.sha256(data).hexdigest()


def canonical(value: object) -> bytes:
    """Encode receipt evidence deterministically."""
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def capture_toolchain() -> dict[str, str]:
    """Record the actual installed compiler/runtime versions used by the build."""
    result = {"platform": sys.platform, "python": sys.version.split()[0]}
    for name in ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH"):
        if os.environ.get(name):
            result[name] = os.environ[name]
    for name, argument in (
        ("node", "--version"),
        ("rustc", "--version"),
        ("cargo", "--version"),
        ("go", "version"),
        ("xcodebuild", "-version"),
    ):
        executable = shutil.which(name)
        if executable:
            # Repository-controlled argv; no shell interpolation or external command text.
            checked = subprocess.run(  # nosec B603
                [executable, argument],
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
            )
            value = checked.stdout.strip()
            if not value or len(value) > 4096:
                raise ValueError(f"Invalid toolchain version output: {name}")
            result[name] = value
    return result


def receipt_packages(assets: Path) -> list[dict[str, object]]:
    """Inventory a nonempty flat package directory without existing receipts."""
    packages: list[dict[str, object]] = []
    seen = set()
    for path in sorted(assets.iterdir()):
        if path.name.startswith("release-inputs-") and path.suffix == ".json":
            raise ValueError("Package directory already contains a version receipt")
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Package must be a flat regular file: {path.name}")
        if path.name.casefold() in seen or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9._+-]{0,199}", path.name
        ):
            raise ValueError("Unsafe or duplicate package name")
        seen.add(path.name.casefold())
        with path.open("rb") as stream:
            identity = stream_identity(stream)
        packages.append({"name": path.name, **identity})
    if not packages:
        raise ValueError("Cannot attest an empty package directory")
    return packages


def create_receipt(
    plan_path: Path, inputs_path: Path, assets: Path, output: Path
) -> dict[str, object]:
    """Attest inputs still present at the checkout containing the saved plan."""
    plan = version_plan.validate_plan(json.loads(plan_path.read_text(encoding="utf-8")))
    evidence = cast(
        dict[str, object], json.loads(inputs_path.read_text(encoding="utf-8"))
    )
    if evidence.get("plan_sha256") != version_plan.plan_digest(plan):
        raise ValueError("Build inputs belong to a different release plan")
    if evidence.get("source_sha") != plan["source_sha"] or not evidence.get("files"):
        raise ValueError("Missing source-bound version inputs")
    if evidence.get("effective_inputs_sha256") != version_plan.effective_inputs_digest(
        cast(list[dict[str, object]], evidence["files"])
    ):
        raise ValueError("Build input evidence digest mismatch")
    if assets.is_symlink() or not assets.is_dir():
        raise ValueError("Assets must be a regular directory")
    if output.parent.resolve() != assets.resolve() or not re.fullmatch(
        r"release-inputs-[A-Za-z0-9._-]+\.json", output.name
    ):
        raise ValueError("Receipt must have a unique release-inputs-TARGET.json name")
    packages = receipt_packages(assets)
    result: dict[str, object] = {
        **evidence,
        "artifacts": packages,
        "toolchain": capture_toolchain(),
    }
    verify_current_inputs(
        plan_path.parent, cast(list[dict[str, object]], evidence["files"])
    )
    # Fail if a caller reuses an existing receipt path, including a symlink.
    with output.open("x", encoding="utf-8") as stream:
        stream.write(canonical(result).decode())
    return result


def verify_current_inputs(root: Path, files: list[dict[str, object]]) -> None:
    """Reject packaging changes to the exact version inputs captured before build."""
    root = root.resolve(strict=True)
    for item in files:
        # Reuse the synchronizer's confinement, symlink, hardlink and size checks.
        # pylint: disable-next=protected-access
        path = version_plan._path(root, cast(str, item["path"]))
        descriptor = os.open(
            path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
        )
        with os.fdopen(descriptor, "rb") as stream:
            info = os.fstat(stream.fileno())
            if (
                not stat.S_ISREG(info.st_mode)
                or info.st_nlink != 1
                or info.st_size > version_plan.MAX_METADATA
            ):
                raise ValueError(
                    f"Build input is not a bounded regular file: {item['path']}"
                )
            data = stream.read(version_plan.MAX_METADATA + 1)
        if (
            len(data) > version_plan.MAX_METADATA
            or sha256(data) != item["after_sha256"]
        ):
            raise ValueError(f"Build input changed after version sync: {item['path']}")


def verify_receipt_evidence(
    receipt: dict[str, object],
    plan: dict[str, object],
    name: str,
    policy: dict[str, object] | None,
) -> None:
    """Validate a receipt's source, toolchain and frozen version projections."""
    if receipt.get("plan_sha256") != version_plan.plan_digest(plan):
        raise ValueError(f"Build used a different release plan: {name}")
    if receipt.get("source_sha") != plan["source_sha"] or not receipt.get("files"):
        raise ValueError("Receipt lacks source-bound version input evidence")
    if not isinstance(receipt.get("toolchain"), dict) or not cast(
        dict[str, object], receipt["toolchain"]
    ).get("python"):
        raise ValueError("Receipt lacks actual build toolchain versions")
    if receipt.get("effective_inputs_sha256") != version_plan.effective_inputs_digest(
        cast(list[dict[str, object]], receipt["files"])
    ):
        raise ValueError("Receipt version input digest mismatch")
    if policy is not None and {
        item["path"] for item in cast(list[dict[str, object]], receipt["files"])
    } != {
        item["path"]
        for item in cast(
            list[dict[str, object]],
            cast(dict[str, object], policy["versioning"])["files"],
        )
    }:
        raise ValueError("Receipt does not cover every declared version source")
    if policy is not None:
        validate_input_fields(
            cast(list[dict[str, object]], receipt["files"]), policy, plan
        )


def cover_receipt_artifacts(
    receipt: dict[str, object],
    expected: dict[str, dict[str, object]],
    receipts: set[str],
    covered: set[str],
) -> None:
    """Accept exact payload metadata once, refusing recursive receipt coverage."""
    artifacts = receipt.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        raise ValueError("Empty receipt artifact inventory")
    for artifact in cast(list[dict[str, object]], artifacts):
        asset_name = cast(str, artifact.get("name"))
        if asset_name in covered or asset_name in receipts:
            raise ValueError("Payload has duplicate or recursive build coverage")
        if expected.get(asset_name) != artifact:
            raise ValueError(f"Receipt does not match staged payload: {asset_name}")
        covered.add(asset_name)


def verify_receipts(
    directory: Path,
    plan: dict[str, object],
    payloads: list[dict[str, object]],
    policy: dict[str, object] | None = None,
) -> list[dict[str, object]]:
    """Require exactly one plan-bound build receipt for every staged payload."""
    expected = {cast(str, entry["name"]): entry for entry in payloads}
    receipts = {
        name
        for name in expected
        if re.fullmatch(r"release-inputs-[A-Za-z0-9._-]+\.json", name)
    }
    if not receipts:
        raise ValueError("Versioned release has no build receipts")
    covered: set[str] = set()
    results: list[dict[str, object]] = []
    for name in sorted(receipts):
        with (directory / name).open("rb") as stream:
            raw = stream.read(MAX_RECEIPT_BYTES + 1)
        if len(raw) > MAX_RECEIPT_BYTES:
            raise ValueError("Oversized build receipt")
        receipt = cast(dict[str, object], json.loads(raw))
        verify_receipt_evidence(receipt, plan, name, policy)
        cover_receipt_artifacts(receipt, expected, receipts, covered)
        results.append({"name": name, "sha256": sha256(raw), "inputs": receipt})
    if covered != set(expected) - receipts:
        raise ValueError("Some release payloads lack version input evidence")
    if policy is not None and (DETACHED_PROVENANCE_REQUIRED or policy.get("detached_provenance")):
        if __package__:
            from .release_provenance import verify_all  # pylint: disable=import-outside-toplevel
        else:
            from release_provenance import verify_all  # pylint: disable=import-outside-toplevel

        verify_all(directory, policy, plan, payloads)
    return results


def validate_input_fields(
    files: list[dict[str, object]], policy: dict[str, object], plan: dict[str, object]
) -> None:
    """Check that receipts describe the declared projections, not just file names."""
    expected: dict[str, list[dict[str, object]]] = {}
    for declaration in cast(
        list[dict[str, object]], cast(dict[str, object], policy["versioning"])["files"]
    ):
        value = {
            "format": declaration["format"],
            "field": declaration.get("field"),
            "package": declaration.get("package"),
            "projection": declaration.get("value", "package"),
            "value": version_plan.projected_value(plan, declaration),
        }
        expected.setdefault(cast(str, declaration["path"]), []).append(value)
    for file in files:
        fields = file.get("fields")
        if not isinstance(fields, list):
            raise TypeError("Missing receipt version field projections")
        actual = [
            {
                key: item.get(key)
                for key in ("format", "field", "package", "projection", "value")
            }
            for item in cast(list[dict[str, object]], fields)
        ]
        if sorted(map(canonical, actual)) != sorted(
            map(canonical, expected[cast(str, file["path"])])
        ):
            raise ValueError("Receipt field values do not match the frozen plan")


def verify_declared_artifacts(
    directory: Path, policy: dict[str, object], plan: dict[str, object]
) -> list[dict[str, object]]:
    """The aggregate publisher must see every configured package metadata target."""
    result: list[dict[str, object]] = []
    for declaration in cast(
        list[dict[str, object]],
        cast(dict[str, object], policy["versioning"]).get("artifacts", []),
    ):
        pattern = declaration.get("path")
        if not isinstance(pattern, str) or "/" in pattern or "\\" in pattern:
            raise ValueError("Published artifact selectors must match flat asset names")
        matches = sorted(
            path
            for path in directory.iterdir()
            if fnmatch.fnmatchcase(path.name, pattern)
        )
        if not matches:
            raise ValueError(f"Declared package metadata target is missing: {pattern}")
        for path in matches:
            inspected = version_plan.verify_artifact(path, declaration, plan)
            inspected["path"] = path.name
            result.append(inspected)
    return result


def check_cli_path_kind(resolved: Path, kind: str) -> None:
    """Enforce input/output filesystem roles after path confinement."""
    if kind == "file" and not resolved.is_file():
        raise ValueError("CLI input must be a regular file")
    if kind == "directory" and not resolved.is_dir():
        raise ValueError("CLI assets must be a directory")
    if kind == "new" and (resolved.exists() or not resolved.parent.is_dir()):
        raise ValueError("CLI output must be a new file in an existing directory")


def confined_cli_path(root: Path, value: Path, kind: str) -> Path:
    """Constrain CLI paths to their installed checkout before any content I/O."""
    root = root.resolve(strict=True)
    candidate = value if value.is_absolute() else Path.cwd() / value
    if any(part == ".." or part.casefold() == ".git" for part in candidate.parts):
        raise ValueError("CLI paths must not traverse parent or Git directories")
    resolved = candidate.resolve(strict=kind != "new")
    if not resolved.is_relative_to(root) or resolved == root:
        raise ValueError("CLI path must stay inside the script checkout")
    relative = resolved.relative_to(root)
    if any(part.casefold() == ".git" for part in relative.parts):
        raise ValueError("CLI paths must not access Git directories")
    # Ignore aliases above the checkout (e.g. macOS /var -> /private/var), but
    # refuse a caller-selected symlink into any file or directory inside it.
    for component in (candidate, *candidate.parents):
        if component.is_symlink() and component.resolve().is_relative_to(root):
            raise ValueError("CLI path must not contain a symlink")
    if kind == "metadata":
        # Includes the synchronizer's regular-file, hardlink and metadata limits.
        # pylint: disable-next=protected-access
        return version_plan._path(root, relative.as_posix())
    check_cli_path_kind(resolved, kind)
    return resolved


def main() -> None:
    """Write one receipt after a platform finishes packaging its artifacts."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["create"])
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    plan = confined_cli_path(root, args.plan, "metadata")
    inputs = confined_cli_path(root, args.inputs, "metadata")
    assets = confined_cli_path(root, args.assets, "directory")
    output = confined_cli_path(root, args.output, "new")
    create_receipt(plan, inputs, assets, output)


if __name__ == "__main__":
    main()
