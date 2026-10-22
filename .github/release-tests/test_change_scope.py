# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Conservative change scope against real, isolated Git histories; no network."""

import importlib.util
import json
import os
# Subprocesses use explicit argv and never a shell.
import subprocess  # nosec B404
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).parents[2] / "scripts/change_scope.py"
SPEC = importlib.util.spec_from_file_location("change_scope", SCRIPT)
scope = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(scope)


# The isolated repository fixture is shared by independent event/boundary cases.
# pylint: disable-next=too-many-public-methods
class ChangeScopeTests(unittest.TestCase):
    """Git itself supplies revisions, modes and complete NUL-delimited paths."""

    def setUp(self):
        # pylint: disable-next=consider-using-with
        directory = self.enterContext(tempfile.TemporaryDirectory())
        self.directory = Path(directory).resolve()
        self.repo = self.directory / "project"
        self.repo.mkdir()
        self.git("init", "--initial-branch=main")
        self.git("config", "user.name", "Scope tests")
        self.git("config", "user.email", "scope@example.invalid")
        self.git("config", "core.filemode", "true")
        for name in ("README.md", "docs/guide.md", "docs/old.md", "vendor/README.md"):
            self.write(name, "Documentation\n")
        self.write("src/main.py", "print('application')\n")
        self.base = self.commit()

    def git(self, *arguments):
        """Never invoke the workstation's signing key or repository hooks."""
        # Fixed Git executable in an isolated fixture, without hooks or signing.
        return subprocess.check_output(  # nosec B603, B607
            [
                "git",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-C",
                str(self.repo),
                *arguments,
            ],
            stderr=subprocess.PIPE,
            text=True,
        ).strip()

    def write(self, name, content="Updated documentation\n"):
        """Create or replace a fixture without shell interpolation."""
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    def commit(self):
        """Commit fixture changes and return the immutable full revision."""
        self.git("add", "-A")
        self.git("commit", "-m", "Fixture update")
        return self.git("rev-parse", "HEAD")

    def event(self, name="push", *, base=None, head=None):
        """Construct the three documented GitHub revision shapes."""
        base = self.base if base is None else base
        head = self.git("rev-parse", "HEAD") if head is None else head
        if name == "pull_request":
            return {"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}
        if name == "merge_group":
            return {"merge_group": {"base_sha": base, "head_sha": head}}
        return {"before": base, "after": head}

    def classify(self, name="push", **options):
        """Classify the current committed fixture, not its working tree."""
        return scope.classify(self.repo, name, self.event(name), **options)

    def test_documentation_defaults_all_events(self):
        """Only ordinary files in the documented default allowlist skip."""
        for name in (
            "README.md",
            "CHANGELOG.rst",
            "CONTRIBUTING.md",
            "SECURITY.rst",
            "RELEASING.md",
            "CODE_OF_CONDUCT.rst",
            "docs/nested/guide.md",
        ):
            self.write(name)
        self.commit()
        for name in ("push", "pull_request", "merge_group"):
            with self.subTest(event=name):
                self.assertEqual(
                    self.classify(name),
                    {
                        "run": False,
                        "reason": "documentation-only",
                    },
                )

    def test_pr_checks_cumulative_changes_not_only_latest_commit(self):
        """A final docs commit cannot conceal an earlier code change in a PR."""
        self.write("src/main.py", "print('changed')\n")
        self.commit()
        self.write("README.md")
        self.commit()
        self.assertTrue(self.classify("pull_request")["run"])

    def test_push_checks_all_pushed_commits(self):
        """A multi-commit push must retain earlier non-documentation changes."""
        self.write("src/main.py", "print('changed')\n")
        self.commit()
        self.write("README.md")
        self.commit()
        self.assertTrue(self.classify("push")["run"])

    def test_pr_merge_base_ignores_unrelated_target_branch_changes(self):
        """PR uses base...head; merge queue uses the requested base..head."""
        self.git("switch", "-c", "feature")
        self.write("README.md")
        head = self.commit()
        self.git("switch", "main")
        self.write("src/main.py", "print('target branch')\n")
        base = self.commit()
        pull = scope.classify(
            self.repo,
            "pull_request",
            self.event(
                "pull_request",
                base=base,
                head=head,
            ),
        )
        group = scope.classify(
            self.repo,
            "merge_group",
            self.event(
                "merge_group",
                base=base,
                head=head,
            ),
        )
        self.assertFalse(pull["run"])
        self.assertTrue(group["run"])

    def test_deleted_code_requires_full_pipeline(self):
        """Deleted code is still an input change, even alongside new docs."""
        (self.repo / "src/main.py").unlink()
        self.write("README.md")
        self.commit()
        self.assertTrue(self.classify()["run"])

    def test_deleted_documentation_is_documentation_only(self):
        """Removing an ordinary doc does not introduce an executable change."""
        (self.repo / "docs/old.md").unlink()
        self.commit()
        self.assertFalse(self.classify()["run"])

    def test_code_to_documentation_rename_requires_full_pipeline(self):
        """Checking only a rename destination would incorrectly skip this."""
        self.git("mv", "src/main.py", "docs/implementation.md")
        self.commit()
        self.assertTrue(self.classify()["run"])

    def test_documentation_to_code_rename_requires_full_pipeline(self):
        """Checking only a rename source would incorrectly skip this."""
        self.git("mv", "docs/guide.md", "src/template.md")
        self.commit()
        self.assertTrue(self.classify()["run"])

    def test_documentation_to_documentation_rename_can_skip(self):
        """Both independently classified paths are ordinary documentation."""
        self.git("mv", "docs/guide.md", "docs/renamed.md")
        self.commit()
        self.assertFalse(self.classify()["run"])

    def test_nul_paths_preserve_unicode_newlines_and_spaces(self):
        """Git's quoted display format and newline splitting are never used."""
        self.write("docs/русский guide\nline.md")
        self.commit()
        self.assertFalse(self.classify()["run"])

    def test_file_mode_change_requires_full_pipeline(self):
        """A documentation suffix cannot exempt executable permission changes."""
        (self.repo / "README.md").chmod(0o755)
        self.commit()
        self.assertEqual(self.classify()["reason"], "non-regular-or-mode-change")

    def test_symlink_requires_full_pipeline(self):
        """A documentation path cannot stand in for a symlink target."""
        (self.repo / "docs/link.md").symlink_to("../src/main.py")
        self.commit()
        self.assertEqual(self.classify()["reason"], "non-regular-or-mode-change")

    def test_submodule_requires_full_pipeline(self):
        """Gitlinks are detected directly from raw tree modes without fetching."""
        self.git(
            "update-index", "--add", "--cacheinfo", f"160000,{self.base},docs/module.md"
        )
        self.git("commit", "-m", "Add gitlink")
        self.assertEqual(self.classify()["reason"], "non-regular-or-mode-change")

    def test_submodule_ignore_configuration_cannot_hide_updates(self):
        """Local diff settings cannot exempt a changed gitlink beside docs."""
        self.git("update-index", "--add", "--cacheinfo", f"160000,{self.base},module")
        self.git("commit", "-m", "Initial gitlink")
        base = self.git("rev-parse", "HEAD")
        self.git("update-index", "--cacheinfo", f"160000,{base},module")
        self.write("README.md")
        self.git("add", "README.md")
        self.git("commit", "-m", "Changed gitlink and docs")
        self.git("config", "diff.ignoreSubmodules", "all")
        result = scope.classify(self.repo, "push", self.event(base=base))
        self.assertTrue(result["run"])

    def test_markdown_outside_defaults_requires_explicit_opt_in(self):
        """A vendor README can be admitted as one exact, reviewed doc path."""
        self.write("vendor/README.md")
        self.commit()
        self.assertTrue(self.classify()["run"])
        self.assertFalse(self.classify(documentation_paths=["vendor/README.md"])["run"])
        self.assertTrue(self.classify(documentation_paths=["vendor/OTHER.md"])["run"])

    def test_allowlist_cannot_override_protected_locations_or_inputs(self):
        """Neither docs nesting nor policy exceptions hide runtime/build inputs."""
        names = [
            "src/README.md",
            "tests/README.md",
            "fixtures/README.md",
            "resources/README.md",
            "assets/README.md",
            "templates/README.md",
            ".github/workflows/README.md",
            "scripts/README.md",
            "tools/README.md",
            "ci/README.md",
            "config/README.md",
            "dependencies/README.md",
            "build/README.md",
            "docs/assets/guide.md",
            "docs/templates/guide.md",
            "package.json",
            "docs/guide.py",
        ]
        for name in names:
            with self.subTest(path=name):
                self.git("reset", "--hard", self.base)
                self.write(name)
                self.commit()
                self.assertTrue(self.classify(documentation_paths=[name])["run"])

    def test_required_doc_input_overrides_defaults_and_explicit_paths(self):
        """A compiled privacy policy remains a runtime input despite .md."""
        path = "docs/privacy-policy.md"
        self.write(path)
        self.commit()
        self.assertFalse(self.classify()["run"])
        result = self.classify(documentation_paths=[path], required_paths=[path])
        self.assertEqual(result, {"run": True, "reason": "required-path-change"})

    def test_required_path_is_checked_on_rename_source(self):
        """Renaming a required source away must not remove its CI obligation."""
        self.git("mv", "docs/guide.md", "docs/renamed.md")
        self.commit()
        self.assertTrue(self.classify(required_paths=["docs/guide.md"])["run"])

    def test_invalid_documentation_policy_fails_conservatively(self):
        """Broad globs, traversal and non-array or non-doc values cannot skip."""
        self.write("README.md")
        self.commit()
        for paths in (
            "README.md",
            None,
            ["*.md"],
            ["docs/**"],
            ["../README.md"],
            ["/README.md"],
            ["docs/../README.md"],
            ["docs//guide.md"],
            [True],
            ["scripts/check.py"],
            [""],
            ["docs\\guide.md"],
            ["docs/guide.md\0"],
        ):
            with self.subTest(policy=paths):
                self.assertEqual(
                    self.classify(documentation_paths=paths)["reason"],
                    "invalid-documentation-paths",
                )

    def test_invalid_required_paths_cannot_disable_full_validation(self):
        """Required inputs are exact paths as well; malformed policy runs CI."""
        self.write("README.md")
        self.commit()
        for paths in (None, "README.md", ["**"], ["../README.md"], [True], ["."]):
            with self.subTest(policy=paths):
                self.assertEqual(
                    self.classify(required_paths=paths)["reason"],
                    "invalid-required-paths",
                )

    def test_manual_schedule_and_unknown_events_always_run_without_git(self):
        """Qualification and unrecognized event shapes are never docs exemptions."""
        for name in (
            "workflow_dispatch",
            "schedule",
            "workflow_call",
            "pull_request_target",
            "",
            None,
        ):
            with self.subTest(event=name), patch.object(scope, "git") as command:
                self.assertEqual(
                    scope.classify(self.repo, name, {}),
                    {
                        "run": True,
                        "reason": "unsupported-event",
                    },
                )
                command.assert_not_called()

    def test_force_never_reads_event_policy_or_git(self):
        """Full release qualification cannot depend on a docs diff or its parser."""
        with patch.object(scope, "git") as command:
            self.assertEqual(
                scope.classify(
                    self.repo,
                    "push",
                    None,
                    "invalid",
                    required_paths=None,
                    force=True,
                ),
                {"run": True, "reason": "forced"},
            )
            command.assert_not_called()

    def test_unsafe_revision_metadata_never_reaches_git(self):
        """Only nonzero immutable full SHAs can become Git command arguments."""
        bad = [
            None,
            "",
            "0" * 40,
            "a" * 39,
            "--help",
            "HEAD",
            True,
            [],
            {},
            "a" * 40 + "\n",
        ]
        for name in ("pull_request", "merge_group", "push"):
            for revision in bad:
                with (
                    self.subTest(event=name, revision=revision),
                    patch.object(scope, "git") as command,
                ):
                    payload = (
                        self.event(name, head=revision)
                        if revision is not None
                        else None
                    )
                    self.assertTrue(scope.classify(self.repo, name, payload)["run"])
                    command.assert_not_called()

    def test_missing_event_fields_fail_conservatively(self):
        """Missing/wrongly typed base and head containers are not a docs result."""
        for payload in (
            {},
            [],
            None,
            {"pull_request": []},
            {"pull_request": {"base": True}},
        ):
            with self.subTest(payload=payload):
                self.assertEqual(
                    scope.classify(self.repo, "pull_request", payload)["reason"],
                    "invalid-revisions",
                )

    def test_empty_diff_requires_full_pipeline(self):
        """An empty or incomplete event cannot masquerade as a positive docs diff."""
        self.assertEqual(self.classify()["reason"], "empty-diff")

    def test_missing_commit_requires_full_pipeline(self):
        """Missing history is not silently narrowed to whatever Git can see."""
        result = scope.classify(self.repo, "push", self.event(head="f" * 40))
        self.assertEqual(result["reason"], "git-error")

    def test_non_commit_sha_requires_full_pipeline(self):
        """A full object hash must name a commit, not a blob or a tag object."""
        blob = self.git("rev-parse", "HEAD:README.md")
        result = scope.classify(self.repo, "push", self.event(head=blob))
        self.assertEqual(result["reason"], "invalid-revisions")

    def test_shallow_checkout_requires_full_pipeline(self):
        """A local shallow clone is incomplete even when its tip has only docs."""
        self.write("README.md")
        head = self.commit()
        shallow = self.directory / "shallow"
        subprocess.run(  # nosec B603, B607 - fixed local Git clone fixture
            ["git", "clone", "--depth=1", self.repo.as_uri(), str(shallow)],
            check=True,
            capture_output=True,
        )
        result = scope.classify(shallow, "push", self.event(head=head))
        self.assertEqual(result["reason"], "incomplete-history")

    def test_disconnected_pr_history_requires_full_pipeline(self):
        """Two available commits with no merge base cannot prove docs-only scope."""
        self.git("switch", "--orphan", "unrelated")
        self.write("README.md")
        head = self.commit()
        result = scope.classify(
            self.repo, "pull_request", self.event("pull_request", head=head)
        )
        self.assertEqual(result["reason"], "git-error")

    def test_git_errors_and_malformed_diff_require_full_pipeline(self):
        """Timeouts and unexpected output cannot accidentally expose run=false."""
        for failure in (OSError("missing git"), subprocess.TimeoutExpired("git", 30)):
            with (
                self.subTest(error=type(failure).__name__),
                patch.object(scope, "git", side_effect=failure),
            ):
                self.assertEqual(self.classify()["reason"], "git-error")
        for raw in (b"bad", b"bad\0", b"bad\0docs/guide.md\0"):
            with self.subTest(raw=raw):
                self.assertTrue(
                    scope.classify_diff(raw, frozenset(), frozenset())["run"]
                )

    def test_git_sink_rejects_unlisted_operations_and_unsafe_arguments(self):
        """The execution boundary independently rejects options and ref syntax."""
        requests = [
            ("checkout", self.base),
            ("shallow", "--help"),
            ("commit-type", "--batch"),
            ("commit-type", self.base + "\n"),
            ("commit-type", self.base + "^{tree}"),
            ("commit-type", None),
            ("diff", "--output=owned"),
            ("diff", "HEAD..HEAD"),
            ("diff", self.base + "...." + self.base),
            ("diff", self.base + ".." + self.base + " --output=owned"),
        ]
        for operation, revision in requests:
            with (
                self.subTest(operation=operation, revision=revision),
                patch.object(scope.subprocess, "run") as command,
            ):
                with self.assertRaises(ValueError):
                    scope.git(self.repo, operation, revision)
                command.assert_not_called()

    def test_git_sink_keeps_repository_out_of_arguments_and_bounds_revisions(self):
        """An option-like directory is a cwd, never a Git option or revision."""
        renamed = self.directory / "--upload-pack=other command"
        self.repo.rename(renamed)
        self.repo = renamed
        self.write("README.md")
        head = self.commit()
        event = self.event(head=head)
        with patch.object(scope.subprocess, "run", wraps=subprocess.run) as command:
            self.assertFalse(scope.classify(self.repo, "push", event)["run"])
        for invocation in command.call_args_list:
            arguments = invocation.args[0]
            self.assertNotIn("-C", arguments)
            self.assertNotIn(str(renamed), arguments)
            self.assertEqual(invocation.kwargs["cwd"], renamed.resolve())
        arguments = command.call_args_list[-1].args[0]
        self.assertEqual(
            arguments[-3:], ["--end-of-options", self.base + ".." + head, "--"]
        )

    def test_missing_or_non_directory_repository_requires_full_pipeline(self):
        """Repository selection errors never become a documentation-only result."""
        for repository in (self.directory / "missing", self.repo / "README.md"):
            with self.subTest(repository=repository):
                result = scope.classify(repository, "push", self.event())
                self.assertEqual(result, {"run": True, "reason": "git-error"})

    def cli(self, *arguments, event_content=None, env_overrides=None):
        """Run the executable contract with real event and GITHUB_OUTPUT files."""
        event_file = self.directory / "event.json"
        event_file.write_text(
            json.dumps(self.event()) if event_content is None else event_content
        )
        output_file = self.directory / "outputs"
        output_file.write_text("existing=value\n")
        environment = dict(
            os.environ,
            GITHUB_EVENT_NAME="push",
            GITHUB_EVENT_PATH=str(event_file),
            GITHUB_OUTPUT=str(output_file),
        )
        environment.update(env_overrides or {})
        result = subprocess.run(  # nosec B603 - reviewed local script and explicit test argv
            [sys.executable, str(SCRIPT), "--repo", str(self.repo), *arguments],
            capture_output=True,
            text=True,
            env=environment,
            check=False,
        )
        return result, output_file.read_text()

    def test_cli_environment_outputs_and_json_policy(self):
        """Reusable and generated workflows consume identical lowercase outputs."""
        self.write("vendor/README.md")
        self.commit()
        result, output = self.cli("--documentation-paths-json", '["vendor/README.md"]')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout), {"run": False, "reason": "documentation-only"}
        )
        self.assertEqual(
            output, "existing=value\nrun=false\nreason=documentation-only\n"
        )

    def test_cli_repeated_paths_and_required_json(self):
        """Both CLI forms preserve required-input precedence over exceptions."""
        self.write("vendor/README.md")
        self.commit()
        result, output = self.cli(
            "--documentation-path",
            "vendor/README.md",
            "--required-paths-json",
            '["vendor/README.md"]',
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("run=true\nreason=required-path-change\n", output)
        result, output = self.cli(
            "--documentation-paths-json",
            '["vendor/README.md"]',
            "--require-path",
            "vendor/README.md",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("run=true\nreason=required-path-change\n", output)

    def test_cli_malformed_inputs_are_successful_full_decisions(self):
        """Invalid event/JSON policy is full CI, not a skipped or failed gate."""
        for options in (
            {"event_content": "{"},
            {"env_overrides": {"GITHUB_EVENT_PATH": "/missing/event.json"}},
        ):
            with self.subTest(options=options):
                result, output = self.cli(**options)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("run=true\n", output)
        for argument in ("--documentation-paths-json", "--required-paths-json"):
            for value in ("{", '"README.md"', "null", "[true]"):
                with self.subTest(argument=argument, value=value):
                    result, output = self.cli(argument, value)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("run=true\n", output)

    def test_cli_force_ignores_missing_event_and_invalid_policy(self):
        """Force works from an inline script without event/history availability."""
        result, output = self.cli(
            "--force",
            "--documentation-paths-json",
            "{",
            env_overrides={"GITHUB_EVENT_PATH": "/missing/event.json"},
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("run=true\nreason=forced\n", output)

    def test_cli_cannot_report_success_if_outputs_cannot_be_written(self):
        """A runner output failure blocks the gate instead of leaving false state."""
        result, _ = self.cli(
            env_overrides={"GITHUB_OUTPUT": str(self.directory / "missing" / "out")}
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot write GitHub outputs", result.stderr)

    def test_cli_cannot_override_runner_file_channels(self):
        """CLI input cannot redirect event reads or append data to another file."""
        destination = self.directory / "unrelated-file"
        destination.write_text("Keep unrelated data intact.\n")
        for option in ("--event-path", "--github-output"):
            with self.subTest(option=option):
                result, output = self.cli(option, str(destination))
                self.assertEqual(result.returncode, 2)
                self.assertEqual(output, "existing=value\n")
                self.assertEqual(
                    destination.read_text(), "Keep unrelated data intact.\n"
                )


if __name__ == "__main__":
    unittest.main()
