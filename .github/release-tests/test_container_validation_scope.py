"""Keep expensive container validation required only for relevant changes."""
import importlib.util
import unittest
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import Mock

SPEC = importlib.util.spec_from_file_location("scope", Path(__file__).resolve().parents[2] / "scripts/container_validation_scope.py")
scope = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scope)

class ContainerValidationScopeTests(unittest.TestCase):
    def test_inputs_trigger_both_architectures(self):
        for path in ["Dockerfile", "Cargo.lock", "src-rs/player/Cargo.toml", "src-rs/Cargo.toml", "scripts/container_validation_scope.py", ".github/release-tests/test_container_workspace.py", "src-rs/core/src/shared_guide.rs", "src-rs/core/src/xmltv.rs", "src-rs/core/src/native_xmltv.rs", "src-rs/server/src/main.rs", "vendor/ottplay-core.js", "scripts/check-epg-performance.py"]:
            self.assertTrue(scope.relevant([path]), path)

    def test_unrelated_changes_skip_builds(self):
        self.assertFalse(scope.relevant(["README.md", ".github/workflows/auto-approve.yml", "src/ui.ts"]))

    def test_native_record_kernel_and_its_oracle_require_container_validation(self):
        for path in ["src-rs/core/src/xmltv/server_records.rs", "src-rs/core/src/xmltv_differential_tests.rs"]:
            self.assertTrue(scope.relevant([path]), path)

    def test_pr_and_queue_compare_immutable_commits(self):
        base, head = "a" * 40, "b" * 40
        for kind, event in [("pull_request", {"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}), ("merge_group", {"merge_group": {"base_sha": base, "head_sha": head}})]:
            changes = Mock(return_value=["Dockerfile"])
            self.assertTrue(scope.run_required(kind, event, changes))
            changes.assert_called_once_with(base, head)

    def test_invalid_scope_fails_closed(self):
        event = {"merge_group": {"base_sha": "main", "head_sha": "b" * 40}}
        with self.assertRaises(ValueError):
            scope.run_required("merge_group", event, Mock())

    def test_manual_runs_and_non_pr_events(self):
        self.assertTrue(scope.run_required("workflow_dispatch", {}, Mock()))
        self.assertFalse(scope.run_required("push", {}, Mock()))
        self.assertFalse(scope.run_required("schedule", {}, Mock()))

    def test_renamed_input_still_requires_container_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", "-c", "commit.gpgsign=false", "-c", "user.name=CI fixture", "-c", "user.email=ci@example.invalid", *args], cwd=root, text=True, stderr=subprocess.DEVNULL).strip()
            git("init")
            (root / "Cargo.toml").write_text("[workspace]\nmembers = []\n")
            git("add", ".")
            git("commit", "-m", "fixture")
            base = git("rev-parse", "HEAD")
            git("mv", "Cargo.toml", "build-config.txt")
            git("commit", "-m", "rename input")
            head = git("rev-parse", "HEAD")
            paths = scope.git_changes(base, head, directory=root)
            self.assertIn("Cargo.toml", paths)
            self.assertIn("build-config.txt", paths)
            self.assertTrue(scope.relevant(paths))
