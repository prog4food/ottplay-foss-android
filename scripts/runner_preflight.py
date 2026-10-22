#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Reject a final build on the wrong runner before installing/building packages.

This additive guard is not release acceptance or a replacement for the exact
post-build toolchain comparison. It never retries, dispatches, or writes GitHub.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import stat
# Subprocesses use explicit argv and never a shell.
import subprocess  # nosec B404
import sys
import threading
import time
from pathlib import Path
from urllib.parse import quote, unquote

if __package__:
    from . import release_control as rc
    from . import release_state as state
    from . import version_plan
else:
    import release_control as rc
    import release_state as state
    import version_plan

MAX_METADATA = 2_000_000
MAX_BINARY = 4_000_000
MAX_API_BYTES = 8_000_000
MAX_HTTP_HEADER_BYTES = 65_536
MAX_ERROR_BYTES = 8_192
DOWNLOAD_TIMEOUT = 45
RUNNER_FIELDS = ("platform", "ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH")
PLAN_NAME = ".release-plan.json"


class PreflightGitHub(state.StateGitHub):
    """Bound every GET response, including JSON, ledger and paginated metadata."""

    def __init__(self, repository):
        """Read-only preflight never performs a publication permission probe."""
        rc.require(
            bool(rc.REPO_RE.fullmatch(repository)), "Repository must be OWNER/REPO"
        )
        self.repo = repository
        self.base = f"repos/{repository}"

    def request(self, path, method="GET", body=None, mode="json"):
        """Preserve canonical read routes and 404 semantics; prohibit all writes."""
        rc.require(method == "GET" and body is None, "Preflight is read-only")
        command = self.read_command(path, mode)
        binary = mode == "asset" or path.endswith("/zip")
        limit = MAX_BINARY if binary else MAX_API_BYTES
        with subprocess.Popen(  # nosec B603 - read_command validates fixed-host GET routes
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        ) as process:
            return read_process(process, limit, paginated=mode == "pages")

    def read_command(self, path, mode):
        """Construct one fixed-host GET after validating the route and mode."""
        rc.require(
            any(
                re.fullmatch(pattern, path, re.ASCII) for pattern in rc.API_PATHS["GET"]
            )
            and all(part not in {".", ".."} for part in unquote(path).split("/")),
            "Unsupported preflight endpoint",
        )
        rc.require(mode in {"json", "pages", "asset"}, "Unsupported preflight mode")
        command = [
            "gh",
            "api",
            "--hostname",
            "github.com",
            "--method",
            "GET",
            "--include",
        ]
        endpoint = f"{self.base}/{path}".rstrip("/")
        if mode == "asset":
            command += ["-H", "Accept: application/octet-stream"]
        elif mode == "pages":
            command += ["--paginate", "--jq", "tojson"]
            endpoint += ("&" if "?" in endpoint else "?") + "per_page=100"
        command += ["--", endpoint]
        return command

    def binary(self, path):
        """Allow only bounded release metadata and immutable evidence downloads."""
        if re.fullmatch(r"actions/artifacts/[1-9]\d*/zip", path, re.ASCII):
            return self.request(path)
        rc.require(
            re.fullmatch(r"releases/assets/[1-9]\d*", path, re.ASCII),
            "Unsupported preflight binary endpoint",
        )
        return self.request(path, mode="asset")


def read_process(process, limit, paginated=False):
    """Drain bounded stdout/stderr under one deadline, then check exit status."""
    # Keep the existing payload limit while allowing bounded protocol overhead.
    wire_limit = limit + MAX_HTTP_HEADER_BYTES
    output, errors = [], []
    readers = [
        threading.Thread(
            target=lambda: output.append(process.stdout.read(wire_limit + 1)),
            daemon=True,
        ),
        threading.Thread(
            target=lambda: errors.append(process.stderr.read(MAX_ERROR_BYTES + 1)),
            daemon=True,
        ),
    ]
    deadline = time.monotonic() + DOWNLOAD_TIMEOUT
    for reader in readers:
        reader.start()
    for reader in readers:
        reader.join(max(0, deadline - time.monotonic()))
    stalled = any(reader.is_alive() for reader in readers)
    oversized = bool(output and len(output[0]) > wire_limit) or bool(
        errors and len(errors[0]) > MAX_ERROR_BYTES
    )
    if stalled or oversized:
        process.kill()
        process.wait()
        for reader in readers:
            reader.join()
        reason = "exceeds limit" if oversized else "timed out"
        raise rc.ReleaseError(f"Preflight metadata download {reason}")
    status = wait_process(process, deadline)
    try:
        http_status, payload = rc.github_http_response(output[0], paginated=paginated)
    except rc.GitHubError:
        raise rc.GitHubError("Preflight metadata download failed") from None
    if (status == 0) != (200 <= http_status < 300):
        raise rc.GitHubError("Preflight HTTP status and CLI result disagree")
    if status:
        raise rc.GitHubError("Preflight metadata download failed", http_status == 404)
    rc.require(len(payload) <= limit, "Preflight metadata download exceeds limit")
    return payload


def wait_process(process, deadline):
    """Do not let a closed-pipe process outlive the same download deadline."""
    try:
        return process.wait(timeout=max(0.01, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        raise rc.ReleaseError("Preflight metadata download did not finish") from None


def read_metadata(root, relative):
    """Read a fixed name below a trusted root; reject links beneath that root."""
    root = root.resolve(strict=True)
    rc.require(
        not relative.is_absolute() and ".." not in relative.parts,
        "Metadata path must stay below its trusted root",
    )
    path = root
    for part in relative.parts:
        path /= part
        rc.require(not path.is_symlink(), "Metadata path contains a link")
    rc.require(path.resolve(strict=True) == path, "Metadata path contains a link")
    rc.require(stat.S_ISREG(path.lstat().st_mode), "Metadata must be a plain file")
    with path.open("rb") as stream:
        raw = stream.read(MAX_METADATA + 1)
    rc.require(len(raw) <= MAX_METADATA, "Preflight metadata exceeds limit")
    return rc.parse_json(raw, "preflight metadata")


def read_event():
    """Bind the Actions event to the runner's separate trusted temporary root."""
    root = Path(os.environ["RUNNER_TEMP"])
    event = Path(os.environ["GITHUB_EVENT_PATH"])
    relative = Path("_github_workflow") / "event.json"
    rc.require(root.is_absolute(), "Runner temporary root must be absolute")
    rc.require(
        event in {root / relative, root.resolve(strict=True) / relative},
        "Workflow event path differs from runner-owned location",
    )
    return read_metadata(root, relative)


def runner_identity():
    """Capture only actual runner identity; provisioning versions are not checked."""
    return {
        "platform": sys.platform,
        **{key: os.environ.get(key) for key in RUNNER_FIELDS[1:]},
    }


def require_identity(identity):
    """Missing identities fail closed, including runners without an image contract."""
    rc.require(
        isinstance(identity, dict)
        and all(
            isinstance(identity.get(key), str)
            and re.fullmatch(r"[A-Za-z0-9_.+-]{1,100}", identity[key], re.ASCII)
            for key in RUNNER_FIELDS
        ),
        "Runner identity is missing or invalid",
    )


def verify_context(gh, plan, policy):
    """Read the current run once; a stale/queued response cannot authorize work."""
    # Validate bounds and links before the canonical execution check rereads it.
    event = read_event()
    info = rc.repository_info(gh)
    run_id = rc.positive(os.environ.get("GITHUB_RUN_ID"), "run ID")
    attempt = rc.positive(os.environ.get("GITHUB_RUN_ATTEMPT"), "run attempt")
    run = gh.api(f"actions/runs/{run_id}")
    rc.require(run.get("id") == run_id, "Preflight run ID mismatch")
    rc.require(run.get("conclusion") is None, "Executing run already has a conclusion")
    rc.check_execution(gh, run_id, "stable", info, run)
    rc.validate_run(
        gh, run, info, plan["source_sha"], attempt, completed=False, gate=False
    )
    snapshot = rc.source_policy_snapshot(gh, plan["source_sha"])
    rc.require(snapshot["data"] == policy, "Working policy differs from source commit")
    head = gh.api(f"git/ref/heads/{quote(info['default_branch'], safe='')}")
    rc.require(
        head.get("ref") == f"refs/heads/{info['default_branch']}"
        and head.get("object", {}).get("type") == "commit"
        and head["object"].get("sha") == plan["source_sha"],
        "Default branch changed before runner preflight",
    )
    ledger, _ = state.read_state(gh)
    record = ledger["plans"].get(str(run_id))
    rc.require(
        isinstance(record, dict) and record.get("plan") == plan,
        "Preflight reservation mismatch",
    )
    parent = record.get("parent")
    rc.require(
        isinstance(parent, dict)
        and set(parent) == {"tag", "manifest_sha256", "source_sha", "run_id"}
        and isinstance(parent["tag"], str)
        and re.fullmatch(
            r"v" + rc.VERSION_PATTERN + r"-rc\.[1-9]\d*", parent["tag"], re.ASCII
        )
        and parent["source_sha"] == plan["source_sha"]
        and isinstance(parent["manifest_sha256"], str)
        and re.fullmatch(r"[0-9a-f]{64}", parent["manifest_sha256"])
        and rc.positive(parent["run_id"], "parent RC run ID") != run_id,
        "Invalid accepted RC reservation parent",
    )
    rc.require(
        event.get("inputs", {}).get("rc_tag") == parent["tag"],
        "Dispatch RC differs from reservation",
    )
    state.verify_reservation(gh, plan, run_id, parent)
    return info, run, snapshot, parent


def fetch_receipt(gh, plan, target, info, policy_snapshot, parent):
    """Verify selected RC receipt through the already reserved immutable parent."""
    initial = rc.release_snapshot(gh, parent["tag"])
    ref, _, assets = initial
    inventory = {item["name"]: item for item in assets}
    rc.require(
        rc.MANIFEST in inventory and target in inventory,
        "RC manifest or target receipt missing",
    )
    manifest_asset = inventory[rc.MANIFEST]
    rc.require(
        type(manifest_asset.get("size")) is int
        and 0 < manifest_asset["size"] <= MAX_METADATA,
        "Invalid RC manifest size",
    )
    raw = gh.binary(
        f"releases/assets/{rc.positive(manifest_asset['id'], 'manifest asset ID')}"
    )
    rc.require(
        len(raw) == manifest_asset["size"]
        and rc.digest(raw) == parent["manifest_sha256"],
        "Reserved RC manifest checksum mismatch",
    )
    manifest = rc.validate_manifest(raw, gh.repo, parent["tag"])
    rc.require(
        manifest["source_sha"] == plan["source_sha"] == ref["object"].get("sha")
        and manifest["run_id"] == parent["run_id"]
        and manifest["version"] == plan["base_version"]
        and manifest["source_policy"] == policy_snapshot
        and manifest["version_plan"]["promotion"] == "final-build",
        "RC source, base, policy, or reservation binding differs",
    )
    source_run = gh.api(f"actions/runs/{parent['run_id']}")
    rc.require(
        source_run.get("id") == parent["run_id"]
        and source_run.get("event") == "workflow_dispatch",
        "RC source run mismatch",
    )
    rc.validate_run(
        gh,
        source_run,
        info,
        plan["source_sha"],
        manifest["run_attempt"],
        completed=True,
    )
    rc.verify_evidence(gh, manifest, raw)
    expected = {item["name"]: item for item in manifest["assets"]}
    rc.require(
        set(inventory) == set(expected) | {rc.MANIFEST}, "RC asset inventory changed"
    )
    declarations = manifest.get("build_receipts")
    rc.require(
        isinstance(declarations, list) and declarations, "RC receipt inventory missing"
    )
    rc.require(
        all(
            isinstance(item, dict) and set(item) == {"name", "sha256"}
            for item in declarations
        ),
        "Invalid RC receipt inventory",
    )
    names = [item["name"] for item in declarations]
    rc.require(
        all(
            isinstance(name, str)
            and re.fullmatch(r"release-inputs-[A-Za-z0-9._-]+\.json", name)
            for name in names
        ),
        "Invalid RC receipt target",
    )
    rc.require(
        len(names) == len(set(names)) and target in names,
        "RC receipt inventory duplicate or target missing",
    )
    wanted = next(item for item in declarations if item["name"] == target)
    declared = expected.get(target)
    rc.require(
        isinstance(declared, dict) and wanted["sha256"] == declared["sha256"],
        "RC receipt checksum declarations disagree",
    )
    asset = inventory[target]
    rc.require(
        type(asset.get("size")) is int
        and 0 < asset["size"] <= MAX_METADATA
        and asset["size"] == declared["size"],
        "Invalid RC receipt size",
    )
    content = gh.binary(
        f"releases/assets/{rc.positive(asset['id'], 'receipt asset ID')}"
    )
    rc.require(
        len(content) == declared["size"] and rc.digest(content) == wanted["sha256"],
        "RC receipt checksum mismatch",
    )
    receipt = rc.parse_json(content, "RC runner receipt")
    rc.require(
        isinstance(receipt, dict)
        and receipt.get("source_sha") == plan["source_sha"]
        and receipt.get("plan_sha256") == manifest["plan_sha256"],
        "RC receipt source/plan binding differs",
    )
    require_identity(receipt.get("toolchain"))
    rc.require(
        rc.snapshot_identity(rc.release_snapshot(gh, parent["tag"]))
        == rc.snapshot_identity(initial),
        "RC changed during preflight",
    )
    return receipt, wanted["sha256"]


def check(gh, plan, policy, channel, target, actual):
    """Return a precise early decision; never claim full toolchain equivalence."""
    version_plan.validate_plan(plan, policy, rc.checked_out_sha())
    rc.require(channel == plan["channel"], "Preflight channel differs from plan")
    rc.require(
        re.fullmatch(r"release-inputs-[A-Za-z0-9._-]+\.json", target),
        "Invalid preflight target",
    )
    result = {
        "schema": 1,
        "phase": "runner-identity",
        "target": target,
        "plan_sha256": version_plan.plan_digest(plan),
    }
    if channel != "stable":
        return {
            **result,
            "status": "not-applicable",
            "reason": "Candidate has no accepted RC runner expectation",
        }
    rc.require(
        plan["promotion"] == "final-build", "Runner preflight requires final-build"
    )
    require_identity(actual)
    info, run, snapshot, parent = verify_context(gh, plan, policy)
    receipt, receipt_sha = fetch_receipt(gh, plan, target, info, snapshot, parent)
    differences = [
        {"field": key, "expected": receipt["toolchain"][key], "actual": actual[key]}
        for key in RUNNER_FIELDS
        if receipt["toolchain"][key] != actual[key]
    ]
    return {
        **result,
        "status": "blocked" if differences else "runner-identity-match",
        "source_sha": plan["source_sha"],
        "run_id": run["id"],
        "run_attempt": run["run_attempt"],
        "accepted_rc": parent,
        "receipt_sha256": receipt_sha,
        "differences": differences,
        "full_toolchain_verified": False,
        "next_action": "Resolve runner environment; no automatic retry"
        if differences
        else "Continue provisioning; final exact toolchain acceptance remains required",
    }


def main(argv=None):
    """Emit one structured result and fail closed on mismatch or invalid evidence."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--plan", choices=(PLAN_NAME,), required=True)
    parser.add_argument(
        "--channel", required=True, choices=("nightly", "beta", "rc", "stable")
    )
    parser.add_argument("--receipt", required=True)
    args = parser.parse_args(argv)
    try:
        result = check(
            PreflightGitHub(args.repo),
            read_metadata(Path.cwd(), Path(PLAN_NAME)),
            read_metadata(Path.cwd(), Path(rc.POLICY)),
            args.channel,
            args.receipt,
            runner_identity(),
        )
    except (
        rc.ReleaseError,
        OSError,
        ValueError,
        KeyError,
        TypeError,
    ):
        # Untrusted metadata/transport errors can contain tokens or log syntax.
        result = {
            "schema": 1,
            "phase": "runner-identity",
            "status": "invalid-evidence",
            "reason": "Runner preflight could not verify its bound inputs; no build authorized",
        }
    print(json.dumps(result, sort_keys=True))
    return 1 if result["status"] in {"blocked", "invalid-evidence"} else 0


if __name__ == "__main__":
    sys.exit(main())
