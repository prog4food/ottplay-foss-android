# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Offline early-runner regression and provenance tests using real RC lifecycle."""

# Match the existing lifecycle fixture conventions and vendored test imports.
# pylint: disable=missing-function-docstring,missing-class-docstring,wrong-import-position
import copy
import io
import json
import os
# Subprocesses use explicit argv and never a shell.
import subprocess  # nosec B404
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import runner_preflight as preflight
import test_versioned_release as lifecycle_tests

rc = lifecycle_tests.rc
preflight.rc = rc
IDENTITY = {
    "platform": "linux",
    "ImageOS": "ubuntu22",
    "ImageVersion": "20260927.309.1",
    "RUNNER_OS": "Linux",
    "RUNNER_ARCH": "X64",
}
TARGET = "release-inputs-android.json"


class PreflightTests(unittest.TestCase):
    def setUp(self):
        self.fixture = lifecycle_tests.LifecycleTests(methodName="runTest")
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.gh = self.fixture.gh
        self.fixture.start_run("rc", 100)
        lifecycle_tests.lifecycle.prepare(self.fixture.args)
        with patch.object(
            lifecycle_tests.receipt,
            "capture_toolchain",
            return_value={**IDENTITY, "python": "3.12.8", "rustc": "rustc 1.90.0"},
        ):
            self.fixture.build_current()
        assets = Path(self.fixture.args.assets)
        (assets / "release-inputs-linux.json").rename(assets / TARGET)
        released = lifecycle_tests.lifecycle.publish_versioned(self.fixture.args)
        raw = rc.EVIDENCE.read_bytes()
        self.gh.save_completed_evidence(raw)
        self.manifest = json.loads(raw)
        self.fixture.start_run("stable", 101, released["tag"])
        lifecycle_tests.lifecycle.prepare(self.fixture.args)
        self.plan = json.loads(lifecycle_tests.lifecycle.PLAN.read_bytes())
        self.policy = self.fixture.policy
        self.parent = self.gh.ledger["plans"]["101"]["parent"]
        release_id = next(
            key
            for key, value in self.gh.releases.items()
            if value["tag_name"] == released["tag"]
        )
        self.assets = self.gh.assets[release_id]
        self.receipt_asset = next(
            item for item in self.assets if item["name"] == TARGET
        )
        self.manifest_asset = next(
            item for item in self.assets if item["name"] == rc.MANIFEST
        )
        runtime = self.fixture.root / "runner-temp"
        event = runtime / "_github_workflow" / "event.json"
        event.parent.mkdir(parents=True)
        Path(os.environ["GITHUB_EVENT_PATH"]).rename(event)
        self.enterContext(
            patch.dict(
                os.environ,
                {"RUNNER_TEMP": str(runtime), "GITHUB_EVENT_PATH": str(event)},
            )
        )
        self.gh.writes.clear()
        self.gh.ledger_writes.clear()

    def check(self, actual=None):
        result = preflight.check(
            self.gh, self.plan, self.policy, "stable", TARGET, actual or IDENTITY
        )
        self.assertEqual(self.gh.writes, [])
        self.assertEqual(self.gh.ledger_writes, [])
        return result

    def replace_receipt(self, change):
        value = json.loads(self.gh.files[self.receipt_asset["id"]])
        change(value)
        data = rc.json_bytes(value)
        self.gh.files[self.receipt_asset["id"]] = data
        self.receipt_asset["size"] = len(data)
        for item in self.manifest["assets"]:
            if item["name"] == TARGET:
                item.update(size=len(data), sha256=rc.digest(data))
        for item in self.manifest["build_receipts"]:
            if item["name"] == TARGET:
                item["sha256"] = rc.digest(data)
        self.replace_manifest()

    def replace_manifest(self):
        raw = rc.json_bytes(self.manifest)
        self.gh.files[self.manifest_asset["id"]] = raw
        self.manifest_asset["size"] = len(raw)
        self.parent["manifest_sha256"] = rc.digest(raw)
        self.gh.save_completed_evidence(raw)

    def test_matching_identity_is_not_full_toolchain_acceptance(self):
        with patch.object(self.gh, "binary", wraps=self.gh.binary) as binary:
            result = self.check()
        self.assertEqual(result["status"], "runner-identity-match")
        self.assertIs(result["full_toolchain_verified"], False)
        self.assertEqual(result["differences"], [])
        self.assertEqual(
            {call.args[0] for call in binary.call_args_list},
            {
                f"releases/assets/{self.receipt_asset['id']}",
                f"releases/assets/{self.manifest_asset['id']}",
                "actions/artifacts/1100/zip",
            },
        )

    def test_actual_android_rc309_final303_blocks_before_build(self):
        result = self.check({**IDENTITY, "ImageVersion": "20260920.303.1"})
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(result["target"], TARGET)
        self.assertEqual(
            result["differences"],
            [
                {
                    "field": "ImageVersion",
                    "expected": "20260927.309.1",
                    "actual": "20260920.303.1",
                }
            ],
        )
        self.assertIn("no automatic retry", result["next_action"])

    def test_each_runner_field_is_exact(self):
        for key in preflight.RUNNER_FIELDS:
            with self.subTest(key=key):
                result = self.check({**IDENTITY, key: IDENTITY[key] + "-changed"})
                self.assertEqual(result["status"], "blocked")
                self.assertEqual(
                    [item["field"] for item in result["differences"]], [key]
                )

    def test_missing_or_unsafe_actual_identity_fails(self):
        for value in (None, "", True, "::error::secret\n"):
            with self.subTest(value=value), self.assertRaises(rc.ReleaseError):
                self.check({**IDENTITY, "ImageVersion": value})

    def test_missing_expected_image_fails_even_with_consistent_hashes(self):
        self.replace_receipt(lambda value: value["toolchain"].pop("ImageVersion"))
        with self.assertRaisesRegex(rc.ReleaseError, "identity is missing"):
            self.check()

    def test_receipt_tampering_is_not_drift(self):
        self.gh.files[self.receipt_asset["id"]] += b" "
        with self.assertRaisesRegex(rc.ReleaseError, "receipt checksum"):
            self.check()

    def test_manifest_tampering_rejects_reserved_parent(self):
        self.gh.files[self.manifest_asset["id"]] += b" "
        with self.assertRaisesRegex(rc.ReleaseError, "manifest checksum"):
            self.check()

    def test_receipt_checksum_bindings_must_agree(self):
        self.manifest["build_receipts"][0]["sha256"] = "f" * 64
        self.replace_manifest()
        with self.assertRaisesRegex(rc.ReleaseError, "declarations disagree"):
            self.check()

    def test_wrong_receipt_source_or_plan_fails(self):
        self.replace_receipt(lambda value: value.update(source_sha="e" * 40))
        with self.assertRaisesRegex(rc.ReleaseError, "source/plan"):
            self.check()

    def test_wrong_rc_policy_fails_even_with_updated_parent(self):
        self.manifest["source_policy"]["data"]["notes"] = ["other"]
        # The manifest's plan digest itself now fails its declared policy binding.
        self.replace_manifest()
        with self.assertRaises(
            (rc.ReleaseError, lifecycle_tests.versions.VersionError)
        ):
            self.check()

    def test_missing_immutable_evidence_fails(self):
        self.gh.evidence_by_run[100] = []
        with self.assertRaisesRegex(rc.ReleaseError, "immutable release-evidence"):
            self.check()

    def test_corrupt_immutable_evidence_fails(self):
        self.gh.evidence_archives[1100] += b"changed"
        with self.assertRaisesRegex(rc.ReleaseError, "artifact digest"):
            self.check()

    def test_duplicate_receipt_inventory_fails(self):
        self.manifest["build_receipts"].append(
            copy.deepcopy(self.manifest["build_receipts"][0])
        )
        self.replace_manifest()
        with self.assertRaisesRegex(rc.ReleaseError, "duplicate"):
            self.check()

    def test_missing_target_fails(self):
        self.assets.remove(self.receipt_asset)
        with self.assertRaisesRegex(rc.ReleaseError, "receipt missing"):
            self.check()

    def test_reservation_different_plan_or_missing_parent_fails(self):
        self.gh.ledger["plans"]["101"]["parent"] = None
        with self.assertRaisesRegex(rc.ReleaseError, "reservation parent"):
            self.check()

    def test_dispatch_cannot_substitute_another_rc(self):
        event = Path(os.environ["GITHUB_EVENT_PATH"])
        value = json.loads(event.read_bytes())
        value["inputs"]["rc_tag"] = "v1.2.3-rc.999"
        event.write_bytes(rc.json_bytes(value))
        with self.assertRaisesRegex(rc.ReleaseError, "Dispatch RC"):
            self.check()

    def test_main_movement_fails(self):
        self.gh.default_head = "e" * 40
        with self.assertRaisesRegex(rc.ReleaseError, "Default branch changed"):
            self.check()

    def test_run_attempt_movement_fails(self):
        self.gh.runs[101]["run_attempt"] = 2
        with self.assertRaisesRegex(rc.ReleaseError, "attempt"):
            self.check()

    def test_run_conclusion_must_be_consistent(self):
        self.gh.runs[101]["conclusion"] = "success"
        with self.assertRaisesRegex(rc.ReleaseError, "already has a conclusion"):
            self.check()

    def test_event_bounds_are_checked_before_canonical_execution_read(self):
        event = Path(os.environ["GITHUB_EVENT_PATH"])
        event.write_bytes(b" " * (preflight.MAX_METADATA + 1))
        with (
            patch.object(rc, "check_execution") as execution,
            self.assertRaisesRegex(rc.ReleaseError, "metadata exceeds limit"),
        ):
            self.check()
        execution.assert_not_called()

    def test_reusable_context_is_caller_workflow_and_dispatch_event(self):
        # GitHub's reusable github context belongs to the caller, not release-build.yml.
        with (
            patch.dict(
                os.environ,
                {
                    "GITHUB_WORKFLOW_REF": f"{self.gh.repo}/.github/workflows/release-build.yml@refs/heads/main"
                },
            ),
            self.assertRaisesRegex(rc.ReleaseError, "Execution workflow mismatch"),
        ):
            self.check()
        self.assertEqual(self.check()["status"], "runner-identity-match")

    def test_queued_run_fails_without_wait_or_retry(self):
        self.gh.runs[101]["status"] = "queued"
        with (
            patch.object(self.gh, "api", wraps=self.gh.api) as api,
            self.assertRaisesRegex(rc.ReleaseError, "not in progress"),
        ):
            self.check()
        self.assertEqual(
            sum(call.args[0] == "actions/runs/101" for call in api.call_args_list), 1
        )

    def test_oversized_receipt_metadata_rejects_before_download(self):
        self.receipt_asset["size"] = preflight.MAX_METADATA + 1
        with (
            patch.object(self.gh, "binary", wraps=self.gh.binary) as binary,
            self.assertRaisesRegex(rc.ReleaseError, "receipt size"),
        ):
            self.check()
        self.assertNotIn(
            f"releases/assets/{self.receipt_asset['id']}",
            [call.args[0] for call in binary.call_args_list],
        )

    def test_beta_and_rc_report_no_expectation_without_network(self):
        for channel in ("beta", "rc"):
            plan = lifecycle_tests.versions.create_plan(
                "1.2.3", channel, 1, lifecycle_tests.SHA, self.policy, 55
            )
            with (
                self.subTest(channel=channel),
                patch.object(self.gh, "api", side_effect=AssertionError("network")),
                patch.object(self.gh, "binary", side_effect=AssertionError("download")),
            ):
                result = preflight.check(
                    self.gh, plan, self.policy, channel, TARGET, {}
                )
            self.assertEqual(result["status"], "not-applicable")

    def test_channel_override_cannot_skip_stable_check(self):
        with self.assertRaisesRegex(rc.ReleaseError, "channel differs"):
            preflight.check(self.gh, self.plan, self.policy, "rc", TARGET, {})

    def test_cli_emits_structured_failure_without_untrusted_error(self):
        output = io.StringIO()
        with (
            patch.object(
                preflight,
                "check",
                side_effect=rc.ReleaseError("secret\n::warning::injected"),
            ),
            redirect_stdout(output),
        ):
            code = preflight.main(
                [
                    "--repo",
                    self.gh.repo,
                    "--plan",
                    str(lifecycle_tests.lifecycle.PLAN),
                    "--channel",
                    "stable",
                    "--receipt",
                    TARGET,
                ]
            )
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue())["status"], "invalid-evidence")
        self.assertNotIn("secret", output.getvalue())


class MetadataPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        old = Path.cwd()
        os.chdir(self.workspace)
        self.addCleanup(os.chdir, old)
        self.runtime = self.root / "runner-temp"
        self.event = self.runtime / "_github_workflow" / "event.json"
        self.event.parent.mkdir(parents=True)
        self.event.write_text('{"inputs":{"channel":"stable"}}')
        self.enterContext(
            patch.dict(
                os.environ,
                {
                    "RUNNER_TEMP": str(self.runtime),
                    "GITHUB_EVENT_PATH": str(self.event),
                },
            )
        )

    def cli(self, path):
        return preflight.main(
            [
                "--repo",
                "owner/repo",
                "--plan",
                path,
                "--channel",
                "stable",
                "--receipt",
                TARGET,
            ]
        )

    def test_cli_rejects_every_noncanonical_plan_before_reading(self):
        link = self.workspace / "linked"
        link.symlink_to(self.root, target_is_directory=True)
        for path in (
            "../.release-plan.json",
            str(self.root / ".release-plan.json"),
            str(self.workspace / ".release-plan.json"),
            "./.release-plan.json",
            "other.json",
            "linked/.release-plan.json",
        ):
            with (
                self.subTest(path=path),
                patch.object(preflight, "read_metadata") as read,
                redirect_stderr(io.StringIO()),
                self.assertRaises(SystemExit) as error,
            ):
                self.cli(path)
            self.assertEqual(error.exception.code, 2)
            read.assert_not_called()

    def test_fixed_plan_and_policy_are_read_from_checkout(self):
        (self.workspace / preflight.PLAN_NAME).write_text('{"plan":true}')
        (self.workspace / rc.POLICY).write_text('{"policy":true}')
        with (
            patch.object(
                preflight, "check", return_value={"status": "not-applicable"}
            ) as check,
            redirect_stdout(io.StringIO()),
        ):
            self.assertEqual(self.cli(preflight.PLAN_NAME), 0)
        self.assertEqual(check.call_args.args[1:3], ({"plan": True}, {"policy": True}))

    def test_cli_rejects_symlinked_plan_or_policy(self):
        outside = self.root / "outside.json"
        outside.write_text("{}")
        for name in (preflight.PLAN_NAME, rc.POLICY):
            with self.subTest(name=name):
                for filename in (preflight.PLAN_NAME, rc.POLICY):
                    (self.workspace / filename).write_text("{}")
                path = self.workspace / name
                path.unlink()
                path.symlink_to(outside)
                output = io.StringIO()
                with patch.object(preflight, "check") as check, redirect_stdout(output):
                    self.assertEqual(self.cli(preflight.PLAN_NAME), 1)
                check.assert_not_called()
                self.assertEqual(
                    json.loads(output.getvalue())["status"], "invalid-evidence"
                )
                path.unlink()

    def test_reader_rejects_relative_absolute_and_symlinked_parent_escape(self):
        (self.root / "outside.json").write_text("{}")
        (self.workspace / "linked").symlink_to(self.root, target_is_directory=True)
        for relative in (
            Path("../outside.json"),
            self.root / "outside.json",
            Path("linked/outside.json"),
        ):
            with self.subTest(relative=relative), self.assertRaises(rc.ReleaseError):
                preflight.read_metadata(self.workspace, relative)

    def test_absolute_runner_event_outside_checkout_is_valid(self):
        self.assertFalse(self.event.is_relative_to(self.workspace))
        self.assertEqual(preflight.read_event(), {"inputs": {"channel": "stable"}})

    def test_metadata_symlink_loop_is_rejected_without_following_it(self):
        path = self.workspace / preflight.PLAN_NAME
        path.symlink_to(preflight.PLAN_NAME)
        with self.assertRaisesRegex(rc.ReleaseError, "contains a link"):
            preflight.read_metadata(self.workspace, Path(preflight.PLAN_NAME))

    def test_runtime_root_alias_is_normalized_without_trusting_child_links(self):
        alias = self.root / "runtime-alias"
        alias.symlink_to(self.runtime, target_is_directory=True)
        for event in (alias / "_github_workflow/event.json", self.event):
            with patch.dict(
                os.environ, {"RUNNER_TEMP": str(alias), "GITHUB_EVENT_PATH": str(event)}
            ):
                self.assertEqual(preflight.read_event()["inputs"]["channel"], "stable")

    def test_runner_event_rejects_relative_and_absolute_other_paths(self):
        for event in (
            "_github_workflow/event.json",
            str(self.workspace / "event.json"),
            str(self.runtime / "../outside.json"),
        ):
            with (
                self.subTest(event=event),
                patch.dict(os.environ, {"GITHUB_EVENT_PATH": event}),
                self.assertRaisesRegex(rc.ReleaseError, "runner-owned location"),
            ):
                preflight.read_event()

    def test_runner_event_rejects_symlink_leaf_and_parent(self):
        real_directory = self.root / "real-event"
        self.event.parent.rename(real_directory)
        self.event.parent.symlink_to(real_directory, target_is_directory=True)
        with self.assertRaisesRegex(rc.ReleaseError, "contains a link"):
            preflight.read_event()
        self.event.parent.unlink()
        self.event.parent.mkdir()
        self.event.symlink_to(real_directory / "event.json")
        with self.assertRaisesRegex(rc.ReleaseError, "contains a link"):
            preflight.read_event()


class BoundedDownloadTests(unittest.TestCase):
    @staticmethod
    def http_bytes(payload, status=200):
        return (
            f"HTTP/2.0 {status}\r\nContent-Type: application/octet-stream\r\n\r\n".encode()
            + payload
        )

    @staticmethod
    def program(stdout, stderr=b"", exit_code=0):
        return (
            "import sys; "
            f"sys.stdout.buffer.write({stdout!r}); "
            f"sys.stderr.buffer.write({stderr!r}); sys.exit({exit_code})"
        )

    def fetch(self, program, path="releases/assets/1", mode="binary", *, timeout=2.0):
        self.calls = []
        real_popen = subprocess.Popen

        def launch(*_args, **kwargs):
            self.calls.append(_args[0])
            return real_popen([sys.executable, "-c", program], **kwargs)

        with (
            patch.object(preflight.subprocess, "Popen", side_effect=launch),
            patch.object(preflight, "MAX_BINARY", 64),
            patch.object(preflight, "MAX_API_BYTES", 64),
            patch.object(preflight, "MAX_ERROR_BYTES", 64),
            patch.object(preflight, "DOWNLOAD_TIMEOUT", timeout),
        ):
            client = preflight.PreflightGitHub("owner/repo")
            return (
                client.binary(path)
                if mode == "binary"
                else client.request(path, mode=mode)
            )

    def test_bounded_small_payload(self):
        self.assertEqual(self.fetch(self.program(self.http_bytes(b"ok"))), b"ok")
        self.assertIn("--include", self.calls[0])

    def test_headers_do_not_reduce_or_bypass_the_payload_limit(self):
        payload = b"x" * 64
        self.assertEqual(self.fetch(self.program(self.http_bytes(payload))), payload)
        program = self.program(self.http_bytes(payload + b"x"))
        with self.assertRaisesRegex(rc.ReleaseError, "exceeds limit"):
            self.fetch(program)

    def test_protocol_overhead_is_bounded(self):
        wire = b"HTTP/2.0 200\r\nX-Pad: " + b"x" * (
            preflight.MAX_HTTP_HEADER_BYTES + 64
        )
        program = self.program(wire + b"\r\n\r\n")
        with self.assertRaisesRegex(rc.ReleaseError, "exceeds limit"):
            self.fetch(program)

    def test_binary_payload_is_not_parsed_as_another_response(self):
        payload = b"\x00\xffHTTP/2.0 404\r\n\r\nbody\n"
        self.assertEqual(self.fetch(self.program(self.http_bytes(payload))), payload)

    def test_paginated_responses_keep_every_page_without_slurp(self):
        wire = self.http_bytes(b"[1]") + b"\n" + self.http_bytes(b"[2]")
        result = self.fetch(self.program(wire), "releases", "pages")
        self.assertEqual(json.loads(result), [[1], [2]])
        self.assertIn("--include", self.calls[0])
        self.assertIn("--paginate", self.calls[0])
        self.assertEqual(self.calls[0][self.calls[0].index("--jq") + 1], "tojson")
        self.assertNotIn("--slurp", self.calls[0])
        self.assertEqual(len(self.calls), 1)

    def test_failed_page_discards_the_partial_result(self):
        wire = self.http_bytes(b"[1]") + b"\n" + self.http_bytes(b"secret", 502)
        program = self.program(wire, b"gh: HTTP 404", 1)
        with self.assertRaises(rc.GitHubError) as error:
            self.fetch(program, "releases", "pages")
        self.assertFalse(error.exception.not_found)
        self.assertNotIn("secret", str(error.exception))
        self.assertEqual(len(self.calls), 1)

    def test_oversize_stops_process_without_unbounded_read(self):
        with self.assertRaisesRegex(rc.ReleaseError, "exceeds limit"):
            self.fetch("import sys; sys.stdout.write('x' * 10000000)")

    def test_stalled_download_times_out_without_retry(self):
        with self.assertRaisesRegex(rc.ReleaseError, "timed out"):
            self.fetch("import time; time.sleep(10)", timeout=0.2)

    def test_nonzero_transport_fails(self):
        with self.assertRaisesRegex(rc.ReleaseError, "download failed"):
            self.fetch("raise SystemExit(2)")

    def test_closed_pipes_do_not_allow_process_to_outlive_deadline(self):
        with self.assertRaisesRegex(rc.ReleaseError, "did not finish"):
            self.fetch("import os,time; os.close(1); os.close(2); time.sleep(10)")

    def test_json_and_paginated_metadata_are_bounded(self):
        for mode, path in (
            ("json", "actions/runs/1"),
            ("pages", "releases"),
            ("json", preflight.state.READ_PATH),
        ):
            with (
                self.subTest(mode=mode, path=path),
                self.assertRaisesRegex(rc.ReleaseError, "exceeds limit"),
            ):
                self.fetch("import sys; sys.stdout.write('x' * 10000000)", path, mode)
            self.assertEqual(len(self.calls), 1)

    def test_metadata_timeout_is_bounded(self):
        with self.assertRaisesRegex(rc.ReleaseError, "timed out"):
            self.fetch("import time; time.sleep(10)", preflight.state.READ_PATH, "json", timeout=0.2)
        self.assertEqual(len(self.calls), 1)

    def test_stderr_is_bounded_and_never_echoed(self):
        with self.assertRaisesRegex(rc.ReleaseError, "exceeds limit"):
            self.fetch(
                "import sys; sys.stderr.write('SECRET' * 10000000)", "releases", "pages"
            )

    def test_404_remains_distinguishable_without_raw_error(self):
        program = self.program(self.http_bytes(b"secret", 404), b"secret HTTP 403", 1)
        with self.assertRaises(rc.GitHubError) as error:
            self.fetch(
                program,
                preflight.state.READ_PATH,
                "json",
            )
        self.assertTrue(error.exception.not_found)
        self.assertNotIn("secret", str(error.exception))

    def test_error_prose_without_an_authoritative_404_never_means_missing(self):
        for stdout, stderr in (
            (b"", b"gh: HTTP 404"),
            (b"", b"gh: HTTP 404: upstream\nfailure (HTTP 502)\n"),
            (self.http_bytes(b"HTTP 404", 502), b"gh: HTTP 404"),
            (b"HTTP/2.0 404\r\n", b"gh: HTTP 404"),
        ):
            with self.subTest(stdout=stdout, stderr=stderr):
                program = self.program(stdout, stderr, 1)
                with self.assertRaises(rc.GitHubError) as error:
                    self.fetch(program, "releases", "json")
                self.assertFalse(error.exception.not_found)
                self.assertEqual(len(self.calls), 1)

    def test_http_status_and_cli_exit_must_agree(self):
        for status, exit_code in ((200, 1), (404, 0)):
            with self.subTest(status=status, exit_code=exit_code):
                program = self.program(self.http_bytes(b"secret", status), b"secret", exit_code)
                with self.assertRaisesRegex(rc.GitHubError, "disagree") as error:
                    self.fetch(
                        program,
                        "releases",
                        "json",
                    )
                self.assertFalse(error.exception.not_found)
                self.assertNotIn("secret", str(error.exception))

    def test_constructor_does_not_run_publication_scope_probe(self):
        with (
            patch.dict(os.environ, {"RELEASE_REQUIRE_WORKFLOW_SCOPE": "true"}),
            patch.object(
                preflight.subprocess,
                "run",
                side_effect=AssertionError("unbounded probe"),
            ),
        ):
            preflight.PreflightGitHub("owner/repo")

    def test_no_write_or_unlisted_endpoint_can_start_transport(self):
        client = preflight.PreflightGitHub("owner/repo")
        with patch.object(
            preflight.subprocess,
            "Popen",
            side_effect=AssertionError("transport started"),
        ):
            for method in ("POST", "PUT", "PATCH", "DELETE"):
                with (
                    self.subTest(method=method),
                    self.assertRaisesRegex(rc.ReleaseError, "read-only"),
                ):
                    client.request("releases", method, {})
            with self.assertRaisesRegex(
                rc.ReleaseError, "Unsupported preflight endpoint"
            ):
                client.request("secrets")


if __name__ == "__main__":
    unittest.main()
