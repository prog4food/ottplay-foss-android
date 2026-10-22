# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Offline contracts for stable assets, registry publication and image identity."""

import io
import json
import os
# Only mocked publication calls and subprocess exception fixtures are used here.
import subprocess  # nosec B404
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
# Import the checkout's scripts after explicitly adding their location.
# pylint: disable=wrong-import-position
import publish_verified as publisher
import verified_images
from release_control import ReleaseError
from test_release_control import SHA, FakeGitHub, policy, policy_snapshot, rc

# pylint: enable=wrong-import-position


class StableAssetVerificationTests(unittest.TestCase):
    """Verify registry admission against the original candidate source policy."""

    def github(self):
        """Return a published stable release backed by valid immutable RC evidence."""
        gh = FakeGitHub()
        gh.releases[10].update(tag_name="v1.2.3", prerelease=False)
        gh.refs["v1.2.3"] = {
            "ref": "refs/tags/v1.2.3",
            "object": {"type": "commit", "sha": SHA},
        }
        return gh

    def verify(self, gh):
        """Download and verify stable assets inside a disposable local directory."""
        with tempfile.TemporaryDirectory() as temp:
            return publisher.verified_assets(gh, "v1.2.3", Path(temp))

    def test_stable_assets_verify_policy_at_original_source_commit(self):
        """Stable assets verify policy at original source commit."""
        gh = self.github()
        result = self.verify(gh)
        self.assertEqual(result["source_policy"], policy_snapshot())
        self.assertEqual(gh.policy_reads, [SHA])
        self.assertEqual(gh.writes, [])

    def test_claimed_clean_snapshot_cannot_qualify_blocked_source(self):
        """Claimed clean snapshot cannot qualify blocked source."""
        for field in ("release_blockers", "stable_blockers"):
            with self.subTest(field=field):
                gh = self.github()
                gh.source_policies[SHA][field] = ["Missing required integration checks"]
                with self.assertRaisesRegex(ReleaseError, field):
                    self.verify(gh)
                self.assertEqual(gh.policy_reads, [SHA])
                self.assertEqual(gh.writes, [])

    def test_clean_snapshot_must_still_match_original_policy(self):
        """Clean snapshot must still match original policy."""
        gh = self.github()
        original = {**policy(), "validation_workflows": ["other-ci.yml"]}
        gh.source_policies[SHA] = original
        with self.assertRaisesRegex(ReleaseError, "policy snapshot differs"):
            self.verify(gh)

    def test_original_policy_must_declare_release_mode(self):
        """Original policy must declare release mode."""
        gh = self.github()
        gh.source_policies[SHA]["mode"] = "validation-only"
        with self.assertRaisesRegex(ReleaseError, "mode must be release"):
            self.verify(gh)

    def test_legacy_manifest_without_source_policy_is_rejected(self):
        """Legacy manifest without source policy is rejected."""
        gh = self.github()
        data = json.loads(gh.files[21])
        data.pop("source_policy")
        gh.files[21] = rc.json_bytes(data)
        gh.set_evidence(gh.files[21])
        with self.assertRaisesRegex(ReleaseError, "policy snapshot"):
            self.verify(gh)

    def test_rc_source_run_must_be_manual_and_have_exact_identity(self):
        """Rc source run must be manual and have exact identity."""
        for change in ({"event": "push"}, {"event": "schedule"}, {"id": 18}):
            with self.subTest(change=change):
                gh = self.github()
                gh.runs[17].update(change)
                with self.assertRaises(ReleaseError):
                    self.verify(gh)
                self.assertEqual(gh.writes, [])


class RegistryPublicationTests(unittest.TestCase):
    """Check registry destinations, unchanged bytes and digest-bound deployment."""

    def setUp(self):
        self.policy = {
            "repository": "owner/repo",
            "container_assets": {"image.oci.tar": "ghcr.io/owner/image"},
        }

    @staticmethod
    def assets(_gh, _tag, directory):
        """Provide approved local payloads and their original publication mappings."""
        (directory / "image.oci.tar").write_bytes(b"approved image")
        return {
            "version": "1.2.3",
            "tag": "v1.2.3-rc.1",
            "source_sha": "a" * 40,
            "source_policy": {
                "data": {
                    "container_assets": {"image.oci.tar": "ghcr.io/owner/image"},
                    "pypi_assets": ["*.whl"],
                }
            },
        }

    def test_publication_rejects_current_mapping_drift_before_registry_access(self):
        """Publication rejects current mapping drift before registry access."""
        cases = (
            (
                "containers",
                "container_assets",
                {"image.oci.tar": "ghcr.io/owner/other"},
            ),
            ("pypi", "pypi_assets", ["*"]),
        )
        for target, field, changed in cases:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                current = {**self.policy, field: changed}
                (root / ".release-policy.json").write_text(json.dumps(current))
                with (
                    mock.patch.object(publisher, "ROOT", root),
                    mock.patch.object(
                        publisher, "verified_assets", side_effect=self.assets
                    ),
                    mock.patch.object(publisher.subprocess, "run") as run,
                    mock.patch.object(
                        sys,
                        "argv",
                        ["publish_verified.py", target, "--tag", "v1.2.3", "--execute"],
                    ),
                ):
                    self.assertEqual(publisher.main(), 1)
                    run.assert_not_called()

    def test_deployment_rejects_current_image_mapping_drift(self):
        """Deployment rejects current image mapping drift."""
        current = {
            **self.policy,
            "container_assets": {"image.oci.tar": "ghcr.io/owner/other"},
        }
        with tempfile.TemporaryDirectory() as temp:
            with (
                mock.patch.object(
                    verified_images, "verified_assets", side_effect=self.assets
                ),
                mock.patch.object(verified_images.subprocess, "run") as run,
                self.assertRaisesRegex(ReleaseError, "container_assets differs"),
            ):
                verified_images.resolve(current, "v1.2.3", Path(temp))
            run.assert_not_called()

    def test_latest_uses_same_private_approved_archive(self):
        """Latest uses same private approved archive."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / ".release-policy.json").write_text(json.dumps(self.policy))
            with (
                mock.patch.object(publisher, "ROOT", root),
                mock.patch.object(
                    publisher, "verified_assets", side_effect=self.assets
                ),
                mock.patch.object(
                    publisher.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess([], 0, '{"Tags":[]}', ""),
                ) as run,
                mock.patch.object(
                    sys,
                    "argv",
                    [
                        "publish_verified.py",
                        "containers",
                        "--tag",
                        "v1.2.3",
                        "--execute",
                        "--latest",
                    ],
                ),
            ):
                self.assertEqual(publisher.main(), 0)
            copies = [
                call.args[0] for call in run.call_args_list if call.args[0][1] == "copy"
            ]
            self.assertEqual(len(copies), 2)
            self.assertTrue(copies[0][-2].startswith("oci-archive:"))
            self.assertEqual(copies[0][-2], copies[1][-2])
            self.assertTrue(copies[1][-1].endswith(":latest"))

    def test_existing_registry_version_is_not_overwritten(self):
        """Existing registry version is not overwritten."""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / ".release-policy.json").write_text(json.dumps(self.policy))
            with (
                mock.patch.object(publisher, "ROOT", root),
                mock.patch.object(
                    publisher, "verified_assets", side_effect=self.assets
                ),
                mock.patch.object(
                    publisher.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess(
                        [], 0, '{"Tags":["1.2.3"]}', ""
                    ),
                ) as run,
                mock.patch.object(
                    sys,
                    "argv",
                    [
                        "publish_verified.py",
                        "containers",
                        "--tag",
                        "v1.2.3",
                        "--execute",
                    ],
                ),
            ):
                self.assertEqual(publisher.main(), 1)
            self.assertEqual(run.call_count, 1)

    def test_each_target_writes_only_with_execute(self):
        """A dry run may read registry inventory but never copy or upload payloads."""
        for target in ("containers", "pypi"):
            for execute in (False, True):
                with (
                    self.subTest(target=target, execute=execute),
                    tempfile.TemporaryDirectory() as temp,
                ):
                    root = Path(temp)
                    current = {**self.policy, "pypi_assets": ["*.whl"]}
                    (root / ".release-policy.json").write_text(json.dumps(current))

                    def assets(gh, tag, directory):
                        manifest = self.assets(gh, tag, directory)
                        (directory / "approved.whl").write_bytes(b"approved wheel")
                        (directory / "unselected.tar.gz").write_bytes(b"source archive")
                        return manifest

                    argv = ["publish_verified.py", target, "--tag", "v1.2.3"]
                    if execute:
                        argv.append("--execute")
                    with (
                        mock.patch.object(publisher, "ROOT", root),
                        mock.patch.object(
                            publisher, "verified_assets", side_effect=assets
                        ),
                        mock.patch.object(
                            publisher.subprocess,
                            "run",
                            return_value=subprocess.CompletedProcess(
                                [], 0, '{"Tags":[]}', ""
                            ),
                        ) as run,
                        mock.patch.object(sys, "argv", argv),
                        mock.patch.object(
                            sys, "stdout", new_callable=io.StringIO
                        ) as out,
                    ):
                        self.assertEqual(publisher.main(), 0)
                    plan = json.loads(out.getvalue())
                    self.assertEqual(plan["execute"], execute)
                    issued = [call.args[0] for call in run.call_args_list]
                    if target == "containers":
                        self.assertEqual(issued.pop(0)[1], "list-tags")
                    else:
                        self.assertEqual(plan["commands"][0][3], "check")
                        self.assertEqual(plan["commands"][1][3], "upload")
                        self.assertEqual(len(plan["commands"][0]), 5)
                        self.assertTrue(
                            plan["commands"][0][-1].endswith("approved.whl")
                        )
                    self.assertEqual(issued, plan["commands"] if execute else [])

    def test_missing_registry_accepts_skopeo_rendered_diagnostic(self):
        """A new GHCR image can be published with current Skopeo diagnostics."""
        for error in (
            'time="2026-10-10T14:18:00-07:00" level=fatal msg="Error listing '
            'repository tags: fetching tags list: name unknown"\n',
            "NAME_UNKNOWN: repository name not known to registry\n",
            "NAME_UNKNOWN\n",
            "repository does not exist\n",
        ):
            with (
                self.subTest(error=error),
                mock.patch.object(
                    publisher.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess([], 1, "", error),
                ),
            ):
                publisher.require_unpublished_version("ghcr.io/owner/new", "1.2.3")

    def test_registry_failures_do_not_authorize_publication(self):
        """Access, transport and ambiguous absence errors still fail closed."""
        for error in (
            "unauthorized: authentication required",
            "denied: permission denied",
            "repository does not exist or may require docker login",
            "NAME_UNKNOWN: authentication required",
            "name unknown: access denied",
            "certificate signed by unknown authority",
            "dial tcp: connection refused",
            "MANIFEST_UNKNOWN: manifest unknown",
            "unexpected EOF",
        ):
            with (
                self.subTest(error=error),
                mock.patch.object(
                    publisher.subprocess,
                    "run",
                    return_value=subprocess.CompletedProcess([], 1, "", error),
                ),
                self.assertRaisesRegex(
                    ReleaseError, "Cannot establish registry tag inventory"
                ),
            ):
                publisher.require_unpublished_version("ghcr.io/owner/new", "1.2.3")

    def test_all_versions_precede_latest_from_the_same_approved_archives(self):
        """Multiple images are preflighted before any version or latest write."""
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            manifest = self.assets(None, None, directory)
            (directory / "second.oci.tar").write_bytes(b"second approved image")
            mapping = {
                **self.policy["container_assets"],
                "second.oci.tar": "ghcr.io/owner/second",
            }
            current = {**self.policy, "container_assets": mapping}
            manifest["source_policy"]["data"]["container_assets"] = mapping
            with mock.patch.object(
                publisher.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, '{"Tags":[]}', ""),
            ) as run:
                commands = publisher.container_commands(
                    current, manifest, directory, latest=True
                )
            self.assertEqual(
                [call.args[0][1] for call in run.call_args_list], ["list-tags"] * 2
            )
            self.assertEqual(len(commands), 4)
            for index in range(2):
                version, latest = commands[index], commands[index + 2]
                self.assertEqual(version[:-1], latest[:-1])
                self.assertTrue(version[-1].endswith(":1.2.3"))
                self.assertTrue(latest[-1].endswith(":latest"))
            with (
                mock.patch.object(
                    publisher.subprocess,
                    "run",
                    side_effect=[
                        subprocess.CompletedProcess([], 0, '{"Tags":[]}', ""),
                        subprocess.CompletedProcess([], 1, "", "access denied"),
                    ],
                ) as run,
                self.assertRaisesRegex(
                    ReleaseError, "Cannot establish registry tag inventory"
                ),
            ):
                publisher.container_commands(current, manifest, directory, latest=True)
            self.assertEqual(
                [call.args[0][1] for call in run.call_args_list], ["list-tags"] * 2
            )

    def test_deployment_uses_digest_and_rejects_registry_retag(self):
        """Deployment uses digest and rejects registry retag."""
        with tempfile.TemporaryDirectory() as temp:
            with (
                mock.patch.object(
                    verified_images, "verified_assets", side_effect=self.assets
                ),
                mock.patch.object(
                    verified_images.subprocess,
                    "run",
                    side_effect=[
                        subprocess.CompletedProcess([], 0, b"approved manifest"),
                        subprocess.CompletedProcess([], 0, b"approved manifest"),
                    ],
                ),
            ):
                result = verified_images.resolve(self.policy, "v1.2.3", Path(temp))
                self.assertIn("@sha256:", result["images"]["ghcr.io/owner/image"])
            with (
                mock.patch.object(
                    verified_images, "verified_assets", side_effect=self.assets
                ),
                mock.patch.object(
                    verified_images.subprocess,
                    "run",
                    side_effect=[
                        subprocess.CompletedProcess([], 0, b"approved manifest"),
                        subprocess.CompletedProcess([], 0, b"tampered manifest"),
                    ],
                ),
                self.assertRaises(ReleaseError),
            ):
                verified_images.resolve(self.policy, "v1.2.3", Path(temp))


class VerifiedImageOutputTests(unittest.TestCase):
    """Selected output roots confine destinations without clobbering aliases."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()
        (self.checkout / ".release-policy.json").write_text("{}")
        self.destination = self.root / "separate-deployment-inputs"
        self.destination.mkdir()
        self.output = self.destination / "images.json"
        self.original = self.root / "original.json"
        self.original.write_bytes(b"outside sentinel\n")
        self.result = {
            "repository": "example/product",
            "tag": "v1.2.3",
            "source_sha": SHA,
            "images": {
                "ghcr.io/example/image": "ghcr.io/example/image@sha256:" + "a" * 64
            },
        }

    def run_main(self, output=None, output_root=None, resolver=None):
        argv = [
            "verified_images.py",
            "--tag",
            "v1.2.3",
            "--output",
            str(output or self.output),
        ]
        if output_root is not None:
            argv.extend(["--output-root", str(output_root)])
        with (
            mock.patch.object(verified_images, "ROOT", self.checkout),
            mock.patch.object(Path, "cwd", return_value=self.checkout),
            mock.patch.object(
                verified_images,
                "resolve",
                return_value=self.result,
                side_effect=resolver,
            ) as resolution,
            mock.patch.object(sys, "argv", argv),
            mock.patch("sys.stdout", new_callable=io.StringIO),
            mock.patch("sys.stderr", new_callable=io.StringIO),
        ):
            status = verified_images.main()
        self.resolution = resolution
        return status

    def test_explicit_external_directory_create_and_hardlink_overwrite(self):
        self.assertEqual(self.run_main(output_root=self.destination), 0)
        expected = (json.dumps(self.result, indent=2) + "\n").encode()
        self.assertEqual(self.output.read_bytes(), expected)
        self.output.unlink()
        os.link(self.original, self.output)
        self.assertEqual(self.run_main(output_root=self.destination), 0)
        self.assertEqual(self.output.read_bytes(), expected)
        self.assertEqual(self.original.read_bytes(), b"outside sentinel\n")
        self.assertNotEqual(self.output.stat().st_ino, self.original.stat().st_ino)
        self.assertEqual(list(self.destination.iterdir()), [self.output])

    def test_symlink_and_directory_output_fail_closed(self):
        self.output.symlink_to(self.original)
        self.assertEqual(self.run_main(output_root=self.destination), 1)
        self.resolution.assert_not_called()
        self.assertTrue(self.output.is_symlink())
        self.assertEqual(self.original.read_bytes(), b"outside sentinel\n")
        self.output.unlink()
        self.output.mkdir()
        self.assertEqual(self.run_main(output_root=self.destination), 1)
        self.resolution.assert_not_called()
        self.assertTrue(self.output.is_dir())
        self.assertEqual(list(self.destination.iterdir()), [self.output])

    def test_relative_and_absolute_outputs_below_default_cwd(self):
        nested = Path("nested directory/..ordinary-name/images.json")
        (self.checkout / nested).parent.mkdir(parents=True)
        for requested in (Path("images.json"), self.checkout / "images.json", nested):
            with self.subTest(requested=requested):
                output = self.checkout / requested
                self.assertEqual(self.run_main(output=requested), 0)
                self.assertEqual(json.loads(output.read_bytes()), self.result)
                output.unlink()

    def test_parent_traversal_and_outside_absolute_paths_reject_before_network(self):
        for output in (
            Path("../outside.json"),
            Path("nested/../images.json"),
            self.output,
            self.root / "checkout-neighbor" / "images.json",
        ):
            with self.subTest(output=output):
                self.assertEqual(self.run_main(output=output), 1)
                self.resolution.assert_not_called()
        self.assertFalse(self.output.exists())
        self.assertEqual(self.original.read_bytes(), b"outside sentinel\n")

    def test_missing_output_root_or_parent_reject_before_network(self):
        for output, root in (
            (Path("images.json"), self.root / "missing"),
            (Path("missing/images.json"), self.checkout),
            (self.checkout, self.checkout),
        ):
            with self.subTest(output=output, root=root):
                self.assertEqual(self.run_main(output, root), 1)
                self.resolution.assert_not_called()
        self.assertEqual(
            list(self.checkout.iterdir()), [self.checkout / ".release-policy.json"]
        )

    def test_symlink_destination_parent_rejects_before_network(self):
        parent = self.checkout / "linked"
        parent.symlink_to(self.destination, target_is_directory=True)
        self.assertEqual(self.run_main(parent / "images.json"), 1)
        self.resolution.assert_not_called()
        self.assertFalse(self.output.exists())

    def test_explicit_root_can_use_a_platform_directory_alias(self):
        alias = self.root / "platform-alias"
        alias.symlink_to(self.destination, target_is_directory=True)
        for output in (alias / "images.json", self.output.resolve()):
            with self.subTest(output=output):
                self.assertEqual(self.run_main(output, alias), 0)
                self.assertEqual(json.loads(self.output.read_bytes()), self.result)

    def test_parent_replacement_cannot_redirect_the_anchored_write(self):
        parent = self.checkout / "output"
        parent.mkdir()
        anchored = self.checkout / "original-output"

        def replace_parent(*_):
            parent.rename(anchored)
            parent.symlink_to(self.destination, target_is_directory=True)
            return self.result

        self.assertEqual(
            self.run_main(parent / "images.json", resolver=replace_parent), 0
        )
        self.assertFalse(self.output.exists())
        self.assertEqual(
            json.loads((anchored / "images.json").read_bytes()), self.result
        )
        self.assertEqual(self.original.read_bytes(), b"outside sentinel\n")

    def test_write_failures_preserve_existing_output_and_close_directory(self):
        self.output.write_bytes(b"prior verified inputs\n")
        self.output.chmod(0o640)
        for operation in ("fsync", "replace"):
            with (
                self.subTest(operation=operation),
                mock.patch.object(
                    verified_images.os,
                    operation,
                    side_effect=OSError("injected failure"),
                ),
                mock.patch.object(verified_images.os, "close", wraps=os.close) as close,
            ):
                self.assertEqual(self.run_main(output_root=self.destination), 1)
            self.assertEqual(self.output.read_bytes(), b"prior verified inputs\n")
            self.assertEqual(self.output.stat().st_mode & 0o777, 0o640)
            self.assertEqual(list(self.destination.iterdir()), [self.output])
            self.assertTrue(close.called)
            for call in close.call_args_list:
                with self.assertRaises(OSError):
                    os.fstat(call.args[0])

    def test_unsupported_platform_fails_without_network_or_fallback_write(self):
        with mock.patch.object(verified_images.os, "supports_dir_fd", set()):
            self.assertEqual(self.run_main(output_root=self.destination), 1)
        self.resolution.assert_not_called()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
