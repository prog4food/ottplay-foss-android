# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Durable native-build ordering independent of mutable GitHub releases."""

# Tests exercise the existing in-memory GitHub CAS contract without remote calls.
# pylint: disable=missing-function-docstring,missing-class-docstring

import copy
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

from test_versioned_release import REPO, SHA, LedgerGitHub, policy, rc, state


class PublicationFloorTests(unittest.TestCase):
    def setUp(self):
        self.gh = LedgerGitHub()
        self.gh.releases.clear()
        self.policy = policy()
        self.now = datetime(2026, 9, 13, tzinfo=timezone.utc)

    def reserve(self, run_id=99, channel="beta", parent=None):
        return state.reserve_plan(
            self.gh, self.policy, "1.2.3", channel, SHA, run_id, 1, self.now, parent
        )

    def test_new_ledger_has_zero_floor_without_writes(self):
        ledger, previous = state.read_state(self.gh)
        self.assertEqual(ledger["publication_floor"], 0)
        self.assertIsNone(previous)
        self.assertEqual(self.gh.ledger_writes, [])
        self.assertEqual(self.gh.writes, [])

    def test_begin_consumes_number_before_any_public_mutation(self):
        plan = self.reserve()
        state.begin_publication(self.gh, plan, 99)
        self.assertEqual(self.gh.ledger["publication_floor"], plan["build_number"])
        self.assertEqual(self.gh.ledger["plans"]["99"], {"plan": plan, "parent": None})
        self.assertEqual(self.gh.writes, [])
        self.assertEqual(self.gh.releases, {})

    def test_deleting_published_release_does_not_reenable_older_build(self):
        old = self.reserve()
        newer = self.reserve(100)
        state.begin_publication(self.gh, newer, 100)
        self.gh.releases[50] = {"tag_name": newer["tag"], "draft": False}
        del self.gh.releases[50]
        writes = len(self.gh.ledger_writes)
        with self.assertRaisesRegex(rc.ReleaseError, "publication floor"):
            state.verify_reservation(self.gh, old, 99)
        with self.assertRaisesRegex(rc.ReleaseError, "publication floor"):
            state.begin_publication(self.gh, old, 99)
        self.assertEqual(len(self.gh.ledger_writes), writes)
        self.assertEqual(self.gh.writes, [])

    def test_failure_after_floor_write_requires_new_run_and_number(self):
        failed = self.reserve()
        state.begin_publication(self.gh, failed, 99)
        self.assertEqual(self.reserve(), failed)
        with self.assertRaisesRegex(rc.ReleaseError, "publication floor"):
            state.begin_publication(self.gh, failed, 99)
        replacement = self.reserve(100)
        self.assertGreater(replacement["build_number"], failed["build_number"])
        self.assertGreater(replacement["sequence"], failed["sequence"])
        state.begin_publication(self.gh, replacement, 100)
        self.assertEqual(
            self.gh.ledger["publication_floor"], replacement["build_number"]
        )
        self.assertEqual(self.gh.writes, [])

    def test_cas_failure_does_not_advance_floor_or_mutate_public_tags(self):
        plan = self.reserve()
        before = copy.deepcopy(self.gh.ledger)
        self.gh.conflict = True
        with self.assertRaisesRegex(rc.GitHubError, "409"):
            state.begin_publication(self.gh, plan, 99)
        self.assertEqual(self.gh.ledger, before)
        self.assertEqual(self.gh.writes, [])

    def test_concurrent_newer_publication_invalidates_original_cas(self):
        old = self.reserve()
        newer = self.reserve(100)
        pages = self.gh.pages

        def publish_newer_during_inventory(path, field=None):
            self.gh.ledger["publication_floor"] = newer["build_number"]
            self.gh.ledger_sha = rc.digest(rc.json_bytes(self.gh.ledger))[:40]
            return pages(path, field)

        with (
            patch.object(self.gh, "pages", side_effect=publish_newer_during_inventory),
            self.assertRaisesRegex(rc.GitHubError, "409"),
        ):
            state.begin_publication(self.gh, old, 99)
        self.assertEqual(self.gh.ledger["publication_floor"], newer["build_number"])
        self.assertEqual(self.gh.writes, [])

    def test_wrong_parent_fails_before_floor_or_tag_mutations(self):
        plan = self.reserve(channel="stable", parent={"run_id": 17})
        before = copy.deepcopy(self.gh.ledger)
        with self.assertRaisesRegex(rc.ReleaseError, "reservation differs"):
            state.begin_publication(self.gh, plan, 99, {"run_id": 18})
        self.assertEqual(self.gh.ledger, before)
        self.assertEqual(self.gh.writes, [])

    def test_final_build_consumes_its_own_number(self):
        parent = {"run_id": 17}
        plan = self.reserve(channel="stable", parent=parent)
        state.begin_publication(self.gh, plan, 99, parent)
        self.assertEqual(self.gh.ledger["publication_floor"], plan["build_number"])

    def test_byte_promotion_preserves_equal_rc_floor_from_another_run(self):
        self.policy = policy("promote-bytes")
        candidate = self.reserve(channel="rc")
        state.begin_publication(self.gh, candidate, 99)
        self.gh.releases[50] = {"tag_name": candidate["tag"], "draft": False}
        state.verify_promotion_order(self.gh, candidate)
        state.begin_publication(self.gh, candidate, 100, promotion=True)
        self.assertEqual(self.gh.ledger["publication_floor"], candidate["build_number"])
        self.assertEqual(self.gh.writes, [])

    def test_newer_consumed_number_blocks_rc_even_without_a_github_release(self):
        self.policy = policy("promote-bytes")
        candidate = self.reserve(channel="rc")
        state.begin_publication(self.gh, candidate, 99)
        self.gh.releases[50] = {"tag_name": candidate["tag"], "draft": False}
        newer = self.reserve(100)
        state.begin_publication(self.gh, newer, 100)
        with self.assertRaisesRegex(rc.ReleaseError, "publication floor"):
            state.verify_promotion_order(self.gh, candidate)
        with self.assertRaisesRegex(rc.ReleaseError, "publication floor"):
            state.begin_publication(self.gh, candidate, 101, promotion=True)
        self.assertEqual(self.gh.ledger["publication_floor"], newer["build_number"])
        self.assertEqual(self.gh.writes, [])

    def test_deleted_source_rc_cannot_be_promoted(self):
        self.policy = policy("promote-bytes")
        candidate = self.reserve(channel="rc")
        state.begin_publication(self.gh, candidate, 99)
        with self.assertRaisesRegex(rc.ReleaseError, "no longer published"):
            state.begin_publication(self.gh, candidate, 100, promotion=True)
        self.assertEqual(self.gh.writes, [])

    def test_floor_rejects_missing_boolean_negative_and_above_counter(self):
        self.reserve()
        for value in (None, True, False, -1, self.gh.ledger["counter"] + 1):
            with self.subTest(value=value):
                self.gh.ledger["publication_floor"] = value
                with self.assertRaisesRegex(rc.ReleaseError, "publication floor"):
                    state.read_state(self.gh)
        del self.gh.ledger["publication_floor"]
        with self.assertRaisesRegex(rc.ReleaseError, "publication floor"):
            state.read_state(self.gh)

    def test_boolean_schema_and_counter_are_rejected(self):
        self.reserve()
        before = copy.deepcopy(self.gh.ledger)
        for field in ("schema", "counter"):
            with self.subTest(field=field):
                self.gh.ledger = copy.deepcopy(before)
                self.gh.ledger[field] = True
                with self.assertRaises(rc.ReleaseError):
                    state.read_state(self.gh)

    def test_deleted_ledger_on_existing_branch_cannot_reset_counters(self):
        plan = self.reserve()
        state.begin_publication(self.gh, plan, 99)
        self.gh.ledger = None
        with self.assertRaisesRegex(rc.ReleaseError, "restore it from history"):
            self.reserve(100)
        self.assertEqual(self.gh.writes, [])

    def test_invalid_run_id_or_promotion_flag_fails_before_writes(self):
        plan = self.reserve()
        for run_id, promotion in ((True, False), (0, False), (99, "false")):
            with self.subTest(run_id=run_id, promotion=promotion):
                before = copy.deepcopy(self.gh.ledger)
                with self.assertRaises(rc.ReleaseError):
                    state.begin_publication(self.gh, plan, run_id, promotion=promotion)
                self.assertEqual(self.gh.ledger, before)
        self.assertEqual(self.gh.writes, [])

    def test_client_rejects_state_file_put_on_main_before_subprocess(self):
        with patch.object(state.subprocess, "run") as run:
            client = state.StateGitHub(REPO)
            with self.assertRaisesRegex(rc.ReleaseError, "branch mismatch"):
                client.api(
                    state.WRITE_PATH, "PUT", {"branch": "main", "content": "bad"}
                )
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
