#!/usr/bin/env python3
"""Mode A companion E2E play-path smoke (HTTP / stream readiness).

Automated companion-side verification of the path a player uses to reach a
channel stream — without a headed browser:

  1. Health or index reachable
  2. Static player-shell assets (/, CSS/JS, optional /f/)
  3. Optional EPG slice when EPG_HASH is set (same honesty as siblings)
  4. M3U match-channels with a secret-free fixture payload
  5. Stream-proxy "play": POST /m3u/cp.php at a controllable media fixture
     (local mock by default, or MEDIA_URL) and assert HTTP 200 + non-empty
     body / expected Content-Type (first bytes through the proxy)

This is NOT headed UI E2E (no clicking play in a browser). Sibling scripts:
smoke-modea-companion.sh (presence), smoke-m3u-stream-proxy-headers.sh
(UA/Referer), smoke-xmltv-cache-refresh.sh, smoke-command-queue.sh.

Exit codes:
  0  smoke passed
  1  companion not listening / connection failed
  2  assertion failed
  3  usage / missing dependency

Default BASE_URL http://127.0.0.1:8443. No secrets / no private IPTV URLs.
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

# Tiny HLS playlist — enough for Content-Type + first-bytes through /m3u/cp.php.
DEFAULT_FIXTURE_BODY = (
    b"#EXTM3U\n"
    b"#EXT-X-VERSION:3\n"
    b"#EXTINF:1.0,SmokePlay\n"
    b"http://127.0.0.1/smoke-fixture.ts\n"
)
DEFAULT_FIXTURE_CT = "application/vnd.apple.mpegurl"

# MPEG-TS sync byte fixture (188-byte packet of 0x47 + padding) as alternate.
TS_FIXTURE_BODY = bytes([0x47] + [0xFF] * 187)
TS_FIXTURE_CT = "video/mp2t"


def eprint(*args: object) -> None:
    print(*args, file=sys.stderr)


def not_listening(url: str, detail: str = "") -> None:
    eprint(f"not listening: cannot reach {url}")
    if detail:
        eprint(f"  detail: {detail}")
    eprint(
        "hint: start ottplay-server (local install :8443, cargo/docker often :8080)"
    )
    eprint(
        "      or archive/server.py on the same port; override with BASE_URL=..."
    )
    raise SystemExit(1)


def curl(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: str | None = None,
    connect_timeout: str = "2",
    max_time: str = "20",
) -> tuple[str, str, str]:
    """Return (body, http_code, content_type)."""
    cmd = [
        "curl",
        "--silent",
        "--show-error",
        "--connect-timeout",
        connect_timeout,
        "--max-time",
        max_time,
        "-w",
        "\n%{http_code}\n%{content_type}",
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
    # Last two lines are http_code and content_type (may be empty).
    parts = raw.rsplit("\n", 2)
    if len(parts) == 3:
        b, code, ctype = parts
    elif len(parts) == 2:
        b, code, ctype = parts[0], parts[1], ""
    else:
        b, code, ctype = "", raw.strip(), ""
    return b, code.strip(), (ctype or "").strip()


class MediaFixtureHandler(BaseHTTPRequestHandler):
    """Serve a fixed media body with a media Content-Type."""

    body: bytes = DEFAULT_FIXTURE_BODY
    content_type: str = DEFAULT_FIXTURE_CT

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def do_GET(self) -> None:  # noqa: N802
        payload = self.body
        self.send_response(200)
        self.send_header("Content-Type", self.content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def start_media_fixture(
    body: bytes,
    content_type: str,
    host: str = "127.0.0.1",
    port: int = 0,
) -> tuple[ThreadingHTTPServer, str]:
    handler = type(
        "BoundMediaFixture",
        (MediaFixtureHandler,),
        {"body": body, "content_type": content_type},
    )
    server = ThreadingHTTPServer((host, port), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    bound_host, bound_port = server.server_address[:2]
    # Path suffix helps curl / logs look like a playlist URL.
    url = f"http://{bound_host}:{bound_port}/smoke-play.m3u8"
    return server, url


class Runner:
    def __init__(self, base: str, connect_timeout: str) -> None:
        self.base = base.rstrip("/")
        self.connect_timeout = connect_timeout
        self.fails = 0

    def ok(self, msg: str) -> None:
        print(f"  ok: {msg}")

    def fail(self, msg: str) -> None:
        eprint(f"FAIL: {msg}")
        self.fails += 1

    def get(self, path: str) -> tuple[str, str, str]:
        return curl(
            "GET",
            f"{self.base}{path}",
            connect_timeout=self.connect_timeout,
        )

    def post(
        self,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        body: str | None = None,
    ) -> tuple[str, str, str]:
        return curl(
            "POST",
            f"{self.base}{path}",
            headers=headers,
            body=body,
            connect_timeout=self.connect_timeout,
        )

    def check_health_or_index(self) -> None:
        print("==> health or index")
        body, code, _ct = self.get("/health")
        if code == "200" and "OK" in body:
            self.ok(f"/health → OK ({len(body)} bytes)")
            return
        # Soft: some archive builds omit /health — fall back to /
        if code in ("404", "000") or code != "200":
            print(f"    /health HTTP {code}; trying GET /")
        body2, code2, _ct2 = self.get("/")
        if code2 != "200" or len(body2) < 1:
            self.fail(f"index expected HTTP 200 + body, got {code2} ({len(body2)} bytes)")
            return
        self.ok(f"/ → HTTP {code2} ({len(body2)} bytes)")

    def check_static_shell(self) -> None:
        print("==> static player-shell assets")
        checks = [
            ("/", 1, None),
            ("/styles/player.css", 10, None),
            ("/js/jquery-1.11.1.min.js", 100, None),
            ("/f/README.md", 1, None),  # ServeDir(".") under /f
        ]
        for path, min_bytes, needle in checks:
            body, code, _ct = self.get(path)
            if code != "200":
                self.fail(f"{path}: expected HTTP 200, got {code}")
                continue
            if len(body) < min_bytes:
                self.fail(f"{path}: body too small ({len(body)} < {min_bytes})")
                continue
            if needle and needle not in body:
                self.fail(f"{path}: body missing {needle!r}")
                continue
            self.ok(f"{path} HTTP {code} ({len(body)} bytes)")

    def check_epg_optional(self) -> None:
        epg = os.environ.get("EPG_HASH", "").strip()
        if not epg:
            print("==> EPG skipped (set EPG_HASH)")
            return
        path = f"/epg/{epg if epg.endswith('.json') else epg + '.json'}"
        print(f"==> optional EPG GET {path}")
        body, code, _ct = self.get(path)
        if code != "200":
            self.fail(f"EPG expected HTTP 200, got {code}")
            return
        if "epg_data" not in body:
            self.fail("EPG body missing 'epg_data'")
            return
        if '"epg_data":[]' in body.replace(" ", "") or '"epg_data": []' in body:
            print("  WARN: EPG empty payload — OK (cache miss / unknown hash)")
            return
        self.ok(f"EPG HTTP {code} ({len(body)} bytes)")

    def check_m3u_match(self) -> None:
        print("==> M3U match-channels (secret-free fixture)")
        # Empty array: proves endpoint + JSON path without IPTV credentials.
        body, code, _ct = self.post(
            "/m3u/match-channels",
            headers={"Content-Type": "application/json"},
            body="[]",
        )
        if code != "200":
            self.fail(f"match-channels [] expected HTTP 200, got {code}")
            return
        try:
            data = json.loads(body)
        except json.JSONDecodeError as e:
            self.fail(f"match-channels [] not JSON: {e}; body[:200]={body[:200]!r}")
            return
        if data != []:
            self.fail(f"match-channels [] expected [], got {data!r}")
            return
        self.ok("match-channels [] → []")

        # One synthetic channel (no URL / no provider secrets).
        payload = json.dumps(
            [{"id": "smoke-play-1", "name": "Smoke Play Channel", "logo": "", "url": ""}]
        )
        body2, code2, _ct2 = self.post(
            "/m3u/match-channels",
            headers={"Content-Type": "application/json"},
            body=payload,
        )
        if code2 != "200":
            self.fail(f"match-channels fixture expected HTTP 200, got {code2}")
            return
        try:
            data2 = json.loads(body2)
        except json.JSONDecodeError as e:
            self.fail(f"match-channels fixture not JSON: {e}; body[:200]={body2[:200]!r}")
            return
        if not isinstance(data2, list) or len(data2) != 1:
            self.fail(f"match-channels fixture expected 1-element list, got {data2!r}")
            return
        row = data2[0]
        if not isinstance(row, dict) or row.get("id") != "smoke-play-1":
            self.fail(f"match-channels fixture unexpected row: {row!r}")
            return
        self.ok(f"match-channels fixture → id={row.get('id')!r} score={row.get('score')}")

    def check_stream_play(
        self,
        media_url: str,
        *,
        expect_body: bytes | None,
        expect_ct_substr: str | None,
        lead_at: bool,
    ) -> None:
        print("==> stream-proxy play (POST /m3u/cp.php)")
        target = ("@" + media_url) if lead_at else media_url
        form = urlencode({"url": target})
        # Use binary-safe curl for media bytes (text=True can mangle non-UTF8).
        cmd = [
            "curl",
            "--silent",
            "--show-error",
            "--connect-timeout",
            self.connect_timeout,
            "--max-time",
            "20",
            "-w",
            "\n%{http_code}\n%{content_type}",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/x-www-form-urlencoded",
            "-d",
            form,
            f"{self.base}/m3u/cp.php",
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, check=False)
        except OSError as e:
            not_listening(f"{self.base}/m3u/cp.php", str(e))
        if proc.returncode != 0:
            detail = (proc.stderr or b"").decode("utf-8", errors="replace").strip()
            not_listening(f"{self.base}/m3u/cp.php", detail or f"curl exit {proc.returncode}")

        raw = proc.stdout
        # Split trailing \nCODE\nCTYPE from binary body.
        # Find last two newlines from the end.
        if raw.count(b"\n") < 2:
            self.fail(f"play proxy: unexpected curl -w output ({len(raw)} bytes)")
            return
        before_ct, _nl, ctype_b = raw.rpartition(b"\n")
        before_code, _nl2, code_b = before_ct.rpartition(b"\n")
        body_b = before_code
        code = code_b.decode("ascii", errors="replace").strip()
        ctype = ctype_b.decode("ascii", errors="replace").strip()

        if code != "200":
            preview = body_b[:200]
            self.fail(f"play proxy expected HTTP 200, got {code}; body[:200]={preview!r}")
            return
        if len(body_b) < 1:
            self.fail("play proxy body empty")
            return
        if expect_body is not None and body_b != expect_body:
            self.fail(
                f"play proxy body mismatch: got {len(body_b)} bytes "
                f"(head={body_b[:40]!r}) want {len(expect_body)} bytes "
                f"(head={expect_body[:40]!r})"
            )
            return
        if expect_ct_substr and expect_ct_substr.lower() not in ctype.lower():
            self.fail(
                f"play proxy Content-Type missing {expect_ct_substr!r}: got {ctype!r}"
            )
            return
        at_note = " (leading @ strip)" if lead_at else ""
        self.ok(
            f"POST /m3u/cp.php → HTTP {code}, {len(body_b)} bytes, "
            f"Content-Type={ctype!r}{at_note}"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Mode A companion E2E play-path smoke "
            "(HTTP / stream readiness — not headed UI)"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Env:\n"
            "  BASE_URL          Default http://127.0.0.1:8443\n"
            "  EPG_HASH          Optional channel hash for GET /epg/<hash>.json\n"
            "  MEDIA_URL         Optional upstream media/echo URL for /m3u/cp.php.\n"
            "                    If unset, starts a local HLS-playlist fixture on\n"
            "                    127.0.0.1 (must be reachable from the companion).\n"
            "  CONNECT_TIMEOUT   curl --connect-timeout seconds (default 2).\n"
            "\n"
            "Honesty: this proves companion play-path / stream readiness via curl.\n"
            "It does NOT drive a headed browser or click Play in the TS UI.\n"
            "\n"
            "Examples:\n"
            "  ./scripts/smoke-modea-e2e-play.sh\n"
            "  BASE_URL=http://127.0.0.1:8080 ./scripts/smoke-modea-e2e-play.sh\n"
            "  EPG_HASH=<hash> ./scripts/smoke-modea-e2e-play.sh\n"
            "  MEDIA_URL=https://httpbingo.org/bytes/64 ./scripts/smoke-modea-e2e-play.sh\n"
        ),
    )
    parser.add_argument(
        "--ts-fixture",
        action="store_true",
        help="Use a tiny MPEG-TS (video/mp2t) local fixture instead of HLS playlist",
    )
    parser.add_argument(
        "--with-at-strip",
        action="store_true",
        help="Also POST url with leading '@' (provider form) on the play step",
    )
    args = parser.parse_args(argv)

    if shutil.which("curl") is None:
        eprint("error: curl is required")
        return 3

    base = os.environ.get("BASE_URL", DEFAULT_BASE).rstrip("/")
    connect_timeout = os.environ.get("CONNECT_TIMEOUT", "2")
    media_url_env = os.environ.get("MEDIA_URL", "").strip()

    print("Mode A E2E play-path smoke (companion HTTP / stream readiness)")
    print(f"  BASE_URL={base}")
    print(f"  EPG_HASH={os.environ.get('EPG_HASH', '') or '(unset — skip epg)'}")
    print(f"  MEDIA_URL={media_url_env or '(local fixture)'}")
    print("  note: not headed UI E2E")
    print()

    runner = Runner(base=base, connect_timeout=connect_timeout)
    runner.check_health_or_index()
    if runner.fails:
        # If we cannot reach health/index, stop early (exit 1 already raised on connect).
        eprint(f"FAIL: Mode A E2E play-path smoke against {base} ({runner.fails} failed)")
        return 2

    runner.check_static_shell()
    runner.check_epg_optional()
    runner.check_m3u_match()

    media_server: ThreadingHTTPServer | None = None
    expect_body: bytes | None
    expect_ct: str | None
    if media_url_env:
        media_url = media_url_env
        expect_body = None  # external: only non-empty + 200
        expect_ct = None
        print(f"==> using MEDIA_URL={media_url}")
    else:
        if args.ts_fixture:
            fixture_body, fixture_ct = TS_FIXTURE_BODY, TS_FIXTURE_CT
        else:
            fixture_body, fixture_ct = DEFAULT_FIXTURE_BODY, DEFAULT_FIXTURE_CT
        media_server, media_url = start_media_fixture(fixture_body, fixture_ct)
        expect_body = fixture_body
        expect_ct = fixture_ct
        print(f"==> local media fixture at {media_url} ({fixture_ct})")

    runner.check_stream_play(
        media_url,
        expect_body=expect_body,
        expect_ct_substr=expect_ct,
        lead_at=False,
    )
    if args.with_at_strip and expect_body is not None:
        runner.check_stream_play(
            media_url,
            expect_body=expect_body,
            expect_ct_substr=expect_ct,
            lead_at=True,
        )

    if media_server is not None:
        media_server.shutdown()

    print()
    if runner.fails:
        eprint(
            f"FAIL: Mode A E2E play-path smoke against {base} ({runner.fails} failed)"
        )
        return 2
    print(f"PASS: Mode A E2E play-path smoke against {base}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
