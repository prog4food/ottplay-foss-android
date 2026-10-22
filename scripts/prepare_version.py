#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Prepare all owned base-version files together, optionally as a GitHub PR."""

from __future__ import annotations

import argparse
import copy
import json
import re

# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
import tempfile
from collections.abc import Collection
from pathlib import Path
from typing import cast

if __package__:
    from . import version_plan
else:
    import version_plan


def run(root: Path, *args: str, capture: bool = True) -> str:
    """Use argument arrays; release versions are data, never shell fragments."""
    # Repository-controlled argv; no shell interpolation or external command text.
    result = subprocess.run(  # nosec B603
        args,
        cwd=root,
        text=True,
        check=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else ""


def source_policy(policy: dict[str, object]) -> dict[str, object]:
    """Build counters belong to generated packages, not a base-version PR."""
    result = copy.deepcopy(policy)
    cast(dict[str, object], result["versioning"])["files"] = [
        item
        for item in cast(
            list[dict[str, object]],
            cast(dict[str, object], result["versioning"])["files"],
        )
        if item.get("value") not in {"build", "apple-build"}
    ]
    return result


def _bumped_version(current: str, tags: Collection[str], bump: str) -> str:
    """Choose the requested bump while preserving an already prepared base."""
    values = [
        tuple(map(int, value[1:].split(".")))
        for value in tags
        if value.startswith("v") and version_plan.BASE.fullmatch(value[1:])
    ]
    existing = tuple(map(int, current.split(".")))
    if bump == "next-patch":
        if not values or existing > max(values):
            selected = current
        else:
            major, minor, patch = max(values)
            selected = f"{major}.{minor}.{patch + 1}"
    elif bump == "major":
        selected = f"{existing[0] + 1}.0.0"
    elif bump == "minor":
        selected = f"{existing[0]}.{existing[1] + 1}.0"
    else:
        selected = f"{existing[0]}.{existing[1]}.{existing[2] + 1}"
    return selected


def _validate_preparation_checkout(
    root: Path, policy: dict[str, object]
) -> tuple[str, str, str]:
    """Require a clean checkout of the matching origin and current default branch."""
    if policy.get("mode") != "release":
        raise ValueError("Only release-mode products can prepare versions")
    if run(root, "git", "status", "--porcelain"):
        raise ValueError("Version preparation requires a clean checkout")
    repo = cast(str, policy.get("repository", ""))
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Preparation requires an explicit OWNER/REPO identity")
    for extra in ([], ["--push"]):
        remote_url = run(root, "git", "remote", "get-url", *extra, "origin")
        identity = re.fullmatch(
            r"(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)"
            r"([^/]+/[^/]+?)(?:\.git)?",
            remote_url,
        )
        if not identity or identity[1].casefold() != repo.casefold():
            raise ValueError(
                "Origin fetch/push identity differs from the release policy"
            )
    branch = cast(str, policy.get("default_branch", "main"))
    # Refresh the actual GitHub history; stale local tags cannot choose a version.
    run(root, "git", "fetch", "origin", branch, "--tags", capture=False)
    head = run(root, "git", "rev-parse", "HEAD")
    remote = run(root, "git", "rev-parse", f"origin/{branch}")
    if head != remote:
        raise ValueError("Prepare versions from the current default-branch HEAD")
    return repo, branch, head


def _preparation_topic(
    root: Path, repo: str, branch: str, head: str, target: str
) -> tuple[str, list[dict[str, object]], str | None]:
    """Identify and verify an existing preparation branch before any write."""
    topic = f"release/version-{target}"
    listed = json.loads(
        run(
            root,
            "gh",
            "pr",
            "list",
            "--repo",
            repo,
            "--head",
            topic,
            "--base",
            branch,
            "--state",
            "open",
            "--json",
            "url,isCrossRepository,headRefName,headRefOid,baseRefName",
        )
    )
    existing = own_pull_requests(listed, topic, branch)
    topic_sha = remote_topic(root, topic)
    if existing and topic_sha is None:
        raise ValueError("Open preparation PR has no matching remote branch")
    if existing and existing[0].get("headRefOid") != topic_sha:
        raise ValueError("Preparation PR head SHA differs from the remote topic; retry")
    if topic_sha:
        verify_owned_topic(root, topic_sha, head, target)
    return topic, existing, topic_sha


def choose_version(
    current: str,
    tags: Collection[str],
    requested: str = "",
    bump: str = "next-patch",
    *,
    occupied: Collection[str] | None = None,
) -> str:  # pylint: disable=too-many-branches
    """Use SemVer ordering and preserve an already prepared unreleased cycle."""
    if requested:
        if not version_plan.BASE.fullmatch(requested):
            raise ValueError("Requested version must be X.Y.Z")
        selected = requested
    else:
        selected = _bumped_version(current, tags, bump)
    if tuple(map(int, selected.split("."))) < tuple(map(int, current.split("."))):
        raise ValueError("Preparation must not downgrade the active release base")
    occupied = set(tags if occupied is None else occupied)
    if requested or bump != "next-patch":
        if "v" + selected in occupied:
            raise ValueError("This base version already has a stable tag")
    else:
        major, minor, patch = map(int, selected.split("."))
        while "v" + selected in occupied:
            patch += 1
            selected = f"{major}.{minor}.{patch}"
    return selected


def advertised_tags(root: Path) -> tuple[list[str], set[str]]:
    """Return reachable history plus all occupied names from the same remote read."""
    advertised = {}
    for line in run(
        root, "git", "ls-remote", "--tags", "--refs", "origin"
    ).splitlines():
        object_id, ref = line.split("\t", 1)
        if not re.fullmatch(r"[0-9a-f]{40}", object_id):
            raise ValueError("Remote advertised an invalid tag object")
        if ref.startswith("refs/tags/"):
            advertised[ref.removeprefix("refs/tags/")] = object_id
    merged = run(root, "git", "tag", "--merged", "HEAD", "--list", "v*").splitlines()
    result = []
    for tag in merged:
        if tag not in advertised:
            continue
        local_object = run(root, "git", "rev-parse", "--verify", f"refs/tags/{tag}")
        if local_object != advertised[tag]:
            raise ValueError("Remote tag changed during version preparation")
        result.append(tag)
    return result, set(advertised)


def remote_topic(root: Path, topic: str) -> str | None:
    """Resolve and fetch exactly one remote preparation branch, if present."""
    ref = f"refs/heads/{topic}"
    lines = run(root, "git", "ls-remote", "--heads", "origin", ref).splitlines()
    if not lines:
        return None
    if len(lines) != 1:
        raise ValueError("Preparation branch has ambiguous remote identity")
    sha, advertised_ref = lines[0].split("\t", 1)
    if advertised_ref != ref or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise ValueError("Invalid preparation branch identity")
    run(root, "git", "fetch", "origin", ref, capture=False)
    if run(root, "git", "rev-parse", "FETCH_HEAD") != sha:
        raise ValueError("Preparation branch changed during fetch; retry")
    return sha


def own_pull_requests(rows: object, topic: str, base: str) -> list[dict[str, object]]:
    """A head-name query also returns fork PRs; retain only our exact branch."""
    version_plan.require(isinstance(rows, list), "Invalid preparation PR inventory")
    result: list[dict[str, object]] = []
    for row in cast(list[object], rows):
        if not isinstance(row, dict) or type(row.get("isCrossRepository")) is not bool:  # pylint: disable=unidiomatic-typecheck
            raise ValueError("Preparation PR lacks repository identity")
        if row["isCrossRepository"]:
            continue
        if row.get("headRefName") != topic or row.get("baseRefName") != base:
            raise ValueError("Preparation PR branch identity differs from request")
        result.append(cast(dict[str, object], row))
    if len(result) > 1:
        raise ValueError("Multiple preparation PRs exist for one version")
    return result


def verify_owned_topic(root: Path, topic_sha: str, main_sha: str, target: str) -> None:  # pylint: disable=too-many-locals
    """Reject any existing branch content beyond its declared version inputs."""
    ancestor = run(root, "git", "merge-base", topic_sha, main_sha)
    old_policy = json.loads(
        run(root, "git", "show", f"{ancestor}:.release-policy.json")
    )
    editable = source_policy(old_policy)
    version_plan.validate_policy(editable)
    changed = set(
        run(root, "git", "diff", "--name-only", ancestor, topic_sha).splitlines()
    )
    names = {
        cast(str, item["path"])
        for item in cast(
            list[dict[str, object]],
            cast(dict[str, object], editable["versioning"])["files"],
        )
    }
    if not changed <= names:
        raise ValueError("Existing preparation branch contains unowned changes")
    plan = version_plan.create_plan(target, "stable", None, ancestor, editable)
    with tempfile.TemporaryDirectory(prefix="verify-preparation-tree-") as temp:
        expected = Path(temp)
        for name in names:
            old_entry = run(root, "git", "ls-tree", ancestor, "--", name).split()
            new_entry = run(root, "git", "ls-tree", topic_sha, "--", name).split()
            if not old_entry or not new_entry:
                raise ValueError(
                    "Existing preparation branch removed a declared version file"
                )
            mode, current_mode = old_entry[0], new_entry[0]
            if mode not in {"100644", "100755"} or current_mode != mode:
                raise ValueError(
                    "Existing preparation branch changed a version file type or mode"
                )
            path = expected / name
            path.parent.mkdir(parents=True, exist_ok=True)
            # Developer/CI toolchain selected by the invoking operator via PATH.
            raw = subprocess.check_output(  # nosec B603, B607
                ["git", "show", f"{ancestor}:{name}"], cwd=root
            )
            path.write_bytes(raw)
        version_plan.sync_versions(expected, editable, plan)
        for name in names:
            # Developer/CI toolchain selected by the invoking operator via PATH.
            actual = subprocess.check_output(  # nosec B603, B607
                ["git", "show", f"{topic_sha}:{name}"], cwd=root
            )
            if actual != (expected / name).read_bytes():
                raise ValueError(
                    "Existing preparation branch has edits outside the owned version fields: "
                    f"{name}"
                )


def prepare(
    root: Path,
    requested: str = "",
    bump: str = "next-patch",
    pull_request: bool = False,
    dry_run: bool = False,
) -> dict[str, object]:  # pylint: disable=too-many-locals,too-many-branches,too-many-statements
    """Update declared files locally or create one reviewable preparation branch."""
    root = root.resolve()
    policy = json.loads((root / ".release-policy.json").read_text())
    version_plan.validate_policy(policy)
    repo, branch, head = _validate_preparation_checkout(root, policy)
    tags, occupied = advertised_tags(root)
    current = version_plan.read_base_version(root, policy)
    target = choose_version(current, tags, requested, bump, occupied=occupied)
    editable = source_policy(policy)
    plan = version_plan.create_plan(target, "stable", None, head, editable)
    if dry_run:
        return {
            "version": target,
            "source_sha": head,
            "files": sorted(
                {
                    cast(str, item["path"])
                    for item in cast(
                        list[dict[str, object]],
                        cast(dict[str, object], editable["versioning"])["files"],
                    )
                }
            ),
            "dry_run": True,
        }
    if not pull_request:
        changed_files = version_plan.sync_versions(root, editable, plan)
        version_plan.check_base_versions(root, editable, target)
        return {"version": target, "files": changed_files}
    topic, existing, topic_sha = _preparation_topic(root, repo, branch, head, target)
    with tempfile.TemporaryDirectory(prefix="prepare-release-version-") as temp:
        checkout = Path(temp) / "checkout"
        run(
            root,
            "git",
            "worktree",
            "add",
            "--detach",
            str(checkout),
            head,
            capture=False,
        )
        try:
            version_plan.sync_versions(checkout, editable, plan)
            version_plan.check_base_versions(checkout, editable, target)
            names = {
                cast(str, item["path"])
                for item in cast(
                    list[dict[str, object]],
                    cast(dict[str, object], editable["versioning"])["files"],
                )
            }
            if not existing and not run(checkout, "git", "diff", "--name-only"):
                return {"version": target, "unchanged": True}
            run(checkout, "git", "diff", "--check")
            changed = set(run(checkout, "git", "diff", "--name-only").splitlines())
            if not changed <= names:
                raise ValueError("Preparation changed an unowned file")
            if changed:
                run(checkout, "git", "add", "--", *sorted(changed), capture=False)
            tree = run(checkout, "git", "write-tree")
            topic_tree = (
                run(root, "git", "rev-parse", f"{topic_sha}^{{tree}}")
                if topic_sha
                else None
            )
            updated = tree != topic_tree
            if updated:
                # Verified old topic contains only generated version changes. Its
                # merge commit now uses the current main tree plus the same typed
                # projection, avoiding textual conflicts in shared manifests.
                parents = (
                    ["-p", topic_sha, "-p", head]
                    if topic_sha and topic_sha != head
                    else ["-p", head]
                )
                commit = run(
                    checkout,
                    "git",
                    "commit-tree",
                    tree,
                    *parents,
                    "-m",
                    f"chore: prepare release {target}",
                )
                run(
                    checkout,
                    "git",
                    "push",
                    "origin",
                    f"{commit}:refs/heads/{topic}",
                    capture=False,
                )
            if existing:
                return {
                    "version": target,
                    "pull_request": existing[0]["url"],
                    "existing": True,
                    "updated": updated,
                }
            body = Path(temp) / "pr-body.md"
            body.write_text(
                f"Prepare the {target} release cycle by synchronizing every declared "
                "base-version field and owned lockfile entry. Candidate suffixes "
                "and native build counters are assigned "
                "by the saved release plan before compilation.\n\n"
                "Validation: shared version synchronizer, committed version consistency "
                "check, and git diff --check. "
                "Project CI must pass before merging.\n"
            )
            url = run(
                checkout,
                "gh",
                "pr",
                "create",
                "--repo",
                repo,
                "--base",
                branch,
                "--head",
                topic,
                "--title",
                f"chore: prepare release {target}",
                "--body-file",
                str(body),
            )
            return {
                "version": target,
                "pull_request": url,
                "resumed": topic_sha is not None,
            }
        finally:
            run(
                root,
                "git",
                "worktree",
                "remove",
                "--force",
                str(checkout),
                capture=False,
            )


def main(argv: list[str] | None = None) -> None:
    """Parse the explicit local update or preparation-PR request."""
    # Each vendored CLI keeps its standalone argument parser.
    # pylint: disable=duplicate-code
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group()
    choice.add_argument("--version", default="")
    choice.add_argument(
        "--bump",
        choices=["next-patch", "patch", "minor", "major"],
        default="next-patch",
    )
    # pylint: enable=duplicate-code
    parser.add_argument("--pr", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    options = parser.parse_args(argv)
    print(
        json.dumps(
            prepare(
                Path.cwd(), options.version, options.bump, options.pr, options.dry_run
            ),
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
