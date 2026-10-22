#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Publish verified stable assets to a registry without rebuilding.

The GitHub stable release must already exist. Payload bytes are checked against
the original RC manifest AND its immutable Actions evidence before any write.
Registry credentials come from the operator's existing skopeo/twine login.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
# Publication uses fixed tool commands and verified inputs without a shell.
import subprocess  # nosec B404
import sys
import tempfile
from pathlib import Path
from urllib.parse import quote

if __package__:
    from .release_control import (
        MANIFEST,
        GitHub,
        ReleaseError,
        download_asset,
        positive,
        repository_info,
        require,
        require_release_policy,
        source_policy_snapshot,
        validate_manifest,
        validate_run,
        verify_evidence,
    )
else:
    from release_control import (
        MANIFEST,
        GitHub,
        ReleaseError,
        download_asset,
        positive,
        repository_info,
        require,
        require_release_policy,
        source_policy_snapshot,
        validate_manifest,
        validate_run,
        verify_evidence,
    )

ROOT = Path(__file__).resolve().parents[1]
DOCKER_TRANSPORT = "docker://"


# Keep source policy, run evidence and downloaded bytes in one validation scope.
# pylint: disable-next=too-many-locals
def verified_assets(gh, tag, directory):
    """Verify stable provenance and source policy before downloading approved bytes."""
    require(
        re.fullmatch(r"v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", tag),
        "An exact stable vX.Y.Z tag is required",
    )
    release = gh.api(f"releases/tags/{quote(tag, safe='')}")
    require(
        release.get("draft") is False and release.get("prerelease") is False,
        "Not a published stable release",
    )
    ref = gh.api(f"git/ref/tags/{quote(tag, safe='')}")
    assets = gh.pages(f"releases/{positive(release['id'], 'release ID')}/assets")
    manifests = [a for a in assets if a["name"] == MANIFEST]
    require(len(manifests) == 1, "Stable release has no unambiguous RC manifest")
    raw = gh.binary(f"releases/assets/{manifests[0]['id']}")
    candidate = json.loads(raw)
    manifest = validate_manifest(
        raw, gh.repo, candidate.get("tag", ""), allow_final=True
    )
    original_policy = source_policy_snapshot(gh, manifest["source_sha"])
    require_release_policy(original_policy["data"], gh.repo, qualified=True)
    require(
        original_policy == manifest["source_policy"],
        "Manifest policy snapshot differs from the policy at the candidate source commit",
    )
    require("v" + manifest["version"] == tag, "Stable version differs from the RC")
    require(
        ref.get("object", {}).get("type") == "commit"
        and ref["object"]["sha"] == manifest["source_sha"],
        "Stable tag points to different source",
    )
    info = repository_info(gh)
    run = gh.api(f"actions/runs/{manifest['run_id']}")
    require(run.get("id") == manifest["run_id"], "Source run identity mismatch")
    require(
        run.get("event") == "workflow_dispatch",
        "Release candidate must come from a manual workflow dispatch",
    )
    validate_run(
        gh, run, info, manifest["source_sha"], manifest["run_attempt"], completed=True
    )
    verify_evidence(gh, manifest, raw)
    if manifest["channel"] == "stable":
        # Legacy consumers do not vendor optional versioning modules.
        # pylint: disable-next=import-outside-toplevel
        if __package__:
            from .release_versioned import verified_rc
        else:
            from release_versioned import verified_rc

        _, parent = verified_rc(gh, manifest["derived_from_rc"]["tag"], info, run)
        require(
            parent == manifest["derived_from_rc"],
            "Final package RC provenance mismatch",
        )
    expected = {item["name"]: item for item in manifest["assets"]}
    require(
        len(assets) == len(expected) + 1
        and {a["name"] for a in assets} == set(expected) | {MANIFEST},
        "Stable inventory differs from RC evidence",
    )
    for asset in assets:
        if asset["name"] == MANIFEST:
            continue
        item = expected[asset["name"]]
        identity = download_asset(gh, asset["id"], directory / asset["name"])
        require(
            asset.get("state") == "uploaded"
            and identity["size"] == item["size"]
            and identity["sha256"] == item["sha256"],
            f"Stable payload changed: {asset['name']}",
        )
    if manifest.get("version_plan"):
        # pylint: disable-next=import-outside-toplevel
        if __package__:
            from .version_receipt import verify_declared_artifacts, verify_receipts
        else:
            from version_receipt import verify_declared_artifacts, verify_receipts

        verify_receipts(
            directory,
            manifest["version_plan"],
            manifest["assets"],
            original_policy["data"],
        )
        verify_declared_artifacts(
            directory, original_policy["data"], manifest["version_plan"]
        )
    return manifest


def verified_publication_config(policy, manifest, field):
    """Reject destination mappings that differ from the immutable RC policy."""
    require(field in {"container_assets", "pypi_assets"}, "Unknown publication mapping")
    default = {} if field == "container_assets" else []
    original = manifest["source_policy"]["data"].get(field, default)
    require(
        policy.get(field, default) == original,
        f"Current {field} differs from the candidate source policy; "
        "use the original mapping or create a new RC",
    )
    return original


def require_unpublished_version(image, version):
    """Fail closed unless registry inventory proves the version is unpublished."""
    # The caller validates the registry destination; skopeo receives one transport argument.
    check = subprocess.run(  # nosec B603, B607
        ["skopeo", "list-tags", DOCKER_TRANSPORT + image],
        capture_output=True,
        text=True,
        check=False,
    )
    if check.returncode == 0:
        require(
            version not in json.loads(check.stdout).get("Tags", []),
            f"Container version already exists: {image}:{version}",
        )
    # Skopeo can render the registry's NAME_UNKNOWN code as "name unknown".
    # Require an unambiguous terminal diagnostic: a missing-repository phrase
    # followed by a login or permission warning is not proof of absence.
    elif not re.search(
        r"(?:\bNAME_UNKNOWN\b(?:: repository name not known to registry)?"
        r"|\bname unknown\b|\brepository does not exist\b)[\"']?\s*$",
        check.stderr,
        re.IGNORECASE,
    ):
        raise ReleaseError(
            "Cannot establish registry tag inventory; authenticate and retry: " + image
        )


def image_copy_command(archive, image, tag):
    """Copy every approved OCI platform without rebuilding or changing digests."""
    return [
        "skopeo",
        "copy",
        "--all",
        "--preserve-digests",
        "oci-archive:" + str(archive),
        DOCKER_TRANSPORT + image + ":" + tag,
    ]


def container_commands(policy, manifest, directory, latest):
    """Preflight all original destinations, then order version and latest copies."""
    mapping = verified_publication_config(policy, manifest, "container_assets")
    require(mapping, "No container archive mapping in .release-policy.json")
    commands = []
    for name, image in mapping.items():
        require(
            (directory / name).is_file() and Path(name).name == name,
            f"Missing approved image archive: {name}",
        )
        require(
            re.fullmatch(r"(?:ghcr\.io|docker\.io)/[a-z0-9][a-z0-9._/-]*", image),
            f"Invalid configured image destination: {image}",
        )
        # Never overwrite an existing version tag, even on retries.
        require_unpublished_version(image, manifest["version"])
        commands.append(
            image_copy_command(directory / name, image, manifest["version"])
        )
    if latest:
        commands.extend(
            image_copy_command(directory / name, image, "latest")
            for name, image in mapping.items()
        )
    return commands


def pypi_commands(policy, manifest, directory):
    """Check and upload only distributions named by the original source policy."""
    patterns = verified_publication_config(policy, manifest, "pypi_assets")
    files = sorted(
        {
            str(path)
            for pattern in patterns
            for path in directory.iterdir()
            if fnmatch.fnmatch(path.name, pattern)
        }
    )
    require(
        files and any(name.endswith(".whl") for name in files),
        "No verified wheel assets configured for PyPI",
    )
    return [
        ["python3", "-m", "twine", "check", *files],
        ["python3", "-m", "twine", "upload", *files],
    ]


def main():
    """Display or execute registry publication from verified stable payloads."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=["containers", "pypi"])
    parser.add_argument("--tag", required=True)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Perform the displayed registry publication (default verifies only)",
    )
    parser.add_argument(
        "--latest",
        action="store_true",
        help="Also move container latest after every versioned image is published",
    )
    args = parser.parse_args()
    try:
        policy = json.loads((ROOT / ".release-policy.json").read_text())
        gh = GitHub(policy["repository"])
        with tempfile.TemporaryDirectory(prefix="verified-publication-") as temp:
            directory = Path(temp)
            manifest = verified_assets(gh, args.tag, directory)
            if args.target == "containers":
                commands = container_commands(policy, manifest, directory, args.latest)
            else:
                commands = pypi_commands(policy, manifest, directory)
            print(
                json.dumps(
                    {
                        "repository": gh.repo,
                        "stable_tag": args.tag,
                        "candidate": manifest["tag"],
                        "commands": commands,
                        "execute": args.execute,
                    },
                    indent=2,
                )
            )
            if args.execute:
                for command in commands:
                    # Commands come only from the verified OCI/PyPI builders above.
                    subprocess.run(command, check=True)  # nosec B603
        return 0
    except (
        ReleaseError,
        OSError,
        ValueError,
        KeyError,
        subprocess.CalledProcessError,
    ) as exc:
        print(f"publish-verified: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
