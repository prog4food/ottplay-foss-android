#!/usr/bin/env python3
"""Offline Cargo integration contracts for the container cache input boundary."""

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import tomllib

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "prepare_container_workspace", ROOT / "scripts/prepare-container-workspace.py"
)
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def crate(directory, name, version, dependencies="", source="pub fn value() -> u32 { 7 }"):
    write(
        directory / "Cargo.toml", f'[package]\nname = "{name}"\nversion = "{version}"\nedition = "2021"\n{dependencies}'
    )
    write(directory / "src/lib.rs", source)


class WorkspaceContracts(unittest.TestCase):
    def test_root_manifest_changes_only_owned_members(self):
        source = (ROOT / "Cargo.toml").read_text()
        original = tomllib.loads(source)
        result = tomllib.loads(PREPARE.server_manifest(source))
        original["workspace"]["members"] = list(PREPARE.SERVER_MEMBERS)
        self.assertEqual(result, original)
        self.assertTrue(result["profile"]["release"]["lto"])
        self.assertEqual(result["patch"], original["patch"])

    def test_unknown_members_fail_instead_of_silently_dropping_new_code(self):
        source = (ROOT / "Cargo.toml").read_text()
        for changed in (
            source.replace('"src-tauri"', '"src-tauri", "new-crate"'),
            source.replace('"src-tauri"', '"src-tauri", "src-tauri"'),
            source.replace('"src-rs/core"', '"different-core"'),
        ):
            with self.subTest(manifest=changed), self.assertRaisesRegex(ValueError, "workspace members"):
                PREPARE.server_manifest(changed)

    def test_multiline_members_and_unrelated_tables_are_preserved(self):
        source = '[workspace]\nresolver = "2"\nmembers = [\n "src-rs/core",\n "src-rs/server",\n "src-tauri",\n]\n\n[workspace.metadata]\nlabel = "src-tauri"\n'
        result = PREPARE.server_manifest(source)
        self.assertIn('label = "src-tauri"', result)
        self.assertEqual(tomllib.loads(result)["workspace"]["members"], list(PREPARE.SERVER_MEMBERS))

    def test_lock_guard_rejects_versions_sources_and_checksums(self):
        local = '\n[[package]]\nname = "ottplay-core"\nversion = "0.1.0"\n\n[[package]]\nname = "ottplay-server"\nversion = "0.1.0"\n'
        external = (
            '\n[[package]]\nname = "locked-dependency"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "'
            + "a" * 64
            + '"\n'
        )
        before = "version = 4\n" + local + external
        self.assertEqual(PREPARE.verify_locked_packages(before, before), (3, 3))
        for changed in (
            before.replace('version = "1.0.0"', 'version = "1.0.1"'),
            before.replace("crates.io-index", "other-index"),
            before.replace("a" * 64, "b" * 64),
            before + '\n[[package]]\nname = "unlocked"\nversion = "1.0.0"\n',
        ):
            with self.subTest(lock=changed), self.assertRaisesRegex(ValueError, "changed a locked package"):
                PREPARE.verify_locked_packages(before, changed)
        git = before.replace(
            "registry+https://github.com/rust-lang/crates.io-index", "git+https://example.invalid/repo#" + "1" * 40
        )
        with self.assertRaisesRegex(ValueError, "changed a locked package"):
            PREPARE.verify_locked_packages(git, git.replace("1" * 40, "2" * 40))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            PREPARE.locked_packages(before + external)


@unittest.skipUnless(shutil.which("cargo"), "Cargo is required for offline integration tests")
class CargoIntegration(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="ottplay-container-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.workspace = self.base / "workspace"
        self.registry = self.base / "registry"
        cargo_home = self.base / "cargo-home"
        write(
            cargo_home / "config.toml",
            '[source.crates-io]\nreplace-with = "fixture"\n[source.fixture]\ndirectory = '
            + json.dumps(str(self.registry))
            + "\n",
        )
        self.env = patch.dict(
            os.environ, {"CARGO_HOME": str(cargo_home), "CARGO_TARGET_DIR": str(self.base / "target")}
        )
        self.env.start()
        self.addCleanup(self.env.stop)
        self.add_registry_version("1.0.0")
        write(
            self.workspace / "Cargo.toml",
            '[workspace]\nresolver = "2"\nmembers = ["src-rs/core", "src-rs/server", "src-tauri"]\n[profile.release]\nlto = true\ncodegen-units = 1\nstrip = true\n',
        )
        (self.workspace / "vendor").mkdir()
        crate(
            self.workspace / "src-rs/core",
            "ottplay-core",
            "0.1.0",
            '[dependencies]\nlocked-dependency = "1"\n',
            "pub fn value() -> u32 { locked_dependency::value() }",
        )
        crate(
            self.workspace / "src-rs/server",
            "ottplay-server",
            "0.1.0",
            '[dependencies]\nottplay-core = { path = "../core" }\n',
        )
        write(self.workspace / "src-rs/server/src/main.rs", "fn main() { assert_eq!(ottplay_core::value(), 7); }")
        crate(
            self.workspace / "src-tauri",
            "ottplay-tauri",
            "1.0.0-beta.1",
            '[dependencies]\ndesktop-only = { path = "../vendor/desktop-only" }\n',
        )
        crate(self.workspace / "vendor/desktop-only", "desktop-only", "0.1.0")
        self.cargo("generate-lockfile", "--offline", "--quiet")
        # The registry now contains a newer compatible version. Preparation must
        # retain the older source lock rather than silently resolve the newest.
        self.add_registry_version("1.0.1")

    def add_registry_version(self, version, name="locked-dependency"):
        directory = self.registry / (name + "-" + version)
        crate(directory, name, version)
        files = {
            str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in directory.rglob("*")
            if path.is_file()
        }
        write(
            directory / ".cargo-checksum.json",
            json.dumps({"files": files, "package": hashlib.sha256(version.encode()).hexdigest()}),
        )

    def cargo(self, *arguments, cwd=None):
        return subprocess.run(
            ["cargo", *arguments], cwd=cwd or self.workspace, check=True, capture_output=True, text=True, timeout=30
        )

    def prepare(self, name="prepared"):
        output = self.base / name
        PREPARE.prepare(self.workspace, output, offline=True, timeout=30)
        return output

    def bytes(self, directory):
        return {path.name: path.read_bytes() for path in directory.iterdir()}

    def test_real_cargo_prunes_desktop_and_keeps_older_registry_version(self):
        source_before = (self.workspace / "Cargo.lock").read_bytes()
        original_manifest = (self.workspace / "Cargo.toml").read_bytes()
        output = self.prepare()
        self.assertEqual(set(self.bytes(output)), {"Cargo.toml", "Cargo.lock"})
        lock = tomllib.loads((output / "Cargo.lock").read_text())
        versions = {package["name"]: package["version"] for package in lock["package"]}
        self.assertNotIn("ottplay-tauri", versions)
        self.assertNotIn("desktop-only", versions)
        self.assertEqual(versions["locked-dependency"], "1.0.0")
        self.assertEqual((self.workspace / "Cargo.lock").read_bytes(), source_before)
        self.assertEqual((self.workspace / "Cargo.toml").read_bytes(), original_manifest)
        for directory in ("src-rs", "vendor"):
            shutil.copytree(self.workspace / directory, output / directory)
        # Compile the real minimal workspace with the final stage's strict
        # contract, without network or any production application process.
        prepared_lock = (output / "Cargo.lock").read_bytes()
        self.cargo("build", "--locked", "--offline", "--quiet", "--bin", "ottplay-server", cwd=output)
        self.assertEqual((output / "Cargo.lock").read_bytes(), prepared_lock)

    def test_beta_only_overlays_produce_identical_inputs(self):
        first = self.bytes(self.prepare("first"))
        for path in (self.workspace / "src-tauri/Cargo.toml", self.workspace / "Cargo.lock"):
            path.write_text(path.read_text().replace("1.0.0-beta.1", "1.0.0-beta.2"))
        second = self.bytes(self.prepare("second"))
        self.assertEqual(first, second)

    def test_committed_server_dependency_update_changes_cache_input(self):
        first = self.bytes(self.prepare("first"))
        self.cargo("update", "--offline", "--quiet", "-p", "locked-dependency", "--precise", "1.0.1")
        second = self.bytes(self.prepare("second"))
        self.assertEqual(first["Cargo.toml"], second["Cargo.toml"])
        self.assertNotEqual(first["Cargo.lock"], second["Cargo.lock"])
        self.assertIn(b'version = "1.0.1"', second["Cargo.lock"])

    def test_single_lock_retains_both_linux_architecture_dependencies(self):
        for name in ("arm-only", "x86-only"):
            self.add_registry_version("1.0.0", name)
        manifest = self.workspace / "src-rs/core/Cargo.toml"
        manifest.write_text(
            manifest.read_text()
            + '\n[target.\'cfg(target_arch = "aarch64")\'.dependencies]\narm-only = "1"\n[target.\'cfg(target_arch = "x86_64")\'.dependencies]\nx86-only = "1"\n'
        )
        self.cargo("update", "--workspace", "--offline", "--quiet")
        output = self.prepare()
        lock_before = (output / "Cargo.lock").read_bytes()
        names = {package["name"] for package in tomllib.loads(lock_before.decode())["package"]}
        self.assertTrue({"arm-only", "x86-only"} <= names)
        for directory in ("src-rs", "vendor"):
            shutil.copytree(self.workspace / directory, output / directory)
        for target, present, absent in (
            ("aarch64-unknown-linux-musl", "arm-only", "x86-only"),
            ("x86_64-unknown-linux-musl", "x86-only", "arm-only"),
        ):
            with self.subTest(target=target):
                result = json.loads(
                    self.cargo(
                        "metadata",
                        "--locked",
                        "--offline",
                        "--format-version",
                        "1",
                        "--filter-platform",
                        target,
                        cwd=output,
                    ).stdout
                )
                packages = {package["id"]: package["name"] for package in result["packages"]}
                active = {packages[node["id"]] for node in result["resolve"]["nodes"]}
                self.assertIn(present, active)
                self.assertNotIn(absent, active)
                self.assertEqual((output / "Cargo.lock").read_bytes(), lock_before)

    def test_unlocked_dependency_change_fails_without_output(self):
        path = self.workspace / "src-rs/core/Cargo.toml"
        path.write_text(path.read_text().replace('locked-dependency = "1"', 'locked-dependency = "=1.0.1"'))
        before = (self.workspace / "Cargo.lock").read_bytes()
        with self.assertRaisesRegex(ValueError, "changed a locked package"):
            self.prepare()
        self.assertFalse((self.base / "prepared").exists())
        self.assertEqual(before, (self.workspace / "Cargo.lock").read_bytes())

    def test_already_existing_output_is_never_overwritten(self):
        output = self.prepare()
        before = self.bytes(output)
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.prepare()
        self.assertEqual(before, self.bytes(output))

    def test_unreviewed_workspace_config_fails_closed(self):
        write(self.workspace / ".cargo/config.toml", "[net]\noffline = true\n")
        with self.assertRaisesRegex(ValueError, "configuration"):
            self.prepare()

    def test_cargo_failure_and_timeout_do_not_publish_partial_output(self):
        original = self.bytes(self.prepare("control"))
        with (
            patch.object(PREPARE.subprocess, "run", side_effect=subprocess.TimeoutExpired("cargo", 1)),
            self.assertRaises(subprocess.TimeoutExpired),
        ):
            self.prepare("timeout")
        with (
            patch.object(PREPARE.subprocess, "run", side_effect=subprocess.CalledProcessError(101, "cargo")),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            self.prepare("failed")
        self.assertFalse((self.base / "timeout").exists())
        self.assertFalse((self.base / "failed").exists())
        self.assertEqual(original, self.bytes(self.base / "control"))


if __name__ == "__main__":
    unittest.main()
