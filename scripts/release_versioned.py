#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Prepare exact versions before building and publish only matching build receipts."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import cast
from urllib.parse import quote

if __package__:
    from . import release as client
    from . import release_control as rc
    from . import version_plan
    from .release_state import (
        StateGitHub,
        begin_publication,
        read_state,
        reserve_plan,
        verify_reservation,
    )
    from .version_receipt import verify_declared_artifacts, verify_receipts
else:
    import release as client
    import release_control as rc
    import version_plan
    from release_state import (
        StateGitHub,
        begin_publication,
        read_state,
        reserve_plan,
        verify_reservation,
    )
    from version_receipt import verify_declared_artifacts, verify_receipts

PLAN = Path(".release-plan.json")
MAX_TOOLCHAIN_DIAGNOSTICS = 100


def diagnostic_label(value: str) -> str:
    """Keep receipt names/field paths bounded and free of log control syntax."""
    if re.fullmatch(r"[A-Za-z0-9_./~-]{1,200}", value, re.ASCII):
        return value
    return "redacted-sha256-" + rc.digest(value.encode("utf-8", "surrogatepass"))


def _queue_toolchain_mapping(
    pending: list[tuple[str, object, object]],
    path: str,
    before: dict[str, object],
    after: dict[str, object],
    missing: object,
) -> None:
    """Push mapping fields in reverse order for stable depth-first diagnostics."""
    for key in sorted(before.keys() | after.keys(), reverse=True):
        pending.append(
            (
                diagnostic_label(
                    path + "/" + key.replace("~", "~0").replace("/", "~1")
                ),
                before.get(key, missing),
                after.get(key, missing),
            )
        )


def _queue_toolchain_list(
    pending: list[tuple[str, object, object]],
    path: str,
    before: list[object],
    after: list[object],
    missing: object,
) -> None:
    """Push list positions without exposing the compared toolchain values."""
    for index in reversed(range(max(len(before), len(after)))):
        pending.append(
            (
                diagnostic_label(f"{path}/{index}"),
                before[index] if index < len(before) else missing,
                after[index] if index < len(after) else missing,
            )
        )


def toolchain_changes(original: object, current: object) -> Iterator[tuple[str, str]]:
    """Describe unequal JSON fields deterministically without logging values."""
    missing = object()
    pending = [("toolchain", original, current)]
    while pending:
        path, before, after = pending.pop()
        if before is missing:
            yield path, "missing in accepted RC"
        elif after is missing:
            yield path, "missing in final build"
        elif before == after:
            continue
        elif type(before) is not type(after):
            yield (
                path,
                f"type changed ({type(before).__name__} -> {type(after).__name__})",
            )
        elif isinstance(before, dict):
            _queue_toolchain_mapping(
                pending, path, before, cast(dict[str, object], after), missing
            )
        elif isinstance(before, list):
            _queue_toolchain_list(
                pending, path, before, cast(list[object], after), missing
            )
        else:
            yield path, "value changed"


def context(
    gh: rc.GitHub, channel: str, gate: bool = False
) -> tuple[dict[str, object], dict[str, object], dict[str, object]]:
    """Reuse the original publisher's execution and source-policy checks."""
    run_id = rc.positive(os.environ.get("GITHUB_RUN_ID"), "run ID")
    attempt = rc.positive(os.environ.get("GITHUB_RUN_ATTEMPT"), "run attempt")
    info = rc.repository_info(gh)
    run = rc.wait_for_executing_run(
        gh, run_id, channel, info, rc.checked_out_sha(), attempt, gate=gate
    )
    snapshot = rc.source_policy_snapshot(gh, cast(str, run["head_sha"]))
    rc.require_release_policy(
        snapshot["data"], gh.repo, qualified=channel in {"rc", "stable"}
    )
    rc.require(
        cast(dict[str, object], snapshot["data"]).get("versioning"),
        "Repository has not enabled version plans",
    )
    local_policy = json.loads(Path(rc.POLICY).read_text(encoding="utf-8"))
    rc.require(
        local_policy == snapshot["data"], "Working policy differs from source commit"
    )
    rc.check_ancestry(gh, cast(str, run["head_sha"]), cast(str, info["default_branch"]))
    if gate:
        rc.validate_validation_run(gh, run, cast(dict[str, object], snapshot["data"]), channel)
    return info, run, snapshot


# Keep source, workflow and byte verification together at the trust boundary.
# pylint: disable-next=too-many-locals
def verified_rc(
    gh: rc.GitHub, tag: object, info: dict[str, object], current_run: dict[str, object]
) -> tuple[dict[str, object], dict[str, object]]:
    """Verify the exact accepted RC source, immutable evidence and payload bytes."""
    rc.require(
        isinstance(tag, str)
        and re.fullmatch("v" + rc.VERSION_PATTERN + r"-rc\.[1-9]\d*", tag, re.ASCII),
        "Stable requires an explicit vX.Y.Z-rc.N",
    )
    tag = cast(str, tag)
    initial = rc.release_snapshot(gh, tag)
    ref, _, assets = initial
    manifests = [asset for asset in assets if asset["name"] == rc.MANIFEST]
    rc.require(len(manifests) == 1, "RC manifest is missing")
    raw = gh.binary(
        f"releases/assets/{rc.positive(manifests[0]['id'], 'manifest asset ID')}"
    )
    manifest = rc.validate_manifest(raw, gh.repo, tag)
    source_policy = rc.source_policy_snapshot(gh, cast(str, manifest["source_sha"]))
    rc.require(source_policy == manifest["source_policy"], "RC source policy changed")
    rc.require_current_fuzzing(gh, cast(dict[str, object], source_policy["data"]), cast(str, current_run["head_sha"]))
    rc.require(
        cast(dict[str, object], ref["object"]).get("sha")
        == cast(str, manifest["source_sha"]),
        "RC source tag mismatch",
    )
    rc.require(
        manifest["run_id"] != current_run["id"], "RC must come from a separate run"
    )
    source_run = cast(dict[str, object], gh.api(f"actions/runs/{manifest['run_id']}"))
    rc.validate_validation_run(gh, source_run, cast(dict[str, object], source_policy["data"]), "rc")
    rc.require(
        source_run.get("id") == manifest["run_id"], "RC source run identity mismatch"
    )
    rc.validate_run(
        gh,
        run=source_run,
        info=info,
        sha=cast(str, manifest["source_sha"]),
        attempt=cast(int, manifest["run_attempt"]),
        completed=True,
    )
    rc.require(
        source_run.get("event") == "workflow_dispatch",
        "RC must be explicitly requested",
    )
    rc.check_ancestry(
        gh, cast(str, manifest["source_sha"]), cast(str, info["default_branch"])
    )
    rc.verify_evidence(gh, manifest, raw)
    expected = {
        entry["name"]: entry
        for entry in cast(list[dict[str, object]], manifest["assets"])
    }
    rc.require(
        {item["name"] for item in assets} == set(expected) | {rc.MANIFEST},
        "RC asset inventory differs from immutable evidence",
    )
    rc.require(manifests[0]["size"] == len(raw), "RC asset size mismatch")
    with tempfile.TemporaryDirectory(prefix="verified-rc-") as temp:
        payload = Path(temp) / "payload"
        for item in assets:
            if item["name"] == rc.MANIFEST:
                continue
            identity = rc.download_asset(gh, item["id"], payload)
            payload.unlink()
            rc.require(item["size"] == identity["size"], "RC asset size mismatch")
            declaration = expected[item["name"]]
            rc.require(
                identity["size"] == declaration["size"]
                and identity["sha256"] == declaration["sha256"],
                f"RC payload checksum mismatch: {item['name']}",
            )
    rc.require(
        rc.snapshot_identity(rc.release_snapshot(gh, tag))
        == rc.snapshot_identity(initial),
        "RC changed during verification",
    )
    return manifest, {
        "tag": tag,
        "manifest_sha256": rc.digest(raw),
        "source_sha": cast(str, manifest["source_sha"]),
        "run_id": manifest["run_id"],
    }


def event_inputs() -> dict[str, object]:
    """Read dispatch inputs from the runner-provided event payload."""
    event = rc.parse_json(
        Path(os.environ["GITHUB_EVENT_PATH"]).read_bytes(), "workflow event"
    )
    rc.require(isinstance(event, dict), "Workflow event must be a JSON object")
    inputs = cast(dict[str, object], event).get("inputs")
    if inputs is None:
        return {}
    rc.require(isinstance(inputs, dict), "Workflow inputs must be a JSON object")
    return cast(dict[str, object], inputs)


# Keep integrity checks and mismatch accumulation together at the trust boundary.
# pylint: disable-next=too-many-locals
def verify_final_toolchains(
    gh: rc.GitHub, candidate: dict[str, object], receipts: list[dict[str, object]]
) -> None:
    """Reject exact toolchain drift after checking every platform receipt's bytes."""
    _, _, assets = rc.release_snapshot(gh, cast(str, candidate["tag"]))
    inventory = {item["name"]: item for item in assets}
    expected = {
        cast(str, item["name"]): item
        for item in cast(list[dict[str, object]], candidate.get("build_receipts", []))
    }
    rc.require(
        set(expected) == {item["name"] for item in receipts},
        "Final platform receipt inventory differs from RC",
    )
    differences: list[str] = []
    fields = platforms = 0
    for current in sorted(receipts, key=lambda item: cast(str, item["name"])):
        name = cast(str, current["name"])
        rc.require(name in inventory, "RC platform receipt is missing")
        raw = gh.binary(
            f"releases/assets/{rc.positive(inventory[name]['id'], 'receipt asset ID')}"
        )
        rc.require(
            rc.digest(raw) == expected[name]["sha256"], "RC toolchain receipt changed"
        )
        try:
            original = rc.parse_json(raw, "RC toolchain receipt")
        except rc.ReleaseError:
            # Duplicate JSON keys can contain arbitrary text; do not echo them.
            raise rc.ReleaseError("Invalid JSON in RC toolchain receipt") from None
        rc.require(
            isinstance(original, dict) and isinstance(current.get("inputs"), dict),
            "Invalid toolchain receipt object",
        )
        before = cast(dict[str, object], original).get("toolchain")
        after = cast(dict[str, object], current["inputs"]).get("toolchain")
        # This exact equality remains the acceptance predicate. Diagnostics must
        # never normalize, drop or otherwise reinterpret receipt fields.
        if before == after:
            continue
        platforms += 1
        for path, change in toolchain_changes(before, after):
            fields += 1
            if len(differences) < MAX_TOOLCHAIN_DIAGNOSTICS:
                differences.append(f"  {diagnostic_label(name)}: {path}: {change}")
    if platforms:
        omitted = fields - len(differences)
        if omitted:
            differences.append(
                f"  {omitted} further field differences omitted (log limit)"
            )
        raise rc.ReleaseError(
            f"Build toolchain differs from accepted RC: {platforms} platform receipt(s), "
            f"{fields} field difference(s).\n"
            + "\n".join(differences)
            + "\nValues are withheld; inspect the verified RC/final receipts. "
            "Floating runner image rollouts can give successive jobs different "
            "ImageVersion values. Investigate runner/toolchain availability before "
            "another RC/final cycle; a new RC alone does not guarantee matching inputs. "
            "Exact equality is still required for publication."
        )


def published_plan_snapshot(
    gh: rc.GitHub, tag: str, source: str, prerelease: bool
) -> tuple[dict[str, object], dict[str, object], list[dict[str, object]]]:
    """Read a published versioned package without downloading its payloads."""
    ref = cast(dict[str, object], gh.api(f"git/ref/tags/{tag}"))
    release = cast(dict[str, object], gh.api(f"releases/tags/{tag}"))
    rc.require(
        ref.get("ref") == f"refs/tags/{tag}"
        and cast(dict[str, object], ref.get("object", {})).get("type") == "commit"
        and cast(dict[str, object], ref.get("object", {})).get("sha") == source,
        "Qualified release tag/source mismatch",
    )
    rc.require(
        release.get("tag_name") == tag
        and release.get("draft") is False
        and release.get("prerelease") is prerelease,
        "Qualified release is not published",
    )
    assets = gh.pages(f"releases/{rc.positive(release.get('id'), 'release ID')}/assets")
    names = [asset.get("name") for asset in assets]
    rc.require(
        all(isinstance(name, str) and rc.NAME_RE.fullmatch(name) for name in names)
        and len(names) == len({cast(str, name).casefold() for name in names})
        and all(asset.get("state") == "uploaded" for asset in assets),
        "Qualified release has invalid or incomplete assets",
    )
    return ref, release, assets


# Keep all evidence comparisons together at this read-only reuse boundary.
# pylint: disable-next=too-many-locals,too-many-arguments,too-many-positional-arguments
def verify_scheduled_reuse(
    gh: rc.GitHub,
    info: dict[str, object],
    snapshot: dict[str, object],
    plan: dict[str, object],
    source_run_id: int,
    tag: str,
) -> None:
    """Require retained immutable evidence and matching published asset metadata."""
    initial = published_plan_snapshot(
        gh, tag, cast(str, plan["source_sha"]), tag != f"v{plan['base_version']}"
    )
    identity = rc.snapshot_identity(initial)
    inventory = {asset["name"]: asset for asset in initial[2]}
    asset = inventory[rc.MANIFEST]
    rc.require(cast(int, asset["size"]) <= 2_000_000, "Qualified manifest is too large")
    raw = gh.binary(f"releases/assets/{rc.positive(asset['id'], 'manifest ID')}")
    manifest = rc.parse_json(raw, "qualified manifest")
    rc.require(
        isinstance(manifest, dict)
        and isinstance(manifest.get("schema"), int)
        and not isinstance(manifest["schema"], bool)
        and manifest["schema"] == 1
        and manifest.get("repository") == gh.repo
        and manifest.get("source_sha") == cast(str, plan["source_sha"])
        and manifest.get("version") == cast(str, plan["base_version"])
        and manifest.get("channel") == plan["channel"]
        and manifest.get("tag") == cast(str, plan["tag"])
        and manifest.get("version_plan") == plan
        and manifest.get("plan_sha256") == version_plan.plan_digest(plan)
        and manifest.get("source_policy") == snapshot
        and manifest.get("workflow_path") == rc.WORKFLOW
        and manifest.get("run_id") == source_run_id,
        "Qualified manifest differs from its source and durable plan",
    )
    manifest = cast(dict[str, object], manifest)
    rc.validate_validation_manifest(manifest)
    expected = manifest.get("assets")
    rc.require(isinstance(expected, list) and expected, "Qualified payloads missing")
    expected = cast(list[dict[str, object]], expected)
    declarations = {cast(str, entry["name"]): entry for entry in expected}
    rc.require(
        len(declarations) == len(expected)
        and set(inventory) == set(declarations) | {rc.MANIFEST},
        "Qualified asset inventory mismatch",
    )
    declarations[rc.MANIFEST] = {"size": len(raw), "sha256": rc.digest(raw)}
    rc.require(
        all(
            inventory[name].get("size") == entry["size"]
            and inventory[name].get("digest") == "sha256:" + cast(str, entry["sha256"])
            for name, entry in declarations.items()
        ),
        "Qualified asset metadata mismatch",
    )
    source_run = cast(dict[str, object], gh.api(f"actions/runs/{source_run_id}"))
    rc.validate_validation_run(gh, source_run, cast(dict[str, object], snapshot["data"]), cast(str, plan["channel"]))
    rc.require(source_run.get("id") == source_run_id, "Qualified run ID mismatch")
    attempt = rc.positive(manifest.get("run_attempt"), "qualified run attempt")
    rc.validate_run(
        gh,
        source_run,
        info,
        cast(str, plan["source_sha"]),
        attempt,
        completed=True,
        gate=False,
    )
    jobs = gh.pages(f"actions/runs/{source_run_id}/attempts/{attempt}/jobs", "jobs")
    for names in (("Release gate",), ("CI gate", "checks / CI gate")):
        gates = [job for job in jobs if job.get("name") in names]
        rc.require(
            len(gates) == 1
            and gates[0].get("status") == "completed"
            and gates[0].get("conclusion") == "success"
            and gates[0].get("head_sha") == cast(str, plan["source_sha"]),
            "Qualified run has no successful CI and Release gates",
        )
    rc.verify_evidence(gh, manifest, raw)
    current = published_plan_snapshot(
        gh, tag, cast(str, plan["source_sha"]), tag != f"v{plan['base_version']}"
    )
    rc.require(
        rc.snapshot_identity(current) == identity,
        "Qualified release changed during verification",
    )


def scheduled_reuse(
    gh: rc.GitHub,
    info: dict[str, object],
    run: dict[str, object],
    snapshot: dict[str, object],
    base: str,
) -> str:
    """Find proved same-input publication after fresh scheduled checks and builds."""
    head_path = "git/ref/heads/" + quote(cast(str, info["default_branch"]), safe="")
    if cast(
        dict[str, object], cast(dict[str, object], gh.api(head_path)).get("object", {})
    ).get("sha") != cast(str, run["head_sha"]):
        return ""
    ledger, _ = read_state(gh)
    records = [
        (rc.positive(key, "reserved run"), record["plan"])
        for key, record in ledger["plans"].items()
        if record["plan"]["source_sha"] == cast(str, run["head_sha"])
        and record["plan"]["base_version"] == base
        and record["plan"]["policy_sha256"]
        == version_plan.policy_digest(snapshot["data"])
        and record["plan"]["channel"] in {"beta", "rc", "stable"}
    ]
    # Bound remote probes even when a source has many abandoned reservations.
    for source_run_id, plan in sorted(
        records, key=lambda item: cast(int, item[1]["build_number"]), reverse=True
    )[:10]:
        tags = [cast(str, plan["tag"])]
        if plan["channel"] == "rc" and plan["promotion"] == "promote-bytes":
            tags.append(f"v{base}")
        for tag in tags:
            try:
                verify_scheduled_reuse(gh, info, snapshot, plan, source_run_id, tag)
            except (rc.ReleaseError, ValueError, KeyError, TypeError):
                # Missing, expired or unprovable releases never authorize a skip.
                continue
            if cast(
                dict[str, object],
                cast(dict[str, object], gh.api(head_path)).get("object", {}),
            ).get("sha") == cast(str, run["head_sha"]):
                return tag
            return ""
    return ""


def prepare(args: argparse.Namespace) -> dict[str, object]:
    """Freeze one durable plan before any platform build consumes version files."""
    inputs = event_inputs()
    channel: object
    kind = os.environ.get("GITHUB_EVENT_NAME")
    if kind == "schedule":
        channel = "nightly"
    elif kind == "push":
        channel = "beta"
    else:
        channel = inputs.get("channel")
    rc.require(
        channel in {"nightly", "beta", "rc", "stable"}, "Invalid release channel"
    )
    channel = cast(str, channel)
    if kind == "workflow_dispatch" and channel != "nightly":
        rc.require(
            os.environ.get("PUBLICATION_ENABLED") == "true",
            "Release channels are not enabled",
        )
    gh = StateGitHub(args.repo)
    info, run, snapshot = context(gh, channel)
    policy = cast(dict[str, object], snapshot["data"])
    rc.require(
        not policy.get("release_blockers"), "Release policy has unresolved blockers"
    )
    rc.require(
        not inputs.get("expected_sha")
        or inputs["expected_sha"] == cast(str, run["head_sha"]),
        "Default branch changed since dispatch; refresh and retry",
    )
    parent = None
    if channel == "stable":
        rc.require_reviewers(gh)
        candidate, parent = verified_rc(gh, inputs.get("rc_tag"), info, run)
        base = cast(str, candidate["version"])
        if (
            cast(dict[str, object], policy["versioning"])["promotion"]
            == "promote-bytes"
        ):
            rc.require(
                cast(
                    dict[str, object],
                    cast(
                        dict[str, object],
                        cast(dict[str, object], candidate["source_policy"])["data"],
                    ).get("versioning", {}),
                ).get("promotion")
                != "final-build",
                "A final-build RC cannot be promoted unchanged",
            )
            return {
                "channel": channel,
                "version": base,
                "build": "false",
                "plan_artifact": "",
            }
        rc.require(
            candidate["source_sha"] == cast(str, run["head_sha"]),
            "Final build requires the accepted RC at current HEAD; "
            "create a new RC after source/recipe changes",
        )
        candidate_plan = candidate.get("version_plan")
        rc.require(
            candidate_plan
            and cast(dict[str, object], candidate_plan).get("promotion")
            == "final-build",
            "Final build requires an RC created under the same versioned policy",
        )
        version_plan.validate_plan(candidate_plan, policy, cast(str, run["head_sha"]))
    else:
        base = client.resolve_version(policy, cast(str, inputs.get("version", "")))
    version_plan.check_base_versions(Path.cwd(), policy, base)
    closed = rc.closed_push_cycle(gh, base, cast(str, kind))
    if closed:
        return closed
    if channel in {"beta", "rc", "stable"}:
        rc.ensure_absent(gh, f"v{base}")
    plan = reserve_plan(
        gh,
        policy,
        base,
        channel,
        cast(str, run["head_sha"]),
        cast(int, run["id"]),
        cast(int, run["run_attempt"]),
        datetime.now(timezone.utc),
        parent,
    )
    PLAN.write_bytes(rc.json_bytes(plan))
    return {
        "channel": channel,
        "version": base,
        "build": "true",
        "plan_artifact": f"release-plan-{run['id']}-{run['run_attempt']}",
    }


def verify_candidate_fuzz_report(
    stage: Path, policy: dict[str, object], plan: dict[str, object],
    run: dict[str, object], repository: str,
) -> None:
    """Require source-bound mutation evidence before checking an RC's receipts."""
    if "fuzzing" not in policy or plan["channel"] != "rc":
        return
    if __package__:
        from .release_fuzz import verify_report
    else:
        from release_fuzz import verify_report

    verify_report(stage, Path.cwd(), repository, cast(str, plan["source_sha"]),
                  cast(int, run["id"]), cast(int, run["run_attempt"]))


def candidate_fuzz_receipts(
    policy: dict[str, object], channel: str, receipts: list[dict[str, object]],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    """Separate validation evidence only for an opted-in RC."""
    if "fuzzing" not in policy or channel != "rc":
        return receipts, []
    if __package__:
        from .release_fuzz import split_receipts
    else:
        from release_fuzz import split_receipts

    return split_receipts(receipts)


def fuzz_manifest_fields(
    policy: dict[str, object], channel: str,
    validation_receipts: list[dict[str, object]],
) -> dict[str, object]:
    """Record the selected fuzz policy and authenticated validation receipts."""
    if "fuzzing" not in policy:
        return {}
    if __package__:
        from .release_fuzz import profile
    else:
        from release_fuzz import profile

    return {
        "fuzzing_profile": profile(policy, channel),
        "validation_receipts": [
            {"name": value["name"], "sha256": value["sha256"]}
            for value in validation_receipts
        ],
    }


# Keep the immutable evidence and final public mutation in the same operation.
# pylint: disable-next=too-many-locals
def publish_versioned(args: argparse.Namespace) -> dict[str, object]:
    """Publish a fixed tag only after source, receipts and optional final acceptance pass."""
    plan = version_plan.validate_plan(json.loads(PLAN.read_text(encoding="utf-8")))
    channel = cast(str, plan["channel"])
    gh = StateGitHub(args.repo)
    info, run, snapshot = context(gh, channel, gate=True)
    policy = cast(dict[str, object], snapshot["data"])
    version_plan.validate_plan(plan, policy, cast(str, run["head_sha"]))
    parent = None
    if channel == "stable":
        rc.require(
            plan["promotion"] == "final-build",
            "Stable build must explicitly select final-build",
        )
        rc.require_reviewers(gh)
        candidate, parent = verified_rc(gh, event_inputs().get("rc_tag"), info, run)
        rc.require(
            candidate["source_sha"] == cast(str, plan["source_sha"])
            and candidate["version"] == cast(str, plan["base_version"]),
            "Final build differs from the accepted RC source/base",
        )
        rc.require(
            cast(dict[str, object], candidate.get("version_plan", {})).get("promotion")
            == "final-build",
            "Accepted RC does not permit a final rebuild",
        )
    verify_reservation(gh, plan, cast(int, run["id"]), parent)
    rc.ensure_absent(gh, cast(str, plan["tag"]))
    if channel in {"beta", "rc"}:
        rc.ensure_absent(gh, f"v{plan['base_version']}")
    superseded = rc.superseded_candidate(gh, info, run, channel)
    if superseded:
        return superseded
    with tempfile.TemporaryDirectory(prefix="release-versioned-") as temp:
        stage = Path(temp)
        assets = rc.stage_assets(Path(args.assets), stage)
        verify_candidate_fuzz_report(stage, policy, plan, run, gh.repo)
        receipts = verify_receipts(stage, plan, assets, policy)
        receipts, validation_receipts = candidate_fuzz_receipts(policy, channel, receipts)
        rc.verify_required_signatures(stage, gh.repo, cast(str, plan["source_sha"]))
        if parent:
            verify_final_toolchains(gh, candidate, receipts)
        package_versions = verify_declared_artifacts(stage, policy, plan)
        manifest: dict[str, object] = {
            "schema": 1,
            "repository": info["full_name"],
            "version": cast(str, plan["base_version"]),
            "channel": channel,
            "tag": cast(str, plan["tag"]),
            "source_sha": cast(str, plan["source_sha"]),
            "source_policy": snapshot,
            "workflow_path": rc.WORKFLOW,
            "run_id": cast(int, run["id"]),
            "run_attempt": cast(int, run["run_attempt"]),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "assets": assets,
            "version_plan": plan,
            "plan_sha256": version_plan.plan_digest(plan),
            "build_receipts": [
                {"name": value["name"], "sha256": value["sha256"]} for value in receipts
            ],
            "package_versions": package_versions,
        }
        if parent:
            manifest["derived_from_rc"] = parent
        selected_profile = rc.validation_profile(policy, channel)
        if selected_profile is not None:
            manifest["validation_profile"] = selected_profile
        manifest.update(fuzz_manifest_fields(policy, channel, validation_receipts))
        content = rc.json_bytes(manifest)
        (stage / rc.MANIFEST).write_bytes(content)
        # Recheck immediately before the first public release mutation.
        verify_reservation(gh, plan, cast(int, run["id"]), parent)
        if channel == "stable":
            rc.require_reviewers(gh)
        description = (
            f"Final build from accepted {parent['tag']}; new verified package bytes."
            if parent
            else f"{channel} candidate with a version fixed before compilation."
        )
        superseded = rc.superseded_candidate(gh, info, run, channel)
        if superseded:
            return superseded
        rc.check_workflow_publication(gh, cast(str, plan["source_sha"]))
        if channel == "nightly" and run["event"] == "schedule":
            reused = scheduled_reuse(
                gh, info, run, snapshot, cast(str, plan["base_version"])
            )
            if reused:
                return {
                    "status": "reused",
                    "tag": reused,
                    "reason": (
                        "Qualified same-input release; fresh nightly checks and builds passed"
                    ),
                }
        body = rc.release_notes(
            gh,
            cast(str, plan["tag"]),
            cast(str, plan["source_sha"]),
            description + f"\n\nSource: `{plan['source_sha']}`\n\n"
            f"Validation: https://github.com/{gh.repo}/actions/runs/{run['id']}\n\n"
            f"See `{rc.MANIFEST}` for package hashes and version input evidence.",
        )
        rc.EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
        rc.EVIDENCE.write_bytes(content)
        begin_publication(gh, plan, cast(int, run["id"]), parent)
        result = rc._publish_prepared(  # pylint: disable=protected-access
            gh,
            cast(str, plan["tag"]),
            cast(str, plan["source_sha"]),
            stage,
            channel != "stable",
            body,
        )
    return {
        "status": "published",
        "tag": cast(str, plan["tag"]),
        "release_url": result["html_url"],
        "manifest_path": str(rc.EVIDENCE),
    }


def main() -> None:
    """Prepare a frozen plan or publish its verified build artifacts."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "publish"])
    parser.add_argument("--repo", required=True)
    parser.add_argument("--assets", default=".release-assets")
    args = parser.parse_args()
    try:
        rc.emit_result(
            prepare(args) if args.command == "prepare" else publish_versioned(args)
        )
    except (rc.ReleaseError, ValueError, OSError, KeyError, TypeError) as error:
        print(f"release-versioned: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
