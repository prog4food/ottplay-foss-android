# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Preparation contracts against real Git repositories and a local bare remote."""

# Explicit fixture setup and assertion method names document these tests.
# pylint: disable=missing-function-docstring,wrong-import-position,consider-using-with

import copy
import json
# Subprocess calls below use argument vectors with shell=False.
import subprocess  # nosec B404
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
import prepare_version as preparation


class PreparationTest(unittest.TestCase):  # pylint: disable=too-many-instance-attributes
    """Only GitHub PR transport is faked; commits, worktrees and pushes are real."""

    def setUp(self):
        directory = Path(self.enterContext(tempfile.TemporaryDirectory()))
        self.root = directory / "checkout"
        self.origin = directory / "origin.git"
        self.root.mkdir()
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Release Fixture")
        self.git("config", "user.email", "release@example.invalid")
        self.git("init", "--bare", str(self.origin))
        self.git("remote", "add", "origin", str(self.origin))
        self.policy = {
            "mode": "release",
            "repository": "example/product",
            "version_file": "version",
            "default_branch": "main",
            "versioning": {
                "schema": 1,
                "promotion": "final-build",
                "files": [
                    {"path": "version", "format": "text", "value": "base"},
                    {
                        "path": "package.json",
                        "format": "json",
                        "field": "version",
                        "value": "package",
                    },
                ],
            },
        }
        self.write(".release-policy.json", json.dumps(self.policy))
        self.write("version", "1.2.3\n")
        self.write("package.json", '{"version":"1.2.3","dependency":"9.8.7"}\n')
        self.commit("initial")
        self.git("tag", "v1.2.3")
        self.git("push", "--set-upstream", "origin", "main", "--tags")
        self.main = self.git("rev-parse", "HEAD")
        self.url = "https://github.com/example/product/pull/42"
        self.open_prs = []
        self.creates = []
        self.pushes = []
        self.fail_create = False
        self.real_run = preparation.run
        self.enterContext(patch.object(preparation, "run", side_effect=self.transport))

    def git(self, *args):
        # Test harness intentionally uses its fixture-controlled PATH.
        return subprocess.check_output(  # nosec B603, B607
            ["git", *args], cwd=self.root, text=True, stderr=subprocess.PIPE
        ).strip()

    def write(self, name, content):
        (self.root / name).write_text(content, encoding="utf-8")

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-m", message)

    def transport(self, root, *args, capture=True):
        if args[:3] == ("git", "remote", "get-url"):
            return "https://github.com/example/product.git"
        if args[:3] == ("gh", "pr", "list"):
            rows = copy.deepcopy(self.open_prs)
            for row in rows:
                if row.get("isCrossRepository") is False:
                    row.setdefault("headRefOid", self.topic())
            return json.dumps(rows)
        if args[:3] == ("gh", "pr", "create"):
            self.creates.append(args)
            if self.fail_create:
                self.fail_create = False
                raise subprocess.CalledProcessError(1, args)
            self.open_prs = [
                {
                    "url": self.url,
                    "isCrossRepository": False,
                    "headRefName": "release/version-1.2.4",
                    "baseRefName": "main",
                }
            ]
            return self.url
        if args[:2] == ("git", "push"):
            self.pushes.append(args)
        return self.real_run(root, *args, capture=capture)

    def topic(self):
        return self.git("rev-parse", "refs/remotes/origin/release/version-1.2.4")

    def test_local_only_tag_cannot_select_release_base(self):
        self.git("tag", "v99.0.0")
        result = preparation.prepare(self.root, dry_run=True)
        self.assertEqual(result["version"], "1.2.4")
        self.assertEqual(self.git("rev-parse", "HEAD"), self.main)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.git("branch", "--list", "release/*"), "")
        self.assertEqual(self.pushes, [])

    def test_untrusted_requested_version_is_rejected_before_preparation_writes(self):
        versions = (
            "../outside",
            "1.2.4/../../outside",
            "/outside-checkout/invalid-version",  # Rejected text, never opened.
            "C:\\outside",
            "--output=outside",
            "1.2.4\n",
            "1.2.\u0664",
            "1.2.4\x00",
        )
        before_refs = self.git("show-ref")
        before_worktrees = self.git("worktree", "list", "--porcelain")
        with (
            patch.object(preparation, "_preparation_topic") as topic,
            patch.object(preparation.version_plan, "sync_versions") as sync,
        ):
            for requested in versions:
                with self.subTest(requested=requested), self.assertRaisesRegex(ValueError, "Requested version must"):
                    preparation.prepare(self.root, requested=requested, pull_request=True)
            topic.assert_not_called()
            sync.assert_not_called()
        self.assertEqual(self.git("show-ref"), before_refs)
        self.assertEqual(self.git("worktree", "list", "--porcelain"), before_worktrees)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.pushes, [])
        self.assertEqual(self.creates, [])

    def test_repeated_preparation_uses_same_pr_and_preserves_local_main(self):
        first = preparation.prepare(self.root, pull_request=True)
        old = self.topic()
        second = preparation.prepare(self.root, pull_request=True)
        self.assertEqual(first["pull_request"], self.url)
        self.assertEqual(second["pull_request"], self.url)
        self.assertFalse(second["updated"])
        self.assertEqual(self.topic(), old)
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(len(self.pushes), 1)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.main)
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertEqual(self.git("branch", "--list", "release/*"), "")
        self.assertEqual(self.git("show", f"{old}:version"), "1.2.4")
        package = json.loads(self.git("show", f"{old}:package.json"))
        self.assertEqual(package, {"version": "1.2.4", "dependency": "9.8.7"})

    def test_nonancestor_remote_tag_is_occupied_without_changing_release_train(self):
        self.git("checkout", "-b", "legacy-release")
        self.write("legacy.txt", "legacy branch release\n")
        self.commit("legacy release")
        for tag in ("v1.2.4", "v1.2.5", "v99.0.0"):
            self.git("tag", tag)
            self.git("push", "origin", tag)
        self.git("checkout", "main")
        result = preparation.prepare(self.root, dry_run=True)
        self.assertEqual(result["version"], "1.2.6")
        self.assertEqual(self.pushes, [])
        with self.assertRaisesRegex(ValueError, "already has a stable tag"):
            preparation.prepare(self.root, requested="1.2.4", dry_run=True)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.main)

    def test_existing_pr_advances_with_main_and_new_policy_owned_field(self):
        preparation.prepare(self.root, pull_request=True)
        previous = self.topic()
        updated_policy = copy.deepcopy(self.policy)
        updated_policy["versioning"]["files"].append(
            {"path": "version-new", "format": "text", "value": "base"}
        )
        self.write("version-new", "1.2.3\n")
        self.write(".release-policy.json", json.dumps(updated_policy))
        self.write("application.txt", "new application behavior\n")
        self.commit("new main and owned field")
        head = self.git("rev-parse", "HEAD")
        self.git("push", "origin", "main")
        result = preparation.prepare(self.root, pull_request=True)
        current = self.topic()
        self.assertTrue(result["updated"])
        self.assertEqual(result["pull_request"], self.url)
        self.assertEqual(self.git("show", f"{current}:version-new"), "1.2.4")
        self.assertEqual(
            self.git("show", f"{current}:application.txt"), "new application behavior"
        )
        self.assertEqual(
            self.git("show", "-s", "--format=%P", current).split(), [previous, head]
        )
        self.assertEqual(len(self.creates), 1)
        self.assertTrue(all("--force" not in call for call in self.pushes))
        repeated = preparation.prepare(self.root, pull_request=True)
        self.assertFalse(repeated["updated"])
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(len(self.pushes), 2)

    def test_retry_resumes_remote_branch_after_pr_creation_failure(self):
        self.fail_create = True
        with self.assertRaises(subprocess.CalledProcessError):
            preparation.prepare(self.root, pull_request=True)
        previous = self.topic()
        result = preparation.prepare(self.root, pull_request=True)
        self.assertTrue(result["resumed"])
        self.assertEqual(result["pull_request"], self.url)
        self.assertEqual(self.topic(), previous)
        self.assertEqual(len(self.pushes), 1)
        self.assertEqual(self.git("branch", "--list", "release/*"), "")

    def change_topic(self, name, value):
        self.git("checkout", "--detach", self.topic())
        self.write(name, value)
        self.commit("human changes")
        self.git("push", "origin", "HEAD:refs/heads/release/version-1.2.4")
        self.git("checkout", "main")

    def test_human_edits_to_unowned_file_are_rejected_before_push(self):
        preparation.prepare(self.root, pull_request=True)
        self.change_topic("application.txt", "human changes\n")
        previous = self.topic()
        with self.assertRaisesRegex(ValueError, "unowned changes"):
            preparation.prepare(self.root, pull_request=True)
        self.assertEqual(self.topic(), previous)
        self.assertEqual(len(self.pushes), 1)

    def test_human_edits_to_unowned_field_in_owned_file_are_rejected(self):
        preparation.prepare(self.root, pull_request=True)
        self.change_topic(
            "package.json", '{"version":"1.2.4","dependency":"human-edited"}\n'
        )
        previous = self.topic()
        with self.assertRaisesRegex(ValueError, "outside the owned version fields"):
            preparation.prepare(self.root, pull_request=True)
        self.assertEqual(self.topic(), previous)
        self.assertEqual(len(self.pushes), 1)

    def test_missing_declared_file_and_mode_changes_are_rejected(self):
        preparation.prepare(self.root, pull_request=True)
        self.git("checkout", "--detach", self.topic())
        (self.root / "version").unlink()
        self.commit("delete owned version file")
        self.git("push", "origin", "HEAD:refs/heads/release/version-1.2.4")
        self.git("checkout", "main")
        with self.assertRaisesRegex(ValueError, "removed a declared version file"):
            preparation.prepare(self.root, pull_request=True)
        self.assertEqual(len(self.pushes), 1)

    def test_merged_preparation_does_not_recreate_a_pr(self):
        preparation.prepare(self.root, pull_request=True)
        self.git("merge", "--ff-only", self.topic())
        self.git("push", "origin", "main")
        self.open_prs = []
        result = preparation.prepare(self.root, pull_request=True)
        self.assertTrue(result["unchanged"])
        self.assertEqual(result["version"], "1.2.4")
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(len(self.pushes), 1)

    def test_fork_with_same_head_name_is_never_treated_as_our_preparation_pr(self):
        fork = {
            "url": "https://github.com/example/product/pull/12",
            "isCrossRepository": True,
            "headRefName": "release/version-1.2.4",
            "baseRefName": "main",
            "headRefOid": self.main,
        }
        self.open_prs = [fork]
        result = preparation.prepare(self.root, pull_request=True)
        self.assertEqual(result["pull_request"], self.url)
        self.assertEqual(len(self.creates), 1)
        self.open_prs.append(fork)
        repeated = preparation.prepare(self.root, pull_request=True)
        self.assertEqual(repeated["pull_request"], self.url)
        self.assertFalse(repeated["updated"])
        self.assertEqual(len(self.creates), 1)

    def test_pr_head_sha_must_match_the_actual_remote_topic_before_update(self):
        preparation.prepare(self.root, pull_request=True)
        self.open_prs[0]["headRefOid"] = "b" * 40
        self.write("application.txt", "main changes\n")
        self.commit("advance main")
        self.git("push", "origin", "main")
        previous = self.topic()
        with self.assertRaisesRegex(ValueError, "PR head SHA differs"):
            preparation.prepare(self.root, pull_request=True)
        self.assertEqual(self.topic(), previous)
        self.assertEqual(len(self.creates), 1)
        self.assertEqual(len(self.pushes), 1)

    def test_fetch_and_push_origin_must_match_policy_repository(self):
        def mismatched(root, *args, capture=True):
            if args == ("git", "remote", "get-url", "--push", "origin"):
                return "https://github.com/unexpected/destination.git"
            return self.transport(root, *args, capture=capture)

        with (
            patch.object(preparation, "run", side_effect=mismatched),
            self.assertRaisesRegex(ValueError, "Origin fetch/push identity differs"),
        ):
            preparation.prepare(self.root, pull_request=True)
        self.assertEqual(self.pushes, [])
        self.assertEqual(self.creates, [])

    def test_racing_human_push_is_never_force_overwritten(self):
        preparation.prepare(self.root, pull_request=True)
        self.write("application.txt", "main changes\n")
        self.commit("advance main")
        self.git("push", "origin", "main")
        raced = []

        def competing(root, *args, capture=True):
            if args[:2] == ("git", "push") and not raced:
                self.change_topic("human.txt", "concurrent human change\n")
                raced.append(self.topic())
            return self.transport(root, *args, capture=capture)

        with (
            patch.object(preparation, "run", side_effect=competing),
            self.assertRaises(subprocess.CalledProcessError),
        ):
            preparation.prepare(self.root, pull_request=True)
        self.assertEqual(self.topic(), raced[0])
        self.assertEqual(len(self.creates), 1)
        self.assertTrue(all("--force" not in args for args in self.pushes))


if __name__ == "__main__":
    unittest.main()
