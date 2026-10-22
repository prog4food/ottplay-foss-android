"""Keep native package compatibility independent of the browser runner."""
from pathlib import Path
import re
import unittest

import yaml


ROOT = Path(__file__).resolve().parents[2]


class NativeLinuxBaseline(unittest.TestCase):
    def test_native_linux_builds_keep_fixed_baseline_and_codec_installation(self):
        workflow = yaml.safe_load(
            (ROOT / ".github/workflows/release-build.yml").read_text()
        )
        job = workflow["jobs"]["tauri"]
        entries = job["strategy"]["matrix"]["include"]
        linux = [entry for entry in entries if entry["platform"].startswith("ubuntu")]
        self.assertCountEqual(linux, [
            {"platform": "ubuntu-24.04", "target": ""},
            {"platform": "ubuntu-24.04-arm", "target": "aarch64-unknown-linux-gnu"},
        ])
        dependency_step = next(
            step for step in job["steps"] if step.get("name") == "Install Linux deps"
        )
        selected = re.findall(r"matrix\.platform == '([^']+)'", dependency_step["if"])
        self.assertCountEqual(selected, [entry["platform"] for entry in linux])
        self.assertEqual(dependency_step["run"], "bash scripts/ci-tauri-linux-deps.sh")
        self.assertCountEqual([entry for entry in entries if entry not in linux], [
            {"platform": "macos-latest", "target": "aarch64-apple-darwin"},
            {"platform": "macos-latest", "target": "x86_64-apple-darwin"},
            {"platform": "windows-latest", "target": ""},
        ])


if __name__ == "__main__":
    unittest.main()
