#!/usr/bin/env python3
"""Mode A companion M3U stream-proxy header parity smoke.

POSTs to companion POST /m3u/cp.php with url= pointing at a controllable
header-echo (local mock by default, or ECHO_URL). Compares the upstream
request headers the proxy injects against ottplay-core / archive/server.py.

Documented behavior (read from src-rs/core/src/m3u.rs + archive/server.py —
do not invent):
  * Injects User-Agent only on the upstream GET.
  * Does NOT inject Referer (Capacitor M3UProxy does; Mode A companion does not).
  * Strips a leading '@' from url (provider form: data: { url: "@"+cpurl }).
  * Accepts application/x-www-form-urlencoded (providers) or JSON {url, ua?}.
  * UA presets (exact strings mirrored from server.py / m3u.rs):
      webos, tizen, viera, mag, dune
  * Empty ua → default User-Agent: OTT-play-FOSS/1.0
  * Unknown ua key: Rust passes the string through; archive/server.py maps
    unknown keys to the default (this smoke asserts Rust/ottplay-server).

Sibling scripts: smoke-modea-companion.sh (presence probe), smoke-command-queue.sh.

Exit codes:
  0  smoke passed
  1  companion not listening / connection failed
  2  header / HTTP assertion failed
  3  usage / missing dependency

Default BASE_URL http://127.0.0.1:8443 (same as Mode A companion smoke /
install-ottplay-local-service.sh).
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlencode

DEFAULT_BASE = "http://127.0.0.1:8443"
DEFAULT_UA = "OTT-play-FOSS/1.0"

# Mirrored from src-rs/core/src/m3u.rs / archive/server.py UA_PRESETS.
UA_PRESETS: dict[str, str] = {
    "webos": (
        "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36 LG Browser/9.00.00"
    ),
    "tizen": (
        "Mozilla/5.0 (SMART-TV; Linux; Tizen 5.5) AppleWebKit/537.36 "
        "(KHTML, like Gecko) SamsungTV/3.0 Chrome/76.0.3809.146 Safari/537.36"
    ),
    "viera": (
        "Mozilla/5.0 (Unknown; Linux; Viera/1.0) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36"
    ),
    "mag": "Mozilla/5.0 (STB; Infomir MAG524) Maple 6.0 QtWebKit/3.0",
    "dune": (
        "Mozilla/5.0 (Dune HD; DuneOS) AppleWebKit/537.36 (KHTML, like Gecko) "
        "DuneHD/1.0 Chrome/68.0.3440.106 Safari/537.36"
    ),
}


class HeaderEchoHandler(BaseHTTPRequestHandler):
    """Return request headers as JSON (httpbin /headers shape)."""

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        # Quiet — smoke prints its own progress.
        return

    def do_GET(self) -> None:  # noqa: N802
        headers = {k: v for k, v in self.headers.items()}
        body = json.dumps({"headers": headers}, indent=2).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def start_echo(host: str = "127.0.0.1", port: int = 0) -> tuple[ThreadingHTTPServer, str]:
    server = ThreadingHTTPServer((host, port), HeaderEchoHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    bound_host, bound_port = server.server_address[:2]
    url = f"http://{bound_host}:{bound_port}/headers"
    return server, url


def not_listening(url: str, detail: str = "") -> None:
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


def curl(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: str | None = None,
    connect_timeout: str = "2",
) -> tuple[str, str]:
    cmd = [
        "curl",
        "--silent",
        "--show-error",
        "--connect-timeout",
        connect_timeout,
        "--max-time",
        "20",
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
        not_listening(url, str(e))
    if proc.returncode != 0:
        detail = (proc.stderr or "").strip() or f"curl exit {proc.returncode}"
        not_listening(url, detail)
    raw = proc.stdout
    if "\n" in raw:
        b, _, code = raw.rpartition("\n")
    else:
        b, code = "", raw
    return b, code.strip()


def parse_echo_headers(body: str) -> dict[str, str]:
    """Accept local echo or httpbin-style {\"headers\": {...}}."""
    try:
        data = json.loads(body)
    except json.JSONDecodeError as e:
        raise ValueError(f"proxy body is not JSON header echo: {e}; body[:200]={body[:200]!r}") from e
    if isinstance(data, dict) and isinstance(data.get("headers"), dict):
        # Normalize header names to Title-Case keys for lookup helpers.
        return {str(k): str(v) for k, v in data["headers"].items()}
    raise ValueError(f"unexpected echo JSON shape (want .headers): keys={list(data)[:8]!r}")


def header_get(headers: dict[str, str], name: str) -> str | None:
    want = name.lower()
    for k, v in headers.items():
        if k.lower() == want:
            return v
    return None


def post_cp(
    base: str,
    echo_url: str,
    *,
    ua: str | None = None,
    lead_at: bool = False,
    as_json: bool = False,
    connect_timeout: str = "2",
) -> tuple[dict[str, str], str]:
    target = ("@" + echo_url) if lead_at else echo_url
    url = f"{base.rstrip('/')}/m3u/cp.php"
    if as_json:
        payload: dict[str, str] = {"url": target}
        if ua is not None:
            payload["ua"] = ua
        body = json.dumps(payload)
        hdrs = {"Content-Type": "application/json"}
    else:
        form: dict[str, str] = {"url": target}
        if ua is not None:
            form["ua"] = ua
        body = urlencode(form)
        hdrs = {"Content-Type": "application/x-www-form-urlencoded"}
    resp_body, code = curl("POST", url, headers=hdrs, body=body, connect_timeout=connect_timeout)
    if code != "200":
        raise AssertionError(f"POST /m3u/cp.php expected HTTP 200, got {code}; body={resp_body[:300]!r}")
    return parse_echo_headers(resp_body), resp_body


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Mode A companion /m3u/cp.php upstream header parity smoke",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Env:\n"
            "  BASE_URL          Default http://127.0.0.1:8443\n"
            "  ECHO_URL          Optional public/local echo (httpbin /headers shape).\n"
            "                    If unset, starts a local mock on 127.0.0.1.\n"
            "  CONNECT_TIMEOUT   curl --connect-timeout seconds (default 2).\n"
            "\n"
            "Compare mentally with: curl -v -X POST $BASE_URL/m3u/cp.php \\\n"
            "  -H 'Content-Type: application/x-www-form-urlencoded' \\\n"
            "  -d 'url=http://127.0.0.1:<echo>/headers&ua=webos'\n"
            "then inspect the echo's User-Agent (Referer must be absent on Mode A).\n"
        ),
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Also smoke JSON {url,ua} body (default is form-urlencoded like providers).",
    )
    args = parser.parse_args(argv)

    if shutil.which("curl") is None:
        print("error: curl is required", file=sys.stderr)
        return 3

    base = os.environ.get("BASE_URL", DEFAULT_BASE).rstrip("/")
    connect_timeout = os.environ.get("CONNECT_TIMEOUT", "2")
    echo_url_env = os.environ.get("ECHO_URL", "").strip()

    print("M3U stream-proxy header smoke (Mode A companion)")
    print(f"  BASE_URL={base}")
    print("  expected: User-Agent inject (presets/default); no Referer (server.py parity)")
    print()

    # Reachability probe — cheap GET / (same as modea smoke).
    probe = f"{base}/"
    print(f"==> probe GET {probe}")
    body, code = curl("GET", probe, connect_timeout=connect_timeout)
    if code != "200":
        print(f"error: probe GET expected HTTP 200, got {code}", file=sys.stderr)
        print(f"body: {body[:200]}", file=sys.stderr)
        return 2
    print(f"    listening ({len(body)} bytes)")
    print()

    echo_server: ThreadingHTTPServer | None = None
    if echo_url_env:
        echo_url = echo_url_env
        print(f"==> using ECHO_URL={echo_url}")
    else:
        echo_server, echo_url = start_echo()
        print(f"==> local header echo at {echo_url}")

    fails = 0

    def check(name: str, fn: Any) -> None:
        nonlocal fails
        print(f"==> {name}")
        try:
            fn()
            print(f"  ok: {name}")
        except Exception as e:  # noqa: BLE001 — collect all cases
            print(f"FAIL: {name}: {e}", file=sys.stderr)
            fails += 1

    def expect_ua(label: str, ua_param: str | None, expected_ua: str, *, lead_at: bool = False, as_json: bool = False) -> None:
        headers, _raw = post_cp(
            base,
            echo_url,
            ua=ua_param,
            lead_at=lead_at,
            as_json=as_json,
            connect_timeout=connect_timeout,
        )
        got = header_get(headers, "User-Agent")
        if got != expected_ua:
            raise AssertionError(f"User-Agent mismatch: got={got!r} want={expected_ua!r}")
        ref = header_get(headers, "Referer")
        if ref:
            # Mode A companion must not inject Referer (Cap does).
            raise AssertionError(
                f"Referer unexpectedly present on Mode A upstream request: {ref!r} "
                "(archive/server.py + ottplay-core inject UA only)"
            )
        print(f"    UA={got!r}; Referer absent")

    check(
        "default UA (form, no ua=)",
        lambda: expect_ua("default", None, DEFAULT_UA),
    )
    check(
        "default UA with leading @ strip",
        lambda: expect_ua("at-strip", None, DEFAULT_UA, lead_at=True),
    )
    for key, preset in UA_PRESETS.items():
        check(
            f"ua={key} preset",
            lambda k=key, p=preset: expect_ua(k, k, p),
        )
    check(
        "custom UA passthrough (Rust)",
        lambda: expect_ua("custom", "SmokeCustomUA/1.0", "SmokeCustomUA/1.0"),
    )

    if args.json:
        check(
            "JSON body default UA",
            lambda: expect_ua("json-default", None, DEFAULT_UA, as_json=True),
        )
        check(
            "JSON body ua=webos",
            lambda: expect_ua("json-webos", "webos", UA_PRESETS["webos"], as_json=True),
        )

    # Empty url → companion should 400 (presence / contract).
    def empty_url() -> None:
        url = f"{base}/m3u/cp.php"
        resp_body, code = curl(
            "POST",
            url,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            body="url=",
            connect_timeout=connect_timeout,
        )
        if code != "400":
            raise AssertionError(f"empty url expected HTTP 400, got {code}; body={resp_body[:200]!r}")

    check("empty url → HTTP 400", empty_url)

    if echo_server is not None:
        echo_server.shutdown()

    print()
    if fails:
        print(
            f"FAIL: M3U stream-proxy header smoke against {base} ({fails} failed)",
            file=sys.stderr,
        )
        return 2
    print(f"PASS: M3U stream-proxy header smoke against {base}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
