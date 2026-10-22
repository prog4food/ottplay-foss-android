import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import parse_qs, urlsplit

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/configure-nas-library.py"


class NasConfigurationTests(unittest.TestCase):
    def test_url_and_key_validation_happens_before_configuration_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plist = root / "player.plist"
            links = root / "links.json"
            token = root / "token"
            token.write_text("private-fixture-token")
            config = {"Label": "example.player", "EnvironmentVariables": {}}
            original = plistlib.dumps(config)
            plist.write_bytes(original)
            links.write_text("preserve existing connections")
            command = [sys.executable, str(SCRIPT), "--plex-url", "http://192.168.1.25:32400",
                       "--token-file", str(token), "--player-url", "http://192.168.1.20:8443",
                       "--plist", str(plist), "--connections", str(links)]
            for option in ("--plex-url", "--player-url"):
                for value in ("http://host:not-a-port", "http://host:65536", "http://host:0",
                              "http://[broken", "http://bad host", "http://host\\suffix"):
                    with self.subTest(option=option, value=value):
                        broken = command.copy()
                        broken[broken.index(option) + 1] = value
                        result = subprocess.run(broken, capture_output=True)
                        self.assertNotEqual(result.returncode, 0)
                        self.assertEqual(plist.read_bytes(), original)
                        self.assertEqual(links.read_text(), "preserve existing connections")
                        self.assertFalse((root / ".ottplay-backups").exists())
            for key in ("x" * 32 + "]", "x" * 32 + "\n", "x" * 1025):
                config["EnvironmentVariables"]["OTTPLAY_NAS_KEY"] = key
                before = plistlib.dumps(config)
                plist.write_bytes(before)
                result = subprocess.run(command, capture_output=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(plist.read_bytes(), before)
                self.assertEqual(links.read_text(), "preserve existing connections")
                self.assertFalse((root / ".ottplay-backups").exists())

    def test_existing_opaque_key_survives_portable_url_encoding(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plist = root / "player.plist"
            links = root / "links.json"
            token = root / "token"
            token.write_text("private-fixture-token")
            key = "x" * 32 + "&part=2+#/percent%"
            plist.write_bytes(plistlib.dumps({"Label": "example.player",
                                             "EnvironmentVariables": {"OTTPLAY_NAS_KEY": key}}))
            result = subprocess.run([
                sys.executable, str(SCRIPT), "--plex-url", "http://192.168.1.25:32400",
                "--token-file", str(token), "--player-url", "http://192.168.1.20:8443",
                "--plist", str(plist), "--connections", str(links),
            ], capture_output=True, text=True, check=True)
            urls = json.loads(links.read_text())
            self.assertEqual(parse_qs(urlsplit(urls["playlist"]).query), {"key": [key]})
            self.assertEqual(urlsplit(urls["playlist"]).fragment, "")
            self.assertEqual(urls["vportal"], "portal::[key:" + key + "]http://192.168.1.20:8443/nas/api")
            self.assertEqual(plistlib.loads(plist.read_bytes())["EnvironmentVariables"]["OTTPLAY_NAS_KEY"], key)
            self.assertNotIn(key, result.stdout + result.stderr)

    def test_private_idempotent_configuration_preserves_listeners(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plist = root / "player.plist"
            original = {
                "Label": "example.player",
                "ProgramArguments": ["/example/player", "--port", "8443", "--https-port", "8447"],
                "EnvironmentVariables": {"SWOP_INSTALLATION_TOKEN": "existing-installation-token"},
                "KeepAlive": True,
            }
            plist.write_bytes(plistlib.dumps(original))
            token = root / "token"
            token.write_text("private-fixture-plex-token")
            links = root / "connections.json"
            command = [sys.executable, str(SCRIPT), "--plex-url", "http://192.168.1.25:32400",
                       "--token-file", str(token), "--player-url", "https://player.example:8447",
                       "--plist", str(plist), "--connections", str(links)]
            first = subprocess.run(command, capture_output=True, text=True, check=True)
            config = plistlib.loads(plist.read_bytes())
            key = config["EnvironmentVariables"]["OTTPLAY_NAS_KEY"]
            self.assertGreaterEqual(len(key), 32)
            self.assertEqual(config["ProgramArguments"], original["ProgramArguments"])
            self.assertEqual(config["EnvironmentVariables"]["SWOP_INSTALLATION_TOKEN"], "existing-installation-token")
            self.assertNotIn(key, first.stdout + first.stderr)
            self.assertNotIn(token.read_text(), first.stdout + first.stderr)
            for path in (plist, links, root / ".ottplay-backups/player.plist.before-nas"):
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            connection = json.loads(links.read_text())
            self.assertEqual(connection["vportal"], "portal::[key:" + key + "]https://player.example:8447/nas/api")
            subprocess.run(command, capture_output=True, check=True)
            self.assertEqual(plistlib.loads(plist.read_bytes())["EnvironmentVariables"]["OTTPLAY_NAS_KEY"], key)
            self.assertEqual(plistlib.loads((root / ".ottplay-backups/player.plist.before-nas").read_bytes()), original)
            broken = command.copy()
            broken[broken.index("--plex-url") + 1] = "http://user:password@server/"
            self.assertNotEqual(subprocess.run(broken, capture_output=True).returncode, 0)
            self.assertEqual(plistlib.loads(plist.read_bytes()), config)
            # Restart must reload the new environment, rather than kickstarting
            # launchd's cached service definition.
            launcher = root / "launchctl"
            record = root / "launch-calls.jsonl"
            launcher.write_text("#!" + sys.executable + "\nimport json,sys\n"
                                + "with open(" + repr(str(record)) + ", 'a') as out: out.write(json.dumps(sys.argv[1:])+'\\n')\n")
            launcher.chmod(0o755)
            subprocess.run(command + ["--restart"], capture_output=True, check=True,
                           env=dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"]))
            calls = [json.loads(line) for line in record.read_text().splitlines()]
            self.assertEqual([call[0] for call in calls], ["bootout", "bootstrap"])
            self.assertEqual(calls[1][-1], str(plist))


if __name__ == "__main__":
    unittest.main()
