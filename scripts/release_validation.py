#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Explicit beta validation policy and fail-closed release gate contracts."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

WORKFLOW = "release-quality-gate.yml"
CHANNELS = {"nightly", "beta", "rc", "stable"}


def channel_workflows(policy: dict[str, Any]) -> list[str] | None:
    """Only hosted, versioned releases may opt beta into different validators."""
    if "channel_validation_workflows" not in policy:
        return None
    config = policy["channel_validation_workflows"]
    if (
        not isinstance(config, dict)
        or set(config) != {"beta"}
        or policy.get("mode", "release") != "release"
        or policy.get("ci_execution", "github") != "github"
        or policy.get("single_entry_ci") is not True
        or not isinstance(policy.get("versioning"), dict)
    ):
        raise ValueError(
            "channel_validation_workflows requires versioned single-entry releases and only beta"
        )
    names = config["beta"]
    if (
        not isinstance(names, list)
        or not names
        or any(
            not isinstance(name, str)
            or not re.fullmatch(r"[A-Za-z0-9_-]+\.ya?ml", name)
            or name
            in {
                WORKFLOW,
                "quality-gate.yml",
                "release-pipeline.yml",
                "release-build.yml",
            }
            for name in names
        )
        or len(set(names)) != len(names)
    ):
        raise ValueError(
            "Beta validation requires unique, nonempty local validator filenames"
        )
    return names


def profile(policy: dict[str, Any], channel: str) -> dict[str, Any] | None:
    """Describe the selected checks without changing legacy manifest contracts."""
    beta = channel_workflows(policy)
    if beta is None:
        return None
    if channel not in CHANNELS:
        raise ValueError("Unknown release validation channel")
    return {
        "schema": 1,
        "channel": channel,
        "workflows": beta if channel == "beta" else policy["validation_workflows"],
    }


def expected_results(policy: dict[str, Any], channel: str) -> dict[str, str]:
    """Require every selected job and exactly the declared unselected skips."""
    beta = channel_workflows(policy)
    if beta is None or channel not in CHANNELS:
        raise ValueError(
            "Release validation needs an explicit policy and known channel"
        )
    results = dict.fromkeys(
        ("scope", "workflow-contracts", "release-contracts"), "success"
    )
    for index, _ in enumerate(policy["validation_workflows"]):
        results[f"check-{index}"] = "skipped" if channel == "beta" else "success"
    for index, _ in enumerate(beta):
        results[f"beta-check-{index}"] = "success" if channel == "beta" else "skipped"
    for report in policy.get("coverage", {}).get("reports", []):
        results["coverage-" + report["name"]] = (
            "skipped" if channel == "beta" else "success"
        )
    return results


def check_results(
    policy: dict[str, Any], channel: str, results: dict[str, Any]
) -> None:
    """Missing, canceled, failed and unexpected skipped checks all fail closed."""
    expected = expected_results(policy, channel)
    if set(results) != set(expected):
        raise ValueError("Release validation job inventory differs")
    if results["scope"].get("outputs", {}).get("run") != "true":
        raise ValueError("Release validation scope must run real checks")
    failed = {
        name: result.get("result")
        for name, result in results.items()
        if result.get("result") != expected[name]
    }
    if failed:
        raise ValueError(f"Release validation did not pass: {failed}")


def check_event(channel: str) -> None:
    """The release caller supplies prepare's frozen channel, never a PR shortcut."""
    event = os.environ.get("GITHUB_EVENT_NAME")
    expected = {"push": "beta", "schedule": "nightly"}.get(event)
    if event == "workflow_dispatch":
        expected = (
            json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
            .get("inputs", {})
            .get("channel")
        )
    if channel not in CHANNELS or expected != channel:
        raise ValueError("Validation channel differs from the release event")


def check_run_jobs(jobs: list[dict[str, Any]], channel: str, sha: str) -> None:
    """Bind opt-in publication to both its CI gate and selected channel marker."""
    markers = [
        job
        for job in jobs
        if str(job.get("name", "")).startswith("checks / Validation profile (")
    ]
    if len(markers) != 1:
        raise ValueError("Release validation must have exactly one channel profile")
    for name in ("checks / CI gate", f"checks / Validation profile ({channel})"):
        matches = [job for job in jobs if job.get("name") == name]
        if (
            len(matches) != 1
            or matches[0].get("head_sha") != sha
            or matches[0].get("status") != "completed"
            or matches[0].get("conclusion") != "success"
        ):
            raise ValueError(
                "Release validation profile and CI gate must succeed at the source SHA"
            )


def main() -> None:
    """Run the generated workflow's policy/event and aggregate checks."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("select", "gate"))
    parser.add_argument("--channel", required=True)
    args = parser.parse_args()
    policy = json.loads(Path(".release-policy.json").read_text())
    profile(policy, args.channel)
    check_event(args.channel)
    if args.action == "gate":
        check_results(policy, args.channel, json.loads(os.environ["RESULTS"]))
    print(f"Release validation profile: {args.channel}")


if __name__ == "__main__":
    main()
