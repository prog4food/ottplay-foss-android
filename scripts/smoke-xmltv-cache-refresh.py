#!/usr/bin/env python3
"""Mode A companion XMLTV / EPG cache warm-up smoke.

Honest checks against live ottplay-server (or archive/server.py) behavior as
implemented in src-rs — do not invent cache APIs.

What the companion actually does (src-rs):
  - Serves EPG from an in-memory XmltvCache (EPG_CACHE RwLock).
  - Fetches EPG_URLS (default epg.it999.ru) in the background without delaying
    HTTP startup, then waits 2h after each fetch before refreshing again.
  - Optional SQLite persist when DATABASE_URL is set (write-only persist in
    ottplay_core::db; no public HTTP cache-status endpoint).
  - GET /health → "OK"; GET /epg/:hash → always JSON {"epg_data":[...]} (200).
  - archive/server.py also keeps a 2h on-disk .cache/epg_*.json (Python only).

Default path does NOT kill or restart processes. Optional --restart-cmd /
RESTART_CMD runs an operator-supplied restart, then waits for /health. Health
only confirms HTTP readiness; --strict-epg additionally polls the requested
EPG hash for non-empty epg_data within the same restart warm-up timeout.

Sibling scripts: smoke-modea-companion.sh, smoke-m3u-stream-proxy-headers.sh,
smoke-logo-concurrent-bench.sh, smoke-command-queue.sh.

Exit codes:
  0  smoke passed
  1  companion not listening / connection failed
  2  HTTP/JSON assertion failed (or restart warm-up failed)
  3  usage / missing dependency

Default BASE_URL http://127.0.0.1:8443. No secrets.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_BASE = "http://127.0.0.1:8443"
DEFAULT_CONNECT_TIMEOUT = 2.0
DEFAULT_READ_TIMEOUT = 15.0
DEFAULT_WARMUP_TIMEOUT = 180.0
DEFAULT_WARMUP_POLL = 2.0
PROBE_HASH = "xmltv-smoke-probe"


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


def http_get(
    url: str,
    *,
    connect_timeout: float,
    read_timeout: float,
) -> tuple[int, bytes]:
    req = urllib.request.Request(url, method="GET", headers={"Accept": "*/*"})
    timeout = max(connect_timeout, read_timeout)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
            status = int(getattr(resp, "status", None) or resp.getcode())
            return status, body
    except urllib.error.HTTPError as e:
        body = e.read() if e.fp else b""
        return int(e.code), body
    except Exception as exc:  # noqa: BLE001 — map connect failures to exit 1
        not_listening(url, f"{type(exc).__name__}: {exc}")
        raise  # unreachable


def join_url(base: str, path: str) -> str:
    return f"{base.rstrip('/')}{path}"


def epg_path(hash_value: str) -> str:
    h = hash_value.strip()
    if not h.endswith(".json"):
        h = f"{h}.json"
    return f"/epg/{urllib.parse.quote(h, safe='.-_')}"


def check_health(base: str, connect_timeout: float, read_timeout: float) -> None:
    url = join_url(base, "/health")
    print(f"==> GET /health")
    status, body = http_get(url, connect_timeout=connect_timeout, read_timeout=read_timeout)
    text = body.decode("utf-8", errors="replace").strip()
    if status != 200 or text != "OK":
        eprint(f"FAIL: /health expected HTTP 200 body OK, got {status} {text!r}")
        raise SystemExit(2)
    print("  ok: /health → OK")


def check_epg(
    base: str,
    hash_value: str,
    *,
    connect_timeout: float,
    read_timeout: float,
    label: str,
    require_nonempty: bool,
) -> dict[str, Any]:
    path = epg_path(hash_value)
    url = join_url(base, path)
    print(f"==> GET {path} ({label})")
    status, body = http_get(url, connect_timeout=connect_timeout, read_timeout=read_timeout)
    if status != 200:
        eprint(f"FAIL: {path} expected HTTP 200, got {status}")
        raise SystemExit(2)
    try:
        data = json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        eprint(f"FAIL: {path} not JSON: {exc}")
        raise SystemExit(2) from exc
    if not isinstance(data, dict) or "epg_data" not in data:
        eprint(f"FAIL: {path} missing epg_data key: {data!r}")
        raise SystemExit(2)
    epg = data.get("epg_data")
    if not isinstance(epg, list):
        eprint(f"FAIL: {path} epg_data is not a list")
        raise SystemExit(2)
    n = len(epg)
    print(f"  ok: {path} → 200, epg_data len={n}")
    if require_nonempty and n == 0:
        eprint(
            f"FAIL: {path} epg_data empty (hash may be unmatched or cache cold)"
        )
        raise SystemExit(2)
    if n == 0 and hash_value != PROBE_HASH:
        eprint(
            f"WARN: {path} epg_data empty — hash unmatched, cache empty, "
            "or programmes outside ±48h window (not a hard fail)"
        )
    return data


def wait_for_health(
    base: str,
    *,
    connect_timeout: float,
    read_timeout: float,
    timeout: float,
    poll: float,
) -> None:
    url = join_url(base, "/health")
    print(f"==> wait for /health (timeout={timeout:.0f}s, poll={poll:.1f}s)")
    deadline = time.monotonic() + timeout
    last_detail = ""
    while time.monotonic() < deadline:
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(
                req, timeout=min(max(connect_timeout, read_timeout),
                                 max(0.001, deadline - time.monotonic()))
            ) as resp:
                body = resp.read().decode("utf-8", errors="replace").strip()
                status = int(getattr(resp, "status", None) or resp.getcode())
                if status == 200 and body == "OK":
                    print("  ok: companion listening again; EPG may still be loading")
                    return
                last_detail = f"HTTP {status} body={body!r}"
        except Exception as exc:  # noqa: BLE001 — keep polling until timeout
            last_detail = f"{type(exc).__name__}: {exc}"
        time.sleep(min(poll, max(0, deadline - time.monotonic())))
    eprint(
        "FAIL: companion did not return /health OK within warm-up timeout "
        f"({timeout:.0f}s); last={last_detail}"
    )
    eprint(
        "note: /health confirms HTTP readiness, not XMLTV cache readiness"
    )
    raise SystemExit(2)


def wait_for_epg(
    base: str,
    hash_value: str,
    *,
    connect_timeout: float,
    read_timeout: float,
    timeout: float,
    poll: float,
) -> None:
    """Wait for the requested channel, not merely a responsive /epg route."""
    path = epg_path(hash_value)
    url = join_url(base, path)
    print(f"==> wait for non-empty {path} (remaining timeout={max(0, timeout):.1f}s)")
    deadline = time.monotonic() + timeout
    last_detail = "warm-up budget exhausted"
    while time.monotonic() < deadline:
        try:
            req = urllib.request.Request(url, method="GET", headers={"Accept": "application/json"})
            with urllib.request.urlopen(
                req, timeout=min(max(connect_timeout, read_timeout),
                                 max(0.001, deadline - time.monotonic()))
            ) as resp:
                status = int(getattr(resp, "status", None) or resp.getcode())
                data = json.loads(resp.read().decode("utf-8"))
                epg = data.get("epg_data") if isinstance(data, dict) else None
                if status != 200 or not isinstance(epg, list):
                    eprint(f"FAIL: {path} expected HTTP 200 with epg_data list")
                    raise SystemExit(2)
                if epg:
                    print(f"  ok: {path} → 200, epg_data len={len(epg)}")
                    return
                last_detail = "epg_data empty (cache loading, unmatched hash, or no programmes in range)"
        except (ValueError, UnicodeError) as exc:
            eprint(f"FAIL: {path} invalid JSON: {type(exc).__name__}")
            raise SystemExit(2) from exc
        except (OSError, urllib.error.URLError) as exc:
            last_detail = type(exc).__name__
        time.sleep(min(poll, max(0, deadline - time.monotonic())))
    eprint(f"FAIL: {path} did not become non-empty within restart warm-up timeout; last={last_detail}")
    raise SystemExit(2)


def run_restart(cmd: str) -> None:
    print(f"==> restart: {cmd}")
    try:
        proc = subprocess.run(
            cmd,
            shell=True,
            check=False,
            text=True,
            capture_output=True,
        )
    except OSError as exc:
        eprint(f"FAIL: cannot run restart command: {exc}")
        raise SystemExit(2) from exc
    if proc.stdout.strip():
        print(proc.stdout.rstrip())
    if proc.stderr.strip():
        eprint(proc.stderr.rstrip())
    if proc.returncode != 0:
        eprint(f"FAIL: restart command exited {proc.returncode}")
        raise SystemExit(2)
    print("  ok: restart command finished")


def maybe_note_disk_cache(path: str | None) -> None:
    """Optional local peek at archive/server.py .cache (Python companion only)."""
    if not path:
        return
    print(f"==> disk cache peek: {path}")
    p = os.path.expanduser(path)
    if not os.path.isdir(p):
        eprint(f"WARN: disk cache dir not found: {p}")
        return
    metas = sorted(
        f for f in os.listdir(p) if f.startswith("epg_") and f.endswith(".meta")
    )
    datas = sorted(
        f for f in os.listdir(p) if f.startswith("epg_") and f.endswith(".json")
    )
    print(f"  ok: found {len(metas)} meta, {len(datas)} json under {p}")
    if not metas and not datas:
        eprint(
            "WARN: no archive-style epg_*.meta/json — expected only for "
            "archive/server.py working dir .cache/ (Rust uses in-memory + "
            "optional DATABASE_URL SQLite, not this layout)"
        )


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description=(
            "XMLTV/EPG cache warm-up smoke for Mode A companion "
            "(ottplay-server / archive/server.py)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Manual kill+restart (when you cannot pass --restart-cmd safely):
  # macOS local install (KeepAlive — unload/load relaunches + re-fetches EPG)
  launchctl unload ~/Library/LaunchAgents/com.ottplay-foss-local.plist
  launchctl load   ~/Library/LaunchAgents/com.ottplay-foss-local.plist
  # then re-run this smoke (or pass the same as --restart-cmd)

  # cargo/docker: stop the process/container, start again, wait for /health

Automated default does not kill anything — only curls /health and /epg.
""".strip(),
    )
    p.add_argument(
        "--base-url",
        default=os.environ.get("BASE_URL", DEFAULT_BASE),
        help=f"Companion base URL (default {DEFAULT_BASE} or BASE_URL)",
    )
    p.add_argument(
        "--epg-hash",
        default=os.environ.get("EPG_HASH", ""),
        help="Optional channel EPG hash for GET /epg/:hash before/after restart",
    )
    p.add_argument(
        "--strict-epg",
        action="store_true",
        help="Require non-empty epg_data for --epg-hash / EPG_HASH",
    )
    p.add_argument(
        "--restart-cmd",
        default=os.environ.get("RESTART_CMD", ""),
        help="Optional shell command to kill+restart companion (or RESTART_CMD)",
    )
    p.add_argument(
        "--warmup-timeout",
        type=float,
        default=float(os.environ.get("WARMUP_TIMEOUT", DEFAULT_WARMUP_TIMEOUT)),
        help=f"Total seconds to wait for /health and strict EPG after restart (default {DEFAULT_WARMUP_TIMEOUT:.0f})",
    )
    p.add_argument(
        "--warmup-poll",
        type=float,
        default=float(os.environ.get("WARMUP_POLL", DEFAULT_WARMUP_POLL)),
        help=f"Poll interval while waiting for /health and strict EPG (default {DEFAULT_WARMUP_POLL})",
    )
    p.add_argument(
        "--connect-timeout",
        type=float,
        default=float(os.environ.get("CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT)),
        help=f"Connect timeout seconds (default {DEFAULT_CONNECT_TIMEOUT})",
    )
    p.add_argument(
        "--read-timeout",
        type=float,
        default=float(os.environ.get("READ_TIMEOUT", DEFAULT_READ_TIMEOUT)),
        help=f"Read timeout seconds (default {DEFAULT_READ_TIMEOUT})",
    )
    p.add_argument(
        "--check-disk-cache",
        default=os.environ.get("XMLTV_DISK_CACHE", ""),
        metavar="DIR",
        help=(
            "Optional local archive/server.py .cache dir peek "
            "(epg_*.meta / epg_*.json); skip for remote companions"
        ),
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    base = args.base_url.rstrip("/")
    if shutil.which("curl") is None:
        # urllib is enough; curl presence is optional sibling convention
        pass

    print(f"XMLTV cache smoke against {base}")
    print(
        "cache model: in-memory EPG_CACHE + 2h background refresh; "
        "optional SQLite if DATABASE_URL set; no public cache-status HTTP API"
    )

    # 1) Listening / warm process
    check_health(base, args.connect_timeout, args.read_timeout)

    # 2) /epg route consistency (always 200 + epg_data for unknown hash)
    check_epg(
        base,
        PROBE_HASH,
        connect_timeout=args.connect_timeout,
        read_timeout=args.read_timeout,
        label="probe hash",
        require_nonempty=False,
    )

    # 3) Optional real hash (before restart)
    epg_hash = (args.epg_hash or "").strip()
    if epg_hash:
        check_epg(
            base,
            epg_hash,
            connect_timeout=args.connect_timeout,
            read_timeout=args.read_timeout,
            label="before restart",
            require_nonempty=args.strict_epg,
        )
    else:
        print("==> EPG_HASH not set — skipping real-hash /epg check")

    # 4) Optional disk cache peek (archive/server.py only; local machine)
    maybe_note_disk_cache(args.check_disk_cache.strip() or None)

    # 5) Optional restart + warm-up re-verify
    restart_cmd = (args.restart_cmd or "").strip()
    if restart_cmd:
        run_restart(restart_cmd)
        warmup_deadline = time.monotonic() + args.warmup_timeout
        wait_for_health(
            base,
            connect_timeout=args.connect_timeout,
            read_timeout=args.read_timeout,
            timeout=args.warmup_timeout,
            poll=args.warmup_poll,
        )
        if epg_hash and args.strict_epg:
            wait_for_epg(
                base,
                epg_hash,
                connect_timeout=args.connect_timeout,
                read_timeout=args.read_timeout,
                timeout=warmup_deadline - time.monotonic(),
                poll=args.warmup_poll,
            )
        check_epg(
            base,
            PROBE_HASH,
            connect_timeout=args.connect_timeout,
            read_timeout=args.read_timeout,
            label="after restart (probe)",
            require_nonempty=False,
        )
        if epg_hash and not args.strict_epg:
            check_epg(
                base,
                epg_hash,
                connect_timeout=args.connect_timeout,
                read_timeout=args.read_timeout,
                label="after restart",
                require_nonempty=args.strict_epg,
            )
    else:
        print(
            "==> no --restart-cmd / RESTART_CMD — skipping kill+restart; "
            "see --help for manual launchctl unload/load steps"
        )

    print("PASS: XMLTV cache smoke")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
