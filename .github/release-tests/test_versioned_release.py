# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Offline integration contracts for allocation, real file overlays and publication."""

# Fixture byte layouts and descriptive test names are intentional; cleanup uses unittest.
# pylint: disable=missing-function-docstring,missing-class-docstring,line-too-long,consider-using-with
# Keep candidate byte verification beside the final-build lifecycle regressions.
# pylint: disable=too-many-lines
# Imports follow the vendored script path setup.
# pylint: disable=wrong-import-position

import argparse
import base64
import copy
import io
import json
import os

# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime, timezone
from functools import partial
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import prepare_version
import release_state as state
import release_versioned as lifecycle
import test_release_control as legacy_tests
import version_plan as versions
import version_receipt as receipt

# The legacy contract suite loads the script through importlib, while lifecycle
# modules import it normally. Bind the fake to the same exception/module identity.
REPO = legacy_tests.REPO
SHA = legacy_tests.SHA
rc = legacy_tests.rc
state.rc = rc
lifecycle.rc = rc


def policy(profile="final-build"):
    return {
        "repository": REPO,
        "mode": "release",
        "default_branch": "main",
        "version_file": "version",
        "validation_workflows": ["ci.yml"],
        "versioning": {
            "schema": 1,
            "promotion": profile,
            "build_number_floor": 50,
            "files": [{"path": "version", "format": "text", "value": "package"}],
        },
    }


class LedgerGitHub(legacy_tests.FakeGitHub):  # pylint: disable=too-many-instance-attributes
    """Model GitHub's atomic file update, independently from release mutations."""

    def __init__(self):
        super().__init__()
        self.ledger = None
        self.ledger_sha = None
        self.branch = False
        self.conflict = False
        self.ledger_writes = []
        self.evidence_by_run = {}
        self.evidence_archives = {}
        self.jobs_by_run = {}

    def api(self, path, method="GET", body=None):
        if path.startswith("compare/"):
            source = path.removeprefix("compare/").split("...", 1)[0]
            return {"status": "ahead", "merge_base_commit": {"sha": source}}
        if path == state.REF_PATH:
            if not self.branch:
                raise rc.GitHubError("HTTP 404", True)
            return {"ref": "refs/heads/" + state.BRANCH, "object": {"sha": SHA}}
        if path == state.READ_PATH:
            if self.ledger is None:
                raise rc.GitHubError("HTTP 404", True)
            return {
                "type": "file",
                "encoding": "base64",
                "sha": self.ledger_sha,
                "content": base64.b64encode(rc.json_bytes(self.ledger)).decode(),
            }
        if (
            path == "git/refs"
            and method == "POST"
            and body["ref"] == "refs/heads/" + state.BRANCH
        ):
            if self.branch:
                raise rc.GitHubError("HTTP 422")
            self.branch = True
            return {"ref": body["ref"]}
        if path == state.WRITE_PATH and method == "PUT":
            if self.conflict or body.get("sha") != self.ledger_sha:
                raise rc.GitHubError("HTTP 409 conflicting ledger write")
            self.ledger = json.loads(base64.b64decode(body["content"]))
            self.ledger_sha = rc.digest(rc.json_bytes(self.ledger))[:40]
            self.ledger_writes.append(copy.deepcopy(self.ledger))
            return {"content": {"sha": self.ledger_sha}}
        return super().api(path, method, body)

    def save_completed_evidence(self, raw):
        """Freeze real manifest bytes under the actual completed source run."""
        manifest = json.loads(raw)
        run_id = manifest["run_id"]
        archive_id = 1000 + run_id
        zipped = io.BytesIO()
        with zipfile.ZipFile(zipped, "w") as archive:
            archive.writestr(rc.MANIFEST, raw)
        content = zipped.getvalue()
        self.evidence_archives[archive_id] = content
        self.evidence_by_run[run_id] = [
            {
                "id": archive_id,
                "name": "release-evidence",
                "expired": False,
                "digest": "sha256:" + rc.digest(content),
                "workflow_run": {"id": run_id, "head_sha": manifest["source_sha"]},
            }
        ]
        self.runs[run_id].update(status="completed", conclusion="success")

    def pages(self, path, field=None):
        if path.startswith("actions/runs/") and path.endswith("/jobs"):
            run_id = int(path.split("/")[2])
            if run_id in self.jobs_by_run:
                return copy.deepcopy(self.jobs_by_run[run_id])
        if path.startswith("actions/runs/") and path.endswith("/artifacts"):
            run_id = int(path.split("/")[2])
            if run_id in self.evidence_by_run:
                return copy.deepcopy(self.evidence_by_run[run_id])
        return super().pages(path, field)

    def binary(self, path):
        if path.startswith("actions/artifacts/") and path.endswith("/zip"):
            archive_id = int(path.split("/")[2])
            if archive_id in self.evidence_archives:
                return self.evidence_archives[archive_id]
        return super().binary(path)


class DownloadingGitHub(legacy_tests.FakeGitHub):
    """Model downloads updating telemetry before the final candidate snapshot."""

    def __init__(self, mutation=None):
        super().__init__()
        self.mutation = mutation
        self.downloads = []
        for asset in self.assets[10]:
            asset.update(
                download_count=0,
                digest="sha256:" + rc.digest(self.files[asset["id"]]),
                url=f"https://api.github.com/repos/{REPO}/releases/assets/{asset['id']}",
                browser_download_url=(
                    f"https://github.com/{REPO}/releases/download/"
                    f"{legacy_tests.RC_TAG}/{asset['name']}"
                ),
                updated_at="2026-09-12T01:00:00Z",
                extra_metadata={"download_count": 0},
            )

    def binary(self, path):
        data = super().binary(path)
        if path.startswith("releases/assets/"):
            asset = next(
                item
                for item in self.assets[10]
                if item["id"] == int(path.split("/")[-1])
            )
            asset["download_count"] += 1
            self.downloads.append(asset["name"])
        return data

    def api(self, path, method="GET", body=None):
        if (
            path.startswith("git/ref/tags/")
            and self.snapshot_reads == 1
            and self.mutation
        ):
            self.mutation(self)
            self.mutation = None
        return super().api(path, method, body)


class CandidateDownloadTests(unittest.TestCase):
    """Exercise the real RC gate while the asset GETs change remote metadata."""

    def verify(self, gh):
        return lifecycle.verified_rc(gh, legacy_tests.RC_TAG, gh.info, gh.runs[99])

    def test_own_downloads_do_not_invalidate_unchanged_candidate(self):
        gh = DownloadingGitHub()
        manifest, parent = self.verify(gh)
        self.assertEqual(manifest, legacy_tests.manifest())
        self.assertEqual(parent["source_sha"], SHA)
        self.assertEqual(gh.downloads, [rc.MANIFEST, "package.tar.gz"])
        self.assertEqual([asset["download_count"] for asset in gh.assets[10]], [1, 1])
        self.assertEqual(gh.writes, [])

    def test_payloads_use_streaming_and_only_one_private_staged_file(self):
        gh = legacy_tests.FakeGitHub()
        candidate = legacy_tests.manifest()
        gh.files[22] = b"another verified payload"
        candidate["assets"].append(
            {
                "name": "second.zip",
                "size": len(gh.files[22]),
                "sha256": rc.digest(gh.files[22]),
            }
        )
        gh.files[21] = rc.json_bytes(candidate)
        gh.assets[10][1]["size"] = len(gh.files[21])
        gh.assets[10].append(
            {
                "id": 22,
                "name": "second.zip",
                "size": len(gh.files[22]),
                "state": "uploaded",
            }
        )
        gh.set_evidence(gh.files[21])
        binary = gh.binary
        staged = []

        def metadata_only(path):
            self.assertNotIn(path, {"releases/assets/20", "releases/assets/22"})
            return binary(path)

        def stream(path, output):
            destination = Path(output.name)
            self.assertEqual(list(destination.parent.iterdir()), [destination])
            output.write(gh.files[int(path.split("/")[-1])])
            staged.append(destination)

        with (
            patch.object(gh, "binary", side_effect=metadata_only),
            patch.object(gh, "download_asset", side_effect=stream) as download,
        ):
            manifest, _ = self.verify(gh)
        self.assertEqual(manifest, candidate)
        self.assertEqual(download.call_count, 2)
        self.assertEqual(len(staged), 2)
        self.assertTrue(all(not path.exists() for path in staged))
        self.assertTrue(all(not path.parent.exists() for path in staged))
        self.assertEqual(gh.writes, [])

    def test_streamed_corruption_and_truncation_reject_before_acceptance(self):
        def corrupt(mutate, source, paths, path, output):
            paths.append(Path(output.name))
            output.write(mutate(source.binary(path)))

        for change in (
            lambda data: b"x" * len(data),
            lambda data: data[:-1],
            lambda data: data + b"extra",
        ):
            gh = legacy_tests.FakeGitHub()
            staged = []

            with (
                patch.object(
                    gh,
                    "download_asset",
                    side_effect=partial(corrupt, change, gh, staged),
                ),
                self.assertRaises(rc.ReleaseError),
            ):
                self.verify(gh)
            self.assertEqual(len(staged), 1)
            self.assertFalse(staged[0].parent.exists())
            self.assertEqual(gh.snapshot_reads, 1)
            self.assertEqual(gh.writes, [])

    def test_interrupted_stream_never_accepts_or_leaves_private_payload(self):
        def fail(download_error, paths, _path, output):
            paths.append(Path(output.name))
            output.write(b"incomplete")
            raise download_error

        for error in (
            rc.GitHubError("HTTP 500"),
            rc.GitHubError("asset download exceeded 900 seconds"),
            KeyboardInterrupt(),
        ):
            with self.subTest(error=str(error)):
                gh = legacy_tests.FakeGitHub()
                staged = []

                with (
                    patch.object(
                        gh, "download_asset", side_effect=partial(fail, error, staged)
                    ),
                    self.assertRaises(type(error)),
                ):
                    self.verify(gh)
                self.assertEqual(len(staged), 1)
                self.assertFalse(staged[0].parent.exists())
                self.assertEqual(gh.snapshot_reads, 1)
                self.assertEqual(gh.writes, [])

    def test_asset_mutation_during_downloads_still_rejects_candidate(self):
        for field, value in {
            "id": 999,
            "digest": "sha256:" + "0" * 64,
            "size": 999,
            "state": "new",
            "name": "changed.tar.gz",
            "url": "https://api.github.com/changed",
            "browser_download_url": "https://github.com/changed",
            "updated_at": "2026-09-12T02:00:00Z",
            # Unknown fields, including nested counters, remain part of identity.
            "extra_metadata": {"download_count": 1},
        }.items():
            with self.subTest(field=field):

                def change(candidate, key=field, new=value):
                    candidate.assets[10][0][key] = new

                gh = DownloadingGitHub(change)
                with self.assertRaises(rc.ReleaseError):
                    self.verify(gh)
                self.assertEqual(gh.downloads, [rc.MANIFEST, "package.tar.gz"])
                self.assertEqual(gh.writes, [])

    def test_release_and_tag_changes_during_downloads_still_reject_candidate(self):
        def replace_release(gh):
            gh.releases[10]["id"] = 11
            gh.assets[11] = gh.assets[10]

        changes = {
            "release.updated_at": lambda gh: gh.releases[10].update(
                updated_at="2026-09-12T02:00:00Z"
            ),
            "release.target_commitish": lambda gh: gh.releases[10].update(
                target_commitish="b" * 40
            ),
            "release.id": replace_release,
            "release.tag_name": lambda gh: gh.releases[10].update(
                tag_name="v1.2.3-rc.3"
            ),
            "release.draft": lambda gh: gh.releases[10].update(draft=True),
            "release.prerelease": lambda gh: gh.releases[10].update(prerelease=False),
            "tag.commit": lambda gh: gh.refs[legacy_tests.RC_TAG]["object"].update(
                sha="b" * 40
            ),
            "tag.type": lambda gh: gh.refs[legacy_tests.RC_TAG]["object"].update(
                type="tag"
            ),
            "asset.removal": lambda gh: gh.assets[10].pop(),
            "asset.addition": lambda gh: gh.assets[10].append(
                dict(gh.assets[10][0], id=100, name="unexpected.zip")
            ),
        }
        for name, change in changes.items():
            with self.subTest(change=name):
                gh = DownloadingGitHub(change)
                with self.assertRaises(rc.ReleaseError):
                    self.verify(gh)
                self.assertEqual(gh.downloads, [rc.MANIFEST, "package.tar.gz"])
                self.assertEqual(gh.writes, [])


class AllocationTests(unittest.TestCase):
    def setUp(self):
        self.gh = LedgerGitHub()
        self.policy = policy()
        self.now = datetime(2026, 9, 13, tzinfo=timezone.utc)

    def reserve(self, run_id=99, channel="beta", attempt=1):
        return state.reserve_plan(
            self.gh, self.policy, "1.2.3", channel, SHA, run_id, attempt, self.now
        )

    def test_retry_uses_same_plan_without_another_write(self):
        first = self.reserve()
        self.assertEqual(first["build_number"], 51)
        self.assertEqual(first["tag"], "v1.2.3-beta.1")
        self.assertEqual(self.reserve(attempt=2), first)
        self.assertEqual(len(self.gh.ledger_writes), 1)
        self.assertEqual(self.reserve(100)["tag"], "v1.2.3-beta.2")

    def test_retry_cannot_change_policy_or_channel(self):
        self.reserve()
        with self.assertRaises(rc.ReleaseError):
            self.reserve(channel="rc")
        self.policy["versioning"]["build_number_floor"] = 100
        with self.assertRaises(ValueError):
            self.reserve()

    def test_cas_conflict_does_not_silently_reassign_or_publish(self):
        self.gh.conflict = True
        with self.assertRaisesRegex(rc.GitHubError, "409"):
            self.reserve()
        self.assertEqual(self.gh.ledger_writes, [])
        self.assertEqual(self.gh.writes, [])

    def test_abandoned_build_reservations_are_not_reused(self):
        first = self.reserve()
        second = self.reserve(100)
        self.assertGreater(second["build_number"], first["build_number"])
        self.assertNotEqual(second["tag"], first["tag"])

    def test_delayed_build_cannot_publish_after_newer_number(self):
        first = self.reserve()
        second = self.reserve(100)
        self.gh.releases[50] = {"tag_name": second["tag"], "draft": False}
        with self.assertRaisesRegex(rc.ReleaseError, "newer build number"):
            state.verify_reservation(self.gh, first, 99)

    def test_plan_tampering_fails_reservation(self):
        plan = self.reserve()
        plan["build_number"] += 1
        with self.assertRaisesRegex(rc.ReleaseError, "reservation differs"):
            state.verify_reservation(self.gh, plan, 99)

    def test_byte_promotion_ignores_selected_rc_but_rejects_newer_published_build(self):
        self.policy = policy("promote-bytes")
        candidate = self.reserve(channel="rc")
        self.gh.releases[50] = {"tag_name": candidate["tag"], "draft": False}
        state.verify_promotion_order(self.gh, candidate)
        later = self.reserve(run_id=100)
        self.gh.releases[51] = {"tag_name": later["tag"], "draft": True}
        state.verify_promotion_order(self.gh, candidate)
        self.gh.releases[51]["draft"] = False
        with self.assertRaisesRegex(rc.ReleaseError, "newer native build"):
            state.verify_promotion_order(self.gh, candidate)
        self.assertEqual(self.gh.writes, [])

    def test_byte_promotion_requires_unique_exact_reservation(self):
        self.policy = policy("promote-bytes")
        candidate = self.reserve(channel="rc")
        self.gh.releases[50] = {"tag_name": candidate["tag"], "draft": False}
        self.gh.ledger["plans"].clear()
        with self.assertRaisesRegex(rc.ReleaseError, "unique durable"):
            state.verify_promotion_order(self.gh, candidate)

    def test_branch_creation_and_cas_requests_use_real_narrow_client(self):
        client = state.StateGitHub(REPO)
        responses = [
            legacy_tests.http_response(stdout=b'{"ref":"refs/heads/release-version-state"}'),
            legacy_tests.http_response(stdout=b'{"content":{"sha":"' + SHA.encode() + b'"}}'),
        ]
        with patch.object(state.subprocess, "run", side_effect=responses) as run:
            client.api(
                "git/refs", "POST", {"ref": "refs/heads/" + state.BRANCH, "sha": SHA}
            )
            state.write_state(client, {"schema": 1, "counter": 0, "plans": {}}, None)
        self.assertEqual(run.call_args_list[0].args[0][-1], f"repos/{REPO}/git/refs")
        self.assertEqual(
            json.loads(run.call_args_list[1].kwargs["input"])["branch"], state.BRANCH
        )
        with (
            patch.object(state.subprocess, "run") as run,
            self.assertRaisesRegex(rc.ReleaseError, "branch mismatch"),
        ):
            client.api(state.WRITE_PATH, "PUT", {"branch": "main", "content": "bad"})
        run.assert_not_called()


class ToolchainTests(unittest.TestCase):
    def test_receipt_records_actual_available_tool_version_output(self):
        def available(name):
            return "/installed/rustc" if name == "rustc" else None

        response = subprocess.CompletedProcess(
            [], 0, "rustc 1.90.0 (recorded compiler)\n"
        )
        with (
            patch.object(receipt.shutil, "which", side_effect=available),
            patch.object(receipt.subprocess, "run", return_value=response) as execute,
        ):
            result = receipt.capture_toolchain()
        self.assertEqual(result["rustc"], "rustc 1.90.0 (recorded compiler)")
        self.assertEqual(result["python"], sys.version.split()[0])
        execute.assert_called_once_with(
            ["/installed/rustc", "--version"],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )

    def test_installed_tool_with_empty_version_output_cannot_be_attested(self):
        with (
            patch.object(receipt.shutil, "which", return_value="/installed/compiler"),
            patch.object(
                receipt.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, ""),
            ),
            self.assertRaisesRegex(ValueError, "Invalid toolchain version output"),
        ):
            receipt.capture_toolchain()


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        # This synthetic fixture intentionally has no detached OCI contract.
        import release_provenance
        self.enterContext(patch.object(release_provenance, "REQUIRED_PAIRS", ()))
        self.enterContext(
            patch.object(
                receipt,
                "capture_toolchain",
                return_value={
                    "python": "3.12.8",
                    "platform": "linux",
                    "rustc": "rustc 1.90.0",
                },
            )
        )
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "version").write_text("1.2.3\n")
        self.policy = policy()
        self.plan = versions.create_plan("1.2.3", "beta", 1, SHA, self.policy, 51)
        self.plan_path = self.root / ".release-plan.json"
        self.plan_path.write_bytes(rc.json_bytes(self.plan))
        evidence = versions.sync_versions(self.root, self.policy, self.plan)
        self.inputs_path = self.root / ".release-inputs.json"
        self.inputs_path.write_bytes(
            rc.json_bytes(
                {
                    "schema": 1,
                    "source_sha": SHA,
                    "plan_sha256": versions.plan_digest(self.plan),
                    "files": evidence,
                    "effective_inputs_sha256": versions.effective_inputs_digest(
                        evidence
                    ),
                }
            )
        )
        self.assets = self.root / "assets"
        self.assets.mkdir()
        (self.assets / "app.bin").write_bytes(
            b"real package " + (self.root / "version").read_bytes()
        )

    def create(self):
        return receipt.create_receipt(
            self.plan_path,
            self.inputs_path,
            self.assets,
            self.assets / "release-inputs-linux.json",
        )

    def staged(self):
        return [
            {
                "name": path.name,
                "size": path.stat().st_size,
                "sha256": rc.digest(path.read_bytes()),
            }
            for path in self.assets.iterdir()
        ]

    def test_overlay_receipt_binds_exact_payload_and_inputs(self):
        self.create()
        verified = receipt.verify_receipts(
            self.assets, self.plan, self.staged(), self.policy
        )
        self.assertEqual(len(verified), 1)
        self.assertEqual((self.root / "version").read_text(), "1.2.3-beta.1\n")

    def test_changed_or_extra_payload_is_rejected(self):
        self.create()
        original = (self.assets / "app.bin").read_bytes()
        (self.assets / "app.bin").write_bytes(b"different binary")
        staged = self.staged()
        with self.assertRaisesRegex(ValueError, "does not match"):
            receipt.verify_receipts(self.assets, self.plan, staged)
        (self.assets / "app.bin").write_bytes(original)
        (self.assets / "uncovered.bin").write_bytes(b"missing evidence")
        staged = self.staged()
        with self.assertRaisesRegex(ValueError, "payloads lack version input evidence"):
            receipt.verify_receipts(self.assets, self.plan, staged)

    def test_other_plan_or_partial_input_inventory_is_rejected(self):
        self.create()
        other = versions.create_plan("1.2.3", "beta", 2, SHA, self.policy, 52)
        staged = self.staged()
        with self.assertRaisesRegex(ValueError, "different release plan"):
            receipt.verify_receipts(self.assets, other, staged)
        altered = copy.deepcopy(self.policy)
        altered["versioning"]["files"].append({"path": "missing", "format": "text"})
        staged = self.staged()
        with self.assertRaisesRegex(ValueError, "every declared"):
            receipt.verify_receipts(self.assets, self.plan, staged, altered)

    def test_symlink_or_empty_assets_never_get_receipt(self):
        (self.assets / "app.bin").unlink()
        with self.assertRaisesRegex(ValueError, "empty"):
            self.create()
        (self.assets / "link").symlink_to(self.root / "version")
        with self.assertRaisesRegex(ValueError, "regular file"):
            self.create()


class LifecycleTests(unittest.TestCase):  # pylint: disable=too-many-public-methods
    def setUp(self):
        # This synthetic fixture intentionally has no detached OCI contract.
        import release_provenance
        self.enterContext(patch.object(release_provenance, "REQUIRED_PAIRS", ()))
        self.enterContext(
            patch.object(
                receipt,
                "capture_toolchain",
                return_value={
                    "python": "3.12.8",
                    "platform": "linux",
                    "rustc": "rustc 1.90.0",
                },
            )
        )
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        old = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, old)
        self.policy = policy()
        (self.root / ".release-policy.json").write_bytes(rc.json_bytes(self.policy))
        (self.root / "version").write_text("1.2.3\n")
        event = self.root / "event.json"
        event.write_text(
            json.dumps({"inputs": {"channel": "beta", "expected_sha": SHA}})
        )
        self.gh = LedgerGitHub()
        self.gh.source_policies[SHA] = self.policy
        self.args = argparse.Namespace(repo=REPO, assets=".release-assets")
        patches = [
            patch.object(lifecycle, "StateGitHub", return_value=self.gh),
            patch.object(lifecycle.client, "ROOT", self.root),
            patch.object(lifecycle.rc, "checked_out_sha", return_value=SHA),
            patch.dict(
                os.environ,
                {
                    "GITHUB_ACTIONS": "true",
                    "GITHUB_REPOSITORY": REPO,
                    "GITHUB_RUN_ID": "99",
                    "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_REF": "refs/heads/main",
                    "GITHUB_WORKFLOW_REF": f"{REPO}/{rc.WORKFLOW}@refs/heads/main",
                    "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_EVENT_PATH": str(event),
                    "PUBLICATION_ENABLED": "true",
                },
            ),
        ]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    def start_run(self, channel, run_id, rc_tag=None):
        """Model an isolated fresh checkout and one manual workflow request."""
        self.gh.runs[run_id] = legacy_tests.run(run_id, completed=False)
        os.environ["GITHUB_RUN_ID"] = str(run_id)
        inputs = {"channel": channel, "expected_sha": SHA}
        if rc_tag:
            inputs["rc_tag"] = rc_tag
        Path(os.environ["GITHUB_EVENT_PATH"]).write_text(
            json.dumps({"inputs": inputs}), encoding="utf-8"
        )
        (self.root / "version").write_text("1.2.3\n")
        self.args.assets = str(self.root / f"assets-{run_id}")

    def build_current(self):
        plan = json.loads(lifecycle.PLAN.read_text(encoding="utf-8"))
        evidence = versions.sync_versions(self.root, self.policy, plan)
        inputs = self.root / ".release-inputs.json"
        inputs.write_bytes(
            rc.json_bytes(
                {
                    "schema": 1,
                    "source_sha": plan["source_sha"],
                    "plan_sha256": versions.plan_digest(plan),
                    "files": evidence,
                    "effective_inputs_sha256": versions.effective_inputs_digest(
                        evidence
                    ),
                }
            )
        )
        assets = Path(self.args.assets)
        assets.mkdir()
        package = {
            "version": (self.root / "version").read_text().strip(),
            "build_number": plan["build_number"],
        }
        (assets / "app.json").write_bytes(rc.json_bytes(package))
        receipt.create_receipt(
            lifecycle.PLAN, inputs, assets, assets / "release-inputs-linux.json"
        )
        return plan

    def release_run(self, channel, run_id, rc_tag=None):
        self.start_run(channel, run_id, rc_tag)
        lifecycle.prepare(self.args)
        plan = self.build_current()
        result = lifecycle.publish_versioned(self.args)
        raw = rc.EVIDENCE.read_bytes()
        self.gh.save_completed_evidence(raw)
        return result, plan, json.loads(raw)

    def declare_json_artifact(self):
        self.policy["versioning"]["artifacts"] = [
            {
                "path": "app.json",
                "format": "json",
                "field": "version",
                "value": "package",
            }
        ]
        self.gh.source_policies[SHA] = copy.deepcopy(self.policy)
        (self.root / ".release-policy.json").write_bytes(rc.json_bytes(self.policy))

    def qualify_schedule_fixture(self, channel="rc"):
        """Publish real receipts/evidence, then model GitHub's asset digests."""
        result, plan, _ = self.release_run(channel, 100)
        self.gh.jobs_by_run[100] = [
            copy.deepcopy(self.gh.jobs[0]),
            {**self.gh.jobs[0], "name": "checks / CI gate"},
        ]
        for assets in self.gh.assets.values():
            for asset in assets:
                asset["digest"] = "sha256:" + rc.digest(self.gh.files[asset["id"]])
        return result, plan

    def start_schedule(self):
        """A schedule starts in a fresh checkout and never receives a manual opt-in."""
        self.start_run("nightly", 200)
        self.gh.runs[200]["event"] = "schedule"
        os.environ["GITHUB_EVENT_NAME"] = "schedule"
        lifecycle.PLAN.unlink(missing_ok=True)
        rc.EVIDENCE.unlink(missing_ok=True)

    def build_schedule(self):
        self.start_schedule()
        prepared = lifecycle.prepare(self.args)
        self.assertEqual(prepared["build"], "true")
        self.assertTrue(prepared["plan_artifact"])
        self.assertNotIn("reused_release", prepared)
        return self.build_current()

    def test_scheduled_rc_reuse_preserves_floor_and_promotion_after_full_build(self):
        self.policy["versioning"]["promotion"] = "promote-bytes"
        self.gh.source_policies[SHA] = self.policy
        (self.root / ".release-policy.json").write_bytes(rc.json_bytes(self.policy))
        published, accepted = self.qualify_schedule_fixture()
        floor = self.gh.ledger["publication_floor"]
        plan = self.build_schedule()
        self.assertGreater(plan["build_number"], accepted["build_number"])
        writes = copy.deepcopy(self.gh.ledger_writes)
        release_writes = copy.deepcopy(self.gh.writes)
        with patch.object(
            self.gh, "download_asset", wraps=self.gh.download_asset
        ) as download:
            result = lifecycle.publish_versioned(self.args)
        self.assertEqual(result["status"], "reused")
        self.assertEqual(result["tag"], published["tag"])
        self.assertEqual(self.gh.ledger["publication_floor"], floor)
        self.assertEqual(self.gh.ledger_writes, writes)
        self.assertEqual(self.gh.writes, release_writes)
        state.verify_promotion_order(self.gh, accepted)
        self.assertFalse(rc.EVIDENCE.exists())
        download.assert_not_called()

    def test_scheduled_beta_reuses_retained_qualified_package(self):
        published, _ = self.qualify_schedule_fixture("beta")
        self.build_schedule()
        result = lifecycle.publish_versioned(self.args)
        self.assertEqual(result["status"], "reused")
        self.assertEqual(result["tag"], published["tag"])

    def test_promoted_stable_can_reuse_original_rc_evidence(self):
        self.policy["versioning"]["promotion"] = "promote-bytes"
        self.gh.source_policies[SHA] = self.policy
        (self.root / ".release-policy.json").write_bytes(rc.json_bytes(self.policy))
        published, _ = self.qualify_schedule_fixture()
        release = next(
            value
            for value in self.gh.releases.values()
            if value["tag_name"] == published["tag"]
        )
        release.update(tag_name="v1.2.3", prerelease=False)
        self.gh.refs["v1.2.3"] = {
            "ref": "refs/tags/v1.2.3",
            "object": {"type": "commit", "sha": SHA},
        }
        del self.gh.refs[published["tag"]]
        self.build_schedule()
        result = lifecycle.publish_versioned(self.args)
        self.assertEqual(result["status"], "reused")
        self.assertEqual(result["tag"], "v1.2.3")

    def test_final_build_stable_is_a_qualified_publication(self):
        candidate, _ = self.qualify_schedule_fixture()
        published, _, _ = self.release_run("stable", 101, candidate["tag"])
        self.gh.jobs_by_run[101] = [
            copy.deepcopy(self.gh.jobs[0]),
            {**self.gh.jobs[0], "name": "checks / CI gate"},
        ]
        for assets in self.gh.assets.values():
            for asset in assets:
                asset["digest"] = "sha256:" + rc.digest(self.gh.files[asset["id"]])
        self.build_schedule()
        result = lifecycle.publish_versioned(self.args)
        self.assertEqual(result["status"], "reused")
        self.assertEqual(result["tag"], published["tag"])

    def test_release_mutation_during_verification_does_not_skip_publication(self):
        published, _ = self.qualify_schedule_fixture()
        self.build_schedule()
        release = next(
            value
            for value in self.gh.releases.values()
            if value["tag_name"] == published["tag"]
        )
        original = self.gh.binary

        def changed(path):
            release["updated_at"] = "2026-10-02T11:59:00Z"
            return original(path)

        with patch.object(self.gh, "binary", side_effect=changed):
            result = lifecycle.publish_versioned(self.args)
        self.assertEqual(result["status"], "published")

    def test_unqualified_or_changed_release_never_skips_publication(self):
        published, _ = self.qualify_schedule_fixture()
        plan = self.build_schedule()
        baseline = copy.deepcopy(self.gh)
        release_id = next(
            key
            for key, value in baseline.releases.items()
            if value["tag_name"] == published["tag"]
        )
        cases = {
            "draft": lambda gh: gh.releases[release_id].update(draft=True),
            "upload": lambda gh: gh.assets[release_id][0].update(state="new"),
            "asset_digest": lambda gh: gh.assets[release_id][0].update(
                digest="sha256:" + "0" * 64
            ),
            "expired": lambda gh: gh.evidence_by_run[100][0].update(expired=True),
            "evidence_digest": lambda gh: gh.evidence_by_run[100][0].update(
                digest="sha256:" + "0" * 64
            ),
            "failed_run": lambda gh: gh.runs[100].update(conclusion="failure"),
            "rerun": lambda gh: gh.runs[100].update(run_attempt=2),
            "wrong_workflow": lambda gh: gh.runs[100].update(
                path=".github/workflows/other.yml"
            ),
            "ci_failure": lambda gh: gh.jobs_by_run[100][1].update(
                conclusion="failure"
            ),
            "release_failure": lambda gh: gh.jobs_by_run[100][0].update(
                conclusion="failure"
            ),
            "changed_source": lambda gh: gh.ledger["plans"]["100"]["plan"].update(
                source_sha="b" * 40
            ),
            "changed_policy": lambda gh: gh.ledger["plans"]["100"]["plan"].update(
                policy_sha256="0" * 64
            ),
            "changed_base": lambda gh: gh.ledger["plans"]["100"]["plan"].update(
                base_version="1.2.4",
                version="1.2.4-rc.3",
                tag="v1.2.4-rc.3",
                sequence=3,
            ),
        }
        for reason, mutate in cases.items():
            gh = copy.deepcopy(baseline)
            mutate(gh)
            with (
                self.subTest(reason=reason),
                patch.object(lifecycle, "StateGitHub", return_value=gh),
            ):
                result = lifecycle.publish_versioned(self.args)
                self.assertEqual(result["status"], "published")
                self.assertEqual(result["tag"], plan["tag"])
                self.assertEqual(gh.ledger["publication_floor"], plan["build_number"])

    def test_unqualified_nightly_is_not_a_reuse_baseline(self):
        self.qualify_schedule_fixture("nightly")
        self.build_schedule()
        self.assertEqual(lifecycle.publish_versioned(self.args)["status"], "published")

    def test_manual_nightly_always_publishes_despite_qualified_rc(self):
        self.qualify_schedule_fixture()
        self.start_run("nightly", 200)
        lifecycle.prepare(self.args)
        self.build_current()
        with patch.object(lifecycle, "scheduled_reuse") as reuse:
            result = lifecycle.publish_versioned(self.args)
        self.assertEqual(result["status"], "published")
        reuse.assert_not_called()

    def test_new_source_always_publishes_despite_previous_rc(self):
        self.qualify_schedule_fixture()
        self.start_schedule()
        sha = "b" * 40
        self.gh.default_head = sha
        self.gh.runs[200]["head_sha"] = sha
        self.gh.jobs[0]["head_sha"] = sha
        self.gh.source_policies[sha] = self.policy
        Path(os.environ["GITHUB_EVENT_PATH"]).write_text("{}", encoding="utf-8")
        with patch.object(rc, "checked_out_sha", return_value=sha):
            lifecycle.prepare(self.args)
            self.build_current()
            result = lifecycle.publish_versioned(self.args)
        self.assertEqual(result["status"], "published")

    def test_default_branch_movement_during_reuse_prevents_skip(self):
        self.qualify_schedule_fixture()
        self.build_schedule()
        info = rc.repository_info(self.gh)
        snapshot = rc.source_policy_snapshot(self.gh, SHA)
        binary = self.gh.binary

        def moved(path):
            self.gh.default_head = "b" * 40
            return binary(path)

        with patch.object(self.gh, "binary", side_effect=moved):
            result = lifecycle.scheduled_reuse(
                self.gh, info, self.gh.runs[200], snapshot, "1.2.3"
            )
        self.assertEqual(result, "")

    def test_failed_current_gate_cannot_reuse_previous_rc(self):
        self.qualify_schedule_fixture()
        self.build_schedule()
        self.gh.jobs[0]["conclusion"] = "failure"
        with patch.object(lifecycle, "scheduled_reuse") as reuse:
            with self.assertRaisesRegex(rc.ReleaseError, "gate"):
                lifecycle.publish_versioned(self.args)
        reuse.assert_not_called()

    def test_invalid_current_build_receipt_cannot_reuse_previous_rc(self):
        self.qualify_schedule_fixture()
        self.build_schedule()
        (Path(self.args.assets) / "app.json").write_bytes(b"changed build")
        with patch.object(lifecycle, "scheduled_reuse") as reuse:
            with self.assertRaises(ValueError):
                lifecycle.publish_versioned(self.args)
        reuse.assert_not_called()

    def test_prepare_uses_refreshed_run_after_transient_status(self):
        """The frozen-plan prepare boundary waits without bypassing execution guards."""
        original_api = self.gh.api
        statuses = iter(("queued", "pending", "in_progress"))

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
            result = lifecycle.prepare(self.args)
        self.assertEqual(sleep.call_count, 2)
        self.assertEqual(result["channel"], "beta")
        self.assertEqual(len(self.gh.ledger_writes), 1)
        self.assertEqual(self.gh.writes, [])

    def test_closed_push_cycle_stops_before_plan_allocation(self):
        self.gh.refs["v1.2.3"] = {
            "ref": "refs/tags/v1.2.3",
            "object": {"type": "commit", "sha": SHA},
        }
        self.gh.runs[99]["event"] = "push"
        os.environ["GITHUB_EVENT_NAME"] = "push"
        original = (self.root / "version").read_bytes()
        result = lifecycle.prepare(self.args)
        self.assertEqual(result["status"], "version-required")
        self.assertEqual(result["build"], "false")
        self.assertEqual(self.gh.ledger_writes, [])
        self.assertEqual(self.gh.writes, [])
        self.assertFalse(lifecycle.PLAN.exists())
        self.assertEqual((self.root / "version").read_bytes(), original)

    def test_closed_push_cycle_does_not_bypass_source_or_version_checks(self):
        self.gh.refs["v1.2.3"] = {
            "ref": "refs/tags/v1.2.3",
            "object": {"type": "commit", "sha": SHA},
        }
        self.gh.runs[99]["event"] = "push"
        os.environ["GITHUB_EVENT_NAME"] = "push"
        with (
            patch.object(lifecycle.rc, "checked_out_sha", return_value="b" * 40),
            self.assertRaises(rc.ReleaseError),
        ):
            lifecycle.prepare(self.args)
        with (
            patch.object(lifecycle.client, "resolve_version", return_value="1.2.4"),
            self.assertRaises(ValueError),
        ):
            lifecycle.prepare(self.args)
        self.assertEqual(self.gh.ledger_writes, [])

    def test_explicit_beta_keeps_existing_stable_tag_error(self):
        self.gh.refs["v1.2.3"] = {
            "ref": "refs/tags/v1.2.3",
            "object": {"type": "commit", "sha": SHA},
        }
        with self.assertRaisesRegex(rc.ReleaseError, "Tag already exists"):
            lifecycle.prepare(self.args)
        self.assertEqual(self.gh.ledger_writes, [])

    def test_prepare_build_receipt_publish_keeps_exact_identity(self):
        result = lifecycle.prepare(self.args)
        self.assertEqual(result["build"], "true")
        self.assertEqual(self.gh.writes, [])
        plan = json.loads(lifecycle.PLAN.read_text(encoding="utf-8"))
        evidence = versions.sync_versions(self.root, self.policy, plan)
        inputs = self.root / ".release-inputs.json"
        inputs.write_bytes(
            rc.json_bytes(
                {
                    "schema": 1,
                    "source_sha": SHA,
                    "plan_sha256": versions.plan_digest(plan),
                    "files": evidence,
                    "effective_inputs_sha256": versions.effective_inputs_digest(
                        evidence
                    ),
                }
            )
        )
        assets = self.root / self.args.assets
        assets.mkdir()
        (assets / "app.bin").write_bytes((self.root / "version").read_bytes())
        receipt.create_receipt(
            lifecycle.PLAN, inputs, assets, assets / "release-inputs-linux.json"
        )
        published = lifecycle.publish_versioned(self.args)
        self.assertEqual(published["tag"], plan["tag"])
        recorded = json.loads(rc.EVIDENCE.read_text())
        self.assertEqual(recorded["version_plan"], plan)
        self.assertEqual(recorded["version"], "1.2.3")
        self.assertEqual(len(recorded["assets"]), 2)

    def enable_beta_validation(self, channel):
        self.policy.update(
            {
                "single_entry_ci": True,
                "channel_validation_workflows": {"beta": ["beta-checks.yml"]},
            }
        )
        (self.root / ".release-policy.json").write_bytes(rc.json_bytes(self.policy))
        self.gh.jobs.extend(
            [
                {**self.gh.jobs[0], "name": "checks / CI gate"},
                {**self.gh.jobs[0], "name": f"checks / Validation profile ({channel})"},
            ]
        )

    def test_beta_profile_survives_real_prepare_receipt_and_publication(self):
        self.enable_beta_validation("beta")
        _, plan, manifest = self.release_run("beta", 100)
        self.assertEqual(
            manifest["validation_profile"],
            {
                "schema": 1,
                "channel": "beta",
                "workflows": ["beta-checks.yml"],
            },
        )
        self.assertEqual(manifest["version_plan"], plan)
        self.assertEqual(len(manifest["assets"]), 2)
        raw = rc.json_bytes(manifest)
        with self.assertRaisesRegex(rc.ReleaseError, "Only release candidates"):
            rc.validate_manifest(raw, REPO, plan["tag"])

    def test_rc_profile_cannot_claim_fast_beta_evidence(self):
        self.enable_beta_validation("rc")
        _, plan, manifest = self.release_run("rc", 100)
        self.assertEqual(manifest["validation_profile"]["workflows"], ["ci.yml"])
        rc.validate_manifest(rc.json_bytes(manifest), REPO, plan["tag"])
        manifest["validation_profile"]["workflows"] = ["beta-checks.yml"]
        raw = rc.json_bytes(manifest)
        with self.assertRaisesRegex(rc.ReleaseError, "validation profile"):
            rc.validate_manifest(raw, REPO, plan["tag"])

    def test_opt_in_rc_promotes_with_unchanged_full_validation_evidence(self):
        self.policy["versioning"]["promotion"] = "promote-bytes"
        self.enable_beta_validation("rc")
        candidate, _, manifest = self.release_run("rc", 100)
        raw = rc.EVIDENCE.read_bytes()
        self.gh.jobs_by_run[100] = copy.deepcopy(self.gh.jobs)
        self.start_run("stable", 101, candidate["tag"])
        prepared = lifecycle.prepare(self.args)
        self.assertEqual(prepared["build"], "false")
        arguments = argparse.Namespace(repo=REPO, rc=candidate["tag"], run_id="101")
        with patch.object(rc, "GitHub", return_value=self.gh):
            stable = rc.promote(arguments)
        release_id = next(
            key
            for key, value in self.gh.releases.items()
            if value["tag_name"] == stable["tag"]
        )
        promoted = {
            asset["name"]: self.gh.files[asset["id"]]
            for asset in self.gh.assets[release_id]
        }
        self.assertEqual(promoted[rc.MANIFEST], raw)
        self.assertEqual(
            manifest["validation_profile"],
            {"schema": 1, "channel": "rc", "workflows": ["ci.yml"]},
        )
        for asset in manifest["assets"]:
            self.assertEqual(rc.digest(promoted[asset["name"]]), asset["sha256"])

    def test_publication_rejects_missing_selected_gate_before_public_writes(self):
        self.enable_beta_validation("rc")
        self.start_run("beta", 100)
        lifecycle.prepare(self.args)
        self.build_current()
        with self.assertRaisesRegex(rc.ReleaseError, "profile and CI gate"):
            lifecycle.publish_versioned(self.args)
        self.assertEqual(self.gh.writes, [])

    def automatic_build(self):
        lifecycle.prepare(self.args)
        plan = self.build_current()
        self.gh.runs[99]["event"] = "push"
        os.environ["GITHUB_EVENT_NAME"] = "push"
        return plan

    def advance_default(self):
        self.gh.default_head = "b" * 40
        self.gh.successors = [
            {
                **legacy_tests.run(100, False),
                "event": "push",
                "head_sha": self.gh.default_head,
            }
        ]

    def test_automatic_current_head_publishes_exact_built_bytes(self):
        plan = self.automatic_build()
        result = lifecycle.publish_versioned(self.args)
        self.assertEqual(result["status"], "published")
        self.assertEqual(result["tag"], plan["tag"])
        self.assertEqual(json.loads(rc.EVIDENCE.read_bytes())["source_sha"], SHA)

    def test_early_and_late_supersession_preserve_reservation_without_publication(self):
        plan = self.automatic_build()
        ledger = copy.deepcopy(self.gh.ledger)
        original = lifecycle.verify_receipts
        for late in (True, False):
            self.gh.default_head = SHA
            self.gh.successors = []

            def advance_after_receipts(*args):
                result = original(*args)
                self.advance_default()
                return result

            if not late:
                self.advance_default()
            with patch.object(
                lifecycle, "verify_receipts", side_effect=advance_after_receipts
            ):
                result = lifecycle.publish_versioned(self.args)
            self.assertEqual(result["status"], "superseded")
            self.assertEqual(self.gh.ledger, ledger)
            self.assertEqual(json.loads(lifecycle.PLAN.read_bytes()), plan)
            self.assertEqual(len(self.gh.ledger_writes), 1)
            self.assertEqual(self.gh.writes, [])
            self.assertFalse(rc.EVIDENCE.exists())

    def test_unproven_replacement_fails_before_floor_and_tag(self):
        self.automatic_build()
        ledger = copy.deepcopy(self.gh.ledger)
        self.advance_default()
        self.gh.successors = []
        with self.assertRaisesRegex(rc.ReleaseError, "one proven replacement"):
            lifecycle.publish_versioned(self.args)
        self.assertEqual(self.gh.ledger, ledger)
        self.assertEqual(self.gh.writes, [])
        self.assertFalse(rc.EVIDENCE.exists())

    def test_supersession_does_not_hide_a_previously_consumed_plan(self):
        plan = self.automatic_build()
        state.begin_publication(self.gh, plan, 99)
        self.advance_default()
        with self.assertRaisesRegex(rc.ReleaseError, "publication floor"):
            lifecycle.publish_versioned(self.args)
        self.assertEqual(self.gh.ledger["publication_floor"], plan["build_number"])
        self.assertEqual(self.gh.writes, [])
        self.assertFalse(rc.EVIDENCE.exists())

    def test_post_guard_tag_failure_consumes_floor_without_retry_or_false_skip(self):
        plan = self.automatic_build()
        original = self.gh.api
        attempts = []

        def denied_tag(path, method="GET", body=None):
            if path == "git/refs" and method == "POST":
                attempts.append(body)
                self.advance_default()
                raise rc.GitHubError("POST git/refs: HTTP 403")
            return original(path, method, body)

        with patch.object(self.gh, "api", side_effect=denied_tag):
            with self.assertRaisesRegex(rc.GitHubError, "403"):
                lifecycle.publish_versioned(self.args)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(self.gh.ledger["publication_floor"], plan["build_number"])
        self.assertEqual(len(self.gh.ledger_writes), 2)
        self.assertNotIn(plan["tag"], self.gh.refs)

    def reject_workflow_drift_without_publication(self, publish):
        """Keep an allocated plan reusable when a known permission failure is found."""
        self.gh.default_head = "b" * 40
        self.gh.github_directories[self.gh.default_head][0]["sha"] = "d" * 40
        ledger = copy.deepcopy(self.gh.ledger)
        ledger_writes = copy.deepcopy(self.gh.ledger_writes)
        writes = copy.deepcopy(self.gh.writes)
        with self.assertRaisesRegex(rc.ReleaseError, "workflows differ"):
            publish()
        self.assertEqual(self.gh.ledger, ledger)
        self.assertEqual(self.gh.ledger_writes, ledger_writes)
        self.assertEqual(self.gh.writes, writes)
        self.assertNotIn("v1.2.3", self.gh.refs)

    def test_manual_beta_and_rc_workflow_drift_preserves_publication_floor(self):
        for channel, run_id in (("beta", 100), ("rc", 101)):
            with self.subTest(channel=channel):
                self.gh.default_head = SHA
                self.start_run(channel, run_id)
                lifecycle.prepare(self.args)
                self.build_current()
                self.reject_workflow_drift_without_publication(
                    partial(lifecycle.publish_versioned, self.args)
                )
                self.assertFalse(rc.EVIDENCE.exists())

    def test_final_build_workflow_drift_preserves_rc_floor_and_evidence(self):
        candidate, _, _ = self.release_run("rc", 100)
        accepted = rc.EVIDENCE.read_bytes()
        self.start_run("stable", 101, candidate["tag"])
        lifecycle.prepare(self.args)
        self.build_current()
        self.reject_workflow_drift_without_publication(
            partial(lifecycle.publish_versioned, self.args)
        )
        self.assertEqual(rc.EVIDENCE.read_bytes(), accepted)

    def test_byte_promotion_workflow_drift_preserves_rc_floor(self):
        self.policy = policy("promote-bytes")
        self.gh.source_policies[SHA] = self.policy
        Path(rc.POLICY).write_bytes(rc.json_bytes(self.policy))
        candidate, _, _ = self.release_run("rc", 100)
        self.start_run("stable", 101, candidate["tag"])
        arguments = argparse.Namespace(repo=REPO, rc=candidate["tag"], run_id="101")
        with patch.object(rc, "GitHub", return_value=self.gh):
            self.reject_workflow_drift_without_publication(
                partial(rc.promote, arguments)
            )

    def reject_missing_notes_without_mutation(self, operation):
        """Invalid notes cannot replace retained evidence or advance the floor."""
        ledger = copy.deepcopy(self.gh.ledger)
        ledger_writes = copy.deepcopy(self.gh.ledger_writes)
        writes = copy.deepcopy(self.gh.writes)
        evidence = rc.EVIDENCE.read_bytes() if rc.EVIDENCE.exists() else None
        with patch.object(
            rc, "release_notes", side_effect=rc.ReleaseError("missing notes")
        ):
            with self.assertRaisesRegex(rc.ReleaseError, "missing notes"):
                operation()
        self.assertEqual(self.gh.ledger, ledger)
        self.assertEqual(self.gh.ledger_writes, ledger_writes)
        self.assertEqual(self.gh.writes, writes)
        current = rc.EVIDENCE.read_bytes() if rc.EVIDENCE.exists() else None
        self.assertEqual(current, evidence)

    def test_candidate_notes_fail_before_evidence_or_publication_floor(self):
        for channel, run_id in (("beta", 100), ("rc", 101), ("nightly", 102)):
            with self.subTest(channel=channel):
                self.start_run(channel, run_id)
                lifecycle.prepare(self.args)
                self.build_current()
                self.reject_missing_notes_without_mutation(
                    partial(lifecycle.publish_versioned, self.args)
                )

    def test_final_build_notes_fail_before_replacing_rc_evidence(self):
        candidate, _, _ = self.release_run("rc", 100)
        self.start_run("stable", 101, candidate["tag"])
        lifecycle.prepare(self.args)
        self.build_current()
        self.reject_missing_notes_without_mutation(
            partial(lifecycle.publish_versioned, self.args)
        )

    def test_byte_promotion_notes_fail_before_advancing_rc_floor(self):
        self.policy = policy("promote-bytes")
        self.gh.source_policies[SHA] = self.policy
        Path(rc.POLICY).write_bytes(rc.json_bytes(self.policy))
        candidate, _, _ = self.release_run("rc", 100)
        self.start_run("stable", 101, candidate["tag"])
        arguments = argparse.Namespace(repo=REPO, rc=candidate["tag"], run_id="101")
        with patch.object(rc, "GitHub", return_value=self.gh):
            self.reject_missing_notes_without_mutation(partial(rc.promote, arguments))

    def test_workflow_change_after_floor_write_still_cannot_create_tag(self):
        lifecycle.prepare(self.args)
        plan = self.build_current()
        original = lifecycle.begin_publication

        def advance_after_floor(*args):
            original(*args)
            self.gh.default_head = "b" * 40
            self.gh.github_directories[self.gh.default_head][0]["sha"] = "d" * 40

        with patch.object(
            lifecycle, "begin_publication", side_effect=advance_after_floor
        ):
            with self.assertRaisesRegex(rc.ReleaseError, "workflows differ"):
                lifecycle.publish_versioned(self.args)
        self.assertEqual(self.gh.ledger["publication_floor"], plan["build_number"])
        self.assertEqual(self.gh.writes, [])
        self.assertNotIn(plan["tag"], self.gh.refs)

    def test_stale_request_rejects_before_reserving(self):
        Path(os.environ["GITHUB_EVENT_PATH"]).write_text(
            json.dumps({"inputs": {"channel": "beta", "expected_sha": "b" * 40}}),
            encoding="utf-8",
        )
        with self.assertRaisesRegex(rc.ReleaseError, "changed since dispatch"):
            lifecycle.prepare(self.args)
        self.assertEqual(self.gh.ledger_writes, [])

    def test_real_beta_rc_final_cycle_has_exact_versions_and_fresh_final_hashes(self):
        self.declare_json_artifact()
        beta, beta_plan, beta_manifest = self.release_run("beta", 100)
        candidate, rc_plan, rc_manifest = self.release_run("rc", 101)
        stable, final_plan, final_manifest = self.release_run(
            "stable", 102, candidate["tag"]
        )
        self.assertEqual(beta["tag"], "v1.2.3-beta.1")
        self.assertTrue(candidate["tag"].startswith("v1.2.3-rc."))
        self.assertEqual(stable["tag"], "v1.2.3")
        self.assertLess(beta_plan["build_number"], rc_plan["build_number"])
        self.assertLess(rc_plan["build_number"], final_plan["build_number"])
        self.assertEqual(final_plan["source_sha"], rc_plan["source_sha"])
        self.assertEqual(final_manifest["derived_from_rc"]["tag"], candidate["tag"])
        self.assertEqual(
            final_manifest["derived_from_rc"]["manifest_sha256"],
            rc.digest(rc.json_bytes(rc_manifest)),
        )
        self.assertEqual(final_manifest["derived_from_rc"]["run_id"], 101)

        def package_hash(manifest):
            return next(
                item["sha256"]
                for item in manifest["assets"]
                if item["name"] == "app.json"
            )

        self.assertEqual(
            len(
                {
                    package_hash(beta_manifest),
                    package_hash(rc_manifest),
                    package_hash(final_manifest),
                }
            ),
            3,
        )
        stable_release = next(
            item for item in self.gh.releases.values() if item["tag_name"] == "v1.2.3"
        )
        self.assertFalse(stable_release["prerelease"])
        self.assertFalse(stable_release["draft"])
        self.assertEqual(stable_release["make_latest"], "true")
        rc.validate_manifest(
            rc.json_bytes(final_manifest), REPO, "v1.2.3", allow_final=True
        )
        encoded = rc.json_bytes(final_manifest)
        with self.assertRaisesRegex(rc.ReleaseError, "Only release candidates"):
            rc.validate_manifest(encoded, REPO, "v1.2.3")

    def test_final_build_rejects_legacy_rc_before_allocating(self):
        self.start_run("stable", 100, legacy_tests.RC_TAG)
        # Model the real migration: legacy RC exists at old source SHA, while the
        # versioning policy and workflow are introduced by a later commit.
        new_sha = "b" * 40
        self.gh.source_policies[SHA] = legacy_tests.policy()
        self.gh.source_policies[new_sha] = self.policy
        self.gh.runs[100]["head_sha"] = new_sha
        self.gh.jobs_by_run[100] = [{**self.gh.jobs[0], "head_sha": new_sha}]
        event = {
            "inputs": {
                "channel": "stable",
                "expected_sha": new_sha,
                "rc_tag": legacy_tests.RC_TAG,
            }
        }
        Path(os.environ["GITHUB_EVENT_PATH"]).write_text(
            json.dumps(event), encoding="utf-8"
        )
        with (
            patch.object(rc, "checked_out_sha", return_value=new_sha),
            self.assertRaisesRegex(rc.ReleaseError, "accepted RC at current HEAD"),
        ):
            lifecycle.prepare(self.args)
        self.assertEqual(self.gh.ledger_writes, [])
        self.assertEqual(self.gh.writes, [])

    def test_final_build_rejects_later_source_or_recipe_even_with_same_policy(self):
        candidate, _, _ = self.release_run("rc", 100)
        self.start_run("stable", 101, candidate["tag"])
        new_sha = "b" * 40
        self.gh.source_policies[new_sha] = copy.deepcopy(self.policy)
        self.gh.runs[101]["head_sha"] = new_sha
        self.gh.jobs_by_run[101] = [{**self.gh.jobs[0], "head_sha": new_sha}]
        Path(os.environ["GITHUB_EVENT_PATH"]).write_text(
            json.dumps(
                {
                    "inputs": {
                        "channel": "stable",
                        "expected_sha": new_sha,
                        "rc_tag": candidate["tag"],
                    }
                }
            ),
            encoding="utf-8",
        )
        writes = copy.deepcopy(self.gh.writes)
        allocations = copy.deepcopy(self.gh.ledger_writes)
        with (
            patch.object(rc, "checked_out_sha", return_value=new_sha),
            self.assertRaisesRegex(rc.ReleaseError, "accepted RC at current HEAD"),
        ):
            lifecycle.prepare(self.args)
        self.assertEqual(self.gh.writes, writes)
        self.assertEqual(self.gh.ledger_writes, allocations)

    def test_final_rechecks_gate_and_required_reviewers_before_any_publication(self):
        candidate, _, _ = self.release_run("rc", 100)
        self.start_run("stable", 101, candidate["tag"])
        lifecycle.prepare(self.args)
        self.build_current()
        previous = copy.deepcopy(self.gh.writes)
        self.gh.jobs[0]["conclusion"] = "failure"
        with self.assertRaisesRegex(rc.ReleaseError, "Release gate"):
            lifecycle.publish_versioned(self.args)
        self.assertEqual(self.gh.writes, previous)
        self.gh.jobs[0]["conclusion"] = "success"
        self.gh.environment["protection_rules"] = []
        with self.assertRaisesRegex(rc.ReleaseError, "reviewer"):
            lifecycle.publish_versioned(self.args)
        self.assertEqual(self.gh.writes, previous)

    def test_final_toolchain_drift_blocks_before_publication(self):
        candidate, _, _ = self.release_run("rc", 100)
        self.start_run("stable", 101, candidate["tag"])
        lifecycle.prepare(self.args)
        self.build_current()
        input_path = Path(self.args.assets) / "release-inputs-linux.json"
        inputs = json.loads(input_path.read_bytes())
        inputs["toolchain"]["rustc"] = "rustc unexpected different compiler"
        input_path.write_bytes(rc.json_bytes(inputs))
        previous = copy.deepcopy(self.gh.writes)
        allocations = copy.deepcopy(self.gh.ledger_writes)
        with self.assertRaisesRegex(
            rc.ReleaseError, "toolchain differs from accepted RC"
        ):
            lifecycle.publish_versioned(self.args)
        self.assertEqual(self.gh.writes, previous)
        self.assertEqual(self.gh.ledger_writes, allocations)

    def test_changed_rc_bytes_or_evidence_block_final_before_reservation(self):
        candidate, _, _ = self.release_run("rc", 100)
        self.start_run("stable", 101, candidate["tag"])
        release_id = next(
            key
            for key, value in self.gh.releases.items()
            if value["tag_name"] == candidate["tag"]
        )
        payload_id = next(
            item["id"]
            for item in self.gh.assets[release_id]
            if item["name"] == "app.json"
        )
        original = self.gh.files[payload_id]
        self.gh.files[payload_id] = b"x" * len(original)
        writes = copy.deepcopy(self.gh.writes)
        reservations = copy.deepcopy(self.gh.ledger_writes)
        with self.assertRaisesRegex(rc.ReleaseError, "checksum mismatch"):
            lifecycle.prepare(self.args)
        self.assertEqual(self.gh.writes, writes)
        self.assertEqual(self.gh.ledger_writes, reservations)
        self.gh.files[payload_id] = original
        self.gh.evidence_by_run[100][0]["expired"] = True
        with self.assertRaisesRegex(rc.ReleaseError, "evidence"):
            lifecycle.prepare(self.args)
        self.assertEqual(self.gh.writes, writes)

    def test_metadata_mismatch_fails_even_with_valid_payload_receipt(self):
        self.declare_json_artifact()
        self.start_run("beta", 100)
        lifecycle.prepare(self.args)
        self.build_current()
        assets = Path(self.args.assets)
        (assets / "release-inputs-linux.json").unlink()
        (assets / "app.json").write_text('{"version":"wrong-version"}')
        receipt.create_receipt(
            lifecycle.PLAN,
            self.root / ".release-inputs.json",
            assets,
            assets / "release-inputs-linux.json",
        )
        with self.assertRaisesRegex(ValueError, "Artifact field mismatch"):
            lifecycle.publish_versioned(self.args)
        self.assertEqual(self.gh.writes, [])

    def test_publish_tag_collision_never_relabels_already_built_payloads(self):
        self.start_run("beta", 100)
        lifecycle.prepare(self.args)
        plan = self.build_current()
        self.gh.refs[plan["tag"]] = {"object": {"type": "commit", "sha": SHA}}
        with self.assertRaisesRegex(rc.ReleaseError, "already exists"):
            lifecycle.publish_versioned(self.args)
        self.assertEqual(self.gh.writes, [])
        self.assertFalse(any(tag.endswith("beta.2") for tag in self.gh.refs))

    def test_plan_receipt_source_and_effective_digest_tampering_never_publish(self):
        self.start_run("beta", 100)
        lifecycle.prepare(self.args)
        self.build_current()
        receipt_path = Path(self.args.assets) / "release-inputs-linux.json"
        raw = receipt_path.read_bytes()
        for field, value in (
            ("plan_sha256", "0" * 64),
            ("source_sha", "b" * 40),
            ("effective_inputs_sha256", "0" * 64),
        ):
            body = json.loads(raw)
            body[field] = value
            receipt_path.write_bytes(rc.json_bytes(body))
            with self.subTest(field=field), self.assertRaises(ValueError):
                lifecycle.publish_versioned(self.args)
            self.assertEqual(self.gh.writes, [])
        receipt_path.write_bytes(raw)

    def test_old_allocator_cannot_publish_a_versioned_policy(self):
        arguments = argparse.Namespace(
            repo=REPO,
            channel="beta",
            version="1.2.3",
            sha=SHA,
            run_id=99,
            run_attempt=1,
            sequence=None,
            assets=self.args.assets,
        )
        with (
            patch.object(rc, "GitHub", return_value=self.gh),
            self.assertRaisesRegex(rc.ReleaseError, "frozen-plan publisher"),
        ):
            rc.candidate(arguments)
        self.assertEqual(self.gh.writes, [])

    def test_byte_promotion_rejects_final_build_rc(self):
        candidate, _, _ = self.release_run("rc", 100)
        self.start_run("stable", 101, candidate["tag"])
        before = copy.deepcopy(self.gh.writes)
        arguments = argparse.Namespace(repo=REPO, rc=candidate["tag"], run_id="101")
        with (
            patch.object(rc, "GitHub", return_value=self.gh),
            self.assertRaisesRegex(rc.ReleaseError, "separately validated final build"),
        ):
            rc.promote(arguments)
        self.assertEqual(self.gh.writes, before)

    def test_real_upload_boundary_accepts_versioned_private_staging_only(self):
        with tempfile.TemporaryDirectory(prefix="release-versioned-") as temp:
            path = Path(temp).resolve() / "app.bin"
            path.write_bytes(b"package")
            with patch.object(
                rc.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, b"", b""),
            ) as run:
                rc.GitHub(REPO).upload("v1.2.3-beta.1", path)
            self.assertEqual(run.call_args.args[0][1:3], ["release", "upload"])


class PreparationTests(unittest.TestCase):
    def test_version_order_and_explicit_breaking_intent(self):
        self.assertEqual(
            prepare_version.choose_version("1.2.9", ["v1.2.9", "v1.2.10"]), "1.2.11"
        )
        self.assertEqual(
            prepare_version.choose_version("1.3.0", ["v1.2.9", "v1.3.0-beta.8"]),
            "1.3.0",
        )
        self.assertEqual(
            prepare_version.choose_version("1.3.0", [], bump="major"), "2.0.0"
        )
        with self.assertRaisesRegex(ValueError, "already has a stable"):
            prepare_version.choose_version("1.2.3", ["v1.2.3"], requested="1.2.3")


if __name__ == "__main__":
    unittest.main()
