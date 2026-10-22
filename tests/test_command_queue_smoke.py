"""Run real shell helpers with fake curl; never open or enable a queue listener."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "synthetic-command-queue-token-1234567890"
FAKE_CURL = '''#!/usr/bin/env python3
import json, os, pathlib, stat, sys
args=sys.argv[1:]
entry={"args":args,"auth":False}
if "--config" in args:
    config=pathlib.Path(args[args.index("--config")+1])
    entry.update(auth=config.read_text()=='header = "Authorization: Bearer '+os.environ.get("QUEUE_HTTP_TOKEN",os.environ.get("OTTPLAY_QUEUE_HTTP_TOKEN",""))+'"\\n',mode=stat.S_IMODE(config.stat().st_mode),config=str(config))
with open(os.environ["CURL_LOG"],"a") as log: log.write(json.dumps(entry)+"\\n")
url=args[-1]
if url.endswith("/api/webhook/health"):
    body={"status":"ok","backend":os.environ.get("MOCK_BACKEND","capacitor"),"port":18081}
elif "-X" in args and args[args.index("-X")+1]=="POST":
    body={"status":"ok","queued":1}
else: body=[{"command":"popup_message"}]
print(json.dumps(body)+"\\n200")
'''


class QueueSmokeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ott-queue-smoke-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        fake = self.directory / "curl"
        fake.write_text(FAKE_CURL)
        fake.chmod(0o755)
        self.log = self.directory / "calls.jsonl"
        self.env = {k: v for k, v in os.environ.items() if k not in {
            "QUEUE_HTTP_TOKEN", "OTTPLAY_QUEUE_HTTP_TOKEN", "BASE_URL", "QUEUE_BASE_URL",
            "BACKEND_FILTER", "DISCOVER_FROM", "DISCOVER_TO", "DEVICE_ID", "COMMAND_JSON",
        }}
        self.env.update(PATH=str(self.directory)+os.pathsep+os.environ["PATH"], CURL_LOG=str(self.log))

    def run_helper(self, name, args=(), extra=None, expected=0):
        env = dict(self.env, **(extra or {}))
        result = subprocess.run(["bash", "-x", str(ROOT / "scripts" / name), *args], env=env,
                                capture_output=True, text=True, timeout=90)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        for call in calls:
            self.assertNotIn(TOKEN, " ".join(call["args"]))
            if "config" in call:
                self.assertTrue(call["auth"])
                self.assertEqual(call["mode"], 0o600)
                self.assertFalse(Path(call["config"]).exists(), "private auth config was not removed")
        return result, calls

    def test_default_capacitor_and_optional_native_checks_do_not_connect(self):
        for name, args in [("smoke-capacitor-device.sh", ()),
                           ("smoke-capacitor-device.sh", ("--queue",)),
                           ("smoke-tauri-desktop.sh", ("--check-queue",)),
                           ("smoke-command-queue.sh", ())]:
            with self.subTest(name=name, args=args):
                _, calls = self.run_helper(name, args)
                self.assertEqual(calls, [])

    def test_required_opt_in_without_token_is_usage_error(self):
        for name, flag in [("smoke-capacitor-device.sh", "--queue"), ("smoke-tauri-desktop.sh", "--check-queue")]:
            _, calls = self.run_helper(name, (flag, "--require-queue"), expected=3)
            self.assertEqual(calls, [])

    def test_mode_a_explicit_target_requires_device_code(self):
        _, calls = self.run_helper("smoke-command-queue.sh", extra={"BASE_URL": "http://127.0.0.1:8081"}, expected=3)
        self.assertEqual(calls, [])

    def test_mode_a_explicit_target_sends_device_code(self):
        _, calls = self.run_helper("smoke-command-queue.sh", ("--aliases",),
                                  {"OTTPLAY_QUEUE_HTTP_TOKEN": TOKEN, "BASE_URL": "http://127.0.0.1:8081"})
        self.assertEqual(len(calls), 5)
        self.assertTrue(all(call["auth"] for call in calls))

    def test_authenticated_primary_alias_requests_hide_and_remove_token_file(self):
        _, calls = self.run_helper("smoke-command-queue.sh", ("--aliases",),
                                  {"QUEUE_HTTP_TOKEN": TOKEN, "BASE_URL": "http://127.0.0.1:18081"})
        self.assertEqual(len(calls), 5)
        self.assertTrue(all(call["auth"] for call in calls))
        self.assertTrue(all("--noproxy" in call["args"] for call in calls))

    def test_authenticated_discovery_understands_actual_capacitor_health(self):
        _, calls = self.run_helper("smoke-command-queue.sh", ("--discover", "--backend", "capacitor"),
                                  {"OTTPLAY_QUEUE_HTTP_TOKEN": TOKEN, "DISCOVER_FROM": "18081", "DISCOVER_TO": "18081"})
        self.assertEqual(len(calls), 4)
        self.assertTrue(all(call["auth"] for call in calls))

    def test_no_token_is_sent_to_non_loopback_or_invalid_origin(self):
        for url in ["https://example.invalid", "http://127.0.0.1@other.invalid", "http://127.0.0.1/?next=other"]:
            _, calls = self.run_helper("smoke-command-queue.sh", extra={"QUEUE_HTTP_TOKEN": TOKEN, "BASE_URL": url}, expected=3)
            self.assertEqual(calls, [])

    def test_optional_tauri_check_does_not_mask_invalid_auth_configuration(self):
        _, calls = self.run_helper("smoke-tauri-desktop.sh", ("--check-queue",),
                                  {"QUEUE_HTTP_TOKEN": "short", "QUEUE_BASE_URL": "http://127.0.0.1:18081"}, expected=3)
        self.assertEqual(calls, [])

    def test_both_wrappers_forward_optional_auth(self):
        for name, args, env in [
            ("smoke-capacitor-device.sh", ("--queue", "--require-queue"), {"BASE_URL": "http://127.0.0.1:18081"}),
            ("smoke-tauri-desktop.sh", ("--check-queue", "--require-queue"), {"QUEUE_BASE_URL": "http://127.0.0.1:18081"}),
        ]:
            self.log.unlink(missing_ok=True)
            _, calls = self.run_helper(name, args, {**env, "QUEUE_HTTP_TOKEN": TOKEN})
            self.assertTrue(any(call["auth"] for call in calls))
            self.assertTrue(all(call["auth"] for call in calls if "--config" in call["args"]))


if __name__ == "__main__":
    unittest.main()
