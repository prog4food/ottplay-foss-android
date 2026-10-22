# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Exercise local release commands and generated workflow safety contracts offline."""

import importlib.util
# Subprocesses use explicit argv and never a shell.
import subprocess  # nosec B404
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def module(name):
    """Load a toolkit script directly without executing its command entry point."""
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


client = module("release")


class ClientTest(unittest.TestCase):
    """Check version resolution, asset collection and guarded dispatch behavior."""

    def test_all_declared_local_checks_run_in_order(self):
        """Do not silently omit security/integration after the default unit suite."""
        checks = ["bash scripts/ci.sh", "bash scripts/ci.sh security"]
        with mock.patch.object(client, "run") as run:
            client.local_checks({"local_checks": checks})
        self.assertEqual([call.args[-1] for call in run.call_args_list], checks)
        self.assertTrue(
            all(
                call.args[:5] == ("bash", "-e", "-o", "pipefail", "-c")
                for call in run.call_args_list
            )
        )

    def test_failed_local_check_stops_following_commands(self):
        """A failing validation cannot fall through into the next stage."""
        with (
            mock.patch.object(
                client, "run", side_effect=subprocess.CalledProcessError(1, "check")
            ) as run,
            self.assertRaises(subprocess.CalledProcessError),
        ):
            client.local_checks({"local_checks": ["first", "second"]})
        self.assertEqual(run.call_count, 1)

    def test_malformed_local_checks_rejected_before_execution(self):
        """Validate the complete command list before running its first entry."""
        for checks in [[], "bash scripts/ci.sh", ["first", None], ["first", " "]]:
            with mock.patch.object(client, "run") as run, self.assertRaises(ValueError):
                client.local_checks({"local_checks": checks})
            run.assert_not_called()

    def test_validation_only_doctor_does_not_request_paid_environment(self):
        """Infrastructure needs no release reviewers or environment API call."""
        with mock.patch.object(client, "gh_json") as api:
            client.doctor({"repository": "owner/repo", "mode": "validation-only"})
        api.assert_not_called()

    def test_source_versions(self):
        """Resolve supported committed plain-text, JSON and TOML version sources."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with mock.patch.object(client, "ROOT", root):
                for name, data in [
                    ("version", "v1.2.3\n"),
                    ("package.json", '{"version":"1.2.3"}'),
                    ("Cargo.toml", '[workspace.package]\nversion = "1.2.3"'),
                    ("pyproject.toml", '[project]\nversion="1.2.3"'),
                ]:
                    (root / name).write_text(data)
                    self.assertEqual(
                        client.resolve_version({"version_file": name}), "1.2.3"
                    )

    def test_reject_requested_injection(self):
        """Reject noncanonical or injected explicit version arguments."""
        for value in [
            "v1.2.3",
            "1.2.3-rc.1",
            "1.2.03",
            "1.2.3\nchannel=stable",
            "$(id)",
            "1١.2.3",
            "1.2.3١",
        ]:
            with self.assertRaises(ValueError):
                client.resolve_version({}, value)
        self.assertIsNone(client.RC.fullmatch("v1.2.3-rc.1١"))

    def test_missing_version_is_not_invented(self):
        """Require a version source rather than inventing a release version."""
        with self.assertRaises(ValueError):
            client.resolve_version({})

    def test_collection_rejects_cross_platform_collisions(self):
        """Reject duplicate basenames instead of overwriting another platform asset."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / ".release-policy.json").write_text("{}")
            for platform in ["linux", "windows"]:
                directory = root / ".release-download" / platform
                directory.mkdir(parents=True)
                (directory / "checksums.txt").write_text(platform)
            with (
                mock.patch.object(client, "ROOT", root),
                mock.patch(
                    "sys.argv",
                    ["release.py", "collect", ".release-download", ".release-assets"],
                ),
            ):
                self.assertEqual(client.main(), 1)

    def test_collection_copies_only_fixed_download_directory(self):
        """Copy the exact artifact bytes without accepting arbitrary CLI paths."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / ".release-download" / "linux"
            source.mkdir(parents=True)
            (source / "app.tar.gz").write_bytes(b"approved bytes")
            with mock.patch.object(client, "ROOT", root):
                client.collect_assets()
                self.assertEqual(
                    (root / ".release-assets/app.tar.gz").read_bytes(),
                    b"approved bytes",
                )
                with self.assertRaises(FileExistsError):
                    client.collect_assets()
            with (
                mock.patch(
                    "sys.argv", ["release.py", "collect", "../secrets", "../outside"]
                ),
                self.assertRaises(SystemExit) as error,
            ):
                client.arguments()
            self.assertEqual(error.exception.code, 2)

    def test_collection_rejects_symlink_escape_before_creating_output(self):
        """Reject a download-root symlink rather than reading outside the checkout."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / "repo"
            root.mkdir()
            (root / ".release-download").symlink_to(
                Path(temp), target_is_directory=True
            )
            with mock.patch.object(client, "ROOT", root), self.assertRaises(ValueError):
                client.collect_assets()
            self.assertFalse((root / ".release-assets").exists())

    def test_publication_commands_are_remote_workflow_dispatch(self):
        """Publish only by dispatching the default-branch workflow through the CLI."""
        config = {"repository": "owner/repo", "version": "1.2.3"}
        args = type(
            "Args", (), {"command": "rc", "version": "", "rc": "", "dry_run": False}
        )()
        with (
            mock.patch.object(
                client,
                "gh_json",
                side_effect=[{"default_branch": "main"}, {"sha": "a" * 40}],
            ),
            mock.patch.object(client, "run", side_effect=["a" * 40, "", ""]) as run,
        ):
            client.dispatch(args, config)
        final = run.call_args.args
        self.assertEqual(final[:4], ("gh", "workflow", "run", "release-pipeline.yml"))
        self.assertNotIn("release", final)

    def test_dirty_checkout_refused(self):
        """Reject stable requests from a dirty source checkout."""
        args = type(
            "Args", (), {"command": "stable", "rc": "v1.2.3-rc.1", "dry_run": False}
        )()
        with (
            mock.patch.object(
                client,
                "gh_json",
                side_effect=[{"default_branch": "main"}, {"sha": "a" * 40}],
            ),
            mock.patch.object(client, "run", side_effect=["a" * 40, " M source.py"]),
            self.assertRaises(ValueError),
        ):
            client.dispatch(args, {"repository": "owner/repo"})
