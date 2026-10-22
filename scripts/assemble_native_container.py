#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Verify native build receipts and assemble one offline multi-platform OCI asset."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
# Only a fixed read-only Git query is executed, with no shell.
import subprocess  # nosec B404
import tempfile
from contextlib import ExitStack, suppress
from pathlib import Path

if __package__:
    from . import merge_oci_archives
    from . import version_plan
    from . import version_receipt
    from .release_control import stream_identity
else:
    import merge_oci_archives
    import version_plan
    import version_receipt
    from release_control import stream_identity

PLATFORMS = {
    "linux/amd64": {"machine": "x86_64", "runner_arch": "X64"},
    "linux/arm64": {"machine": "aarch64", "runner_arch": "ARM64"},
}


def require(condition: bool, message: str) -> None:
    """Reject incomplete evidence before writing a final release payload."""
    if not condition:
        raise ValueError(message)


def snapshot(path: Path) -> tuple[bytes, dict]:
    """Read bounded, unambiguous JSON from a regular metadata file."""
    descriptor = os.open(
        path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    )
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(
            stat.S_ISREG(info.st_mode)
            and info.st_nlink == 1
            and info.st_size <= version_receipt.MAX_RECEIPT_BYTES,
            f"Unsafe or oversized native metadata: {path.name}",
        )
        raw = stream.read(version_receipt.MAX_RECEIPT_BYTES + 1)
    # Share the duplicate-key and UTF-8 checks used by the frozen version plan.
    # pylint: disable-next=protected-access
    require(
        len(raw) == info.st_size and len(raw) <= version_receipt.MAX_RECEIPT_BYTES,
        "Native metadata changed or exceeded its size limit",
    )
    value = version_plan._json_document(raw)[1]
    require(isinstance(value, dict), "Native metadata must be an object")
    return raw, value


def document(path: Path) -> dict:
    """Read one bounded metadata snapshot."""
    return snapshot(path)[1]


def verify_native_input(root, directory, platform, policy, plan, inputs, run):
    """Bind one archive and its successful native smoke to the current source plan."""
    arch = platform.split("/")[1]
    archive = directory / f"container-{arch}.oci.tar"
    receipt_name = f"release-inputs-native-{arch}.json"
    require(
        not directory.is_symlink() and directory.is_dir(),
        "Native input must be a regular directory",
    )
    paths = sorted(directory.iterdir())
    require(
        {path.name for path in paths}
        == {archive.name, "native-build.json", receipt_name},
        "Native input inventory differs from the build contract",
    )
    payloads, documents = [], {}
    for path in paths:
        info = path.lstat()
        require(
            stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
            "Native input must contain only regular files",
        )
        if path.suffix == ".json":
            raw, documents[path.name] = snapshot(path)
            identity = {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
        else:
            with path.open("rb") as stream:
                identity = stream_identity(stream)
        payloads.append({"name": path.name, **identity})
    # These three files are intermediate native inputs, not a publishable
    # release directory. Verify their full receipts, then policy projections;
    # final staging/signing still requires every detached provenance pair.
    verified = version_receipt.verify_receipts(directory, plan, payloads)
    require(len(verified) == 1, "Expected one native build receipt")
    receipt_identity = next(item for item in payloads if item["name"] == receipt_name)
    require(
        verified[0]["sha256"] == receipt_identity["sha256"],
        "Native receipt changed during verification",
    )
    receipt = verified[0]["inputs"]
    version_receipt.verify_receipt_evidence(receipt, plan, receipt_name, policy)
    require(receipt["files"] == inputs["files"], "Native version inputs differ")
    version_receipt.verify_current_inputs(root, receipt["files"])
    expected = PLATFORMS[platform]
    require(
        receipt["toolchain"].get("RUNNER_ARCH") == expected["runner_arch"]
        and receipt["toolchain"].get("RUNNER_OS") == "Linux",
        "Receipt was not produced on the expected native Linux runner",
    )
    build = documents["native-build.json"]
    identity = {
        "schema_version": 1,
        "platform": platform,
        **expected,
        "source_sha": plan["source_sha"],
        "plan_sha256": version_plan.plan_digest(plan),
        "version": version_plan.projections(plan)["package"],
        "run_id": run["run_id"],
        "run_attempt": run["run_attempt"],
        "smoke_passed": True,
    }
    require(
        all(
            type(build.get(key)) is type(value) and build[key] == value
            for key, value in identity.items()
        ),
        "Native smoke identity, architecture or workflow attempt differs",
    )
    require(
        isinstance(build.get("image_config_digest"), str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", build["image_config_digest"]),
        "Native smoke lacks its exact image config digest",
    )
    require(
        isinstance(build.get("toolchain"), dict)
        and all(
            isinstance(build["toolchain"].get(name), str)
            and 0 < len(build["toolchain"][name]) <= 4096
            for name in ("docker", "buildx")
        ),
        "Native build lacks its actual container toolchain",
    )
    require(
        isinstance(build.get("timings"), dict)
        and all(
            type(build["timings"].get(name)) is int and build["timings"][name] >= 0
            for name in ("build_seconds", "smoke_seconds")
        ),
        "Native build lacks valid timing evidence",
    )
    return archive, {"build": build, "receipt": verified[0]}


def publish_evidence(path: Path, payload: bytes) -> None:
    """Publish complete serialized evidence atomically without replacing a file."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=".native-evidence-", dir=path.parent, delete=False
        ) as stream:
            temporary = Path(stream.name)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        # An operator or concurrent process may create the destination after
        # validation. link refuses that race without replacing the other file.
        os.link(temporary, path)
    finally:
        if temporary is not None:
            # Cleanup must neither roll back a published evidence/OCI pair nor
            # replace the original failure. A hidden temporary orphan is safe:
            # it is excluded from release payload globbing and can be removed
            # with the disposable workspace when filesystem access recovers.
            with suppress(OSError):
                temporary.unlink()


def publish_detached_outputs(staging: Path, outputs: tuple[Path, ...]) -> None:
    """Publish the complete verified set without overwriting or deleting foreign files."""
    linked = []
    try:
        for output in outputs:
            source = staging / output.name
            owned = source.stat()
            os.link(source, output)
            linked.append((output, owned))
        # Strict recipients reject aliases. Removing staging links is part of
        # publication, unlike removing the now-empty temporary directory.
        for output in outputs:
            (staging / output.name).unlink()
        require(
            all(path.stat().st_nlink == 1 for path in outputs),
            "Published native outputs must be unaliased",
        )
    except (OSError, ValueError):
        for output, owned in linked:
            with suppress(OSError):
                if os.path.samestat(output.stat(follow_symlinks=False), owned):
                    output.unlink()
        raise


def discard_staging(temporary: tempfile.TemporaryDirectory) -> None:
    """A cleanup failure must not invalidate an already published verified set."""
    with suppress(OSError):
        temporary.cleanup()


def verify_assembled_inputs(merged, builds):
    """Bind the assembled archive back to receipts, attestations and smoke tests."""
    for archive in merged["inputs"]:
        receipt_assets = builds[archive["platform"]]["receipt"]["inputs"]["artifacts"]
        require(
            {key: archive[key] for key in ("name", "size", "sha256")}
            in receipt_assets,
            "OCI input changed after native receipt verification",
        )
    for platform, build in builds.items():
        require(
            merged["images"][platform]["attestation_digests"],
            "Native OCI input lost its build attestations",
        )
        require(
            merged["images"][platform].get("provenance_digests"),
            "Native OCI input lacks SLSA build provenance",
        )
        require(
            merged["images"][platform]["config_digest"]
            == build["build"]["image_config_digest"],
            "Native smoke tested a different image from the OCI payload",
        )


def provenance_module():
    """Load the optional provenance implementation in CLI and package imports."""
    if __package__:
        from . import release_provenance  # pylint: disable=import-outside-toplevel
    else:
        import release_provenance  # pylint: disable=import-outside-toplevel
    return release_provenance


def assemble(root: Path, directories: dict[str, Path], output: Path, evidence: Path):
    """Validate both native builds before preserving their blobs in a final archive."""
    root = root.resolve(strict=True)
    require(set(directories) == set(PLATFORMS), "Both native platforms are required")
    output = version_receipt.confined_cli_path(root, output, "new")
    evidence = version_receipt.confined_cli_path(root, evidence, "new")
    require(output != evidence, "OCI and evidence destinations must differ")
    policy = document(root / ".release-policy.json")
    # Fixed read-only Git query using the runner's selected toolchain.
    source = subprocess.check_output(  # nosec B603, B607
        ["git", "rev-parse", "HEAD"], cwd=root, text=True
    ).strip()
    plan = version_plan.validate_plan(
        document(root / ".release-plan.json"), policy=policy, source_sha=source
    )
    version_plan.sync_versions(root, policy, plan, check=True)
    inputs = document(root / ".release-inputs.json")
    require(
        inputs.get("plan_sha256") == version_plan.plan_digest(plan)
        and inputs.get("source_sha") == source,
        "Assembly inputs differ from the frozen plan",
    )
    run = {
        "run_id": os.environ.get("GITHUB_RUN_ID", ""),
        "run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", ""),
    }
    require(
        all(re.fullmatch(r"[1-9]\d*", value, flags=re.ASCII) for value in run.values()),
        "Native assembly requires the current workflow run and attempt",
    )
    archives, builds = {}, {}
    for platform, directory in sorted(directories.items()):
        directory = version_receipt.confined_cli_path(root, directory, "directory")
        archives[platform], builds[platform] = verify_native_input(
            root, directory, platform, policy, plan, inputs, run
        )
    # Preserve the default inline-attestation format unless this exact output
    # explicitly opts into the signed detached-provenance contract.
    sidecar = None
    if policy.get("detached_provenance"):
        release_provenance = provenance_module()
        pairs = release_provenance.policy_pairs(policy)
        pair = next((item for item in pairs if item["image"] == output.name), None)
        if pair is not None:
            sidecar = version_receipt.confined_cli_path(
                root, output.parent / pair["sidecar"], "new"
            )
            require(
                sidecar != evidence,
                "Sidecar and native evidence destinations must differ",
            )
    with ExitStack() as stack:
        staging = None
        if sidecar is not None:
            require(
                evidence.parent == output.parent,
                "Detached outputs require one directory",
            )
            temporary = tempfile.TemporaryDirectory(
                prefix=".native-assembly-", dir=output.parent
            )
            stack.callback(discard_staging, temporary)
            staging = Path(temporary.name)
        if sidecar is None:
            merged = merge_oci_archives.merge_archives(
                archives, output, version_plan.projections(plan)["package"], source
            )
        else:
            expected = {}
            for platform, archive in archives.items():
                assets = builds[platform]["receipt"]["inputs"]["artifacts"]
                original = next(item for item in assets if item["name"] == archive.name)
                expected[platform] = {
                    **original,
                    "config_digest": builds[platform]["build"]["image_config_digest"],
                }
            merged = release_provenance.detach(
                archives,
                staging / output.name,
                staging / sidecar.name,
                policy,
                plan,
                expected,
            )

        try:
            verify_assembled_inputs(merged, builds)
            result = {
                "schema_version": 1,
                "source_sha": source,
                "plan_sha256": version_plan.plan_digest(plan),
                **run,
                "native_builds": builds,
                "assembly": merged,
            }
            if staging is None:
                publish_evidence(evidence, version_receipt.canonical(result))
            else:
                publish_evidence(
                    staging / evidence.name, version_receipt.canonical(result)
                )
                publish_detached_outputs(staging, (output, sidecar, evidence))
        except Exception:
            if staging is None:
                output.unlink()
            raise
        return result


def main() -> None:
    """Accept isolated current-run native artifacts without registry access."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    directories = {}
    for value in args.input:
        platform, separator, path = value.partition("=")
        require(
            separator and path and platform not in directories,
            "Native inputs must be unique PLATFORM=DIRECTORY values",
        )
        directories[platform] = Path(path)
    root = Path(__file__).resolve().parents[1]
    assemble(root, directories, args.output, args.evidence)


if __name__ == "__main__":
    main()
