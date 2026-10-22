"""Keep the opt-in FOSS beta checks small, reusable, and permission limited."""

import re
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]

CI_RUNNER = (
    "${{ fromJSON((vars.CI_RUNNER_MODE == 'self-hosted' || vars.CI_RUNNER_MODE == "
    "'k3s') && ((github.event_name == 'pull_request' && "
    'github.event.pull_request.head.repo.full_name == github.repository) || '
    '(contains(fromJSON(\'["push","schedule","workflow_dispatch"]\'), github.event_name) '
    "&& github.ref == format('refs/heads/{0}', "
    "github.event.repository.default_branch))) && (vars.CI_RUNNER_LABELS || '[]') || "
    '\'["ubuntu-latest"]\') }}'
)


class BetaChecksTests(unittest.TestCase):
    """Guard the beta workflow without changing the full validation graph."""

    @classmethod
    def setUpClass(cls):
        cls.workflow = yaml.load(
            (ROOT / ".github/workflows/beta-checks.yml").read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )
        cls.ci = yaml.load(
            (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )

    def test_only_callable_with_read_only_permissions(self):
        self.assertEqual(self.workflow["on"], {"workflow_call": {}})
        self.assertEqual(self.workflow["permissions"], {"contents": "read"})
        self.assertEqual(set(self.workflow["jobs"]), {"fast-checks"})
        job = self.workflow["jobs"]["fast-checks"]
        self.assertNotIn("permissions", job)
        self.assertNotIn("secrets", job)
        self.assertNotIn("if", job)
        self.assertNotIn("continue-on-error", job)
        # Preserve the exact public-PR trust boundary and GitHub-hosted fallback.
        self.assertEqual(job["runs-on"], CI_RUNNER)
        self.assertGreater(int(job["timeout-minutes"]), 0)
        self.assertLessEqual(int(job["timeout-minutes"]), 15)

    def test_pinned_actions_match_full_ci_and_checkout_discards_credentials(self):
        steps = self.workflow["jobs"]["fast-checks"]["steps"]
        actions = [step for step in steps if "uses" in step]
        ci_actions = {
            step["uses"]
            for job in self.ci["jobs"].values()
            for step in job.get("steps", [])
            if "uses" in step
        }
        self.assertEqual(
            [step["uses"].split("@")[0] for step in actions],
            ["step-security/harden-runner", "actions/checkout", "actions/setup-node"],
        )
        for step in actions:
            self.assertRegex(step["uses"], re.compile(r"^[^@]+@[0-9a-f]{40}$"))
            self.assertIn(step["uses"], ci_actions)
        self.assertEqual(actions[0]["with"]["egress-policy"], "audit")
        self.assertEqual(actions[1]["with"], {"persist-credentials": "false"})
        self.assertEqual(self.workflow["env"], {"NODE_VERSION": "22"})
        self.assertEqual(
            actions[2]["with"],
            {"node-version": "${{ env.NODE_VERSION }}", "cache": "npm"},
        )

    def test_exact_fast_suite_has_no_duplicate_build_and_cannot_skip_failures(self):
        steps = self.workflow["jobs"]["fast-checks"]["steps"]
        self.assertEqual(
            [step["run"] for step in steps if "run" in step],
            [
                "npm ci --ignore-scripts",
                "npm run lint",
                "npm run typecheck",
                "npm run test:unified",
            ],
        )
        for step in steps:
            self.assertNotIn("if", step)
            self.assertNotIn("continue-on-error", step)


if __name__ == "__main__":
    unittest.main()
