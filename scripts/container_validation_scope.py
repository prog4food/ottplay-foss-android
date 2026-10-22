#!/usr/bin/env python3
"""Select container validation without making unrelated PRs build both architectures."""
import fnmatch
import json
import os
import re
import subprocess
from pathlib import Path

PATTERNS = (
    "Dockerfile", ".dockerignore", "Cargo.toml", "Cargo.lock", "src-rs/Cargo.toml", "src-rs/**/Cargo.toml",
    ".github/workflows/container-validation.yml", ".github/workflows/release-build.yml",
    "scripts/prepare-container-workspace.py", "scripts/assemble-container-oci.py",
    "scripts/benchmark-container-build.py", "scripts/container_validation_scope.py",
    "scripts/check-epg-performance.py", "scripts/check-container-epg.py",
    "src-rs/core/src/xmltv.rs", "src-rs/core/src/xmltv/**", "src-rs/core/src/xmltv_differential_tests.rs",
    "src-rs/core/src/shared_guide.rs", "src-rs/core/src/m3u.rs",
    "src-rs/core/src/lib.rs", "src-rs/core/src/native_xmltv.rs", "src-rs/server/src/main.rs", "vendor/ottplay-core.*",
    "tests/test_container_workspace.py", ".github/release-tests/test_container_*.py",
)


def relevant(paths):
    return any(fnmatch.fnmatchcase(path, pattern) for path in paths for pattern in PATTERNS)


def run_required(kind, event, changed_paths):
    if kind == "workflow_dispatch":
        return True
    if kind not in {"pull_request", "merge_group"}:
        return False
    refs = event["pull_request"] if kind == "pull_request" else event["merge_group"]
    base = refs["base"]["sha"] if kind == "pull_request" else refs["base_sha"]
    head = refs["head"]["sha"] if kind == "pull_request" else refs["head_sha"]
    if not all(re.fullmatch(r"[0-9a-f]{40}", value) for value in (base, head)):
        raise ValueError("Container validation needs immutable base and head commits")
    return relevant(changed_paths(base, head))


def git_changes(base, head, directory=None):
    return subprocess.check_output(["git", "diff", "--no-renames", "--name-only", "-z", base, head, "--"], text=True, cwd=directory).split("\0")


if __name__ == "__main__":
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    print("run=" + str(run_required(os.environ["GITHUB_EVENT_NAME"], event, git_changes)).lower())
