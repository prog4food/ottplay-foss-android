# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""A final package receipt must still match its actual declared build inputs."""

# Imports follow the vendored script path; each test owns its temporary checkout.
# pylint: disable=wrong-import-position,missing-class-docstring,missing-function-docstring

import json
import os
import sys
import tempfile
import unittest
from contextlib import chdir
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import version_plan
import version_receipt


# Explicit paths and evidence describe the shared build fixture.
# pylint: disable-next=too-many-instance-attributes
class CurrentBuildInputsTests(unittest.TestCase):
    def setUp(self):
        # This synthetic fixture intentionally has no detached OCI contract.
        import release_provenance
        self.enterContext(patch.object(release_provenance, "REQUIRED_PAIRS", ()))
        # unittest owns cleanup across setup, the test body and assertion failures.
        # pylint: disable-next=consider-using-with
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.metadata = self.root / "metadata"
        self.metadata.mkdir()
        self.source = self.metadata / "package.json"
        self.source.write_text(
            '{"version":"1.2.3","dependencies":{"example":"1.0.0"}}',
            encoding="utf-8",
        )
        self.policy = {
            "repository": "example/project",
            "mode": "release",
            "version_file": "metadata/package.json",
            "versioning": {
                "schema": 1,
                "promotion": "final-build",
                "files": [
                    {
                        "path": "metadata/package.json",
                        "format": "json",
                        "field": "version",
                        "value": "full",
                    }
                ],
            },
        }
        self.plan = version_plan.create_plan(
            "1.2.3", "rc", 1, "a" * 40, self.policy, 51
        )
        self.files = version_plan.sync_versions(self.root, self.policy, self.plan)
        self.evidence = {
            "source_sha": self.plan["source_sha"],
            "plan_sha256": version_plan.plan_digest(self.plan),
            "effective_inputs_sha256": version_plan.effective_inputs_digest(self.files),
            "files": self.files,
        }
        self.plan_path = self.root / ".release-plan.json"
        self.plan_path.write_text(json.dumps(self.plan), encoding="utf-8")
        self.inputs_path = self.root / ".release-inputs.json"
        self.write_evidence()
        self.assets = self.root / "assets"
        self.assets.mkdir()
        (self.assets / "package.bin").write_bytes(b"package with the full RC identity")
        self.output = self.assets / "release-inputs-linux.json"
        toolchain = patch.object(
            version_receipt, "capture_toolchain", return_value={"python": "3.12.0"}
        )
        toolchain.start()
        self.addCleanup(toolchain.stop)

    def write_evidence(self):
        self.inputs_path.write_text(json.dumps(self.evidence), encoding="utf-8")

    def create(self):
        return version_receipt.create_receipt(
            self.plan_path, self.inputs_path, self.assets, self.output
        )

    def test_unchanged_inputs_produce_a_publisher_accepted_receipt(self):
        result = self.create()
        self.assertEqual(result["files"], self.files)
        payloads = [
            {
                "name": path.name,
                "size": path.stat().st_size,
                "sha256": version_receipt.sha256(path.read_bytes()),
            }
            for path in self.assets.iterdir()
        ]
        verified = version_receipt.verify_receipts(
            self.assets, self.plan, payloads, self.policy
        )
        self.assertEqual(verified[0]["name"], self.output.name)

    def test_invalid_package_name_fails_before_toolchain_or_receipt_write(self):
        (self.assets / "unsafe package.bin").write_bytes(b"not a safe asset name")
        with patch.object(version_receipt, "capture_toolchain") as toolchain:
            with self.assertRaisesRegex(ValueError, "Unsafe or duplicate package name"):
                self.create()
        toolchain.assert_not_called()
        self.assertFalse(self.output.exists())


    def test_publisher_rejects_mutated_receipt_identity_and_coverage(self):
        original = self.create()
        artifact = original["artifacts"][0]
        for changes, message in (
            ({"plan_sha256": "0" * 64}, "different release plan"),
            ({"source_sha": "b" * 40}, "source-bound"),
            ({"toolchain": {}}, "toolchain versions"),
            ({"effective_inputs_sha256": "0" * 64}, "input digest"),
            ({"artifacts": []}, "Empty receipt artifact"),
            ({"artifacts": [{**artifact, "sha256": "0" * 64}]}, "does not match staged payload"),
            ({"artifacts": [artifact, artifact]}, "duplicate or recursive"),
            ({"artifacts": [{**artifact, "name": self.output.name}]}, "duplicate or recursive"),
        ):
            with self.subTest(message=message, changes=changes):
                value = {**original, **changes}
                self.output.write_bytes(version_receipt.canonical(value))
                payloads = [
                    {"name": path.name, "size": path.stat().st_size,
                     "sha256": version_receipt.sha256(path.read_bytes())}
                    for path in self.assets.iterdir()
                ]
                with self.assertRaisesRegex(ValueError, message):
                    version_receipt.verify_receipts(
                        self.assets, self.plan, payloads, self.policy
                    )


    def test_large_package_receipt_does_not_buffer_the_payload(self):
        payload = b"package" * 400_000
        (self.assets / "package.bin").write_bytes(payload)
        with patch.object(
            Path, "read_bytes", side_effect=AssertionError("Whole-file payload read")
        ):
            result = self.create()
        self.assertEqual(
            result["artifacts"],
            [
                {
                    "name": "package.bin",
                    "size": len(payload),
                    "sha256": version_receipt.sha256(payload),
                }
            ],
        )

    def test_oversized_receipt_reads_only_a_bounded_prefix(self):
        self.create()
        with self.output.open("ab") as output:
            output.truncate(64 * 1024 * 1024)
        with self.output.open("rb") as source:
            original_read = source.read

            def bounded_read(size=-1):
                self.assertGreater(size, 0, "Receipt read must have a size limit")
                self.assertLessEqual(size, 2_000_001)
                return original_read(size)

            with (
                patch.object(Path, "open", return_value=source),
                patch.object(source, "read", side_effect=bounded_read) as read,
                self.assertRaisesRegex(ValueError, "Oversized build receipt"),
            ):
                version_receipt.verify_receipts(
                    self.assets, self.plan, [{"name": self.output.name}], self.policy
                )
            read.assert_called_once_with(2_000_001)

    def test_receipt_size_boundary_preserves_exact_bytes_and_validation(self):
        receipt = self.create()
        original = self.output.read_bytes()
        for size in (1_999_999, 2_000_000, 2_000_001):
            with self.subTest(size=size):
                raw = original.ljust(size, b" ")
                self.output.write_bytes(raw)
                payloads = receipt["artifacts"] + [
                    {
                        "name": self.output.name,
                        "size": size,
                        "sha256": version_receipt.sha256(raw),
                    }
                ]
                if size > 2_000_000:
                    with self.assertRaisesRegex(ValueError, "Oversized build receipt"):
                        version_receipt.verify_receipts(
                            self.assets, self.plan, payloads, self.policy
                        )
                else:
                    verified = version_receipt.verify_receipts(
                        self.assets, self.plan, payloads, self.policy
                    )
                    self.assertEqual(
                        verified,
                        [
                            {
                                "name": self.output.name,
                                "sha256": version_receipt.sha256(raw),
                                "inputs": receipt,
                            }
                        ],
                    )

    def test_dependency_change_after_sync_fails_without_a_receipt(self):
        current = json.loads(self.source.read_text(encoding="utf-8"))
        current["dependencies"]["example"] = "2.0.0"
        self.source.write_text(json.dumps(current), encoding="utf-8")
        self.assertEqual(current["version"], self.plan["version"])
        with self.assertRaisesRegex(ValueError, "changed after version sync"):
            self.create()
        self.assertFalse(self.output.exists())

    def test_version_change_after_sync_fails_without_a_receipt(self):
        self.source.write_text('{"version":"1.2.3"}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "changed after version sync"):
            self.create()
        self.assertFalse(self.output.exists())

    def test_missing_input_fails_without_a_receipt(self):
        self.source.unlink()
        with self.assertRaisesRegex(ValueError, "confined regular file"):
            self.create()
        self.assertFalse(self.output.exists())

    def test_symlink_input_with_identical_bytes_is_rejected(self):
        backup = self.root / "original.json"
        self.source.rename(backup)
        self.source.symlink_to(backup)
        with self.assertRaisesRegex(ValueError, "Symlink version input"):
            self.create()
        self.assertFalse(self.output.exists())

    def test_symlink_parent_with_identical_bytes_is_rejected(self):
        backup = self.root / "original-metadata"
        self.metadata.rename(backup)
        self.metadata.symlink_to(backup, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink version input"):
            self.create()
        self.assertFalse(self.output.exists())

    def test_hardlink_input_with_identical_bytes_is_rejected(self):
        os.link(self.source, self.root / "input-alias.json")
        with self.assertRaisesRegex(ValueError, "Hard-linked version input"):
            self.create()
        self.assertFalse(self.output.exists())

    def test_outside_input_paths_are_rejected(self):
        for path in ("../outside.json", "/outside.json", "metadata/../outside.json"):
            with self.subTest(path=path):
                self.evidence["files"][0]["path"] = path
                self.write_evidence()
                with self.assertRaisesRegex(ValueError, "Unsafe version path"):
                    self.create()
                self.assertFalse(self.output.exists())

    def test_oversized_input_is_rejected_before_reading_it(self):
        with self.source.open("wb") as stream:
            stream.truncate(version_plan.MAX_METADATA + 1)
        with self.assertRaisesRegex(ValueError, "Version input is too large"):
            self.create()
        self.assertFalse(self.output.exists())

    def test_unlisted_generated_files_do_not_change_the_declared_snapshot(self):
        (self.root / "generated-info.plist").write_bytes(
            b"generated after platform init"
        )
        self.create()
        self.assertTrue(self.output.is_file())

    def test_checkout_root_comes_from_saved_plan_not_current_directory(self):
        with chdir(self.assets):
            self.create()
        self.assertTrue(self.output.is_file())


if __name__ == "__main__":
    unittest.main()
