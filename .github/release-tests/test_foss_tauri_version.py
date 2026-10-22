"""FOSS-specific release projections required by Tauri's Windows bundler."""

from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VERSION_PLAN = ROOT / "scripts" / "version_plan.py"
sys.path.insert(0, str(VERSION_PLAN.parent))


def load_version_plan():
    """Load the planner only when the test creates its frozen plan."""
    spec = importlib.util.spec_from_file_location("foss_version_plan", VERSION_PLAN)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load version_plan.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FossTauriVersionTests(unittest.TestCase):
    """Keep candidate identity visible while producing MSI-compatible metadata."""

    def test_beta_sync_uses_base_version_only_for_tauri_bundle_metadata(self):
        repository_policy = json.loads((ROOT / ".release-policy.json").read_bytes())
        declarations = {
            item["path"]: item
            for item in repository_policy["versioning"]["files"]
            if item["path"]
            in {
                "package.json",
                "src-tauri/Cargo.toml",
                "src-tauri/tauri.conf.json",
            }
        }
        self.assertEqual(declarations["package.json"]["value"], "package")
        self.assertEqual(declarations["src-tauri/Cargo.toml"]["value"], "package")
        self.assertEqual(declarations["src-tauri/tauri.conf.json"]["value"], "base")

        policy = {
            "version_file": "package.json",
            "repository": "open-ott-play/ottplay-foss",
            "mode": "release",
            "versioning": {
                "schema": 1,
                "promotion": "promote-bytes",
                "files": list(declarations.values()),
                "build_number_floor": 10142,
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            checkout = Path(directory)
            (checkout / "src-tauri").mkdir()
            (checkout / ".release-policy.json").write_text(
                json.dumps(policy), encoding="utf-8"
            )
            (checkout / "package.json").write_text(
                '{"name":"ottplay-foss","version":"1.1.43"}\n', encoding="utf-8"
            )
            (checkout / "src-tauri" / "Cargo.toml").write_text(
                '[package]\nname = "ottplay-tauri"\nversion = "1.1.43"\n',
                encoding="utf-8",
            )
            (checkout / "src-tauri" / "tauri.conf.json").write_text(
                '{"version":"1.1.43"}\n', encoding="utf-8"
            )
            subprocess.run(["git", "init", "-q"], cwd=checkout, check=True)
            subprocess.run(["git", "add", "."], cwd=checkout, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Version fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-qm",
                    "Committed base inputs",
                ],
                cwd=checkout,
                check=True,
            )
            source_sha = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=checkout, text=True
            ).strip()
            plan = load_version_plan().create_plan(
                "1.1.43", "beta", 3, source_sha, policy, build_number=10143
            )
            (checkout / ".release-plan.json").write_text(
                json.dumps(plan), encoding="utf-8"
            )

            subprocess.run(
                [
                    sys.executable,
                    str(VERSION_PLAN),
                    "sync",
                    "--root",
                    str(checkout),
                    "--plan",
                    ".release-plan.json",
                ],
                check=True,
                capture_output=True,
                text=True,
            )

            package_version = json.loads(
                (checkout / "package.json").read_bytes()
            )["version"]
            cargo_version = tomllib.loads(
                (checkout / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
            )["package"]["version"]
            tauri_version = json.loads(
                (checkout / "src-tauri" / "tauri.conf.json").read_bytes()
            )["version"]
            self.assertEqual(package_version, "1.1.43-beta.3")
            self.assertEqual(cargo_version, "1.1.43-beta.3")
            self.assertEqual(tauri_version, "1.1.43")
            self.assertRegex(tauri_version, re.compile(r"^\d+\.\d+\.\d+$"))

    def test_windows_autocrlf_checkout_remains_receipt_stable(self):
        """Tauri's LF rewrite must not invalidate Windows build receipts."""
        repository_policy = json.loads((ROOT / ".release-policy.json").read_bytes())
        rust_inputs = ("Cargo.lock", "src-tauri/Cargo.toml")
        declarations = [
            item
            for item in repository_policy["versioning"]["files"]
            if item["path"] in rust_inputs
        ]
        self.assertEqual({item["path"] for item in declarations}, set(rust_inputs))
        policy = {
            "version_file": "src-tauri/Cargo.toml",
            "repository": repository_policy["repository"],
            "mode": repository_policy["mode"],
            "versioning": {
                "schema": 1,
                "promotion": "promote-bytes",
                "files": declarations,
                "build_number_floor": 10142,
            },
        }
        fixture_files = {
            ".gitattributes",
            "scripts/release_control.py",
            "scripts/version_plan.py",
            "scripts/version_receipt.py",
            *rust_inputs,
        }
        with tempfile.TemporaryDirectory() as directory:
            fixture = Path(directory)
            source = fixture / "source"
            checkout = fixture / "checkout"
            source.mkdir()
            for name in fixture_files:
                destination = source / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(ROOT / name, destination)
            (source / ".release-policy.json").write_text(
                json.dumps(policy), encoding="utf-8"
            )

            subprocess.run(["git", "init", "-q"], cwd=source, check=True)
            subprocess.run(["git", "add", "."], cwd=source, check=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Version fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "-qm",
                    "Committed release inputs",
                ],
                cwd=source,
                check=True,
            )
            source_sha = subprocess.check_output(
                ["git", "rev-parse", "HEAD"], cwd=source, text=True
            ).strip()
            subprocess.run(
                [
                    "git",
                    "-c",
                    "core.autocrlf=true",
                    "clone",
                    "-q",
                    str(source),
                    str(checkout),
                ],
                check=True,
            )

            attributes = subprocess.check_output(
                ["git", "check-attr", "text", "eol", "--", *rust_inputs],
                cwd=checkout,
                text=True,
            )
            for name in rust_inputs:
                self.assertIn(f"{name}: text: set", attributes)
                self.assertIn(f"{name}: eol: lf", attributes)
                contents = (checkout / name).read_bytes()
                self.assertIn(b"\n", contents)
                self.assertNotIn(b"\r\n", contents)

            planner = load_version_plan()
            plan = planner.create_plan(
                planner.read_base_version(checkout, policy),
                "beta",
                5,
                source_sha,
                policy,
                build_number=10147,
            )
            (checkout / ".release-plan.json").write_text(
                json.dumps(plan), encoding="utf-8"
            )
            sync = subprocess.run(
                [
                    sys.executable,
                    str(checkout / "scripts" / "version_plan.py"),
                    "sync",
                    "--root",
                    str(checkout),
                    "--plan",
                    ".release-plan.json",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(sync.returncode, 0, sync.stderr)

            synchronized = {
                name: (checkout / name).read_bytes() for name in rust_inputs
            }
            for name, contents in synchronized.items():
                normalized = contents.replace(b"\r\n", b"\n")
                (checkout / name).write_bytes(normalized)
                self.assertEqual(normalized, contents)

            assets = checkout / "release-assets"
            assets.mkdir()
            (assets / "windows-fixture.bin").write_bytes(b"windows fixture\n")
            receipt = assets / "release-inputs-windows.json"
            created = subprocess.run(
                [
                    sys.executable,
                    str(checkout / "scripts" / "version_receipt.py"),
                    "create",
                    "--plan",
                    ".release-plan.json",
                    "--inputs",
                    ".release-inputs.json",
                    "--assets",
                    "release-assets",
                    "--output",
                    "release-assets/release-inputs-windows.json",
                ],
                cwd=checkout,
                capture_output=True,
                text=True,
            )
            self.assertEqual(created.returncode, 0, created.stderr)
            evidence = json.loads(receipt.read_bytes())
            self.assertEqual(evidence["source_sha"], source_sha)
            self.assertEqual(
                evidence["artifacts"],
                [
                    {
                        "name": "windows-fixture.bin",
                        "sha256": "74e0cb569e95b05ae2cb4bdda89f2e8d8a731899d0fb07201d4a06476751cef2",
                        "size": 16,
                    }
                ],
            )


if __name__ == "__main__":
    unittest.main()
