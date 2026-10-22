# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Offline release-contract tests. No test invokes GitHub or mutates a remote."""

# Keep the shared GitHub fake and its vendored release-contract regressions together.
# pylint: disable=too-many-lines

import argparse
import base64
import importlib.util
import io
import json
import os

# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
import tempfile
import unittest
import zipfile
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from itertools import product
from pathlib import Path
from unittest.mock import Mock, patch

SPEC = importlib.util.spec_from_file_location(
    "release_control", Path(__file__).parents[2] / "scripts/release_control.py"
)
rc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rc)
# These fixtures model the original unsigned publication contract. Consumers may
# opt into signatures; that boundary is exercised with enforcement enabled in
# test_release_signing.py, rather than requiring Cosign/network access here.
rc.RELEASE_SIGNATURES_REQUIRED = False

REPO = "example/project"
SHA = "a" * 40
RC_TAG = "v1.2.3-rc.2"


def http_response(status=0, stdout=b"{}", error_format="gh: API failed (HTTP {status})"):
    """Return a complete gh --include fixture independent of retry support."""
    return subprocess.CompletedProcess(
        [], bool(status), f"HTTP/2.0 {status or 200} Test\nContent-Type: application/json\r\n\r\n".encode() + stdout,
        error_format.format(status=status).encode() if status else b"",
    )


class MetadataReadRetryTests(unittest.TestCase):
    """Transient metadata failures cannot replay publication or change policy."""

    ERROR_FORMATS = (
        "gh: Server Error (HTTP {status})",
        "gh: Server Error (HTTP {status}) (HTTP {status})",
        "gh: HTTP {status}",
        "gh: HTTP {status}\n",
        "gh: HTTP {status}: Gateway response",
        "gh: HTTP {status} \t\r\n",
        "gh: HTTP {status}: Gateway response\r\n",
    )

    response = staticmethod(http_response)

    def failed_request(self, message, method="GET", path="git/ref/tags/v1.2.3", status=403):
        """A lookup or write failure must come from the expected API request."""
        def run(command, **_kwargs):
            self.assertEqual(command[:2], ["gh", "api"])
            self.assertEqual(command[command.index("--method") + 1], method)
            self.assertEqual(command[-2:], ["--", f"repos/{REPO}/{path}"])
            return subprocess.CompletedProcess(command, 1, self.response(status).stdout, message)
        return run

    def test_transient_read_retries_and_discards_partial_pages(self):
        for status, error_format in product((500, 502, 503, 504), self.ERROR_FORMATS):
            partial = self.response(stdout=b'[{"partial": true}]').stdout
            failed = self.response(status, b'{"errors":"HTTP 404"}', error_format)
            failed.stdout = partial + b"\n" + failed.stdout
            with (
                self.subTest(status=status, error_format=error_format),
                patch.object(rc.subprocess, "run", side_effect=[
                    failed,
                    self.response(stdout=b'[{"id": 42}]'),
                ]) as run,
                patch.object(rc.time, "sleep") as sleep,
                patch.object(rc.random, "uniform", return_value=1.5),
            ):
                self.assertEqual(rc.GitHub(REPO).pages("releases"), [{"id": 42}])
                self.assertEqual(run.call_count, 2)
                self.assertEqual(run.call_args_list[0], run.call_args_list[1])
                self.assertEqual(run.call_args.kwargs["timeout"], 30)
                sleep.assert_called_once_with(1.5)

    def test_exhausted_reads_fail_without_becoming_missing(self):
        gh = rc.GitHub(REPO)
        with (
            patch.object(rc.subprocess, "run", return_value=self.response(502)) as run,
            patch.object(rc.time, "sleep") as sleep,
            self.assertRaises(rc.GitHubError) as error,
        ):
            gh.optional("actions/runs/42")
        self.assertEqual(run.call_count, 3)
        self.assertEqual(sleep.call_count, 2)
        self.assertFalse(error.exception.not_found)
        self.assertIn("HTTP 502", str(error.exception))

    def test_only_exact_missing_status_allows_an_optional_resource(self):
        gh = rc.GitHub(REPO)
        for error_format in self.ERROR_FORMATS:
            with (
                self.subTest(error_format=error_format),
                patch.object(rc.subprocess, "run", side_effect=self.failed_request(
                    self.response(404, error_format=error_format).stderr, status=404,
                )) as run,
                patch.object(rc.time, "sleep") as sleep,
            ):
                self.assertIsNone(gh.optional("git/ref/tags/v1.2.3"))
            run.assert_called_once()
            sleep.assert_not_called()

    def test_embedded_missing_status_cannot_authorize_an_absent_release(self):
        gh = rc.GitHub(REPO)
        cases = (
            (b"gh: Request failed: HTTP 404 from upstream (HTTP 403)", 1),
            (b"gh: HTTP 4040: invalid status", 1),
            (b"gh: HTTP 404suffix", 1),
            (b"other tool: HTTP 404", 1),
            (b"gh: HTTP 404: Gateway reported (HTTP 502)", 1),
            (b"gh: HTTP 502: Gateway reported (HTTP 404)", 1),
            (b"gh: Forbidden (HTTP 403) (HTTP 404)", 1),
            (b"gh: Not Found (HTTP 404) (HTTP 403)", 1),
            (b"gh: Untrusted message (HTTP 404) with more text", 1),
            (b"other tool: Not Found (HTTP 404)", 1),
            (b"gh: HTTP 404\ngh: HTTP 403", 1),
            (b"gh: HTTP 502: upstream returned HTTP 404", 3),
        )
        for message, attempts in cases:
            with (
                self.subTest(message=message),
                patch.object(rc.subprocess, "run", side_effect=self.failed_request(
                    message, status=502 if attempts == 3 else 403,
                )) as run,
                patch.object(rc.time, "sleep"),
                self.assertRaises(rc.GitHubError) as error,
            ):
                rc.ensure_absent(gh, "v1.2.3")
            self.assertFalse(error.exception.not_found)
            self.assertEqual(run.call_count, attempts)

    def test_failed_write_uses_the_same_exact_missing_status(self):
        gh = rc.GitHub(REPO)
        with (
            patch.object(rc.subprocess, "run", side_effect=self.failed_request(
                b"gh: Authorization error mentions HTTP 404 (HTTP 403)",
                method="POST", path="releases",
            )) as run,
            self.assertRaises(rc.GitHubError) as error,
        ):
            gh.api("releases", "POST", {"tag_name": RC_TAG})
        self.assertFalse(error.exception.not_found)
        run.assert_called_once()

    def test_multiline_diagnostics_cannot_override_forbidden_http_status(self):
        gh = rc.GitHub(REPO)
        for message in (
            b"gh: HTTP 404: upstream\nfailure (HTTP 502)\n",
            b"gh: HTTP 404: upstream\r\nfailure (HTTP 403)\r\n",
            b"gh: HTTP 404: upstream\rfailure (HTTP 502)\r",
            b"gh: HTTP 502: upstream\nfailure (HTTP 403)\n",
            b"gh: HTTP 404\ngh: HTTP 404\n",
            b"gh: HTTP 404\n\n",
            b"\ngh: HTTP 404\n",
            b"gh: HTTP 502\nadditional diagnostic\n",
            b"gh: Not Found\nadditional detail (HTTP 404)\n",
        ):
            for operation in (
                lambda: gh.optional("git/ref/tags/v1.2.3"),
                lambda: rc.ensure_absent(gh, "v1.2.3"),
            ):
                with self.subTest(message=message, operation=operation):
                    with (
                        patch.object(rc.subprocess, "run", side_effect=self.failed_request(message)) as run,
                        patch.object(rc.time, "sleep") as sleep,
                        self.assertRaises(rc.GitHubError) as error,
                    ):
                        operation()
                    self.assertFalse(error.exception.not_found)
                    run.assert_called_once()
                    sleep.assert_not_called()

    def test_timeouts_are_bounded_and_do_not_expose_partial_output(self):
        gh = rc.GitHub(REPO)
        with (
            patch.object(rc.subprocess, "run", side_effect=subprocess.TimeoutExpired(
                ["gh"], 30, output=b"private payload", stderr=b"private diagnostics"
            )) as run,
            patch.object(rc.time, "sleep") as sleep,
            patch.object(rc.random, "uniform", side_effect=lambda low, high: high),
            self.assertRaises(rc.GitHubError) as error,
        ):
            gh.api("actions/runs/42")
        self.assertEqual(run.call_count, 3)
        self.assertEqual(sum(call.args[0] for call in sleep.call_args_list), 6)
        self.assertNotIn("private", str(error.exception))
        self.assertIn("timed out after 3 attempts", str(error.exception))

    def test_policy_and_rate_limit_errors_are_not_retried(self):
        gh = rc.GitHub(REPO)
        for status, error_format in product(
            (400, 401, 403, 404, 409, 422, 429, 501), self.ERROR_FORMATS
        ):
            with (
                self.subTest(status=status, error_format=error_format),
                patch.object(rc.subprocess, "run", return_value=self.response(
                    status, error_format=error_format
                )) as run,
                patch.object(rc.time, "sleep") as sleep,
                self.assertRaises(rc.GitHubError),
            ):
                gh.api("actions/runs/42")
            run.assert_called_once()
            sleep.assert_not_called()

    def test_unrelated_details_and_longer_status_numbers_do_not_trigger_retry(self):
        gh = rc.GitHub(REPO)
        for message in (
            b"gh: HTTP 403: Gateway reported (HTTP 502)",
            b"gh: HTTP 502: Gateway reported (HTTP 403)",
            b"gh: HTTP 502: Gateway reported (HTTP 503)",
            b"gh: Forbidden (HTTP 403) (HTTP 502)",
            b"gh: Bad Gateway (HTTP 502) (HTTP 403)",
            b"gh: Untrusted message (HTTP 502) with more text",
            b"gh: HTTP 502-not-status",
            b"gh: HTTP 502.5",
            b"gh: HTTP 5020: invalid status",
            b"gh: HTTP 502suffix",
            b"other tool: HTTP 502",
        ):
            with (
                self.subTest(message=message),
                patch.object(rc.subprocess, "run", return_value=subprocess.CompletedProcess(
                    [], 1, self.response(403).stdout, message,
                )) as run,
                patch.object(rc.time, "sleep") as sleep,
                self.assertRaises(rc.GitHubError),
            ):
                gh.api("actions/runs/42")
            run.assert_called_once()
            sleep.assert_not_called()

    def test_writes_and_binary_transfers_are_not_replayed(self):
        gh = rc.GitHub(REPO)
        cases = [
            ("releases", "POST", {"tag_name": RC_TAG}, "json"),
            ("releases/42", "PATCH", {"draft": False}, "json"),
            ("contents/release-version-state.json", "PUT", {"branch": "release-version-state"}, "json"),
            ("releases/assets/42", "GET", None, "asset"),
            ("actions/artifacts/42/zip", "GET", None, "json"),
        ]
        for (path, method, body, mode), error_format in product(cases, self.ERROR_FORMATS):
            with (
                self.subTest(method=method, path=path, error_format=error_format),
                patch.object(rc.subprocess, "run", return_value=self.response(
                    502, error_format=error_format
                )) as run,
                patch.object(rc.time, "sleep") as sleep,
                self.assertRaises(rc.GitHubError),
            ):
                gh.request(path, method, body, mode)
            run.assert_called_once()
            sleep.assert_not_called()
            self.assertNotIn("timeout", run.call_args.kwargs)


class AutomaticBetaPreparationTests(unittest.TestCase):
    """An occupied base skips only automatic builds, never explicit requests."""

    def test_existing_stable_tag_closes_only_push_cycle(self):
        gh = Mock()
        gh.api.return_value = {
            "ref": "refs/tags/v1.2.3",
            "object": {"type": "commit", "sha": SHA},
        }
        result = rc.closed_push_cycle(gh, "1.2.3", "push")
        self.assertEqual(result["status"], "version-required")
        self.assertEqual(result["build"], "false")
        self.assertEqual(result["version"], "1.2.3")
        gh.api.assert_called_once_with("git/ref/tags/v1.2.3")
        for kind in ("workflow_dispatch", "schedule"):
            gh.reset_mock()
            self.assertIsNone(rc.closed_push_cycle(gh, "1.2.3", kind))
            gh.api.assert_not_called()

    def test_missing_tag_continues_but_api_errors_cannot_authorize_skip(self):
        gh = rc.GitHub(REPO)
        with patch.object(gh, "api", side_effect=rc.GitHubError("HTTP 404", True)):
            self.assertIsNone(rc.closed_push_cycle(gh, "1.2.3", "push"))
        for message in ("HTTP 401", "HTTP 403", "HTTP 429", "HTTP 500"):
            with (
                self.subTest(message=message),
                patch.object(gh, "api", side_effect=rc.GitHubError(message)),
                self.assertRaisesRegex(rc.GitHubError, message),
            ):
                rc.closed_push_cycle(gh, "1.2.3", "push")

    def test_malformed_or_wrong_tag_response_fails_closed(self):
        gh = Mock()
        for ref in (
            None,
            {},
            [],
            {"ref": "refs/tags/v1.2.4", "object": {"type": "commit", "sha": SHA}},
        ):
            gh.api.return_value = ref
            with (
                self.subTest(ref=ref),
                self.assertRaisesRegex(rc.ReleaseError, "Invalid stable tag"),
            ):
                rc.closed_push_cycle(gh, "1.2.3", "push")


def policy():
    """Return a minimal release-eligible source policy."""
    return {
        "repository": REPO,
        "mode": "release",
        "default_branch": "main",
        "validation_workflows": ["ci.yml"],
    }


def policy_response(data):
    """Represent policy bytes as a hash-verified GitHub contents response."""
    raw = rc.json_bytes(data)
    blob_sha = rc.hashlib.sha1(
        b"blob " + str(len(raw)).encode() + b"\0" + raw, usedforsecurity=False
    ).hexdigest()
    return {
        "type": "file",
        "path": rc.POLICY,
        "encoding": "base64",
        "size": len(raw),
        "sha": blob_sha,
        "content": base64.b64encode(raw).decode(),
    }


def policy_snapshot(data=None):
    """Build the immutable policy snapshot stored in a release manifest."""
    data = policy() if data is None else data
    raw = rc.json_bytes(data)
    return {
        "schema": 1,
        "path": rc.POLICY,
        "git_blob_sha": policy_response(data)["sha"],
        "sha256": rc.digest(raw),
        "data": deepcopy(data),
    }


def manifest():
    """Return a valid RC manifest with one deterministic binary payload."""
    data = b"built-once-package\x00\xff"
    return {
        "schema": 1,
        "repository": REPO,
        "version": "1.2.3",
        "channel": "rc",
        "tag": RC_TAG,
        "source_sha": SHA,
        "source_policy": policy_snapshot(),
        "workflow_path": rc.WORKFLOW,
        "run_id": 17,
        "run_attempt": 1,
        "created_at": "2026-09-12T00:00:00+00:00",
        "assets": [
            {"name": "package.tar.gz", "size": len(data), "sha256": rc.digest(data)}
        ],
    }


def run(run_id=17, completed=True):
    """Return a trusted default-branch Actions run with configurable completion."""
    return {
        "id": run_id,
        "run_number": run_id,
        "repository": {"full_name": REPO},
        "head_repository": {"full_name": REPO},
        "head_sha": SHA,
        "head_branch": "main",
        "path": rc.WORKFLOW,
        "event": "workflow_dispatch",
        "run_attempt": 1,
        "status": "completed" if completed else "in_progress",
        "conclusion": "success" if completed else None,
    }


# Separate fields intentionally model independently mutable GitHub resources.
# pylint: disable-next=too-many-instance-attributes
class FakeGitHub:
    """Stateful fake with draft uploads, publication history and mutable API data."""

    repo = REPO

    def __init__(self):
        self.info = {"full_name": REPO, "default_branch": "main"}
        self.runs = {17: run(), 99: run(99, False)}
        self.default_head = SHA
        self.github_directories = {
            sha: [
                {
                    "name": "workflows",
                    "path": ".github/workflows",
                    "type": "dir",
                    "sha": "c" * 40,
                }
            ]
            for sha in (SHA, "b" * 40)
        }
        self.successors = []
        self.source_policies = {SHA: policy()}
        self.policy_reads = []
        self.jobs = [
            {
                "name": "Release gate",
                "head_sha": SHA,
                "status": "completed",
                "conclusion": "success",
            }
        ]
        self.environment = {
            "name": "release",
            "protection_rules": [
                {
                    "type": "required_reviewers",
                    "reviewers": [{"type": "User", "reviewer": {"id": 1}}],
                }
            ],
        }
        self.refs = {
            RC_TAG: {
                "ref": f"refs/tags/{RC_TAG}",
                "object": {"type": "commit", "sha": SHA},
            }
        }
        self.releases = {
            10: {
                "id": 10,
                "tag_name": RC_TAG,
                "target_commitish": SHA,
                "draft": False,
                "prerelease": True,
                "html_url": f"https://github.com/{REPO}/releases/tag/{RC_TAG}",
                "updated_at": "2026-09-12T01:00:00Z",
            }
        }
        self.files = {20: b"built-once-package\x00\xff", 21: rc.json_bytes(manifest())}
        self.assets = {
            10: [
                {
                    "id": asset_id,
                    "name": name,
                    "size": len(self.files[asset_id]),
                    "state": "uploaded",
                }
                for asset_id, name in [(20, "package.tar.gz"), (21, rc.MANIFEST)]
            ]
        }
        self.artifacts = []
        self.set_evidence(self.files[21])
        self.writes = []
        self.corrupt_upload = False
        self.mutate_snapshot = False
        self.snapshot_reads = 0

    def set_evidence(self, raw):
        """Package manifest bytes into an immutable artifact with matching metadata."""
        zipped = io.BytesIO()
        with zipfile.ZipFile(zipped, "w") as archive:
            archive.writestr(rc.MANIFEST, raw)
        self.archive = zipped.getvalue()
        self.artifacts = [
            {
                "id": 40,
                "name": "release-evidence",
                "expired": False,
                "digest": f"sha256:{rc.digest(self.archive)}",
                "workflow_run": {"id": 17, "head_sha": SHA},
            }
        ]

    # Endpoint branches mirror the REST API and make unexpected calls fail closed.
    # pylint: disable-next=too-many-return-statements,too-many-branches
    def api(self, path, method="GET", body=None):
        """Model repository reads and release writes while recording every mutation."""
        if method != "GET":
            self.writes.append((path, method, deepcopy(body)))
        if path == "":
            return deepcopy(self.info)
        if path == "git/ref/heads/main":
            return {
                "ref": "refs/heads/main",
                "object": {"type": "commit", "sha": self.default_head},
            }
        if path.startswith("actions/workflows/release-pipeline.yml/runs?"):
            return {
                "total_count": len(self.successors),
                "workflow_runs": deepcopy(self.successors),
            }
        if path.startswith("contents/.github?ref="):
            sha = path.split("?ref=", 1)[1]
            if sha not in self.github_directories:
                raise rc.GitHubError("HTTP 404", True)
            return deepcopy(self.github_directories[sha])
        if path.startswith(f"contents/{rc.POLICY}?ref="):
            sha = path.split("?ref=", 1)[1]
            self.policy_reads.append(sha)
            if sha not in self.source_policies:
                raise rc.GitHubError("HTTP 404", True)
            return policy_response(self.source_policies[sha])
        if path.startswith("actions/runs/"):
            return deepcopy(self.runs[int(path.split("/")[2])])
        if path == "environments/release":
            return deepcopy(self.environment)
        if path.startswith("compare/"):
            return {
                "status": "identical" if self.default_head == SHA else "ahead",
                "merge_base_commit": {"sha": SHA},
            }
        if path.startswith("git/ref/tags/"):
            tag = path.removeprefix("git/ref/tags/")
            if tag not in self.refs:
                raise rc.GitHubError("HTTP 404", True)
            self.snapshot_reads += 1
            if self.mutate_snapshot and self.snapshot_reads > 1:
                self.refs[tag]["object"]["sha"] = "b" * 40
            return deepcopy(self.refs[tag])
        if path.startswith("releases/tags/"):
            tag = path.removeprefix("releases/tags/")
            matches = [
                release
                for release in self.releases.values()
                if release["tag_name"] == tag and not release["draft"]
            ]
            if not matches:
                raise rc.GitHubError("HTTP 404", True)
            return deepcopy(matches[0])
        if path == "git/refs" and method == "POST":
            tag = body["ref"].removeprefix("refs/tags/")
            if tag in self.refs:
                raise rc.GitHubError("HTTP 422 already exists")
            self.refs[tag] = {
                "ref": body["ref"],
                "object": {"type": "commit", "sha": body["sha"]},
            }
            return deepcopy(self.refs[tag])
        if path == "releases" and method == "POST":
            release_id = max(self.releases) + 1
            self.releases[release_id] = {
                **body,
                "id": release_id,
                "html_url": f"https://github.com/{REPO}/releases/tag/{body['tag_name']}",
            }
            self.assets[release_id] = []
            return deepcopy(self.releases[release_id])
        if path.startswith("releases/") and method == "PATCH":
            release_id = int(path.split("/")[1])
            self.releases[release_id].update(body)
            return deepcopy(self.releases[release_id])
        raise AssertionError(f"Unexpected API call {method} {path}")

    optional = rc.GitHub.optional

    def pages(self, path, field=None):
        """Return complete in-memory endpoint collections for the release engine."""
        assert field in (None, "jobs", "artifacts")
        if path.endswith("/jobs"):
            return deepcopy(self.jobs)
        if path.endswith("/artifacts"):
            return deepcopy(self.artifacts)
        if path.startswith("releases/") and path.endswith("/assets"):
            return deepcopy(self.assets[int(path.split("/")[1])])
        if path == "releases":
            return deepcopy(list(self.releases.values()))
        if path == "tags":
            return [{"name": tag} for tag in self.refs]
        raise AssertionError(f"Unexpected pages call {path}")

    def binary(self, path):
        """Return the exact stored release asset or immutable artifact bytes."""
        if path.startswith("releases/assets/"):
            return self.files[int(path.split("/")[2])]
        if path == "actions/artifacts/40/zip":
            return self.archive
        raise AssertionError(f"Unexpected download {path}")

    def download_asset(self, path, output):
        """Write the stored bytes through the release client's streaming contract."""
        output.write(self.binary(path))

    def upload(self, tag, path):
        """Model asset upload and optionally corrupt its server-side bytes."""
        self.writes.append(("upload", tag, path.name))
        release_id = next(
            key for key, value in self.releases.items() if value["tag_name"] == tag
        )
        asset_id = max(self.files) + 1
        data = path.read_bytes()
        self.files[asset_id] = b"x" * len(data) if self.corrupt_upload else data
        self.assets[release_id].append(
            {"id": asset_id, "name": path.name, "size": len(data), "state": "uploaded"}
        )


# Each public method covers an independent adversarial release condition.
# pylint: disable-next=too-many-public-methods
class ReleaseControlTests(unittest.TestCase):
    """Exercise publication sequencing and adversarial promotion inputs."""

    def setUp(self):
        # enterContext also closes the directory when a test or setup fails.
        # pylint: disable-next=consider-using-with
        self.directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.event = self.directory / "event.json"
        self.event.write_text(json.dumps({"inputs": {"channel": "stable"}}))
        environment = {
            "GITHUB_ACTIONS": "true",
            "GITHUB_REPOSITORY": REPO,
            "GITHUB_RUN_ID": "99",
            "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_REF": "refs/heads/main",
            "GITHUB_EVENT_NAME": "workflow_dispatch",
            "GITHUB_WORKFLOW_REF": f"{REPO}/{rc.WORKFLOW}@refs/heads/main",
            "GITHUB_EVENT_PATH": str(self.event),
        }
        self.enterContext(patch.dict(os.environ, environment))
        self.enterContext(patch.object(rc, "checked_out_sha", return_value=SHA))
        self.gh = FakeGitHub()
        self.enterContext(patch.object(rc, "GitHub", return_value=self.gh))
        self.args = argparse.Namespace(repo=REPO, rc=RC_TAG, run_id="99")

    def reject_promotion(self):
        """Require invalid promotion to fail before making any remote writes."""
        with self.assertRaises(rc.ReleaseError):
            rc.promote(self.args)
        self.assertEqual(
            self.gh.writes, [], "Rejected promotion performed remote writes"
        )

    def test_promote_copies_exact_candidate_bytes_then_publishes_latest(self):
        """Promote copies exact candidate bytes then publishes latest."""
        result = rc.promote(self.args)
        self.assertEqual(result["tag"], "v1.2.3")
        stable = next(
            release
            for release in self.gh.releases.values()
            if release["tag_name"] == "v1.2.3"
        )
        self.assertFalse(stable["draft"])
        self.assertFalse(stable["prerelease"])
        self.assertEqual(stable["make_latest"], "true")
        source = {
            asset["name"]: self.gh.files[asset["id"]] for asset in self.gh.assets[10]
        }
        published = {
            asset["name"]: self.gh.files[asset["id"]]
            for asset in self.gh.assets[stable["id"]]
        }
        self.assertEqual(source, published)
        self.assertEqual(
            self.gh.writes[0],
            ("git/refs", "POST", {"ref": "refs/tags/v1.2.3", "sha": SHA}),
        )
        self.assertEqual(self.gh.writes[-1][1], "PATCH")

    def test_workflow_drift_rejects_promotion_without_stranding_stable_tag(self):
        """Known historical-workflow denial must not consume the stable identity."""
        self.gh.default_head = "b" * 40
        self.gh.github_directories[self.gh.default_head][0]["sha"] = "d" * 40
        with patch.object(
            self.gh, "download_asset", wraps=self.gh.download_asset
        ) as download:
            self.reject_promotion()
        download.assert_not_called()
        self.assertNotIn("v1.2.3", self.gh.refs)

    def test_older_rc_with_identical_workflows_keeps_exact_candidate_bytes(self):
        """Unrelated source changes do not prevent promotion of an accepted RC."""
        self.gh.default_head = "b" * 40
        self.test_promote_copies_exact_candidate_bytes_then_publishes_latest()

    def test_promotion_waits_for_fresh_active_run_and_keeps_rc_bytes(self):
        """A stale post-approval status delays, rather than bypasses, promotion."""
        original_api = self.gh.api
        statuses = iter(("waiting", "queued", "in_progress"))

        def delayed(path, method="GET", body=None):
            value = original_api(path, method, body)
            if path == "actions/runs/99":
                value["status"] = next(statuses)
            return value

        with (
            patch.object(self.gh, "api", side_effect=delayed),
            patch.object(rc.time, "sleep") as sleep,
            patch.object(rc.time, "monotonic", return_value=0),
        ):
            result = rc.promote(self.args)
        self.assertEqual(sleep.call_count, 2)
        stable = next(
            item
            for item in self.gh.releases.values()
            if item["tag_name"] == result["tag"]
        )
        expected = {a["name"]: self.gh.files[a["id"]] for a in self.gh.assets[10]}
        actual = {
            a["name"]: self.gh.files[a["id"]] for a in self.gh.assets[stable["id"]]
        }
        self.assertEqual(actual, expected)

    def test_candidate_waits_for_fresh_active_run_before_gate(self):
        """The unversioned publisher uses the same bounded execution check."""
        self.event.write_text(json.dumps({"inputs": {"channel": "rc"}}))
        assets = self.directory / "candidate"
        assets.mkdir()
        (assets / "candidate.zip").write_bytes(b"candidate-build")
        args = argparse.Namespace(
            repo=REPO,
            channel="rc",
            version="2.0.0",
            sha=SHA,
            run_id="99",
            run_attempt="1",
            sequence=None,
            assets=str(assets),
        )
        original_api = self.gh.api
        statuses = iter(("requested", "in_progress"))

        def delayed(path, method="GET", body=None):
            value = original_api(path, method, body)
            if path == "actions/runs/99":
                value["status"] = next(statuses)
            return value

        with (
            patch.object(self.gh, "api", side_effect=delayed),
            patch.object(rc.time, "sleep") as sleep,
            patch.object(rc.time, "monotonic", return_value=0),
            patch.object(rc, "EVIDENCE", self.directory / "evidence" / rc.MANIFEST),
        ):
            result = rc.candidate(args)
        self.assertEqual(sleep.call_count, 1)
        self.assertTrue(result["tag"].startswith("v2.0.0-rc."))

    def test_untrusted_source_runs_never_write(self):
        """Untrusted source runs never write."""
        cases = [
            {"conclusion": "failure"},
            {"conclusion": "skipped"},
            {"status": "in_progress"},
            {"head_sha": "b" * 40},
            {"head_branch": "feature"},
            {"event": "pull_request_target"},
            {"event": "push"},
            {"path": ".github/workflows/unrelated.yml"},
            {"run_attempt": 2},
            {"repository": {"full_name": "fork/project"}},
            {"head_repository": {"full_name": "fork/project"}},
        ]
        for change in cases:
            with self.subTest(change=change):
                self.gh.runs[17] = {**run(), **change}
                self.reject_promotion()

    def test_gate_must_explicitly_succeed_for_source_sha(self):
        """Gate must explicitly succeed for source sha."""
        valid = deepcopy(self.gh.jobs[0])
        for jobs in (
            [],
            [valid, valid],
            [{**valid, "conclusion": "skipped"}],
            [{**valid, "conclusion": "failure"}],
            [{**valid, "status": "queued"}],
            [{**valid, "head_sha": "b" * 40}],
            [{**valid, "name": "Almost release gate"}],
        ):
            with self.subTest(jobs=jobs):
                self.gh.jobs = jobs
                self.reject_promotion()

    def test_candidate_checksum_change_never_writes(self):
        """Candidate checksum change never writes."""
        self.gh.files[20] = b"different-bytes!!!!\x00"
        self.reject_promotion()

    def test_manifest_rewrite_cannot_forge_actions_evidence(self):
        """Manifest rewrite cannot forge actions evidence."""
        forged = manifest()
        forged["assets"][0]["sha256"] = "f" * 64
        self.gh.files[21] = rc.json_bytes(forged)
        self.reject_promotion()

    def test_missing_expired_duplicated_or_corrupt_evidence_never_writes(self):
        """Missing expired duplicated or corrupt evidence never writes."""
        valid = deepcopy(self.gh.artifacts[0])
        for artifacts in (
            [],
            [{**valid, "expired": True}],
            [valid, valid],
            [{**valid, "digest": None}],
            [{**valid, "digest": "sha256:" + "a" * 64}],
            [{**valid, "workflow_run": {"id": 5, "head_sha": SHA}}],
        ):
            with self.subTest(artifacts=artifacts):
                self.gh.artifacts = artifacts
                self.reject_promotion()

    def test_reviewers_are_required(self):
        """Reviewers are required."""
        for environment in (
            {"name": "release", "protection_rules": []},
            {
                "name": "release",
                "protection_rules": [{"type": "wait_timer", "wait_timer": 1}],
            },
            {
                "name": "release",
                "protection_rules": [{"type": "required_reviewers", "reviewers": []}],
            },
        ):
            with self.subTest(environment=environment):
                self.gh.environment = environment
                self.reject_promotion()

    def test_manual_stable_context_required(self):
        """Manual stable context required."""
        for key, value in (
            ("GITHUB_ACTIONS", "false"),
            ("GITHUB_RUN_ID", "17"),
            ("GITHUB_REF", "refs/heads/feature"),
            ("GITHUB_EVENT_NAME", "push"),
            ("GITHUB_WORKFLOW_REF", "wrong"),
            ("GITHUB_RUN_ATTEMPT", "2"),
        ):
            with self.subTest(key=key), patch.dict(os.environ, {key: value}):
                self.reject_promotion()
        self.event.write_text(json.dumps({"inputs": {"channel": "rc"}}))
        self.reject_promotion()

    def test_checkout_sha_must_match_current_run(self):
        """Checkout sha must match current run."""
        with patch.object(rc, "checked_out_sha", return_value="b" * 40):
            self.reject_promotion()

    def test_stable_tag_collision_never_overwrites(self):
        """Stable tag collision never overwrites."""
        self.gh.refs["v1.2.3"] = {
            "ref": "refs/tags/v1.2.3",
            "object": {"type": "commit", "sha": SHA},
        }
        self.reject_promotion()

    def test_draft_collision_never_overwrites(self):
        """Draft collision never overwrites."""
        self.gh.releases[11] = {"id": 11, "tag_name": "v1.2.3", "draft": True}
        self.reject_promotion()

    def test_candidate_snapshot_mutation_never_writes(self):
        """Candidate snapshot mutation never writes."""
        self.gh.mutate_snapshot = True
        self.reject_promotion()

    def test_extra_release_asset_never_writes(self):
        """Extra release asset never writes."""
        self.gh.assets[10].append(
            {"name": "surprise.txt", "id": 44, "state": "uploaded", "size": 0}
        )
        self.reject_promotion()

    def test_corrupt_upload_leaves_draft_and_does_not_publish(self):
        """Corrupt upload leaves draft and does not publish."""
        self.gh.corrupt_upload = True
        with self.assertRaisesRegex(rc.ReleaseError, "Uploaded bytes differ"):
            rc.promote(self.args)
        stable = next(
            release
            for release in self.gh.releases.values()
            if release["tag_name"] == "v1.2.3"
        )
        self.assertTrue(stable["draft"])
        self.assertFalse(any(write[1] == "PATCH" for write in self.gh.writes))

    def test_candidate_channels_publish_unique_prereleases(self):
        """Candidate channels publish unique prereleases."""
        for channel in ("nightly", "beta", "rc"):
            with self.subTest(channel=channel):
                self.gh.runs[99]["status"] = "in_progress"
                self.event.write_text(json.dumps({"inputs": {"channel": channel}}))
                assets = self.directory / channel
                assets.mkdir()
                (assets / "candidate.zip").write_bytes(b"candidate-build")
                args = argparse.Namespace(
                    repo=REPO,
                    channel=channel,
                    version="2.0.0",
                    sha=SHA,
                    run_id="99",
                    run_attempt="1",
                    sequence=None,
                    assets=str(assets),
                )
                with patch.object(
                    rc, "EVIDENCE", self.directory / "evidence" / rc.MANIFEST
                ):
                    result = rc.candidate(args)
                self.assertEqual(result["status"], "published")
                released = next(
                    value
                    for value in self.gh.releases.values()
                    if value["tag_name"] == result["tag"]
                )
                self.assertTrue(released["prerelease"])
                self.assertFalse(released["draft"])
                self.assertEqual(released["make_latest"], "false")
                self.assertTrue(result["tag"].startswith(f"v2.0.0-{channel}."))

    def test_invalid_candidate_notes_preserve_existing_evidence(self):
        """Notes are a precondition for persistent evidence as well as GitHub writes."""
        self.gh.runs[99]["status"] = "in_progress"
        self.event.write_text(json.dumps({"inputs": {"channel": "beta"}}))
        assets = self.directory / "notes-assets"
        assets.mkdir()
        (assets / "candidate.zip").write_bytes(b"candidate-build")
        evidence = self.directory / "existing-evidence"
        evidence.write_bytes(b"previous successful release")
        args = argparse.Namespace(
            repo=REPO,
            channel="beta",
            version="2.0.0",
            sha=SHA,
            run_id="99",
            run_attempt="1",
            sequence=None,
            assets=str(assets),
        )
        with (
            patch.object(rc, "EVIDENCE", evidence),
            patch.object(
                rc, "release_notes", side_effect=rc.ReleaseError("missing notes")
            ),
            self.assertRaisesRegex(rc.ReleaseError, "missing notes"),
        ):
            rc.candidate(args)
        self.assertEqual(evidence.read_bytes(), b"previous successful release")
        self.assertEqual(self.gh.writes, [])

    def test_legacy_automatic_candidate_never_writes_evidence_when_superseded(self):
        """Both publication entry points apply the same early and final guard."""
        assets = self.directory / "automatic"
        assets.mkdir()
        (assets / "candidate.zip").write_bytes(b"candidate-build")
        evidence = self.directory / "evidence" / rc.MANIFEST
        args = argparse.Namespace(
            repo=REPO,
            channel="beta",
            version="2.0.0",
            sha=SHA,
            run_id="99",
            run_attempt="1",
            sequence=None,
            assets=str(assets),
        )
        self.gh.runs[99]["event"] = "push"
        os.environ["GITHUB_EVENT_NAME"] = "push"
        original = rc.stage_assets

        def advance():
            self.gh.default_head = "b" * 40
            self.gh.successors = [
                {
                    **run(100, False),
                    "head_sha": "b" * 40,
                    "event": "push",
                }
            ]

        for late in (True, False):
            self.gh.default_head = SHA

            def staged(*values):
                result = original(*values)
                advance()
                return result

            if not late:
                advance()
            with (
                patch.object(rc, "stage_assets", side_effect=staged),
                patch.object(rc, "EVIDENCE", evidence),
            ):
                result = rc.candidate(args)
            self.assertEqual(result["status"], "superseded")
            self.assertEqual(self.gh.writes, [])
            self.assertFalse(evidence.exists())

    def test_candidate_base_cannot_already_be_stable(self):
        """Candidate base cannot already be stable."""
        self.gh.refs["v2.0.0"] = {
            "ref": "refs/tags/v2.0.0",
            "object": {"type": "commit", "sha": SHA},
        }
        for channel in ("beta", "rc"):
            with self.subTest(channel=channel):
                self.event.write_text(json.dumps({"inputs": {"channel": channel}}))
                args = argparse.Namespace(
                    repo=REPO,
                    channel=channel,
                    version="2.0.0",
                    sha=SHA,
                    run_id="99",
                    run_attempt="1",
                    sequence=None,
                    assets=str(self.directory),
                )
                with self.assertRaisesRegex(rc.ReleaseError, "Tag already exists"):
                    rc.candidate(args)
                self.assertEqual(self.gh.writes, [])

    def test_rc_creation_rejects_source_policy_blockers_before_writes(self):
        """Rc creation rejects source policy blockers before writes."""
        self.event.write_text(json.dumps({"inputs": {"channel": "rc"}}))
        args = argparse.Namespace(
            repo=REPO,
            channel="rc",
            version="2.0.0",
            sha=SHA,
            run_id="99",
            run_attempt="1",
            sequence=None,
            assets=str(self.directory),
        )
        for field in ("release_blockers", "stable_blockers"):
            with self.subTest(field=field):
                self.gh.source_policies[SHA] = {
                    **policy(),
                    field: ["Integration coverage is missing"],
                }
                with self.assertRaisesRegex(rc.ReleaseError, field):
                    rc.candidate(args)
                self.assertEqual(self.gh.writes, [])

    def test_exploratory_candidates_record_blockers_without_qualifying_for_stable(self):
        """Exploratory candidates record blockers without qualifying for stable."""
        blocked = {**policy(), "stable_blockers": ["Hardware validation is missing"]}
        self.gh.source_policies[SHA] = blocked
        for channel in ("nightly", "beta"):
            with self.subTest(channel=channel):
                self.event.write_text(json.dumps({"inputs": {"channel": channel}}))
                assets = self.directory / channel
                assets.mkdir()
                (assets / "package.zip").write_bytes(b"experimental-build")
                args = argparse.Namespace(
                    repo=REPO,
                    channel=channel,
                    version="2.0.0",
                    sha=SHA,
                    run_id="99",
                    run_attempt="1",
                    sequence=None,
                    assets=str(assets),
                )
                with patch.object(
                    rc, "EVIDENCE", self.directory / "evidence" / rc.MANIFEST
                ):
                    result = rc.candidate(args)
                release_id = next(
                    key
                    for key, release in self.gh.releases.items()
                    if release["tag_name"] == result["tag"]
                )
                manifest_id = next(
                    asset["id"]
                    for asset in self.gh.assets[release_id]
                    if asset["name"] == rc.MANIFEST
                )
                recorded = json.loads(self.gh.files[manifest_id])
                self.assertEqual(recorded["source_policy"], policy_snapshot(blocked))
                with self.assertRaises(rc.ReleaseError):
                    rc.validate_policy_snapshot(recorded["source_policy"], REPO)

    def test_old_source_blockers_cannot_be_cleared_by_current_policy(self):
        """Old source blockers cannot be cleared by current policy."""
        newer_sha = "b" * 40
        self.gh.runs[99]["head_sha"] = newer_sha
        self.gh.source_policies[newer_sha] = policy()
        self.gh.source_policies[SHA] = {
            **policy(),
            "stable_blockers": ["Original source had no integration tests"],
        }
        with patch.object(rc, "checked_out_sha", return_value=newer_sha):
            self.reject_promotion()
        self.assertEqual(self.gh.policy_reads, [SHA])

    def test_policy_snapshot_content_must_match_the_original_commit(self):
        """Policy snapshot content must match the original commit."""
        self.gh.source_policies[SHA] = {
            **policy(),
            "validation_workflows": ["different-ci.yml"],
        }
        with self.assertRaisesRegex(rc.ReleaseError, "snapshot differs"):
            rc.promote(self.args)
        self.assertEqual(self.gh.writes, [])

    def test_source_mode_must_be_release(self):
        """Source mode must be release."""
        for mode in ("validation-only", None):
            with self.subTest(mode=mode):
                self.gh.source_policies[SHA] = {**policy(), "mode": mode}
                self.reject_promotion()

    def test_legacy_rc_without_immutable_policy_snapshot_is_rejected(self):
        """Legacy rc without immutable policy snapshot is rejected."""
        legacy = manifest()
        legacy.pop("source_policy")
        raw = rc.json_bytes(legacy)
        self.gh.files[21] = raw
        self.gh.assets[10][1]["size"] = len(raw)
        self.gh.set_evidence(raw)
        self.reject_promotion()


class PublicationPermissionTests(unittest.TestCase):
    """Publication credentials fail closed before any ledger or release mutation."""

    @staticmethod
    def probe(scopes="repo, workflow", **repository):
        """Return captured permission headers, never a real credential."""
        body = {"full_name": REPO, "private": False, "permissions": {"push": True}}
        body.update(repository)
        header = "HTTP/2.0 200 OK\r\nX-OAuth-Scopes: " + scopes + "\r\n\r\n"
        return subprocess.CompletedProcess([], 0, header.encode() + rc.json_bytes(body))

    def test_default_token_does_not_change_or_probe(self):
        """Consumers that did not opt in preserve their GITHUB_TOKEN behavior."""
        with (
            patch.dict(os.environ, {"RELEASE_REQUIRE_WORKFLOW_SCOPE": ""}),
            patch.object(rc.subprocess, "run") as command,
        ):
            gh = rc.GitHub(REPO)
        self.assertFalse(gh.workflow_scope_verified)
        command.assert_not_called()

    def test_scoped_classic_token_probe_is_read_only_and_secret_safe(self):
        """Both public-only and repo scopes work without credentials in arguments."""
        for scopes in ("repo, workflow", "public_repo, workflow"):
            with (
                self.subTest(scopes=scopes),
                patch.dict(
                    os.environ,
                    {
                        # Deliberate test credential, never used for authentication.
                        "GH_TOKEN": "test-secret",  # nosec B105
                        "RELEASE_REQUIRE_WORKFLOW_SCOPE": "true",
                    },
                ),
                patch.object(
                    rc.subprocess, "run", return_value=self.probe(scopes)
                ) as command,
            ):
                gh = rc.GitHub(REPO)
                self.assertTrue(gh.workflow_scope_verified)
                rc.check_workflow_publication(gh, SHA)
            self.assertEqual(command.call_count, 1)
            self.assertEqual(
                command.call_args.args[0],
                [
                    "gh",
                    "api",
                    "--hostname",
                    "github.com",
                    "--method",
                    "GET",
                    "--include",
                    "--",
                    "repos/" + REPO,
                ],
            )
            self.assertNotIn("test-secret", str(command.call_args))

    def test_scope_or_repository_mismatch_rejects_before_write(self):
        """Missing scopes, fine-grained tokens and read-only access cannot publish."""
        cases = [
            self.probe("repo"),
            self.probe("workflow"),
            self.probe(""),
            self.probe("public_repo, workflow", private=True),
            self.probe(full_name="other/project"),
            self.probe(permissions={"push": False}),
        ]
        for response in cases:
            with (
                self.subTest(response=response.stdout),
                patch.dict(
                    os.environ,
                    {
                        # Deliberate test credential, never used for authentication.
                        "GH_TOKEN": "test-secret",  # nosec B105
                        "RELEASE_REQUIRE_WORKFLOW_SCOPE": "true",
                    },
                ),
                patch.object(rc.subprocess, "run", return_value=response) as command,
                self.assertRaises(rc.ReleaseError),
            ):
                rc.GitHub(REPO)
            self.assertEqual(command.call_count, 1)
            self.assertEqual(command.call_args.args[0][5], "GET")

    def test_missing_secret_never_uses_a_fallback_identity(self):
        """An empty selected Actions secret must fail before gh can fall back."""
        with (
            patch.dict(
                # Deliberate test credential, never used for authentication.
                os.environ,
                {"GH_TOKEN": "", "RELEASE_REQUIRE_WORKFLOW_SCOPE": "true"},  # nosec B105
            ),
            patch.object(rc.subprocess, "run") as command,
            self.assertRaises(rc.ReleaseError),
        ):
            rc.GitHub(REPO)
        command.assert_not_called()

    def test_failed_reprobe_clears_previous_workflow_authorization(self):
        """A previously scoped client cannot retain authorization after a failed probe."""
        with (
            patch.dict(
                os.environ,
                # Deliberate test credential, never used for authentication.
                {"GH_TOKEN": "test-secret", "RELEASE_REQUIRE_WORKFLOW_SCOPE": "true"},  # nosec B105
            ),
            patch.object(rc.subprocess, "run", return_value=self.probe()) as command,
        ):
            gh = rc.GitHub(REPO)
            command.return_value = self.probe("repo")
            with self.assertRaises(rc.ReleaseError):
                gh.verify_publication_permissions()
            self.assertFalse(gh.workflow_scope_verified)

    def test_probe_failure_does_not_print_payload_or_auth_diagnostics(self):
        """The permission probe never returns raw potentially sensitive diagnostics."""
        response = subprocess.CompletedProcess(
            [], 1, b"private response", b"test-secret"
        )
        with (
            patch.dict(
                os.environ,
                # Deliberate test credential, never used for authentication.
                {"GH_TOKEN": "test-secret", "RELEASE_REQUIRE_WORKFLOW_SCOPE": "true"},  # nosec B105
            ),
            patch.object(rc.subprocess, "run", return_value=response),
            self.assertRaises(rc.ReleaseError) as error,
        ):
            rc.GitHub(REPO)
        self.assertEqual(
            str(error.exception), "Publication token permission probe failed"
        )

    def test_api_error_identifies_method_and_route_without_body(self):
        """Future publication failures identify the operation without a debug dump."""
        with patch.dict(os.environ, {"RELEASE_REQUIRE_WORKFLOW_SCOPE": ""}):
            gh = rc.GitHub(REPO)
        with (
            patch.object(
                rc.subprocess,
                "run",
                return_value=http_response(
                    403, b"private body",
                    "gh: Resource not accessible by integration (HTTP {status})",
                ),
            ),
            self.assertRaises(rc.GitHubError) as error,
        ):
            gh.api("git/refs", "POST", {"private": "request body"})
        self.assertIn("POST repos/example/project/git/refs: ", str(error.exception))
        self.assertNotIn("private", str(error.exception))


class WorkflowPublicationTests(unittest.TestCase):
    """Check historical-source permission preflight without performing writes."""

    def setUp(self):
        self.gh = FakeGitHub()
        self.gh.default_head = "b" * 40

    def test_current_source_does_not_download_workflow_inventories(self):
        """The common current-HEAD path needs only repository and ref metadata."""
        with patch.object(self.gh, "api", wraps=self.gh.api) as read:
            rc.check_workflow_publication(self.gh, self.gh.default_head)
        self.assertEqual(
            [call.args[0] for call in read.call_args_list], ["", "git/ref/heads/main"]
        )
        self.assertEqual(self.gh.writes, [])

    def test_workflow_directory_metadata_must_be_regular_and_unambiguous(self):
        """Missing, replaced and truncated directory inventories fail closed."""
        original = self.gh.github_directories[SHA][0]
        cases = (
            [],
            {},
            [None],
            [original, original],
            [original] * 1000,
            [{**original, "type": "symlink"}],
            [{**original, "type": "file"}],
            [{**original, "name": "other"}],
            [{**original, "path": ".github/other"}],
            [{**original, "sha": "main"}],
            [{**original, "sha": None}],
        )
        for sha in (SHA, self.gh.default_head):
            for entries in cases:
                with self.subTest(sha=sha, entries=entries):
                    self.gh.github_directories[sha] = entries
                    with self.assertRaises(rc.ReleaseError):
                        rc.check_workflow_publication(self.gh, SHA)
                    self.assertEqual(self.gh.writes, [])
            self.gh.github_directories[sha] = [original]

    def test_missing_directory_and_transport_errors_do_not_mean_equal_trees(self):
        """A missing API resource cannot stand in for an empty workflow tree."""
        original = self.gh.api
        for error in (rc.GitHubError("HTTP 404", True), rc.GitHubError("HTTP 403")):
            with self.subTest(error=str(error)):

                def failed_directory(path, method="GET", body=None, failure=error):
                    if path.startswith("contents/.github?"):
                        raise failure
                    return original(path, method, body)

                with patch.object(self.gh, "api", side_effect=failed_directory):
                    with self.assertRaises(rc.GitHubError):
                        rc.check_workflow_publication(self.gh, SHA)
                self.assertEqual(self.gh.writes, [])

    def test_branch_change_during_workflow_lookup_is_rejected(self):
        """The immutable tree comparison must still describe the fresh branch head."""
        original = self.gh.api

        def advanced(path, method="GET", body=None):
            result = original(path, method, body)
            if path == f"contents/.github?ref={'b' * 40}":
                self.gh.default_head = "d" * 40
            return result

        with patch.object(self.gh, "api", side_effect=advanced):
            with self.assertRaisesRegex(rc.ReleaseError, "changed during publication"):
                rc.check_workflow_publication(self.gh, SHA)
        self.assertEqual(self.gh.writes, [])

    def test_environment_flag_alone_does_not_authorize_historical_workflows(self):
        """Only the successful token probe can grant the existing exception."""
        self.gh.github_directories[self.gh.default_head][0]["sha"] = "d" * 40
        with patch.dict(os.environ, {"RELEASE_REQUIRE_WORKFLOW_SCOPE": "true"}):
            with self.assertRaisesRegex(rc.ReleaseError, "workflows differ"):
                rc.check_workflow_publication(self.gh, SHA)
        self.assertEqual(self.gh.writes, [])

    def test_publish_boundary_rechecks_before_creating_a_tag(self):
        """A branch advance after the earlier check cannot strand a public tag."""
        rc.check_workflow_publication(self.gh, SHA)
        self.gh.github_directories[self.gh.default_head][0]["sha"] = "d" * 40
        with tempfile.TemporaryDirectory() as temp:
            stage = Path(temp)
            (stage / "package.bin").write_bytes(b"accepted bytes")
            with self.assertRaisesRegex(rc.ReleaseError, "workflows differ"):
                rc.publish(self.gh, "v1.2.3", SHA, stage, False, "")
        self.assertEqual(self.gh.writes, [])
        self.assertNotIn("v1.2.3", self.gh.refs)


class TransportTests(unittest.TestCase):
    """Reject CLI argument and path injection before a subprocess can execute."""

    def test_repository_cannot_supply_host_or_options(self):
        """An explicit github.com owner/repository identity is mandatory."""
        for repo in (
            "--hostname/evil",
            "evil.com/owner/repo",
            "owner/repo --help",
            "../repo",
        ):
            with self.subTest(repo=repo), self.assertRaises(rc.ReleaseError):
                rc.GitHub(repo)

    def test_api_routes_methods_and_traversal_fail_before_execution(self):
        """Neither flags, URLs, query fields nor encoded traversal become API routes."""
        gh = rc.GitHub(REPO)
        for path, method, body in (
            ("--hostname=evil.com", "GET", None),
            ("https://evil.com/repos/owner/repo", "GET", None),
            ("../../other/repo/releases", "GET", None),
            ("releases?hostname=evil.com", "GET", None),
            (f"compare/{SHA}...main%2F..%2F..%2Freleases", "GET", None),
            ("releases", "--hostname", None),
            ("releases", "DELETE", None),
            ("", "POST", {}),
            ("releases", "GET", {"draft": False}),
        ):
            with (
                self.subTest(path=path, method=method),
                patch.object(rc.subprocess, "run") as command,
                self.assertRaises(rc.ReleaseError),
            ):
                gh.api(path, method, body)
            command.assert_not_called()

    def test_default_endpoint_and_json_body_have_fixed_argument_boundaries(self):
        """A hostile body remains stdin data, never command-line options."""
        gh = rc.GitHub(REPO)
        body = {"body": "--hostname evil.com --clobber #label"}
        with patch.object(
            rc.subprocess, "run", return_value=http_response()
        ) as command:
            gh.api("")
            gh.api("releases", "POST", body)
        root_call, create_call = command.call_args_list
        self.assertEqual(
            root_call.args[0],
            [
                "gh",
                "api",
                "--hostname",
                "github.com",
                "--include",
                "--method",
                "GET",
                "--",
                f"repos/{REPO}",
            ],
        )
        self.assertEqual(
            create_call.args[0][-4:], ["--input", "-", "--", f"repos/{REPO}/releases"]
        )
        self.assertEqual(create_call.kwargs["input"], rc.json_bytes(body))
        self.assertNotIn(body["body"], create_call.args[0])

    def test_expected_release_routes_remain_available(self):
        """Preserve every internal REST resource, including encoded default branches."""
        gh = rc.GitHub(REPO)
        paths = [
            "",
            "tags",
            "releases",
            "releases/10",
            "releases/10/assets",
            "releases/assets/21",
            f"releases/tags/{RC_TAG}",
            f"git/ref/tags/{RC_TAG}",
            "environments/release",
            "actions/runs/17",
            "actions/runs/17/artifacts",
            "actions/runs/17/attempts/2/jobs",
            "actions/artifacts/40/zip",
            f"contents/{rc.POLICY}?ref={SHA}",
            f"contents/.github?ref={SHA}",
            f"compare/{SHA}...feature%2Fbranch",
        ]
        with patch.object(
            rc.subprocess, "run", return_value=http_response()
        ) as command:
            for path in paths:
                gh.api(path)
            gh.api("git/refs", "POST", {"ref": f"refs/tags/{RC_TAG}", "sha": SHA})
            gh.api("releases/10", "PATCH", {"draft": False})
        self.assertEqual(command.call_count, len(paths) + 2)

    def test_upload_rejects_tags_labels_symlinks_and_unstaged_paths(self):
        """Only a regular asset in the private staging directory can reach gh."""
        gh = rc.GitHub(REPO)
        with tempfile.TemporaryDirectory(prefix="release-candidate-") as temp:
            root = Path(temp)
            asset = root / "package.tar.gz"
            asset.write_bytes(b"package")
            link = root / "link.tar.gz"
            link.symlink_to(asset)
            nested = root / "nested"
            nested.mkdir()
            (nested / asset.name).write_bytes(b"package")
            invalid = [
                ("--clobber", asset),
                ("v1.2.3-rc.01", asset),
                ("v1.2.3#label", asset),
                ("v1.2.٣-rc.2", asset),
                (RC_TAG, link),
                (RC_TAG, nested / asset.name),
                (RC_TAG, Path(asset.name)),
                (RC_TAG, root),
            ]
            for name in ("package.tar.gz#label", "--clobber", "asset*.tar.gz"):
                path = root / name
                path.write_bytes(b"package")
                invalid.append((RC_TAG, path))
            for tag, path in invalid:
                with (
                    self.subTest(tag=tag, path=path),
                    patch.object(rc.subprocess, "run") as command,
                    self.assertRaises(rc.ReleaseError),
                ):
                    gh.upload(tag, path)
                command.assert_not_called()

    def test_upload_never_overwrites_or_retries_an_existing_asset(self):
        """Keep the gh no-clobber default even when GitHub rejects an existing asset."""
        gh = rc.GitHub(REPO)
        with tempfile.TemporaryDirectory(prefix="release-promote-") as temp:
            asset = Path(temp) / "package.tar.gz"
            asset.write_bytes(b"package")
            with (
                patch.object(
                    rc.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(
                        [], 1, stderr=b"HTTP 422 already_exists"
                    ),
                ) as command,
                self.assertRaises(rc.GitHubError),
            ):
                gh.upload("v1.2.3", asset)
            command.assert_called_once_with(
                [
                    "gh",
                    "release",
                    "upload",
                    "--repo",
                    f"github.com/{REPO}",
                    "--",
                    "v1.2.3",
                    str(asset.resolve()),
                ],
                capture_output=True,
                check=False,
            )

    def test_upload_parse_failure_keeps_draft_and_reports_safe_asset_context(self):
        """A committed upload with a broken response must not be retried or published."""
        gh = FakeGitHub()
        client = rc.GitHub(REPO)
        tag = "v1.2.3-beta.7"

        def accepted_upload_then_failed_response(upload_tag, path):
            FakeGitHub.upload(gh, upload_tag, path)
            client.upload(upload_tag, path)

        with tempfile.TemporaryDirectory(prefix="release-versioned-") as temp:
            asset = Path(temp) / rc.MANIFEST
            asset.write_bytes(b"private package bytes")
            with (
                # Deliberate test credential, never used for authentication.
                patch.dict(os.environ, {"GH_TOKEN": "private-token-fixture"}),  # nosec B105
                patch.object(
                    gh, "upload", side_effect=accepted_upload_then_failed_response
                ) as upload,
                patch.object(
                    rc.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(
                        [], 1, b"private response body", b"unexpected end of JSON input"
                    ),
                ) as command,
                self.assertRaises(rc.GitHubError) as error,
            ):
                rc.publish(gh, tag, SHA, Path(temp), True, "private release body")
            release_id = next(
                key
                for key, release in gh.releases.items()
                if release["tag_name"] == tag
            )
            self.assertTrue(gh.releases[release_id]["draft"])
            self.assertEqual(len(gh.assets[release_id]), 1)
            self.assertEqual(sum(write[0] == "upload" for write in gh.writes), 1)
            self.assertFalse(any(write[1] == "PATCH" for write in gh.writes))
            upload.assert_called_once_with(tag, asset)
            command.assert_called_once()
            self.assertNotIn("--clobber", command.call_args.args[0])
            self.assertNotIn(temp, str(error.exception))
            self.assertNotIn("private", str(error.exception))
            self.assertEqual(
                str(error.exception),
                f"upload {tag} {asset.name}: unexpected end of JSON input",
            )

    def test_canonical_numeric_fields_remain_ascii(self):
        """Reject Unicode digits after adopting concise regexes with ASCII flags."""
        for value in ("1.٢.3", "01.2.3", "1.2.3\n"):
            with self.subTest(version=value), self.assertRaises(rc.ReleaseError):
                rc.version(value)
        for value in ("1١", "１２", "01", True):
            with self.subTest(identifier=value), self.assertRaises(rc.ReleaseError):
                rc.positive(value, "run ID")
        for tag in (
            "v0.2.3",
            RC_TAG,
            "v1.2.3-beta.4",
            "v1.2.3-nightly.20260912000000.17.1",
        ):
            self.assertIsNotNone(rc.TAG_RE.fullmatch(tag))
        with self.assertRaises(rc.ReleaseError):
            rc.parse_json(b"\xff", "invalid UTF-8")


class OfflineValidationTests(unittest.TestCase):
    """Check parsing, staging and REST contracts without network access."""

    def test_restricted_suffixes_reject_every_asset_before_staging_copies(self):
        """Do not partially stage allowed files before finding a retired package."""
        restrictions = (
            {
                "suffixes": [".apk", ".aab"],
                "reason": "Android APK/AAB publication moved to another repository",
            },
        )
        for suffix in (".apk", ".APK", ".aab", ".AaB"):
            with (
                self.subTest(suffix=suffix),
                tempfile.TemporaryDirectory() as temp,
                patch.object(rc, "ASSET_RESTRICTIONS", restrictions),
            ):
                source, output = Path(temp) / "source", Path(temp) / "output"
                source.mkdir()
                output.mkdir()
                (source / "first.zip").write_bytes(b"allowed package")
                (source / ("retired" + suffix)).write_bytes(b"retired package")
                with self.assertRaisesRegex(
                    rc.ReleaseError, "APK/AAB publication moved"
                ):
                    rc.stage_assets(source, output)
                self.assertEqual(list(output.iterdir()), [])

    def test_retired_rc_payload_is_rejected_before_any_publication_client_call(self):
        """The current guard applies when promoting bytes from an older RC."""
        restrictions = (
            {"suffixes": [".apk", ".aab"], "reason": "APK/AAB publication moved"},
        )
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(rc, "ASSET_RESTRICTIONS", restrictions),
        ):
            stage = Path(temp)
            (stage / "retired.APK").write_bytes(b"previously verified RC payload")
            gh = Mock(spec_set=[])
            with self.assertRaisesRegex(rc.ReleaseError, "APK/AAB publication moved"):
                rc.publish(gh, "v1.2.3", SHA, stage, False, "")
            self.assertEqual(gh.mock_calls, [])

    def test_restrictions_leave_unrelated_suffixes_and_payload_bytes_unchanged(self):
        """Match literal filename endings rather than substrings or package content."""
        payloads = {
            "app.ipa": b"ios",
            "app.dmg": b"mac",
            "app.exe": b"windows",
            "app.tar.gz": b"web",
            "app.apk.zip": b"archive",
        }
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(
                rc,
                "ASSET_RESTRICTIONS",
                ({"suffixes": [".apk", ".aab"], "reason": "Retired Android package"},),
            ),
        ):
            source, output = Path(temp) / "source", Path(temp) / "output"
            source.mkdir()
            output.mkdir()
            for name, data in payloads.items():
                (source / name).write_bytes(data)
            assets = rc.stage_assets(source, output)
            self.assertEqual({item["name"] for item in assets}, set(payloads))
            for name, data in payloads.items():
                self.assertEqual((output / name).read_bytes(), data)

    def test_unconfigured_repository_can_still_stage_android_packages(self):
        """A retirement rule applies only to the repository declaring it."""
        with (
            tempfile.TemporaryDirectory() as temp,
            patch.object(rc, "ASSET_RESTRICTIONS", ()),
        ):
            source, output = Path(temp) / "source", Path(temp) / "output"
            source.mkdir()
            output.mkdir()
            (source / "app.apk").write_bytes(b"native Android app")
            self.assertEqual(rc.stage_assets(source, output)[0]["name"], "app.apk")

    def test_actions_zip_uses_default_accept_and_release_assets_use_binary_accept(self):
        """Actions zip uses default accept and release assets use binary accept."""
        gh = rc.GitHub(REPO)

        def service(command, **_kwargs):
            if command[-1].endswith("actions/artifacts/40/zip"):
                if "-H" in command:
                    return subprocess.CompletedProcess(
                        command, 1, stderr=b"HTTP 415 Unsupported Accept header"
                    )
                data = b"zip archive"
            else:
                self.assertIn("Accept: application/octet-stream", command)
                data = b"release asset"
            return http_response(stdout=data)

        with patch.object(rc.subprocess, "run", side_effect=service):
            self.assertEqual(gh.binary("actions/artifacts/40/zip"), b"zip archive")
            self.assertEqual(gh.binary("releases/assets/21"), b"release asset")
            with self.assertRaises(rc.ReleaseError):
                gh.binary("unexpected/endpoint")

    def test_source_policy_blob_hash_and_encoding_are_checked(self):
        """Source policy blob hash and encoding are checked."""
        gh = rc.GitHub(REPO)
        valid = policy_response(policy())
        for changes in (
            {"type": "symlink"},
            {"encoding": "none"},
            {"content": "!invalid!"},
            {"sha": "b" * 40},
            {"size": 0},
        ):
            with (
                self.subTest(changes=changes),
                patch.object(gh, "api", return_value={**valid, **changes}),
                self.assertRaises(rc.ReleaseError),
            ):
                rc.source_policy_snapshot(gh, SHA)

    def test_version_rejects_injection_and_noncanonical_values(self):
        """Version rejects injection and noncanonical values."""
        for value in (
            "01.2.3",
            "1.02.3",
            "1.2.03",
            "v1.2.3",
            "1.2",
            "1.2.3-rc.1",
            "1.2.3\n",
            "1.2.3; touch /tmp/owned",
            "$(id)",
        ):
            with self.subTest(value=value), self.assertRaises(rc.ReleaseError):
                rc.version(value)
        self.assertEqual(rc.version("0.0.0"), "0.0.0")

    def test_manifest_rejects_beta_nightly_bad_versions_and_unsafe_names(self):
        """Manifest rejects beta nightly bad versions and unsafe names."""
        for change in (
            {"channel": "beta"},
            {"channel": "nightly"},
            {"version": "01.2.3"},
            {"repository": "other/repo"},
            {"source_sha": "short"},
            {"workflow_path": "other.yml"},
            {"run_id": 0},
            {"run_attempt": True},
            {"tag": "v1.2.3-rc.01"},
            {"assets": []},
        ):
            raw = rc.json_bytes({**manifest(), **change})
            with self.subTest(change=change), self.assertRaises(rc.ReleaseError):
                rc.validate_manifest(raw, REPO, RC_TAG)
        for name in (
            "../escape",
            "/absolute",
            "nested/file",
            "release-manifest.json",
            "asset\n.txt",
        ):
            invalid = manifest()
            invalid["assets"][0]["name"] = name
            raw = rc.json_bytes(invalid)
            with self.subTest(name=name), self.assertRaises(rc.ReleaseError):
                rc.validate_manifest(raw, REPO, RC_TAG)

    def test_duplicate_manifest_fields_and_assets_rejected(self):
        """Duplicate manifest fields and assets rejected."""
        with self.assertRaises(rc.ReleaseError):
            rc.validate_manifest(b'{"schema":1,"schema":2}', REPO, RC_TAG)
        invalid = manifest()
        invalid["assets"].append({**invalid["assets"][0], "name": "PACKAGE.TAR.GZ"})
        raw = rc.json_bytes(invalid)
        with self.assertRaises(rc.ReleaseError):
            rc.validate_manifest(raw, REPO, RC_TAG)

    def test_empty_nested_symlink_reserved_and_colliding_assets_rejected(self):
        """Empty nested symlink reserved and colliding assets rejected."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, output = root / "source", root / "output"
            source.mkdir()
            output.mkdir()
            with self.assertRaises(rc.ReleaseError):
                rc.stage_assets(source, output)
            (source / "directory").mkdir()
            with self.assertRaises(rc.ReleaseError):
                rc.stage_assets(source, output)
            (source / "directory").rmdir()
            (source / "link").symlink_to(root / "missing")
            with self.assertRaises(rc.ReleaseError):
                rc.stage_assets(source, output)
            (source / "link").unlink()
            (source / rc.MANIFEST).write_bytes(b"reserved")
            with self.assertRaises(rc.ReleaseError):
                rc.stage_assets(source, output)

    def test_nightly_identity_and_monotonic_rc_sequences(self):
        """Nightly identity and monotonic rc sequences."""
        gh = FakeGitHub()
        now = datetime(2026, 9, 12, 1, 2, 3, tzinfo=timezone.utc)
        self.assertEqual(
            rc.candidate_tag(gh, "nightly", "1.2.3", 17, 2, None, now),
            "v1.2.3-nightly.20260912010203.17.2",
        )
        self.assertEqual(rc.next_sequence(gh, "1.2.3", "rc"), 3)
        self.assertEqual(rc.next_sequence(gh, "1.2.3", "beta"), 1)
        with self.assertRaises(rc.ReleaseError):
            rc.candidate_tag(gh, "nightly", "1.2.3", 17, 2, 1, now)

    def test_pagination_keeps_gate_on_later_pages(self):
        """Pagination keeps gate on later pages."""
        gh = rc.GitHub(REPO)
        with patch.object(
            rc.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(
                [],
                0,
                http_response(stdout=b'{"jobs":[{"name":"build"}]}').stdout
                + b"\n"
                + http_response(stdout=b'{"jobs":[{"name":"Release gate"}]}').stdout,
            ),
        ) as command:
            jobs = gh.pages("actions/runs/17/attempts/1/jobs", "jobs")
        self.assertEqual([job["name"] for job in jobs], ["build", "Release gate"])
        self.assertIn("--paginate", command.call_args.args[0])
        self.assertNotIn("--slurp", command.call_args.args[0])
        self.assertIn("--include", command.call_args.args[0])

    def test_permission_errors_do_not_masquerade_as_absent_tags(self):
        """Permission errors do not masquerade as absent tags."""
        gh = rc.GitHub(REPO)
        with (
            patch.object(gh, "api", side_effect=rc.GitHubError("HTTP 403 forbidden")),
            self.assertRaises(rc.GitHubError),
        ):
            gh.optional("git/ref/tags/v1.2.3")


class ExecutingRunStatusTests(unittest.TestCase):
    """Exercise delayed aggregate status with real provenance/execution guards."""

    def setUp(self):
        # pylint: disable-next=consider-using-with
        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.event = directory / "event.json"
        self.event.write_text(json.dumps({"inputs": {"channel": "stable"}}))
        self.enterContext(
            patch.dict(
                os.environ,
                {
                    "GITHUB_ACTIONS": "true",
                    "GITHUB_REPOSITORY": REPO,
                    "GITHUB_RUN_ID": "99",
                    "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_REF": "refs/heads/main",
                    "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_WORKFLOW_REF": f"{REPO}/{rc.WORKFLOW}@refs/heads/main",
                    "GITHUB_EVENT_PATH": str(self.event),
                },
            )
        )
        self.checkout = self.enterContext(
            patch.object(rc, "checked_out_sha", return_value=SHA)
        )
        self.gh = FakeGitHub()
        self.now = 0
        self.enterContext(
            patch.object(rc.time, "monotonic", side_effect=lambda: self.now)
        )
        self.sleep = self.enterContext(
            patch.object(rc.time, "sleep", side_effect=self.advance)
        )

    def advance(self, seconds):
        """Move a fake monotonic clock without real sleeps."""
        self.now += seconds

    def wait(self):
        """Use the exact current run binding with an independently tested gate."""
        return rc.wait_for_executing_run(
            self.gh, 99, "stable", self.gh.info, SHA, 1, gate=False
        )

    def test_transitional_states_require_a_fresh_in_progress_response(self):
        """Neither queued nor waiting itself grants permission to publish."""
        responses = [
            {**run(99, False), "status": status}
            for status in ("queued", "requested", "pending", "waiting", "in_progress")
        ]
        responses[-1]["updated_at"] = "fresh-response"
        with patch.object(self.gh, "api", side_effect=responses) as api:
            result = self.wait()
        self.assertEqual(result, responses[-1])
        self.assertEqual(api.call_count, 5)
        self.assertEqual(self.checkout.call_count, 5)
        self.assertEqual(self.sleep.call_count, 4)
        self.assertEqual(self.gh.writes, [])

    def test_every_refreshed_identity_field_is_rechecked(self):
        """A newly active response cannot swap a run, source, workflow or attempt."""
        changes = [
            {"id": 100},
            {"run_attempt": 2},
            {"head_sha": "b" * 40},
            {"path": ".github/workflows/other.yml"},
            {"head_branch": "feature"},
            {"event": "push"},
            {"repository": {"full_name": "fork/project"}},
            {"head_repository": {"full_name": "fork/project"}},
        ]
        for change in changes:
            with (
                self.subTest(change=change),
                patch.object(
                    self.gh,
                    "api",
                    side_effect=[
                        {**run(99, False), "status": "waiting"},
                        {**run(99, False), **change},
                    ],
                ) as api,
            ):
                previous = self.sleep.call_count
                with self.assertRaises(rc.ReleaseError):
                    self.wait()
                self.assertEqual(api.call_count, 2)
                self.assertEqual(self.sleep.call_count, previous + 1)
                self.assertEqual(self.gh.writes, [])

    def test_execution_checkout_is_rechecked_after_wait(self):
        """The checked-out source remains bound after an aggregate-state delay."""
        with (
            patch.object(
                self.gh,
                "api",
                side_effect=[{**run(99, False), "status": "queued"}, run(99, False)],
            ),
            patch.object(rc, "checked_out_sha", side_effect=[SHA, "b" * 40]),
            self.assertRaisesRegex(rc.ReleaseError, "Checkout"),
        ):
            self.wait()
        self.assertEqual(self.sleep.call_count, 1)

    def test_terminal_or_unknown_state_fails_without_sleep(self):
        """Cancelled/completed/unknown executions are never polled into permission."""
        states = [
            ("completed", "success"),
            ("completed", "failure"),
            ("completed", "cancelled"),
            ("cancelled", None),
            ("unknown", None),
            ("waiting", "failure"),
            ("in_progress", "failure"),
        ]
        for status, conclusion in states:
            with (
                self.subTest(status=status, conclusion=conclusion),
                patch.object(
                    self.gh,
                    "api",
                    return_value={
                        **run(99, False),
                        "status": status,
                        "conclusion": conclusion,
                    },
                ),
                self.assertRaises(rc.ReleaseError),
            ):
                self.wait()
        self.sleep.assert_not_called()
        self.assertEqual(self.gh.writes, [])

    def test_timeout_is_bounded_and_does_not_publish(self):
        """A perpetually stale API fails closed after exactly the bounded wait."""
        with (
            patch.object(
                self.gh, "api", return_value={**run(99, False), "status": "waiting"}
            ) as api,
            self.assertRaisesRegex(
                rc.ReleaseError, "within 60 seconds.*waiting.*99.*1"
            ),
        ):
            self.wait()
        self.assertEqual(self.now, 60)
        self.assertEqual(api.call_count, 31)
        self.assertEqual(self.sleep.call_count, 30)
        self.assertEqual(self.gh.writes, [])

    def test_completed_candidate_validation_does_not_poll(self):
        """Accepted RCs still require completed success on the exact attempt."""
        with patch.object(self.gh, "api") as api:
            rc.validate_run(self.gh, run(), self.gh.info, SHA, 1, completed=True)
            for change in (
                {"status": "queued"},
                {"status": "waiting"},
                {"conclusion": "failure"},
                {"run_attempt": 2},
            ):
                candidate = {**run(), **change}
                with self.subTest(change=change), self.assertRaises(rc.ReleaseError):
                    rc.validate_run(
                        self.gh,
                        candidate,
                        self.gh.info,
                        SHA,
                        1,
                        completed=True,
                    )
            api.assert_not_called()
        self.sleep.assert_not_called()


class SupersededCandidateTests(unittest.TestCase):
    """Use real API response fields to prove replacement without claiming release."""

    def setUp(self):
        self.gh = FakeGitHub()
        self.source = {**run(99, False), "event": "push"}
        self.head = "b" * 40
        self.successor = {
            **run(100, False),
            "event": "push",
            "head_sha": self.head,
        }
        self.gh.default_head = self.head
        self.gh.successors = [self.successor]

    def check(self, channel="beta"):
        return rc.superseded_candidate(self.gh, self.gh.info, self.source, channel)

    def test_current_head_always_uses_normal_publication(self):
        self.gh.default_head = SHA
        self.gh.successors = []
        self.assertIsNone(self.check())
        self.assertEqual(self.gh.writes, [])

    def test_push_and_schedule_only_record_proven_supersession(self):
        for event, channel in (("push", "beta"), ("schedule", "nightly")):
            self.source["event"] = event
            result = self.check(channel)
            self.assertEqual(result["status"], "superseded")
            self.assertEqual(result["source_sha"], SHA)
            self.assertEqual(result["superseded_by"], self.head)
            self.assertEqual(result["successor_run_id"], "100")
            self.assertNotIn("manifest_path", result)
            self.assertEqual(self.gh.writes, [])

    def test_manual_dispatch_is_unchanged_even_at_older_source(self):
        self.source["event"] = "workflow_dispatch"
        with patch.object(self.gh, "api") as api:
            for channel in ("beta", "nightly", "rc", "stable"):
                self.assertIsNone(self.check(channel))
            api.assert_not_called()

    def test_successor_completion_is_not_a_publication_claim(self):
        for status, conclusion in (("queued", None), ("completed", "failure")):
            self.successor.update(status=status, conclusion=conclusion)
            self.assertEqual(self.check()["status"], "superseded")

    def test_missing_or_ambiguous_replacement_fails_closed(self):
        for successors in ([], [self.successor, self.successor]):
            self.gh.successors = successors
            with self.assertRaisesRegex(rc.ReleaseError, "one proven replacement"):
                self.check()
        self.assertEqual(self.gh.writes, [])

    def test_forged_old_or_manual_replacement_fails_closed(self):
        for change in (
            {"repository": {"full_name": "other/repo"}},
            {"head_repository": {"full_name": "other/repo"}},
            {"head_branch": "other"},
            {"head_sha": SHA},
            {"path": ".github/workflows/other.yml"},
            {"event": "workflow_dispatch"},
            {"id": 99},
            {"run_number": 99},
            {"run_attempt": 0},
            {"status": "unknown"},
        ):
            with self.subTest(change=change):
                self.gh.successors = [{**self.successor, **change}]
                with self.assertRaises(rc.ReleaseError):
                    self.check()
        self.assertEqual(self.gh.writes, [])

    def test_malformed_or_changed_ref_and_divergence_fail_closed(self):
        original = self.gh.api
        for bad_ref in (
            {},
            {"ref": "refs/heads/other"},
            {"ref": "refs/heads/main", "object": {"type": "tag", "sha": self.head}},
            {"ref": "refs/heads/main", "object": {"type": "commit", "sha": "short"}},
        ):

            def malformed(path, method="GET", body=None):
                return (
                    bad_ref
                    if path == "git/ref/heads/main"
                    else original(path, method, body)
                )

            with patch.object(self.gh, "api", side_effect=malformed):
                with self.assertRaisesRegex(
                    rc.ReleaseError, "verify current default branch"
                ):
                    self.check()
        for status in ("diverged", "behind", "identical"):

            def divergent(path, method="GET", body=None):
                if path.startswith("compare/"):
                    return {"status": status, "merge_base_commit": {"sha": SHA}}
                return original(path, method, body)

            with patch.object(self.gh, "api", side_effect=divergent):
                with self.assertRaises(rc.ReleaseError):
                    self.check()
        reads = 0

        def changing(path, method="GET", body=None):
            nonlocal reads
            result = original(path, method, body)
            if path == "git/ref/heads/main":
                reads += 1
                if reads > 1:
                    result["object"]["sha"] = "c" * 40
            return result

        with patch.object(self.gh, "api", side_effect=changing):
            with self.assertRaisesRegex(rc.ReleaseError, "changed while verifying"):
                self.check()

    def test_default_branch_rename_does_not_skip_against_an_old_branch(self):
        original = self.gh.api

        def renamed(path, method="GET", body=None):
            value = original(path, method, body)
            if path == "":
                value["default_branch"] = "renamed"
            return value

        with patch.object(self.gh, "api", side_effect=renamed):
            with self.assertRaisesRegex(rc.ReleaseError, "Default branch changed"):
                self.check()

    def test_unknown_api_response_and_errors_do_not_become_success(self):
        original = self.gh.api
        for response in (
            {},
            {"total_count": True, "workflow_runs": [self.successor]},
            {"total_count": 101, "workflow_runs": [self.successor]},
        ):

            def invalid(path, method="GET", body=None):
                if path.startswith("actions/workflows/"):
                    return response
                return original(path, method, body)

            with patch.object(self.gh, "api", side_effect=invalid):
                with self.assertRaises(rc.ReleaseError):
                    self.check()
        with patch.object(self.gh, "api", side_effect=rc.GitHubError("HTTP 403")):
            with self.assertRaises(rc.GitHubError):
                self.check()

    def test_narrow_transport_accepts_only_the_fixed_successor_query(self):
        client = rc.GitHub(REPO)
        path = (
            "actions/workflows/release-pipeline.yml/runs"
            f"?branch=main&event=push&head_sha={self.head}&per_page=100"
        )
        result = http_response(stdout=b'{"total_count":0,"workflow_runs":[]}')
        with patch.object(rc.subprocess, "run", return_value=result) as command:
            client.api(path)
            self.assertEqual(command.call_args.args[0][-1], f"repos/{REPO}/{path}")
        for invalid in (
            path.replace("event=push", "event=pull_request"),
            path.replace("release-pipeline.yml", "other.yml"),
        ):
            with self.assertRaises(rc.ReleaseError):
                client.api(invalid)


class AtomicOutputTests(unittest.TestCase):
    """Output replacement must preserve aliases and never publish partial bytes."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / "evidence.json"
        self.before = b"existing output\n"
        self.after = b'{"verified":"exact bytes"}\n'

    def test_create_and_overwrite_preserve_exact_bytes_and_existing_mode(self):
        rc.atomic_write_bytes(self.output, self.before)
        if os.name == "posix":
            self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.output.chmod(0o640)
        rc.atomic_write_bytes(self.output, self.after)
        self.assertEqual(self.output.read_bytes(), self.after)
        self.assertEqual(rc.digest(self.output.read_bytes()), rc.digest(self.after))
        if os.name == "posix":
            self.assertEqual(self.output.stat().st_mode & 0o777, 0o640)
        self.assertEqual(list(self.root.iterdir()), [self.output])

    def test_hardlink_replacement_preserves_other_name_and_bytes(self):
        original = self.root / "outside.json"
        original.write_bytes(self.before)
        os.link(original, self.output)
        rc.atomic_write_bytes(self.output, self.after)
        self.assertEqual(original.read_bytes(), self.before)
        self.assertEqual(self.output.read_bytes(), self.after)
        self.assertNotEqual(original.stat().st_ino, self.output.stat().st_ino)
        self.assertEqual(original.stat().st_nlink, 1)

    def test_symlink_dangling_symlink_directory_and_fifo_fail_closed(self):
        original = self.root / "outside.json"
        original.write_bytes(self.before)
        kinds = ["symlink", "dangling", "directory"]
        if hasattr(os, "mkfifo"):
            kinds.append("fifo")
        for kind in kinds:
            with self.subTest(kind=kind):
                output = self.root / kind
                if kind == "directory":
                    output.mkdir()
                elif kind == "fifo":
                    os.mkfifo(output)
                else:
                    output.symlink_to(
                        original if kind == "symlink" else self.root / "missing"
                    )
                with self.assertRaisesRegex(ValueError, "plain file"):
                    rc.atomic_write_bytes(output, self.after)
                self.assertEqual(original.read_bytes(), self.before)
                self.assertFalse((self.root / "missing").exists())
                self.assertEqual(list(self.root.glob(".release-output-*")), [])

    def test_failed_write_flush_or_replace_preserves_old_output_and_cleans_staging(
        self,
    ):
        original_fdopen = os.fdopen

        @contextmanager
        def partial_write(fd, mode):
            with original_fdopen(fd, mode) as handle:

                def fail(data):
                    handle.write(data[:5])
                    raise OSError("injected partial write")

                writer = Mock(wraps=handle)
                writer.write.side_effect = fail
                yield writer

        for operation, replacement in (
            ("fdopen", partial_write),
            ("fsync", OSError("injected flush failure")),
            ("replace", OSError("injected replacement failure")),
        ):
            with self.subTest(operation=operation):
                self.output.write_bytes(self.before)
                with (
                    patch.object(rc.os, operation, side_effect=replacement),
                    self.assertRaises(OSError),
                ):
                    rc.atomic_write_bytes(self.output, self.after)
                self.assertEqual(self.output.read_bytes(), self.before)
                self.assertEqual(list(self.root.iterdir()), [self.output])

    def test_symlink_inserted_during_staging_is_rejected_without_target_write(self):
        original = self.root / "outside.json"
        original.write_bytes(self.before)
        self.output.write_bytes(b"old output")
        fsync = os.fsync

        def swap(fd):
            fsync(fd)
            self.output.unlink()
            self.output.symlink_to(original)

        with (
            patch.object(rc.os, "fsync", side_effect=swap),
            self.assertRaisesRegex(ValueError, "plain file"),
        ):
            rc.atomic_write_bytes(self.output, self.after)
        self.assertTrue(self.output.is_symlink())
        self.assertEqual(original.read_bytes(), self.before)
        self.assertEqual(list(self.root.glob(".release-output-*")), [])


if __name__ == "__main__":
    unittest.main()
