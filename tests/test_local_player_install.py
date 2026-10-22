"""Exercise local installer configuration without changing the host service."""

import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "scripts/install-ottplay-local-service.sh"
SOURCE = INSTALLER.read_text()
PROXY_KEYS = (
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "PROXY",
    "http_proxy", "https_proxy", "all_proxy", "proxy",
    "NPM_CONFIG_PROXY", "NPM_CONFIG_HTTPS_PROXY",
    "npm_config_proxy", "npm_config_https_proxy", "CARGO_HTTP_PROXY",
)


def embedded_python(marker):
    match = re.search(r"<<'" + marker + r"'\n(.*?)\n" + marker + r"\n", SOURCE, re.S)
    if not match:
        raise AssertionError("Missing executable installer configuration: " + marker)
    return match.group(1)


class LocalPlayerInstallTest(unittest.TestCase):
    def test_download_proxy_reset_is_scoped_and_preserves_command_failure(self):
        function = re.search(r"^without_download_proxy\(\) \(\n.*?^\)\n", SOURCE,
                             re.S | re.M).group(0)
        keys = PROXY_KEYS + ("NO_PROXY", "no_proxy", "TEST_UNRELATED_SETTING")
        probe = ("import json, os, sys; print(json.dumps({key: os.environ.get(key) "
                 "for key in " + repr(keys) + "})); sys.exit(int(sys.argv[1]))")
        env = dict(os.environ, **{key: "http://office-proxy.invalid:3128" for key in PROXY_KEYS},
                   NO_PROXY="office.invalid", no_proxy="office.invalid",
                   TEST_UNRELATED_SETTING="preserved", TEST_PYTHON=sys.executable,
                   TEST_PROBE=probe)
        result = subprocess.run(["bash", "-c", "set -uo pipefail\n" + function + '''
status=0
without_download_proxy "$TEST_PYTHON" -c "$TEST_PROBE" 23 || status=$?
"$TEST_PYTHON" -c "$TEST_PROBE" 0
exit "$status"
'''], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 23, result.stderr)
        child, parent = map(json.loads, result.stdout.splitlines())
        for key in PROXY_KEYS:
            self.assertFalse(child[key], key)
            self.assertEqual(parent[key], env[key], key)
        for key in ["NO_PROXY", "no_proxy"]:
            self.assertEqual(child[key], "*")
            self.assertEqual(parent[key], env[key])
        self.assertEqual(child["TEST_UNRELATED_SETTING"], "preserved")

    def test_npm_download_bypasses_environment_and_npmrc_proxies(self):
        function = re.search(r"^without_download_proxy\(\) \(\n.*?^\)\n", SOURCE,
                             re.S | re.M).group(0)
        command = re.search(r"^without_download_proxy npm ci .*$", SOURCE, re.M).group(0)
        archive = io.BytesIO()
        package = {"name": "local-proxy-regression-fixture", "version": "1.0.0"}
        with tarfile.open(fileobj=archive, mode="w:gz") as tar:
            content = json.dumps(package).encode()
            info = tarfile.TarInfo("package/package.json")
            info.size = len(content)
            tar.addfile(info, io.BytesIO(content))
        payload = archive.getvalue()
        requests = []
        proxy_requests = []

        class RegistryHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        class RejectingProxyHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                proxy_requests.append(self.path)
                self.send_error(502, "Proxy use is forbidden by this test")

            do_CONNECT = do_GET

            def log_message(self, *args):
                pass

        servers = [ThreadingHTTPServer(("127.0.0.1", 0), RegistryHandler),
                   ThreadingHTTPServer(("127.0.0.1", 0), RejectingProxyHandler)]
        workers = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for worker in workers:
            worker.start()
        try:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                proxy = "http://127.0.0.1:" + str(servers[1].server_port)
                url = "http://127.0.0.1:" + str(servers[0].server_port) + "/fixture.tgz"
                npmrc = "proxy=" + proxy + "\nhttps-proxy=" + proxy + "\n"
                config_paths = [root / ".npmrc", root / "user.npmrc", root / "global.npmrc"]
                for config in config_paths:
                    config.write_text(npmrc)
                manifest = {"name": "proxy-regression-consumer", "version": "1.0.0",
                            "dependencies": {package["name"]: package["version"]}}
                (root / "package.json").write_text(json.dumps(manifest))
                integrity = "sha512-" + base64.b64encode(hashlib.sha512(payload).digest()).decode()
                lock = dict(name=manifest["name"], version="1.0.0", lockfileVersion=3,
                            requires=True, packages={"": manifest,
                                "node_modules/" + package["name"]: dict(package, resolved=url,
                                                                       integrity=integrity)})
                (root / "package-lock.json").write_text(json.dumps(lock))
                env = {key: value for key, value in os.environ.items()
                       if not key.lower().startswith("npm_config_")}
                env.update({key: proxy for key in PROXY_KEYS})
                env.update(NO_PROXY="office.invalid", no_proxy="office.invalid",
                           npm_config_userconfig=str(config_paths[1]),
                           npm_config_globalconfig=str(config_paths[2]),
                           npm_config_cache=str(root / "empty-cache"),
                           npm_config_fetch_retries="0", npm_config_fetch_timeout="5000")
                config_command = command.replace("npm ci", "npm config get proxy https-proxy")
                config_command = config_command.replace("1>&2", "")
                result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + function + config_command],
                                        cwd=root, env=env, capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(set(result.stdout.splitlines()), {"proxy=null", "https-proxy=null"})
                self.assertNotIn("invalid config", result.stderr)
                result = subprocess.run(["bash", "-c", "set -euo pipefail\n" + function + command],
                                        cwd=root, env=env, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(requests, ["/fixture.tgz"])
                self.assertEqual(proxy_requests, [])
                installed = root / "node_modules" / package["name"] / "package.json"
                self.assertEqual(json.loads(installed.read_text()), package)
                for config in config_paths:
                    self.assertEqual(config.read_text(), npmrc)
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
            for worker in workers:
                worker.join()

    def test_sync_excludes_native_projects_but_keeps_licenses_and_adapters(self):
        sync = re.search(r'^rsync\b.*?^\s*"\$SRC/" "\$DEST/"$', SOURCE, re.S | re.M).group(0)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "source tree"
            dest = root / "installed player"
            dest.mkdir()
            fixtures = {
                "android/app/native.txt": "Android project",
                "ios/App/native.txt": "iOS project",
                "licenses/android/Apache-2.0.txt": "Apache license text",
                "licenses/ios/LICENSE.txt": "iOS license text",
                "src/devices/android/device.ts": "Android TypeScript adapter",
                "devices/android/device.js": "Android JavaScript adapter",
            }
            for relative, content in fixtures.items():
                path = source / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content)
            subprocess.run(["bash", "-c", "set -euo pipefail\n" + sync],
                           env=dict(os.environ, SRC=str(source), DEST=str(dest)),
                           capture_output=True, text=True, check=True)
            self.assertFalse((dest / "android").exists())
            self.assertFalse((dest / "ios").exists())
            for relative in ["licenses/android/Apache-2.0.txt", "licenses/ios/LICENSE.txt",
                             "src/devices/android/device.ts", "devices/android/device.js"]:
                self.assertTrue((dest / relative).is_file(), relative)
                self.assertEqual((dest / relative).read_text(), fixtures[relative])

    def test_unload_waits_for_absence_and_rejects_inspection_errors(self):
        function = re.search(r"^stop_service\(\) \{\n.*?^\}\n", SOURCE, re.S | re.M).group(0)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            launchctl = root / "launchctl"
            launchctl.write_text("#!/usr/bin/env python3\n" + '''import os, sys
from pathlib import Path
if sys.argv[1] == "bootout":
    sys.exit(0)
state = Path(os.environ["TEST_SERVICE_COUNTER"])
count = int(state.read_text()) if state.exists() else 0
state.write_text(str(count + 1))
mode = os.environ["TEST_SERVICE_STATE"]
if mode == "permission":
    sys.stderr.write("Operation not permitted")
    sys.exit(125)
if mode == "unloading" and count == 0:
    sys.exit(0)
sys.stderr.write("Could not find service test in domain")
sys.exit(113)
''')
            launchctl.chmod(0o755)
            (root / "sleep").write_text("#!/bin/sh\nexit 0\n")
            (root / "sleep").chmod(0o755)
            for mode in ["absent", "unloading", "permission"]:
                with self.subTest(mode=mode):
                    counter = root / (mode + ".counter")
                    env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ["PATH"],
                               TEST_SERVICE_STATE=mode, TEST_SERVICE_COUNTER=str(counter))
                    result = subprocess.run(["bash", "-c", "set -euo pipefail\nDOMAIN=gui/test\n" +
                                             function + "\nstop_service com.example.fixture\n"],
                                            env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode == 0, mode != "permission")
                    self.assertEqual(int(counter.read_text()), 2 if mode == "unloading" else 1)

    def test_invalid_or_retired_ports_fail_before_installation(self):
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / "player"
            env = dict(os.environ, OTTPLAY_SRC=str(ROOT), OTTPLAY_DEST=str(dest))
            env.pop("OTTPLAY_PORT", None)
            env.pop("OTTPLAY_HTTPS_PORTS", None)
            for ports in ["", "8095", "8443 8095", "0", "65536", "8443 8443", "8443 08443", "8443 invalid"]:
                with self.subTest(ports=ports):
                    result = subprocess.run(["bash", str(INSTALLER)],
                                            env=dict(env, OTTPLAY_HTTP_PORTS=ports),
                                            capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("OTTPLAY_HTTP_PORTS", result.stderr)
                    self.assertFalse(dest.exists())

    def test_retired_environment_cannot_restore_legacy_listeners(self):
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / "player"
            env = dict(os.environ, OTTPLAY_SRC=str(ROOT), OTTPLAY_DEST=str(dest))
            env.pop("OTTPLAY_PORT", None)
            env.pop("OTTPLAY_HTTPS_PORTS", None)
            for key, value in [("OTTPLAY_PORT", "8095"), ("OTTPLAY_HTTPS_PORTS", "8443 8444")]:
                result = subprocess.run(["bash", str(INSTALLER)], env=dict(env, **{key: value}),
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("retired", result.stderr)
                self.assertFalse(dest.exists())

    def test_four_http_origins_preserve_operator_plist_settings(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dest = root / 'Player & "data"'
            plist = root / "player.plist"
            old = {
                "Label": "com.ottplay-foss-local",
                "ProgramArguments": [str(dest / "ottplay-server"), "--port", "8095",
                                     "--https-port", "8443", "--cert", "/unused/server.crt",
                                     "--key", "/unused/server.key"],
                "EnvironmentVariables": {"EPG_URLS": "fixture", "OPERATOR_OPTION": "keep"},
                "StandardOutPath": str(root / "custom.log"),
                "StandardErrorPath": str(root / "custom.err"),
                "ThrottleInterval": 7,
            }
            plist.write_bytes(plistlib.dumps(old))
            args = [sys.executable, "-", str(plist), str(dest / "ottplay-server"),
                    str(dest), old["Label"], str(root / "debug & archive"), "8443 8444 8445 8446"]
            for _ in range(2):
                subprocess.run(args, input=embedded_python("PYPLIST"), text=True,
                               capture_output=True, check=True)
                current = plistlib.loads(plist.read_bytes())
                self.assertEqual(current["ProgramArguments"], [str(dest / "ottplay-server"),
                    "--host", "0.0.0.0", "--port", "8443", "--port", "8444",
                    "--port", "8445", "--port", "8446"])
                for key in ["StandardOutPath", "StandardErrorPath", "ThrottleInterval"]:
                    self.assertEqual(current[key], old[key])
                self.assertEqual(current["EnvironmentVariables"]["EPG_URLS"], "fixture")
                self.assertEqual(current["EnvironmentVariables"]["OPERATOR_OPTION"], "keep")
                self.assertEqual(current["WorkingDirectory"], str(dest))
                self.assertTrue(current["RunAtLoad"] and current["KeepAlive"])
                self.assertEqual(plist.stat().st_mode & 0o777, 0o600)

    def test_fresh_configuration_needs_no_certificate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plist = root / "fresh.plist"
            subprocess.run([sys.executable, "-", str(plist), str(root / "ottplay-server"),
                            str(root), "com.ottplay-foss-local", str(root / "archive"),
                            "8443 8444 8445 8446"], input=embedded_python("PYPLIST"),
                           text=True, capture_output=True, check=True)
            self.assertEqual(set(root.iterdir()), {plist})
            config = plistlib.loads(plist.read_bytes())
            self.assertNotIn("--cert", config["ProgramArguments"])
            self.assertNotIn("--https-port", config["ProgramArguments"])

    def test_swop_installation_credential_is_private_and_survives_reinstall(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plist = root / "player.plist"
            dest = root / "player"
            args = [sys.executable, "-", str(plist), str(dest / "ottplay-server"),
                    str(dest), "com.ottplay-foss-local", str(root / "archive"), "8443 8444 8445 8446"]
            clean_env = {key: value for key, value in os.environ.items() if not key.startswith("SWOP_")}
            credential = "fixture-installation-secret-" + "a" * 48
            for env in [dict(clean_env, SWOP_BASE_URL="https://worker.invalid",
                             SWOP_INSTALLATION_TOKEN=credential), clean_env]:
                result = subprocess.run(args, input=embedded_python("PYPLIST"), env=env,
                                        text=True, capture_output=True, check=True)
                saved = plistlib.loads(plist.read_bytes())["EnvironmentVariables"]
                self.assertEqual(saved["SWOP_BASE_URL"], "https://worker.invalid")
                self.assertEqual(saved["SWOP_INSTALLATION_TOKEN"], credential)
                self.assertEqual(plist.stat().st_mode & 0o777, 0o600)
                self.assertEqual(json.loads((dest / "local/swop.json").read_text()),
                                 {"swopBaseUrl": "/swop"})
                self.assertNotIn(credential, result.stdout + result.stderr)
                self.assertNotIn(credential, (dest / "local/swop.json").read_text())


if __name__ == "__main__":
    unittest.main()
