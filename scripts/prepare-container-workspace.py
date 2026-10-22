#!/usr/bin/env python3
"""Derive deterministic server-only Cargo inputs without updating locked packages.

Run this in the native Docker input stage, then copy only the output Cargo.toml
and Cargo.lock into the target compiler stage. Cargo owns dependency resolution;
this helper never edits the lockfile graph. The target build must use --locked.
"""

import argparse
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import tomllib

MEMBERS = ("src-rs/core", "src-rs/server", "src-tauri")
SERVER_MEMBERS = MEMBERS[:2]


def server_manifest(source):
    """Preserve the complete manifest except the explicitly owned member list."""
    original = tomllib.loads(source)
    members = original.get("workspace", {}).get("members")
    if not isinstance(members, list) or sorted(members) != sorted(MEMBERS):
        raise ValueError("Unexpected workspace members; review container inputs")
    if "package" in original:
        raise ValueError("Expected a virtual workspace manifest")
    expected = copy.deepcopy(original)
    expected["workspace"]["members"] = list(SERVER_MEMBERS)
    section = re.search(r"(?ms)^\[workspace\][ \t]*\n(.*?)(?=^\[|\Z)", source)
    if section is None:
        raise ValueError("Expected an explicit workspace table")
    body, count = re.subn(
        r"(?m)^members[ \t]*=[ \t]*\[[^\]]*\]",
        "members = " + json.dumps(SERVER_MEMBERS),
        section.group(1),
    )
    if count != 1:
        raise ValueError("Expected exactly one explicit workspace member list")
    result = source[: section.start(1)] + body + source[section.end(1) :]
    if tomllib.loads(result) != expected:
        raise ValueError("Workspace transformation changed unrelated manifest data")
    return result


def locked_packages(lock):
    """Index Cargo package identities, including exact git revisions and checksums."""
    data = tomllib.loads(lock)
    if data.get("version") != 4 or not isinstance(data.get("package"), list):
        raise ValueError("Expected a populated Cargo lockfile version 4")
    result = {}
    for package in data["package"]:
        identity = (package["name"], package["version"], package.get("source"))
        if identity in result:
            raise ValueError("Duplicate locked package identity")
        result[identity] = package.get("checksum")
    if not result:
        raise ValueError("Expected a populated Cargo lockfile")
    return result


def verify_locked_packages(original, derived):
    before = locked_packages(original)
    after = locked_packages(derived)
    for identity, checksum in after.items():
        if identity not in before or before[identity] != checksum:
            raise ValueError("Cargo changed a locked package; update the source lockfile first")
    names = {identity[0] for identity in after}
    if "ottplay-tauri" in names or not {"ottplay-core", "ottplay-server"} <= names:
        raise ValueError("Derived lockfile does not describe the server-only workspace")
    return len(before), len(after)


def prepare(workspace, output, *, cargo="cargo", offline=False, timeout=300):
    """Resolve in a disposable copy; publish outputs only after all checks pass."""
    workspace = Path(workspace).resolve(strict=True)
    output = Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("Output path already exists; refusing to overwrite inputs")
    if (workspace / ".cargo").exists():
        raise ValueError("Workspace Cargo configuration requires explicit container review")
    manifest = server_manifest((workspace / "Cargo.toml").read_text())
    original_lock = (workspace / "Cargo.lock").read_text()
    locked_packages(original_lock)
    with tempfile.TemporaryDirectory(prefix="ottplay-container-workspace-") as temporary:
        scratch = Path(temporary).resolve()
        (scratch / "Cargo.toml").write_text(manifest)
        (scratch / "Cargo.lock").write_text(original_lock)
        for directory in ("src-rs", "vendor"):
            shutil.copytree(workspace / directory, scratch / directory, symlinks=True)
        # --workspace retains existing external versions. Quiet also avoids the
        # large removed-package report; metadata would download dependency source.
        command = [cargo, "update", "--workspace", "--quiet"]
        if offline:
            command.append("--offline")
        subprocess.run(command, cwd=scratch, check=True, timeout=timeout)
        derived_lock = (scratch / "Cargo.lock").read_text()
        before_count, after_count = verify_locked_packages(original_lock, derived_lock)
        # No build, build script, or dependency-source fetch is needed to verify
        # Cargo's effective workspace and the intended binary target.
        metadata_command = [cargo, "metadata", "--locked", "--offline", "--no-deps", "--format-version", "1"]
        metadata = json.loads(
            subprocess.run(
                metadata_command,
                cwd=scratch,
                check=True,
                timeout=timeout,
                stdout=subprocess.PIPE,
                text=True,
            ).stdout
        )
        packages = {package["id"]: package for package in metadata["packages"]}
        actual_members = {
            str(Path(packages[identity]["manifest_path"]).parent.relative_to(scratch))
            for identity in metadata["workspace_members"]
        }
        if actual_members != set(SERVER_MEMBERS):
            raise ValueError("Cargo included unexpected workspace members")
        server = [package for package in packages.values() if package["name"] == "ottplay-server"]
        if len(server) != 1 or not any(
            target["name"] == "ottplay-server" and "bin" in target["kind"] for target in server[0]["targets"]
        ):
            raise ValueError("Missing expected ottplay-server binary target")
        if (scratch / "Cargo.lock").read_text() != derived_lock:
            raise ValueError("Locked metadata changed the prepared lockfile")
        output.parent.mkdir(parents=True, exist_ok=True)
        # A same-filesystem directory rename makes the two output files appear
        # together. The output deliberately contains no release-specific report.
        with tempfile.TemporaryDirectory(prefix=".container-inputs-", dir=output.parent) as staging:
            pending = Path(staging) / "ready"
            pending.mkdir()
            (pending / "Cargo.toml").write_text(manifest)
            (pending / "Cargo.lock").write_text(derived_lock)
            os.rename(pending, output)
    return {
        "originalPackages": before_count,
        "serverPackages": after_count,
        "cargoTomlSha256": hashlib.sha256((output / "Cargo.toml").read_bytes()).hexdigest(),
        "cargoLockSha256": hashlib.sha256((output / "Cargo.lock").read_bytes()).hexdigest(),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cargo", default="cargo")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--timeout", type=int, default=300)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    result = prepare(args.workspace, args.output, cargo=args.cargo, offline=args.offline, timeout=args.timeout)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
