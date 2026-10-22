#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Skip heavy CI only for a complete Git diff of ordinary documentation files.

The event payload supplies immutable revisions, never a (possibly truncated)
changed-files list. Unknown inputs and failures request the full pipeline. This
module neither fetches history nor changes the repository or contacts GitHub.
"""

import argparse
import json
import os
import re
# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
import sys
from pathlib import Path, PurePosixPath

REVISION = re.compile(r"[0-9a-f]{40}\Z")
DOCUMENT_NAMES = {
    "readme",
    "changelog",
    "contributing",
    "security",
    "releasing",
    "code_of_conduct",
}
# Even an explicit documentation exception cannot hide code, fixtures, CI,
# dependencies or build inputs behind a Markdown extension.
PROTECTED_PARTS = {
    "src",
    "source",
    "sources",
    "test",
    "tests",
    "testdata",
    "fixtures",
    "__tests__",
    "snapshots",
    "resources",
    "assets",
    "templates",
    "scripts",
    "script",
    "tools",
    "ci",
    "workflows",
    "actions",
    "hooks",
    "bin",
    "lib",
    "app",
    "apps",
    "build",
    "dist",
    "target",
    "config",
    "configs",
    "configuration",
    "dependencies",
    "deps",
    "packages",
    "package",
    "packaging",
    "node_modules",
    "gradle",
    "cmake",
    "docker",
    "deploy",
    "deployment",
    "migrations",
    "charts",
    "helm",
    "k8s",
    "vendor-bin",
}
MAX_DIFF_BYTES = 8 * 1024 * 1024


def decision(run, reason):
    """Return the stable function/CLI output contract without exposing file data."""
    return {"run": run, "reason": reason}


def literal_path(path):
    """Validate an exact path, never a glob or an escaping path expression."""
    if not isinstance(path, str) or not path or "\\" in path or "\0" in path:
        return False
    parsed = PurePosixPath(path)
    return (
        not parsed.is_absolute()
        and str(parsed) == path
        and bool(parsed.parts)
        and ".." not in parsed.parts
        and not any(character in path for character in "*?[")
    )


def document_name(path):
    """Validate a literal repository-relative Markdown/reStructuredText path."""
    return literal_path(path) and PurePosixPath(path).suffix.lower() in (".md", ".rst")


def documentation_path(path, explicit):
    """Keep protected locations non-exempt even when policy lists them explicitly."""
    if not document_name(path):
        return False
    parsed = PurePosixPath(path)
    parts = tuple(part.lower() for part in parsed.parts)
    if any(part.startswith(".") or part in PROTECTED_PARTS for part in parts[:-1]):
        return False
    if parts[-1].startswith("."):
        return False
    return (
        path in explicit
        or (len(parts) == 1 and parsed.stem.lower() in DOCUMENT_NAMES)
        or (len(parts) > 1 and parts[0] == "docs")
    )


def event_revisions(event_name, event):
    """Select cumulative PR, merge-queue or complete pushed-range revisions."""
    if not isinstance(event, dict):
        raise TypeError("Invalid event object")
    if event_name == "pull_request":
        pull = event["pull_request"]
        base, head = pull["base"]["sha"], pull["head"]["sha"]
        separator = "..."
    elif event_name == "merge_group":
        group = event["merge_group"]
        base, head = group["base_sha"], group["head_sha"]
        separator = ".."
    else:
        base, head = event["before"], event["after"]
        separator = ".."
    for revision in (base, head):
        if (
            not isinstance(revision, str)
            or not REVISION.fullmatch(revision)
            or revision == "0" * 40
        ):
            raise ValueError("Expected nonzero full commit SHA")
    return base, head, separator


def git(repo, operation, revision=""):
    """Execute only the three read operations, validating arguments at the sink."""
    directory = Path(repo).resolve(strict=True)
    if not directory.is_dir():
        raise ValueError("Expected a repository directory")
    if operation == "shallow" and not revision:
        arguments = ["git", "rev-parse", "--is-shallow-repository"]
    elif operation == "commit-type":
        if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
            raise ValueError("Expected one exact object ID")
        arguments = ["git", "cat-file", "-t", "--", revision]
    elif operation == "diff":
        if not isinstance(revision, str) or not re.fullmatch(
            r"[0-9a-f]{40}\.{2,3}[0-9a-f]{40}", revision
        ):
            raise ValueError("Expected an exact two-commit range")
        arguments = [
            "git",
            "diff",
            "--raw",
            "--no-abbrev",
            "-z",
            "--no-renames",
            "--no-ext-diff",
            "--no-textconv",
            "--no-relative",
            "--ignore-submodules=none",
            "--end-of-options",
            revision,
            "--",
        ]
    else:
        raise ValueError("Unsupported Git read operation")
    environment = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_NO_REPLACE_OBJECTS="1")
    # Repository-controlled argv; no shell interpolation or external command text.
    return subprocess.run(  # nosec B603
        arguments,
        cwd=directory,
        check=True,
        capture_output=True,
        timeout=30,
        env=environment,
    ).stdout


def classify_record(header, raw_path, explicit, required):
    """Validate one complete raw record before classifying its ordinary path."""
    fields = header.split()
    if len(fields) != 5 or not fields[0].startswith(b":"):
        return decision(True, "invalid-diff")
    before, after, old_hash, new_hash, status = fields
    if not all(
        REVISION.fullmatch(value.decode("ascii")) for value in (old_hash, new_hash)
    ):
        return decision(True, "invalid-diff")
    expected_modes = {
        b"A": (b"000000", b"100644"),
        b"D": (b"100644", b"000000"),
        b"M": (b"100644", b"100644"),
    }
    if expected_modes.get(status) != (before[1:], after):
        return decision(True, "non-regular-or-mode-change")
    path = raw_path.decode("utf-8")
    if path in required:
        return decision(True, "required-path-change")
    if not documentation_path(path, explicit):
        return decision(True, "non-documentation-change")
    return None


def classify_diff(raw, explicit, required):
    """Read NUL-delimited raw records, checking modes and both sides of renames."""
    if not raw:
        return decision(True, "empty-diff")
    if len(raw) > MAX_DIFF_BYTES or not raw.endswith(b"\0"):
        return decision(True, "invalid-diff")
    records = raw[:-1].split(b"\0")
    if len(records) % 2:
        return decision(True, "invalid-diff")
    for position in range(0, len(records), 2):
        result = classify_record(
            records[position], records[position + 1], explicit, required
        )
        if result is not None:
            return result
    return decision(False, "documentation-only")


# The function mirrors the workflow's event and two explicit policy lists.
# pylint: disable-next=too-many-arguments,too-many-return-statements
def classify(
    repo, event_name, event, documentation_paths=(), *, required_paths=(), force=False
):
    """Return {run: bool, reason: str}; uncertainty always requests full CI."""
    if force:
        return decision(True, "forced")
    if event_name not in ("pull_request", "merge_group", "push"):
        return decision(True, "unsupported-event")
    if not isinstance(documentation_paths, (list, tuple)) or not all(
        document_name(path) for path in documentation_paths
    ):
        return decision(True, "invalid-documentation-paths")
    if not isinstance(required_paths, (list, tuple)) or not all(
        literal_path(path) for path in required_paths
    ):
        return decision(True, "invalid-required-paths")
    try:
        base, head, separator = event_revisions(event_name, event)
    except (KeyError, TypeError, ValueError):
        return decision(True, "invalid-revisions")
    try:
        if git(repo, "shallow").strip() != b"false":
            return decision(True, "incomplete-history")
        for revision in (base, head):
            if git(repo, "commit-type", revision).strip() != b"commit":
                return decision(True, "invalid-revisions")
        raw = git(repo, "diff", f"{base}{separator}{head}")
        return classify_diff(
            raw, frozenset(documentation_paths), frozenset(required_paths)
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        return decision(True, "git-error")


def json_paths(value, repeated):
    """Combine exact CLI paths with a strict JSON array supplied by a workflow."""
    paths = json.loads(value)
    if not isinstance(paths, list):
        raise TypeError("Expected an array of exact paths")
    return repeated + paths


def from_arguments(args):
    """Interpret workflow arguments without making malformed inputs a skip."""
    if args.force or args.event_name not in ("pull_request", "merge_group", "push"):
        return classify(args.repo, args.event_name, None, force=args.force)
    try:
        documentation_paths = json_paths(
            args.documentation_paths_json, args.documentation_path
        )
    except (TypeError, ValueError):
        return decision(True, "invalid-documentation-paths")
    try:
        required_paths = json_paths(args.required_paths_json, args.require_path)
    except (TypeError, ValueError):
        return decision(True, "invalid-required-paths")
    try:
        # The runner selects its event file; CLI values cannot choose a file to read.
        event = json.loads(
            Path(os.environ.get("GITHUB_EVENT_PATH", "")).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return decision(True, "invalid-event-file")
    return classify(
        args.repo,
        args.event_name,
        event,
        documentation_paths,
        required_paths=required_paths,
    )


def main(argv=None):
    """Print JSON and append the two stable, single-line GitHub job outputs."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--event-name", default=os.environ.get("GITHUB_EVENT_NAME", ""))
    parser.add_argument("--documentation-path", action="append", default=[])
    parser.add_argument("--documentation-paths-json", default="[]")
    parser.add_argument("--require-path", action="append", default=[])
    parser.add_argument("--required-paths-json", default="[]")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    result = from_arguments(args)
    print(json.dumps(result, sort_keys=True))
    # GITHUB_OUTPUT is a runner-created append channel, never a CLI destination.
    output_path = os.environ.get("GITHUB_OUTPUT", "")
    if output_path:
        try:
            with open(output_path, "a", encoding="utf-8") as output:
                output.write(
                    f"run={str(result['run']).lower()}\nreason={result['reason']}\n"
                )
        except OSError:
            print("change-scope: cannot write GitHub outputs", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
