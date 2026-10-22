"""Offline contracts for EPG gate evidence, protocol checks and process cleanup."""
import argparse
from contextlib import contextmanager
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


performance = load("epg_performance", "check-epg-performance.py")
benchmark = load("epg_benchmark", "benchmark-container-build.py")
release = load("epg_release", "check-container-epg.py")


class GateTests(unittest.TestCase):
    def test_loopback_requests_ignore_environment_proxy(self):
        response = io.BytesIO(b"ok")
        response.status = 200
        with patch.dict(performance.os.environ, {"http_proxy": "http://invalid.example:9", "no_proxy": ""}), \
                patch.object(performance.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = response
            self.assertEqual(performance.request("http://127.0.0.1:1234", "/health", None, 2)[1], b"ok")
            self.assertEqual(opener.call_args.args[0].proxies, {})

    def test_legacy_success_rejects_numeric_fallback_ids_and_wrong_channel_ids(self):
        good = b"{}\n\t\n1~local~0123456789abcdef\n\t\nlocal~/"
        performance.matched_rows(good, ["Name"])
        for bad in [good.replace(b"0123456789abcdef", b"1"), good.replace(b"1~local", b"2~local")]:
            with self.assertRaises(AssertionError):
                performance.matched_rows(bad, ["Name"])

    def test_image_is_removed_even_when_create_times_out(self):
        args = argparse.Namespace(image="local:fixture", server=None)
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            if command[:2] == ["docker", "create"]:
                raise subprocess.TimeoutExpired(command, 30)
            return subprocess.CompletedProcess(command, 0)
        with tempfile.TemporaryDirectory() as temporary, patch.object(performance.subprocess, "run", side_effect=run):
            with self.assertRaises(subprocess.TimeoutExpired):
                with performance.running_server(args, Path(temporary), Path(temporary) / "fixture.xml", io.BytesIO()):
                    self.fail("A failed create must not yield")
        self.assertEqual(calls[-1][:3], ["docker", "rm", "--force"])
        self.assertEqual(calls[0][calls[0].index("--name") + 1], calls[-1][-1])

    def test_by_name_probe_cannot_fall_back_to_registered_hash(self):
        paths = []
        @contextmanager
        def server(args, root, feed, output):
            output.write(b"[EPG] Loaded 1 channels, 1 programmes\n")
            output.flush()
            yield Mock(poll=lambda: None), "http://127.0.0.1:1234"
        def request(base, path, body, timeout):
            paths.append(path)
            if path == "/m3u/match-logos":
                return 1.0, b"{}\n\t\n1~https://example.invalid/logo.png"
            if path == "/m3u/match-channels":
                return 1.0, b"{}\n\t\n1~local~0123456789abcdef\n\t\nlocal~/"
            if path == "/epg/0123456789abcdef.json":
                return 1.0, b'{"epg_data":[{"name":"Programme"}]}'
            # Simulate the regression: the hash path works but name lookup fails.
            return 1.0, b'{"epg_data":[]}'
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "report.json"
            args = ["check", "--server", sys.executable, "--channels", "1", "--programmes", "1", "--output", str(output)]
            with patch.object(sys, "argv", args), patch.object(performance, "running_server", server), \
                    patch.object(performance, "request", side_effect=request), patch("sys.stdout", io.StringIO()):
                with self.assertRaises(SystemExit):
                    performance.main()
            self.assertFalse(json.loads(output.read_text())["passed"])
        self.assertTrue(any(path.startswith("/epg/unregistered-name-probe.json?") for path in paths))

    def test_parent_timeout_terminates_checker_gracefully_before_force_kill(self):
        process = Mock()
        process.poll.side_effect = [None]
        process.communicate.side_effect = [subprocess.TimeoutExpired(["checker"], 180), ("", "cleaned up")]
        with tempfile.TemporaryDirectory() as temporary, patch.object(benchmark.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(benchmark.BenchmarkError, "overall time budget"):
                benchmark.epg_image_check("local:fixture", Path(temporary))
        process.terminate.assert_called_once()
        process.kill.assert_not_called()
        self.assertEqual(process.communicate.call_args_list[-1].kwargs["timeout"], 40)

    def test_successful_exit_cannot_reuse_stale_passing_report(self):
        process = Mock(returncode=0)
        process.poll.return_value = 0
        process.communicate.return_value = ("", "")
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            (output / "epg-performance.json").write_text('{"passed":true}')
            with patch.object(benchmark.subprocess, "Popen", return_value=process), self.assertRaises(FileNotFoundError):
                benchmark.epg_image_check("local:fixture", output)

    def test_release_inspection_failure_leaves_sanitized_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "report.json"
            fake = Mock()
            fake.inspect_archive.side_effect = ValueError("bad https://private.invalid/?token=secret")
            fake.safe_diagnostic = benchmark.safe_diagnostic
            args = ["check", "--archive", "fixture.tar", "--platform", "linux/amd64", "--version", "1.2.3", "--revision", "a" * 40, "--output", str(output)]
            with patch.object(sys, "argv", args), patch.object(release.importlib.util, "module_from_spec", return_value=fake), \
                    patch.object(release.importlib.util, "spec_from_file_location", return_value=Mock()), self.assertRaises(ValueError):
                release.main()
            result = json.loads(output.read_text())
            self.assertFalse(result["passed"])
            self.assertEqual(result["phase"], "inspect-archive")
            self.assertNotIn("private.invalid", output.read_text())
            fake.smoke_archive.assert_not_called()


if __name__ == "__main__":
    unittest.main()
