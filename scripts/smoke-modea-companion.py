"""Mode A companion HTTP smoke via curl (JSON-driven checks).

Reads scripts/modea-smoke-checks.json next to this file (or MODEA_SMOKE_CHECKS).
Default BASE_URL http://127.0.0.1:8443 (install-ottplay-local-service.sh).
Sibling concept: scripts/smoke-command-queue.sh for command-queue / local_proxy.

Exit: 0 pass, 1 not listening, 2 required check failed, 3 usage/deps.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

DEFAULT_BASE = "http://127.0.0.1:8443"


def load_checks() -> list[dict[str, Any]]:
    env = os.environ.get("MODEA_SMOKE_CHECKS")
    if env:
        path = Path(env)
    else:
        path = Path(__file__).resolve().parent / "modea-smoke-checks.json"
    if not path.is_file():
        print(f"error: checks file not found: {path}", file=sys.stderr)
        raise SystemExit(3)
    data = json.loads(path.read_text())
    if not isinstance(data, list):
        print("error: checks JSON must be a list", file=sys.stderr)
        raise SystemExit(3)
    return data


def expand(s: str) -> str:
    # {VAR} from environment; missing -> empty
    def repl(m: re.Match[str]) -> str:
        return os.environ.get(m.group(1), "")

    return re.sub(r"\{([A-Z0-9_]+)\}", repl, s)


class Runner:
    def __init__(self, base: str, connect_timeout: str) -> None:
        self.base = base.rstrip("/")
        self.connect_timeout = connect_timeout
        self.fails = 0
        self.warns = 0

    def ok(self, msg: str) -> None:
        print(f"  ok: {msg}")

    def warn(self, msg: str) -> None:
        print(f"WARN: {msg}", file=sys.stderr)
        self.warns += 1

    def fail(self, msg: str) -> None:
        print(f"FAIL: {msg}", file=sys.stderr)
        self.fails += 1

    def not_listening(self, url: str, detail: str = "") -> None:
        print(f"not listening: cannot reach {url}", file=sys.stderr)
        if detail:
            print(f"  detail: {detail}", file=sys.stderr)
        print(
            "hint: start ottplay-server (local install :8443, cargo/docker often :8080)",
            file=sys.stderr,
        )
        print(
            "      or archive/server.py on the same port; override with BASE_URL=...",
            file=sys.stderr,
        )
        raise SystemExit(1)

    def curl(self, method: str, url: str, headers: dict[str, str] | None, body: str | None) -> tuple[str, str]:
        cmd = [
            "curl",
            "--silent",
            "--show-error",
            "--connect-timeout",
            self.connect_timeout,
            "--max-time",
            "15",
            "-w",
            "\n%{http_code}",
            "-X",
            method,
        ]
        for k, v in (headers or {}).items():
            cmd.extend(["-H", f"{k}: {v}"])
        if body is not None:
            cmd.extend(["-d", body])
        cmd.append(url)
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        except OSError as e:
            self.not_listening(url, str(e))
        if proc.returncode != 0:
            detail = (proc.stderr or "").strip() or f"curl exit {proc.returncode}"
            self.not_listening(url, detail)
        raw = proc.stdout
        if "\n" in raw:
            b, _, code = raw.rpartition("\n")
        else:
            b, code = "", raw
        return b, code.strip()

    def run_check(self, check: dict[str, Any]) -> None:
        name = check.get("name", "?")
        needs = check.get("needs_env")
        if needs and not os.environ.get(needs):
            print(f"==> {name} skipped (set {needs})")
            return

        method = check.get("method", "GET").upper()
        path = expand(check["path"])
        if "{" in path or "}" in path:
            self.warn(f"{name}: path still has placeholders after expand: {path}")
            return
        url = f"{self.base}{path}"
        print(f"==> {method} {path}")
        body, code = self.curl(method, url, check.get("headers"), check.get("body"))

        soft = set(check.get("soft_codes") or [])
        expect = str(check.get("expect_code", "200"))
        required = bool(check.get("required", True))
        strict_env = check.get("strict_env")
        if strict_env and os.environ.get(strict_env) == "1":
            required = True

        def soft_or_fail(msg: str) -> None:
            if required:
                self.fail(msg)
            else:
                self.warn(msg)

        if code in soft and code != expect:
            self.warn(f"{name}: HTTP {code} (soft)")
            return

        accept_4xx = bool(check.get("accept_4xx"))
        if code != expect:
            if accept_4xx and code.startswith("4") and code != "404":
                self.ok(f"{name} present (HTTP {code})")
                return
            if code == "404" and accept_4xx:
                soft_or_fail(f"{name} missing (HTTP 404)")
                return
            soft_or_fail(f"{name}: expected HTTP {expect}, got {code}")
            return

        min_bytes = int(check.get("min_bytes") or 0)
        if min_bytes and len(body) < min_bytes:
            soft_or_fail(f"{name}: body too small ({len(body)} < {min_bytes})")
            return

        needle = check.get("body_contains")
        if needle and needle not in body:
            soft_or_fail(f"{name}: body missing {needle!r}")
            return
        needle_ci = check.get("body_contains_ci")
        if needle_ci and needle_ci.lower() not in body.lower():
            soft_or_fail(f"{name}: body missing {needle_ci!r}")
            return

        empty_re = check.get("empty_ok_regex")
        if empty_re and re.search(empty_re, body):
            self.warn(f"{name}: empty payload matched {empty_re!r} — OK")
            return

        self.ok(f"{name} HTTP {code} ({len(body)} bytes)")

    def run(self, checks: list[dict[str, Any]]) -> int:
        print("Mode A companion smoke")
        print(f"  BASE_URL={self.base}")
        epg = os.environ.get("EPG_HASH", "")
        print(f"  EPG_HASH={epg or '(unset — skip epg check)'}")
        print()
        for c in checks:
            self.run_check(c)
        print()
        if self.fails:
            print(
                f"FAIL: Mode A companion smoke against {self.base} "
                f"({self.fails} failed, {self.warns} warnings)",
                file=sys.stderr,
            )
            return 2
        print(f"PASS: Mode A companion smoke against {self.base} ({self.warns} warnings)")
        return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="curl smoke for Mode A companion (JSON-driven)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Env: BASE_URL (default http://127.0.0.1:8443), EPG_HASH, VERSION_REL "
            "(default index.html), CONNECT_TIMEOUT, STRICT_DIST, MODEA_SMOKE_CHECKS.\n"
            "See scripts/modea-smoke-checks.json and README Mode A companion smoke section."
        ),
    )
    parser.parse_args(argv)
    if shutil.which("curl") is None:
        print("error: curl is required", file=sys.stderr)
        return 3
    # default VERSION_REL for path expansion
    os.environ.setdefault("VERSION_REL", "index.html")
    checks = load_checks()
    runner = Runner(
        base=os.environ.get("BASE_URL", DEFAULT_BASE),
        connect_timeout=os.environ.get("CONNECT_TIMEOUT", "2"),
    )
    return runner.run(checks)


if __name__ == "__main__":
    raise SystemExit(main())
