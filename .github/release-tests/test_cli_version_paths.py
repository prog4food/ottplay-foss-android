# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""CLI arguments cannot make release metadata tools leave their own checkout."""

# The path setup supports identical tests in standalone vendored consumers.
# pylint: disable=wrong-import-position,missing-function-docstring,consider-using-with

import json
import sys
import tempfile
import unittest
from contextlib import chdir
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import version_receipt
import write_binary_build_metadata as binary_metadata


class CliPathsTests(unittest.TestCase):
    """Exercise actual CLI parsing with each script rooted in an isolated checkout."""

    def setUp(self):
        directory = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        self.root = directory / "checkout"
        (self.root / "scripts").mkdir(parents=True)
        self.assets = self.root / "dist"
        self.assets.mkdir()
        self.outside = directory / "outside"
        self.outside.mkdir()
        self.secret = self.outside / "secret.json"
        self.secret.write_text('{"private":"outside checkout"}', encoding="utf-8")
        (self.root / "VERSION").write_text("1.2.3-rc.1\n", encoding="utf-8")
        (self.assets / "app").write_bytes(b"compiled application")
        (self.root / ".release-plan.json").write_text("{}", encoding="utf-8")
        (self.root / ".release-inputs.json").write_text("{}", encoding="utf-8")
        self.enterContext(
            patch.object(
                version_receipt,
                "__file__",
                str(self.root / "scripts/version_receipt.py"),
            )
        )
        self.enterContext(
            patch.object(
                binary_metadata,
                "__file__",
                str(self.root / "scripts/write_binary_build_metadata.py"),
            )
        )

    def run_receipt(self, **overrides):
        values = {
            "plan": self.root / ".release-plan.json",
            "inputs": self.root / ".release-inputs.json",
            "assets": self.assets,
            "output": self.assets / "release-inputs-test.json",
        }
        values.update(overrides)
        arguments = ["version_receipt.py", "create"]
        for key, value in values.items():
            arguments.extend(["--" + key, str(value)])
        with patch.object(sys, "argv", arguments):
            version_receipt.main()

    def run_binary(self, binary=None, output=None):
        arguments = [
            "write_binary_build_metadata.py",
            str(binary or self.assets / "app"),
            str(output or self.assets / "build-info.json"),
        ]
        with patch.object(sys, "argv", arguments):
            binary_metadata.main()

    def test_valid_receipt_arguments_preserve_the_explicit_path_api(self):
        with patch.object(version_receipt, "create_receipt") as create:
            self.run_receipt()
        create.assert_called_once_with(
            self.root / ".release-plan.json",
            self.root / ".release-inputs.json",
            self.assets,
            self.assets / "release-inputs-test.json",
        )

    def test_relative_cli_paths_keep_current_working_directory_semantics(self):
        with (
            chdir(self.root),
            patch.object(version_receipt, "create_receipt") as create,
        ):
            self.run_receipt(
                plan=Path(".release-plan.json"),
                inputs=Path(".release-inputs.json"),
                assets=Path("dist"),
                output=Path("dist/release-inputs-test.json"),
            )
            self.run_binary(Path("dist/app"), Path("dist/build-info.json"))
        create.assert_called_once_with(
            self.root / ".release-plan.json",
            self.root / ".release-inputs.json",
            self.assets,
            self.assets / "release-inputs-test.json",
        )
        self.assertTrue((self.assets / "build-info.json").is_file())

    def test_receipt_rejects_each_outside_argument_before_reading_or_writing(self):
        for key, value in {
            "plan": self.secret,
            "inputs": self.secret,
            "assets": self.outside,
            "output": self.outside / "release-inputs-test.json",
        }.items():
            with (
                self.subTest(argument=key),
                patch.object(version_receipt, "create_receipt") as create,
            ):
                with self.assertRaisesRegex(ValueError, "inside the script checkout"):
                    self.run_receipt(**{key: value})
                create.assert_not_called()
        self.assertFalse((self.outside / "release-inputs-test.json").exists())
        self.assertFalse((self.assets / "release-inputs-test.json").exists())

    def test_receipt_rejects_git_parent_traversal_and_symlink_inputs(self):
        git_directory = self.root / ".git"
        git_directory.mkdir()
        git_file = git_directory / "config"
        git_file.write_text("{}", encoding="utf-8")
        link = self.root / "linked-plan.json"
        link.symlink_to(self.root / ".release-plan.json")
        for path in (git_file, self.root / ".." / "outside/secret.json", link):
            with (
                self.subTest(path=path),
                patch.object(version_receipt, "create_receipt") as create,
            ):
                with self.assertRaises(ValueError):
                    self.run_receipt(plan=path)
                create.assert_not_called()

    def test_binary_writes_exact_digest_only_inside_checkout(self):
        self.run_binary()
        info = json.loads((self.assets / "build-info.json").read_bytes())
        self.assertEqual(info["version"], "1.2.3-rc.1")
        self.assertEqual(info["binary"], "app")
        self.assertEqual(
            info["binary_sha256"],
            binary_metadata.hashlib.sha256(b"compiled application").hexdigest(),
        )

    def test_binary_refuses_outside_input_and_output_without_creating_metadata(self):
        for binary, output in (
            (self.secret, self.assets / "build-info.json"),
            (self.assets / "app", self.outside / "metadata.json"),
        ):
            with (
                self.subTest(binary=binary, output=output),
                self.assertRaises(ValueError),
            ):
                self.run_binary(binary, output)
        self.assertFalse((self.assets / "build-info.json").exists())
        self.assertFalse((self.outside / "metadata.json").exists())

    def test_output_symlink_and_existing_file_are_never_overwritten(self):
        original = self.secret.read_bytes()
        link = self.assets / "metadata.json"
        link.symlink_to(self.secret)
        with self.assertRaises(ValueError):
            self.run_binary(output=link)
        existing = self.assets / "build-info.json"
        existing.write_bytes(b"keep existing metadata")
        with self.assertRaises(ValueError):
            self.run_binary(output=existing)
        self.assertEqual(self.secret.read_bytes(), original)
        self.assertEqual(existing.read_bytes(), b"keep existing metadata")

    def test_symlink_parent_inside_checkout_is_rejected(self):
        linked = self.root / "linked-dist"
        linked.symlink_to(self.assets, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.run_binary(output=linked / "new.json")
        with (
            patch.object(version_receipt, "create_receipt") as create,
            self.assertRaisesRegex(ValueError, "symlink"),
        ):
            self.run_receipt(assets=linked)
        create.assert_not_called()
        self.assertFalse((self.assets / "new.json").exists())


if __name__ == "__main__":
    unittest.main()
