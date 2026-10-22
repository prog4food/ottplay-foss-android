#!/usr/bin/env python3
"""Network-free regression for the companion's asynchronous EPG startup."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "xmltv_smoke", Path(__file__).resolve().parents[1] / "scripts/smoke-xmltv-cache-refresh.py"
)
SMOKE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SMOKE)


class Response(io.BytesIO):
    status = 200


class WarmupSmokeTests(unittest.TestCase):
    def setUp(self):
        self.now = 0.0
        self.calls = []
        self.epg_reads = 0
        self.after_restart = False
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(contextlib.redirect_stderr(io.StringIO()))
        self.stack.enter_context(patch.object(SMOKE.time, "monotonic", lambda: self.now))
        self.stack.enter_context(patch.object(SMOKE.time, "sleep", self.sleep))
        self.stack.enter_context(patch.dict(SMOKE.os.environ, {"RESTART_CMD": "", "EPG_HASH": ""}))

    def sleep(self, seconds):
        self.assertGreaterEqual(seconds, 0)
        self.now += seconds

    def open(self, request, *, timeout):
        path = SMOKE.urllib.parse.urlparse(request.full_url).path
        self.calls.append((path, timeout))
        if path == "/health":
            return Response(b"OK")
        if path == SMOKE.epg_path(SMOKE.PROBE_HASH):
            return Response(b'{"epg_data":[]}')
        self.assertEqual(path, "/epg/requested-channel.json")
        if self.after_restart:
            self.epg_reads += 1
        rows = [] if self.after_restart and self.epg_reads < 3 else [{"title": "ready"}]
        return Response(json.dumps({"epg_data": rows}).encode())

    def restart(self, command):
        self.assertEqual(command, "fake-restart")
        self.after_restart = True

    def test_strict_restart_waits_for_requested_channel_after_health(self):
        with patch.object(SMOKE.urllib.request, "urlopen", self.open), patch.object(
            SMOKE, "run_restart", self.restart
        ):
            self.assertEqual(SMOKE.main([
                "--epg-hash", "requested-channel", "--strict-epg",
                "--restart-cmd", "fake-restart", "--warmup-timeout", "5",
                "--warmup-poll", "1",
            ]), 0)
        self.assertEqual(self.epg_reads, 3)
        self.assertEqual(self.now, 2)

    def test_no_restart_does_not_wait_or_execute_command(self):
        with patch.object(SMOKE.urllib.request, "urlopen", self.open), patch.object(
            SMOKE, "run_restart"
        ) as restart, patch.object(SMOKE, "wait_for_epg") as wait:
            self.assertEqual(SMOKE.main(["--epg-hash", "requested-channel", "--strict-epg"]), 0)
        restart.assert_not_called()
        wait.assert_not_called()

    def test_health_time_consumes_same_budget_and_empty_epg_times_out(self):
        def health(*args, **kwargs):
            self.now += 4.5

        def empty(request, *, timeout):
            if self.after_restart:
                self.calls.append((request.full_url, timeout))
                return Response(b'{"epg_data":[]}')
            return self.open(request, timeout=timeout)

        with patch.object(SMOKE.urllib.request, "urlopen", empty), patch.object(
            SMOKE, "run_restart", self.restart
        ), patch.object(SMOKE, "wait_for_health", health):
            with self.assertRaises(SystemExit) as error:
                SMOKE.main([
                    "--epg-hash", "requested-channel", "--strict-epg",
                    "--restart-cmd", "fake-restart", "--warmup-timeout", "5",
                    "--warmup-poll", "2",
                ])
        self.assertEqual(error.exception.code, 2)
        self.assertEqual(self.now, 5)
        self.assertEqual(self.calls[-1], (SMOKE.DEFAULT_BASE + "/epg/requested-channel.json", 0.5))

    def test_malformed_epg_contract_cannot_pass_warmup(self):
        for body in [b"not JSON", b'{"epg_data":{}}', b"[]"]:
            with self.subTest(body=body), patch.object(
                SMOKE.urllib.request, "urlopen", lambda *args, **kwargs: Response(body)
            ):
                with self.assertRaises(SystemExit) as error:
                    SMOKE.wait_for_epg(
                        SMOKE.DEFAULT_BASE, "requested-channel", connect_timeout=2,
                        read_timeout=15, timeout=5, poll=1,
                    )
                self.assertEqual(error.exception.code, 2)
        self.assertEqual(self.now, 0)


class SmokeFailureTests(unittest.TestCase):
    """Failures remain failures without contacting a companion or restarting anything."""

    def test_http_error_retains_status_and_connection_failure_has_distinct_exit(self):
        import urllib.error
        error = urllib.error.HTTPError("http://fixture", 503, "unavailable", {}, io.BytesIO(b"retry"))
        with patch.object(SMOKE.urllib.request, "urlopen", side_effect=error):
            self.assertEqual(SMOKE.http_get("http://fixture", connect_timeout=1, read_timeout=1), (503, b"retry"))
        with patch.object(SMOKE.urllib.request, "urlopen", side_effect=OSError("offline")):
            with self.assertRaises(SystemExit) as raised:
                SMOKE.http_get("http://fixture", connect_timeout=1, read_timeout=1)
            self.assertEqual(raised.exception.code, 1)

    def test_restart_exit_status_is_not_mistaken_for_readiness(self):
        import subprocess
        with patch.object(SMOKE.subprocess, "run", return_value=subprocess.CompletedProcess([], 4, "attempted", "failed")):
            with self.assertRaises(SystemExit) as raised:
                SMOKE.run_restart("synthetic-command")
            self.assertEqual(raised.exception.code, 2)
        with patch.object(SMOKE.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "done", "")) as run:
            SMOKE.run_restart("synthetic-command")
            run.assert_called_once()
        with patch.object(SMOKE.subprocess, "run", side_effect=OSError("denied")):
            with self.assertRaises(SystemExit) as raised:
                SMOKE.run_restart("synthetic-command")
            self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
