"""Keep both real native compatibility builds in the required CI workflow."""

import importlib.util
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("contracts", ROOT / "scripts/workflow_contracts.py")
CONTRACTS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONTRACTS)


def workflow(name):
    return yaml.load((ROOT / ".github/workflows" / name).read_text(), Loader=CONTRACTS.UniqueKeyLoader)


class NativePlaybackCI(unittest.TestCase):
    def test_both_real_builds_are_unconditional_and_fail_closed(self):
        job = workflow("ci.yml")["jobs"]["linux-playback-compat"]
        self.assertEqual(job["strategy"]["matrix"]["platform"], ["ubuntu-24.04", "ubuntu-24.04-arm"])
        self.assertEqual(job["runs-on"], "${{ matrix.platform }}")
        self.assertEqual(job["strategy"]["fail-fast"], "false")
        self.assertNotIn("if", job)
        self.assertNotIn("continue-on-error", job)
        builds = [step for step in job["steps"] if "build-linux-playback-compat.py" in step.get("run", "")]
        self.assertEqual(len(builds), 1)
        self.assertEqual(builds[0]["run"].strip().splitlines(), [
            "python3 scripts/build-linux-playback-compat.py --output build/linux-playback-compat",
            "python3 scripts/package-linux-playback-compat.py prepare",
        ])
        self.assertNotIn("if", builds[0])
        self.assertNotIn("continue-on-error", builds[0])

    def test_parent_quality_gate_waits_for_ci_workflow(self):
        jobs = workflow("quality-gate.yml")["jobs"]
        self.assertEqual(jobs["check-0"]["uses"], "./.github/workflows/ci.yml")
        self.assertIn("check-0", jobs["gate"]["needs"])
        self.assertNotIn("continue-on-error", jobs["check-0"])

    def test_native_ci_artifacts_do_not_collide_with_release_artifacts(self):
        job = workflow("ci.yml")["jobs"]["linux-playback-compat"]
        upload = next(step for step in job["steps"] if step.get("uses", "").startswith("actions/upload-artifact@"))
        self.assertEqual(upload["if"], "always()")
        self.assertEqual(upload["with"]["name"], "ci-linux-playback-compat-${{ matrix.platform }}")
        releases = workflow("release-build.yml")["jobs"]
        names = {step.get("with", {}).get("name") for job in releases.values() for step in job.get("steps", [])}
        self.assertNotIn(upload["with"]["name"], names)


if __name__ == "__main__":
    unittest.main()
