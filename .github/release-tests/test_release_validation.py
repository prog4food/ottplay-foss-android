# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Offline release-profile policy, gate and immutable-evidence contracts."""

import copy
import json
import os
# Subprocesses use explicit argv and never a shell.
import subprocess  # nosec B404
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import release_control as rc  # noqa: E402
import release_validation as validation  # noqa: E402


def policy():
    return {
        "mode": "release",
        "single_entry_ci": True,
        "versioning": {},
        "validation_workflows": ["ci.yml", "native.yml", "codeql.yml"],
        "channel_validation_workflows": {"beta": ["beta-checks.yml"]},
    }


class ReleaseValidationTests(unittest.TestCase):
    def results(self, channel):
        rows = {
            key: {"result": value}
            for key, value in validation.expected_results(policy(), channel).items()
        }
        rows["scope"]["outputs"] = {"run": "true"}
        return rows

    def test_beta_is_reduced_and_every_other_release_channel_is_full(self):
        for channel in ("beta", "rc", "nightly", "stable"):
            rows = self.results(channel)
            validation.check_results(policy(), channel, rows)
            self.assertEqual(
                rows["check-0"]["result"], "skipped" if channel == "beta" else "success"
            )
            self.assertEqual(
                rows["beta-check-0"]["result"],
                "success" if channel == "beta" else "skipped",
            )

    def test_every_bad_result_and_missing_or_extra_job_is_rejected(self):
        config = policy()
        for channel in ("beta", "rc"):
            original = self.results(channel)
            for name, row in original.items():
                for result in {"success", "skipped", "failure", "cancelled"} - {
                    row["result"]
                }:
                    with self.subTest(channel=channel, name=name, result=result):
                        rows = copy.deepcopy(original)
                        rows[name]["result"] = result
                        with self.assertRaises(ValueError):
                            validation.check_results(config, channel, rows)
                rows = copy.deepcopy(original)
                del rows[name]
                with self.assertRaises(ValueError):
                    validation.check_results(config, channel, rows)
            original["unexpected"] = {"result": "success"}
            with self.assertRaises(ValueError):
                validation.check_results(config, channel, original)

    def test_bad_policy_cannot_reduce_rc_or_hide_validators(self):
        base = policy()
        for config in (
            None,
            {},
            {"rc": ["fast.yml"]},
            {"beta": []},
            {"beta": "fast.yml"},
            {"beta": ["../fast.yml"]},
            {"beta": [validation.WORKFLOW]},
            {"beta": ["fast.yml", "fast.yml"]},
            {"beta": [None]},
        ):
            with self.subTest(config=config), self.assertRaises(ValueError):
                validation.channel_workflows(
                    {**base, "channel_validation_workflows": config}
                )
        for key, value in (
            ("mode", "validation-only"),
            ("ci_execution", "local"),
            ("single_entry_ci", False),
            ("versioning", None),
        ):
            with self.subTest(key=key), self.assertRaises(ValueError):
                validation.channel_workflows({**base, key: value})
        with self.assertRaises(ValueError):
            validation.profile(base, "unknown")

    def test_old_manifest_is_unchanged_but_new_profile_cannot_be_omitted_or_relabelled(
        self,
    ):
        old = {"source_policy": {"data": {}}, "channel": "rc"}
        rc.validate_validation_manifest(old)
        for channel in ("beta", "rc"):
            manifest = {
                "source_policy": {"data": policy()},
                "channel": channel,
                "validation_profile": validation.profile(policy(), channel),
            }
            rc.validate_validation_manifest(manifest)
            for wrong in (
                None,
                validation.profile(policy(), "nightly"),
                {**manifest["validation_profile"], "schema": True},
                {**manifest["validation_profile"], "workflows": []},
            ):
                with (
                    self.subTest(channel=channel, wrong=wrong),
                    self.assertRaises(rc.ReleaseError),
                ):
                    rc.validate_validation_manifest(
                        {**manifest, "validation_profile": wrong}
                    )

    def test_successful_fast_beta_cannot_be_promoted(self):
        manifest = {
            "schema": 1,
            "repository": "owner/repo",
            "version": "1.2.3",
            "channel": "beta",
            "tag": "v1.2.3-beta.1",
            "validation_profile": validation.profile(policy(), "beta"),
        }
        raw = rc.json_bytes(manifest)
        with self.assertRaisesRegex(rc.ReleaseError, "Only release candidates"):
            rc.validate_manifest(raw, "owner/repo", manifest["tag"])

    def test_run_proof_requires_channel_marker_ci_success_and_exact_sha(self):
        sha = "a" * 40
        jobs = [
            {
                "name": name,
                "status": "completed",
                "conclusion": "success",
                "head_sha": sha,
            }
            for name in ("checks / CI gate", "checks / Validation profile (beta)")
        ]
        validation.check_run_jobs(jobs, "beta", sha)
        with self.assertRaises(ValueError):
            validation.check_run_jobs(jobs, "rc", sha)
        for index in range(2):
            for field, value in (
                ("status", "in_progress"),
                ("conclusion", "skipped"),
                ("head_sha", "b" * 40),
            ):
                bad = copy.deepcopy(jobs)
                bad[index][field] = value
                with self.assertRaises(ValueError):
                    validation.check_run_jobs(bad, "beta", sha)
            with self.assertRaises(ValueError):
                validation.check_run_jobs(jobs[:index] + jobs[index + 1 :], "beta", sha)
            with self.assertRaises(ValueError):
                validation.check_run_jobs(jobs + [jobs[index]], "beta", sha)

    def test_real_gate_cli_rejects_pr_or_wrong_dispatch_channel(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / ".release-policy.json").write_text(json.dumps(policy()))
            event = root / "event.json"
            event.write_text(json.dumps({"inputs": {"channel": "rc"}}))
            for kind, channel, expected in (
                ("push", "beta", 0),
                ("schedule", "nightly", 0),
                ("workflow_dispatch", "rc", 0),
                ("workflow_dispatch", "beta", 1),
                ("pull_request", "beta", 1),
            ):
                result = subprocess.run(  # nosec B603 - reviewed local CLI with explicit fixture argv
                    [
                        sys.executable,
                        str(ROOT / "scripts/release_validation.py"),
                        "gate",
                        "--channel",
                        channel,
                    ],
                    cwd=root,
                    env={
                        **os.environ,
                        "GITHUB_EVENT_NAME": kind,
                        "GITHUB_EVENT_PATH": str(event),
                        "RESULTS": json.dumps(self.results(channel)),
                    },
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, expected, result.stderr)

    def test_legacy_policy_does_not_require_new_run_api_calls(self):
        with patch.object(rc.GitHub, "pages") as pages:
            rc.validate_validation_run(rc.GitHub("owner/repo"), {}, {}, "rc")
        pages.assert_not_called()


if __name__ == "__main__":
    unittest.main()
