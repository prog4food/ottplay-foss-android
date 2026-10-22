#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Resolve stable container payloads to verified registry digests; never deploy."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import stat
# Fixed skopeo reads compare registry bytes with authenticated release assets.
import subprocess  # nosec B404
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path

if __package__:
    from .publish_verified import verified_assets, verified_publication_config
    from .release_control import (
        GitHub,
        ReleaseError,
        digest,
        require,
    )
else:
    from publish_verified import verified_assets, verified_publication_config
    from release_control import (
        GitHub,
        ReleaseError,
        digest,
        require,
    )

ROOT = Path(__file__).resolve().parents[1]


def plain_output_mode(directory: int, name: str):
    """Reject special destination entries without following a final symlink."""
    try:
        mode = os.stat(name, dir_fd=directory, follow_symlinks=False).st_mode
    except FileNotFoundError:
        return None
    require(stat.S_ISREG(mode), "Verified image output must be a plain file")
    return stat.S_IMODE(mode)


@contextmanager
def output_directory(output: Path, root: Path):
    """Anchor a destination beneath an operator-selected root before verification.

    The root is configuration, not a sandbox against the operator choosing it.
    Walk destination parents without following links and retain their descriptor
    so replacement of a parent pathname cannot redirect the eventual write.
    """
    require(
        {os.open, os.stat, os.unlink, os.rename} <= os.supports_dir_fd
        and hasattr(os, "O_DIRECTORY")
        and hasattr(os, "O_NOFOLLOW")
        and hasattr(os, "fchmod"),
        "Verified image output requires no-follow directory descriptor support",
    )
    require(".." not in output.parts, "Verified image output cannot traverse parents")
    configured_root = Path(os.path.abspath(root))
    # Only the explicitly trusted root may use a platform alias such as macOS /tmp.
    trusted_root = configured_root.resolve(strict=True)
    require(trusted_root.is_dir(), "Verified image output root must be a directory")
    relative = output
    if output.is_absolute():
        try:
            relative = output.relative_to(configured_root)
        except ValueError:
            relative = output.relative_to(trusted_root)
    require(relative.parts, "Verified image output must name a file below its root")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    directory = os.open(trusted_root, flags)
    try:
        for parent in relative.parts[:-1]:
            parent_name = os.path.basename(parent)
            if parent_name != parent or parent_name in {"", ".", ".."}:
                raise ReleaseError("Verified image output parent must be one directory")
            child = os.open(parent_name, flags, dir_fd=directory)
            os.close(directory)
            directory = child
        plain_output_mode(directory, relative.name)
        yield directory, relative.name
    finally:
        os.close(directory)


def write_output(directory: int, name: str, data: bytes) -> None:
    """Atomically replace one leaf inside an already anchored directory."""
    require(
        name not in {"", ".", ".."} and Path(name).name == name,
        "Verified image output must be a single filename",
    )
    mode = plain_output_mode(directory, name)
    temporary = ".verified-images-" + secrets.token_hex(16)
    fd = os.open(
        temporary,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
        dir_fd=directory,
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
            if mode is not None:
                os.fchmod(handle.fileno(), mode)
        plain_output_mode(directory, name)
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass


def resolve(policy: dict, tag: str, directory: Path) -> dict:
    """Match registry manifests to approved OCI archives and return digest references."""
    manifest = verified_assets(GitHub(policy["repository"]), tag, directory)
    images = {}
    mapping = verified_publication_config(policy, manifest, "container_assets")
    require(mapping, "No declared container archives")
    for name, image in mapping.items():
        require(
            Path(name).name == name and (directory / name).is_file(),
            "Approved container archive is missing",
        )
        # Verified regular archive path is a single transport argument; no shell.
        local = subprocess.run(  # nosec B603, B607
            ["skopeo", "inspect", "--raw", "oci-archive:" + str(directory / name)],
            capture_output=True,
            check=True,
        ).stdout
        # Destination and version come from the authenticated source policy and manifest.
        remote = subprocess.run(  # nosec B603, B607
            [
                "skopeo",
                "inspect",
                "--raw",
                "docker://" + image + ":" + manifest["version"],
            ],
            capture_output=True,
            check=True,
        ).stdout
        require(
            local and digest(local) == digest(remote),
            f"Registry bytes differ from approved RC: {image}",
        )
        images[image] = image + "@sha256:" + digest(local)
    return {
        "repository": policy["repository"],
        "tag": tag,
        "source_sha": manifest["source_sha"],
        "images": images,
    }


def main():
    """Write verified image references for a later explicit deployment."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path.cwd(),
        help="Trusted existing output directory (default: current working directory)",
    )
    args = parser.parse_args()
    try:
        with output_directory(args.output, args.output_root) as (directory, name):
            policy = json.loads((ROOT / ".release-policy.json").read_text())
            with tempfile.TemporaryDirectory(
                prefix="verified-image-digests-"
            ) as temporary:
                result = resolve(policy, args.tag, Path(temporary))
            write_output(
                directory, name, (json.dumps(result, indent=2) + "\n").encode()
            )
        print(
            f"Verified {len(result['images'])} immutable image digests in {args.output}"
        )
        return 0
    except (ReleaseError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"verified-images: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
