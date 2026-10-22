# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Exercise source-bound native receipts and same-image smoke verification."""

from __future__ import annotations

import hashlib
import io
import json
import os
# Tests invoke only fixed local fixture commands, never a shell.
import subprocess  # nosec B404
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))
import assemble_native_container as native  # noqa: E402 - Import the source scripts after adding their directory.
import merge_oci_archives as oci  # noqa: E402 - Import the source scripts after adding their directory.
import version_plan  # noqa: E402 - Import the source scripts after adding their directory.
import version_receipt  # noqa: E402 - Import the source scripts after adding their directory.


class NativeReceiptTests(unittest.TestCase):
    """Use real plans, overlays, receipts and archive bytes at the assembly boundary."""

    def setUp(self):
        # This synthetic fixture intentionally has no detached OCI contract.
        import release_provenance

        self.enterContext(patch.object(release_provenance, "REQUIRED_PAIRS", ()))
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.policy = {
            "repository": "example/native",
            "mode": "release",
            "version_file": "VERSION",
            "versioning": {
                "schema": 1,
                "promotion": "promote-bytes",
                "files": [{"path": "VERSION", "format": "text", "value": "package"}],
            },
        }
        if self._testMethodName.startswith("test_detached_"):
            import release_provenance

            requirements = patch.object(release_provenance, "REQUIRED_PAIRS", ())
            requirements.start()
            self.addCleanup(requirements.stop)
            self.policy["sign_releases"] = True
            self.policy["detached_provenance"] = [
                {
                    "image": "container.oci.tar",
                    "sidecar": "container.provenance.json",
                    "platforms": list(native.PLATFORMS),
                }
            ]
            self.policy["versioning"]["artifacts"] = [
                {
                    "path": "container.oci.tar",
                    "format": "oci",
                    "field": ["config", "Labels", "org.opencontainers.image.version"],
                    "value": "package",
                }
            ]
        self.write(".release-policy.json", self.policy)
        (self.root / "VERSION").write_text("1.2.3\n")
        self.command("git", "init", "-q")
        self.command("git", "add", ".")
        self.command(
            "git",
            "-c",
            "user.name=Native fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "Base version",
        )
        self.source = self.command("git", "rev-parse", "HEAD").strip()
        self.plan = version_plan.create_plan(
            "1.2.3", "beta", 7, self.source, self.policy, build_number=7
        )
        self.write(".release-plan.json", self.plan)
        self.command(
            sys.executable,
            str(SCRIPTS / "version_plan.py"),
            "sync",
            "--root",
            str(self.root),
            "--plan",
            ".release-plan.json",
        )
        (self.root / "release-dist").mkdir()
        self.directories = {}
        self.output = self.root / "release-dist/container.oci.tar"
        self.evidence = self.root / "release-dist/container-build-evidence.json"
        environment = patch.dict(
            os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2"}
        )
        environment.start()
        self.addCleanup(environment.stop)
        for platform in native.PLATFORMS:
            self.make_native(platform)

    def command(self, *args):
        # Callers supply explicit Git/Python fixture argv in a temporary checkout.
        return subprocess.check_output(args, cwd=self.root, text=True)  # nosec B603

    def write(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value, sort_keys=True) + "\n")
        return path

    def make_native(self, platform, attestations=True, predicate_types=None):
        arch = platform.split("/")[1]
        directory = self.root / arch
        directory.mkdir(exist_ok=True)
        self.directories[platform] = directory
        entries = {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}'}

        def blob(data, media):
            raw = oci.canonical(data)
            digest = hashlib.sha256(raw).hexdigest()
            entries[f"blobs/sha256/{digest}"] = raw
            return {"mediaType": media, "digest": "sha256:" + digest, "size": len(raw)}

        config = blob(
            {
                "os": "linux",
                "architecture": arch,
                "config": {
                    "Labels": {
                        "org.opencontainers.image.version": "1.2.3-beta.7",
                        "org.opencontainers.image.revision": self.source,
                    }
                },
                "rootfs": {"type": "layers", "diff_ids": []},
            },
            oci.CONFIG,
        )
        manifest = blob(
            {
                "schemaVersion": 2,
                "mediaType": oci.MANIFEST,
                "config": config,
                "layers": [],
            },
            oci.MANIFEST,
        )
        manifest["platform"] = {"os": "linux", "architecture": arch}
        manifests = [manifest]
        if attestations:
            statements = [
                blob(
                    {
                        "_type": "https://in-toto.io/Statement/v0.1",
                        "predicateType": predicate,
                        "subject": [
                            {
                                "name": "native",
                                "digest": {
                                    "sha256": manifest["digest"][7:],
                                },
                            }
                        ],
                        "predicate": {},
                    },
                    oci.IN_TOTO,
                )
                for predicate in (
                    predicate_types or ["https://slsa.dev/provenance/v0.2"]
                )
            ]
            attestation = blob(
                {
                    "schemaVersion": 2,
                    "mediaType": oci.MANIFEST,
                    "artifactType": oci.ATTESTATION,
                    "config": blob({}, oci.EMPTY_CONFIG),
                    "subject": manifest,
                    "layers": statements,
                },
                oci.MANIFEST,
            )
            attestation["platform"] = {"os": "unknown", "architecture": "unknown"}
            manifests.append(attestation)
        entries["index.json"] = oci.canonical(
            {
                "schemaVersion": 2,
                "mediaType": oci.INDEX,
                "manifests": manifests,
            }
        )
        with tarfile.open(directory / f"container-{arch}.oci.tar", "w") as archive:
            for name, raw in entries.items():
                member = tarfile.TarInfo(name)
                member.size = len(raw)
                archive.addfile(member, io.BytesIO(raw))
        self.write(
            f"{arch}/native-build.json",
            {
                "schema_version": 1,
                "platform": platform,
                **native.PLATFORMS[platform],
                "source_sha": self.source,
                "plan_sha256": version_plan.plan_digest(self.plan),
                "run_id": "123",
                "run_attempt": "2",
                "version": "1.2.3-beta.7",
                "smoke_passed": True,
                "image_config_digest": config["digest"],
                "toolchain": {"docker": "Docker fixture", "buildx": "Buildx fixture"},
                "timings": {"build_seconds": 10, "smoke_seconds": 2},
            },
        )
        self.receipt(platform)

    def receipt(self, platform):
        directory = self.directories[platform]
        arch = platform.split("/")[1]
        receipt = directory / f"release-inputs-native-{arch}.json"
        receipt.unlink(missing_ok=True)
        with patch.object(
            version_receipt,
            "capture_toolchain",
            return_value={
                "python": "3.11",
                "RUNNER_OS": "Linux",
                "RUNNER_ARCH": native.PLATFORMS[platform]["runner_arch"],
            },
        ):
            version_receipt.create_receipt(
                self.root / ".release-plan.json",
                self.root / ".release-inputs.json",
                directory,
                receipt,
            )
        return receipt

    def assemble(self):
        return native.assemble(self.root, self.directories, self.output, self.evidence)

    def test_real_receipts_and_smoked_configs_survive_assembly(self):
        result = self.assemble()
        self.assertTrue(self.output.is_file())
        self.assertEqual(result, json.loads(self.evidence.read_text()))
        self.assertEqual(set(result["native_builds"]), set(native.PLATFORMS))
        self.assertEqual(
            result["assembly"]["output"]["sha256"],
            hashlib.sha256(self.output.read_bytes()).hexdigest(),
        )
        for platform, native_build in result["native_builds"].items():
            self.assertEqual(
                result["assembly"]["images"][platform]["config_digest"],
                native_build["build"]["image_config_digest"],
            )

    def test_detached_preserves_native_smoke_and_authenticated_original_graphs(self):
        import release_provenance

        result = self.assemble()
        release_provenance.verify_all(self.output.parent, self.policy, self.plan)
        self.assertEqual(result, json.loads(self.evidence.read_text()))
        self.assertEqual(
            result["assembly"]["sha256"],
            hashlib.sha256(self.output.read_bytes()).hexdigest(),
        )
        for platform, build in result["native_builds"].items():
            self.assertEqual(
                result["assembly"]["images"][platform]["config_digest"],
                build["build"]["image_config_digest"],
            )
            self.assertTrue(
                result["assembly"]["images"][platform]["provenance_digests"]
            )

    def test_detached_rejects_input_changed_after_receipt_verification(self):
        import release_provenance

        original = release_provenance.detach

        def changed(inputs, *args):
            with inputs["linux/arm64"].open("ab") as stream:
                stream.write(b"changed after verification")
            return original(inputs, *args)

        with (
            patch.object(release_provenance, "detach", side_effect=changed),
            self.assertRaisesRegex(ValueError, "differs from verified receipt"),
        ):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.evidence.exists())
        self.assertFalse((self.output.parent / "container.provenance.json").exists())

    def test_detached_evidence_failure_removes_only_owned_pair(self):
        with (
            patch.object(native, "publish_evidence", side_effect=OSError("disk full")),
            self.assertRaisesRegex(OSError, "disk full"),
        ):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse((self.output.parent / "container.provenance.json").exists())

    def test_detached_publication_race_preserves_foreign_files(self):
        original = os.link

        def competing_writer(source, destination, *args, **kwargs):
            if Path(destination) == self.evidence:
                self.output.unlink()
                self.output.write_bytes(b"foreign output")
                self.evidence.write_bytes(b"foreign evidence")
            return original(source, destination, *args, **kwargs)

        with (
            patch.object(native.os, "link", side_effect=competing_writer),
            self.assertRaises(FileExistsError),
        ):
            self.assemble()
        self.assertEqual(self.output.read_bytes(), b"foreign output")
        self.assertEqual(self.evidence.read_bytes(), b"foreign evidence")
        self.assertFalse((self.output.parent / "container.provenance.json").exists())

    def test_detached_mismatched_smoke_config_is_rejected(self):
        path = self.directories["linux/arm64"] / "native-build.json"
        value = json.loads(path.read_text())
        value["image_config_digest"] = "sha256:" + "f" * 64
        path.write_text(json.dumps(value))
        self.receipt("linux/arm64")
        with self.assertRaisesRegex(
            ValueError, "differs from verified receipt or smoke image"
        ):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.evidence.exists())

    def test_detached_staging_cleanup_failure_preserves_success(self):
        import release_provenance

        original = tempfile.TemporaryDirectory.cleanup
        held = []

        def interrupted_cleanup(directory):
            if Path(directory.name).name.startswith(".native-assembly-"):
                held.append(directory)
                raise OSError("staging cleanup unavailable")
            original(directory)

        try:
            with patch.object(
                tempfile.TemporaryDirectory, "cleanup", interrupted_cleanup
            ):
                result = self.assemble()
            self.assertEqual(result, json.loads(self.evidence.read_text()))
            for path in (
                self.output,
                self.evidence,
                self.output.parent / "container.provenance.json",
            ):
                self.assertEqual(path.stat().st_nlink, 1)
            release_provenance.verify_all(self.output.parent, self.policy, self.plan)
        finally:
            for directory in held:
                original(directory)

    def test_detached_staging_link_removal_failure_rolls_back(self):
        original = Path.unlink

        def denied(path, *args, **kwargs):
            if (
                path.parent.name.startswith(".native-assembly-")
                and path.name == self.output.name
            ):
                raise PermissionError("cannot remove staging alias")
            return original(path, *args, **kwargs)

        with (
            patch.object(Path, "unlink", denied),
            self.assertRaisesRegex(PermissionError, "staging alias"),
        ):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.evidence.exists())
        self.assertFalse((self.output.parent / "container.provenance.json").exists())

    def test_detached_existing_sidecar_is_not_replaced(self):
        path = self.output.parent / "container.provenance.json"
        path.write_bytes(b"existing sidecar")
        with self.assertRaises(ValueError):
            self.assemble()
        self.assertEqual(path.read_bytes(), b"existing sidecar")
        self.assertFalse(self.output.exists())

    def test_altered_payload_is_rejected_by_receipt(self):
        path = self.directories["linux/arm64"] / "container-arm64.oci.tar"
        with path.open("ab") as stream:
            stream.write(b"unattested bytes")
        with self.assertRaisesRegex(ValueError, "Receipt does not match"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_native_export_cannot_silently_drop_attestations(self):
        self.make_native("linux/arm64", attestations=False)
        with self.assertRaisesRegex(ValueError, "lost its build attestations"):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.evidence.exists())

    def test_sbom_alone_does_not_replace_build_provenance(self):
        self.make_native("linux/arm64", predicate_types=["https://spdx.dev/Document"])
        with self.assertRaisesRegex(ValueError, "lacks SLSA build provenance"):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.evidence.exists())

    def test_sbom_and_slsa_provenance_can_coexist(self):
        self.make_native(
            "linux/arm64",
            predicate_types=[
                "https://spdx.dev/Document",
                "https://slsa.dev/provenance/v1",
            ],
        )
        result = self.assemble()
        image = result["assembly"]["images"]["linux/arm64"]
        self.assertTrue(image["provenance_digests"])
        self.assertEqual(image["provenance_digests"], image["attestation_digests"])

    def test_partial_evidence_write_is_cleaned_and_retry_succeeds(self):
        original = native.tempfile.NamedTemporaryFile

        class PartialWrite:
            """Simulate a real partial write before the filesystem reports failure."""

            def __init__(self, *args, **kwargs):
                self.stream = original(*args, **kwargs)

            def __enter__(self):
                self.stream.__enter__()
                return self

            def __exit__(self, *args):
                return self.stream.__exit__(*args)

            def __getattr__(self, name):
                return getattr(self.stream, name)

            def write(self, payload):
                self.stream.write(payload[:37])
                self.stream.flush()
                raise OSError("simulated disk full during evidence write")

        with (
            patch.object(native.tempfile, "NamedTemporaryFile", PartialWrite),
            self.assertRaisesRegex(OSError, "disk full"),
        ):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.evidence.exists())
        self.assertEqual(list(self.evidence.parent.glob(".native-evidence-*")), [])
        result = self.assemble()
        self.assertTrue(self.output.is_file())
        self.assertEqual(json.loads(self.evidence.read_text()), result)

    def test_evidence_destination_race_preserves_the_other_file(self):
        original = native.os.link

        def raced(source, destination):
            if Path(destination) == self.evidence:
                self.evidence.write_bytes(b"independent operator file")
            return original(source, destination)

        with (
            patch.object(native.os, "link", side_effect=raced),
            self.assertRaises(FileExistsError),
        ):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertEqual(self.evidence.read_bytes(), b"independent operator file")
        self.assertEqual(list(self.evidence.parent.glob(".native-evidence-*")), [])

    def test_cleanup_failure_after_publication_keeps_valid_output_pair(self):
        original_unlink = Path.unlink

        def cleanup_failure(path, *args, **kwargs):
            if path.name.startswith(".native-evidence-"):
                raise PermissionError("temporary cleanup denied")
            return original_unlink(path, *args, **kwargs)

        with patch.object(Path, "unlink", cleanup_failure):
            result = self.assemble()
        self.assertTrue(self.output.is_file())
        self.assertEqual(json.loads(self.evidence.read_text()), result)
        self.assertEqual(
            hashlib.sha256(self.output.read_bytes()).hexdigest(),
            result["assembly"]["output"]["sha256"],
        )
        temporary = list(self.evidence.parent.glob(".native-evidence-*"))
        self.assertEqual(len(temporary), 1)
        self.assertEqual(temporary[0].read_bytes(), self.evidence.read_bytes())

    def test_cleanup_failure_before_publication_preserves_original_error(self):
        original_unlink = Path.unlink
        original_link = native.os.link

        def cleanup_failure(path, *args, **kwargs):
            if path.name.startswith(".native-evidence-"):
                raise PermissionError("secondary cleanup failure")
            return original_unlink(path, *args, **kwargs)

        def publication_failure(source, destination):
            if Path(destination) == self.evidence:
                raise PermissionError("original publication failure")
            return original_link(source, destination)

        with (
            patch.object(Path, "unlink", cleanup_failure),
            patch.object(native.os, "link", side_effect=publication_failure),
            self.assertRaisesRegex(PermissionError, "original publication failure"),
        ):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.evidence.exists())

    def test_evidence_serialization_failure_does_not_create_files(self):
        with (
            patch.object(
                version_receipt, "canonical", side_effect=ValueError("invalid evidence")
            ),
            self.assertRaisesRegex(ValueError, "invalid evidence"),
        ):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.evidence.exists())
        self.assertEqual(list(self.evidence.parent.glob(".native-evidence-*")), [])

    def test_archive_change_between_receipt_and_merge_is_rejected(self):
        original = oci.merge_archives

        def changed(inputs, output, version, revision):
            with inputs["linux/arm64"].open("ab") as stream:
                stream.write(b"bytes changed after receipt check")
            return original(inputs, output, version, revision)

        with (
            patch.object(oci, "merge_archives", side_effect=changed),
            self.assertRaisesRegex(ValueError, "after native receipt"),
        ):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.evidence.exists())

    def test_smoke_document_uses_only_the_receipted_snapshot(self):
        path = self.directories["linux/arm64"] / "native-build.json"
        value = json.loads(path.read_text())
        value["smoke_passed"] = False
        path.write_text(json.dumps(value))
        self.receipt("linux/arm64")
        original = version_receipt.verify_receipts

        def changed(directory, *args):
            checked = original(directory, *args)
            if directory == path.parent:
                path.write_text(json.dumps({**value, "smoke_passed": True}))
            return checked

        with (
            patch.object(version_receipt, "verify_receipts", side_effect=changed),
            self.assertRaisesRegex(ValueError, "Native smoke identity"),
        ):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_receipt_changes_cannot_replace_the_initial_snapshot(self):
        path = self.receipt("linux/arm64")
        original = version_receipt.verify_receipts

        def changed(directory, *args):
            if directory == path.parent:
                value = json.loads(path.read_text())
                value["toolchain"]["python"] = "changed after snapshot"
                path.write_text(json.dumps(value))
            return original(directory, *args)

        with (
            patch.object(version_receipt, "verify_receipts", side_effect=changed),
            self.assertRaisesRegex(ValueError, "receipt changed"),
        ):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_stale_attempt_or_source_or_failed_smoke_is_rejected(self):
        path = self.directories["linux/arm64"] / "native-build.json"
        original = json.loads(path.read_text())
        for key, value in (
            ("run_attempt", "1"),
            ("source_sha", "f" * 40),
            ("platform", "linux/amd64"),
            ("smoke_passed", False),
            ("smoke_passed", 1),
            ("version", "1.2.3"),
        ):
            with self.subTest(key=key, value=value):
                path.write_text(json.dumps({**original, key: value}))
                self.receipt("linux/arm64")
                with self.assertRaisesRegex(ValueError, "Native smoke identity"):
                    self.assemble()
                self.assertFalse(self.output.exists())

    def test_same_plan_receipt_requires_actual_native_runner(self):
        path = self.receipt("linux/arm64")
        value = json.loads(path.read_text())
        value["toolchain"]["RUNNER_ARCH"] = "X64"
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "expected native Linux runner"):
            self.assemble()

    def test_different_plan_receipt_is_rejected(self):
        path = self.receipt("linux/arm64")
        value = json.loads(path.read_text())
        value["plan_sha256"] = "a" * 64
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "different release plan"):
            self.assemble()

    def test_smoke_config_must_match_archived_image(self):
        path = self.directories["linux/arm64"] / "native-build.json"
        value = json.loads(path.read_text())
        value["image_config_digest"] = "sha256:" + "a" * 64
        path.write_text(json.dumps(value))
        self.receipt("linux/arm64")
        with self.assertRaisesRegex(ValueError, "different image"):
            self.assemble()
        self.assertFalse(self.output.exists())
        self.assertFalse(self.evidence.exists())

    def test_missing_extra_or_symlink_inputs_fail_before_output(self):
        arm = self.directories["linux/arm64"]
        (arm / "unexpected").write_text("stale")
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            self.assemble()
        (arm / "unexpected").unlink()
        smoke = arm / "native-build.json"
        smoke.unlink()
        smoke.symlink_to(self.directories["linux/amd64"] / "native-build.json")
        with self.assertRaisesRegex(ValueError, "regular files"):
            self.assemble()
        del self.directories["linux/arm64"]
        with self.assertRaisesRegex(ValueError, "Both native platforms"):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_changed_applied_inputs_fail_before_output(self):
        (self.root / "VERSION").write_text("9.9.9\n")
        with self.assertRaises(ValueError):
            self.assemble()
        self.assertFalse(self.output.exists())

    def test_existing_output_is_never_replaced(self):
        self.output.write_bytes(b"previous output")
        with self.assertRaisesRegex(ValueError, "new file"):
            self.assemble()
        self.assertEqual(self.output.read_bytes(), b"previous output")


if __name__ == "__main__":
    unittest.main()
