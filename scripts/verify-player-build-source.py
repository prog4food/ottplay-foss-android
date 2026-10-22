#!/usr/bin/env python3
"""Recognize only the exact, fully applied release version overlay on HEAD."""

import argparse
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True
os.environ["GIT_OPTIONAL_LOCKS"] = "0"


def verify(root):
    """Return the source commit without modifying the checkout or trusting receipts."""
    root = Path(root).resolve(strict=True)

    def git(*args):
        config = ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"]
        if os.name != "nt":
            config += ["-c", "core.filemode=true"]
        return subprocess.check_output(
            ["git", "--no-optional-locks", *config, "-C", str(root), *args],
            stderr=subprocess.DEVNULL,
        )

    def plain_file(name):
        path = root / name
        if path.is_symlink() or not path.is_file() or path.resolve() != path:
            raise ValueError("Release input is not a plain checkout file")
        return path

    def status():
        return git("status", "--porcelain=v1", "-z", "--untracked-files=all")

    head = git("rev-parse", "HEAD").decode().strip()
    # Ignore/skip index bits can hide modified files from status and diff.
    if any(entry[:2] != b"H " for entry in git("ls-files", "-v", "-z").split(b"\0") if entry):
        raise ValueError("Index contains hidden worktree entries")
    git("diff", "--cached", "--quiet", "HEAD", "--")
    before = status()
    policy = json.loads(git("show", f"{head}:.release-policy.json"))
    allowed = {item["path"] for item in policy["versioning"]["files"]}
    for entry in before.split(b"\0"):
        if entry and (entry[:3] != b" M " or entry[3:].decode() not in allowed):
            raise ValueError("Checkout contains changes outside release version inputs")
    # In particular, chmod-only changes are not produced by version sync.
    raw = git("diff", "--raw", "-z", "--no-abbrev", "--no-renames", "HEAD", "--").split(b"\0")
    for index in range(0, len(raw) - 1, 2):
        fields = raw[index].split()
        if len(fields) != 5 or fields[0][1:] != fields[1] or fields[1] not in (b"100644", b"100755"):
            raise ValueError("Checkout contains a file type or mode change")

    # Load only unchanged, tracked toolkit code. The policy comes from HEAD;
    # an edited policy cannot broaden the set of accepted version paths.
    for name in (".release-policy.json", "scripts/version_plan.py", "scripts/release_control.py"):
        current = plain_file(name).read_bytes()
        original = git("cat-file", "--filters", f"--path={name}", f"{head}:{name}")
        if current != original:
            raise ValueError("Release policy or version tooling differs from HEAD")
    plan_path = plain_file(".release-plan.json")
    with plan_path.open("rb") as handle:
        plan_bytes = handle.read(2_000_001)
    if len(plan_bytes) > 2_000_000:
        raise ValueError("Release plan is too large")
    plan = json.loads(plan_bytes)
    sys.path.insert(0, str(root / "scripts"))
    version_plan = importlib.import_module("version_plan")
    version_plan.validate_plan(plan, policy, head)
    version_plan.verify_checkout(root, policy, plan)
    version_plan.sync_versions(root, policy, plan, check=True)
    if git("rev-parse", "HEAD").decode().strip() != head or status() != before or plan_path.read_bytes() != plan_bytes:
        raise ValueError("Checkout changed during source verification")
    version_plan.sync_versions(root, policy, plan, check=True)
    return head


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    options = parser.parse_args()
    try:
        print(verify(options.root))
        return 0
    except (ValueError, OSError, KeyError, TypeError, subprocess.CalledProcessError):
        print("Checkout is not an exact frozen release overlay", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
