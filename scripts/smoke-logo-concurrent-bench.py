#!/usr/bin/env python3
"""Mode A companion concurrent GET /logo/<id>.svg latency bench (smoke).

Hits ottplay-server / archive/server.py logo SVG endpoint under load and
reports OK/fail counts plus latency percentiles (p50/p95/p99).

Default is a practical CI-local smoke (200 concurrent × TOTAL, TOTAL=1000).
Full 10k soak is optional: --full / LOGO_BENCH_FULL=1 / TOTAL=10000.

Sibling scripts: smoke-modea-companion.sh, smoke-m3u-stream-proxy-headers.sh,
smoke-command-queue.sh.

Exit codes:
  0  bench passed (error rate under threshold)
  1  companion not listening / connection failed on probe
  2  high error rate / HTTP assertion failed
  3  usage / missing dependency

Default BASE_URL http://127.0.0.1:8443 (same as Mode A companion smoke /
install-ottplay-local-service.sh). No secrets.
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Sequence

DEFAULT_BASE = "http://127.0.0.1:8443"
DEFAULT_CONCURRENCY = 200
DEFAULT_TOTAL = 1000
FULL_TOTAL = 10000
DEFAULT_ID = "bench"
DEFAULT_CH = "Bench"
DEFAULT_MAX_ERROR_RATE = 0.01  # 1%
DEFAULT_CONNECT_TIMEOUT = 2.0
DEFAULT_READ_TIMEOUT = 15.0


@dataclass(frozen=True)
class Sample:
    ok: bool
    status: int | None
    latency_ms: float
    error: str = ""


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


def logo_url(base: str, logo_id: str, ch: str | None, index: int) -> str:
    # Vary id slightly so caches do not collapse every request to one object.
    sid = f"{logo_id}-{index}" if index >= 0 else logo_id
    path = f"/logo/{urllib.parse.quote(sid, safe='')}.svg"
    if ch:
        path += f"?ch={urllib.parse.quote(ch, safe='')}"
    return f"{base.rstrip('/')}{path}"


def fetch_one(
    url: str,
    *,
    connect_timeout: float,
    read_timeout: float,
) -> Sample:
    t0 = time.perf_counter()
    try:
        req = urllib.request.Request(url, method="GET", headers={"Accept": "image/svg+xml,*/*"})
        # urllib timeout is a single overall socket timeout (connect+read).
        with urllib.request.urlopen(
            req, timeout=max(connect_timeout, read_timeout)
        ) as resp:
            body = resp.read()
            status = getattr(resp, "status", None) or resp.getcode()
            elapsed = (time.perf_counter() - t0) * 1000.0
            if status != 200:
                return Sample(False, int(status), elapsed, f"HTTP {status}")
            # Cheap SVG sanity (matches modea-smoke-checks body_contains_ci).
            if b"<svg" not in body.lower():
                return Sample(False, int(status), elapsed, "body missing <svg")
            return Sample(True, int(status), elapsed)
    except urllib.error.HTTPError as e:
        elapsed = (time.perf_counter() - t0) * 1000.0
        return Sample(False, int(e.code), elapsed, f"HTTP {e.code}")
    except Exception as e:  # noqa: BLE001 — bench aggregates all failure modes
        elapsed = (time.perf_counter() - t0) * 1000.0
        return Sample(False, None, elapsed, f"{type(e).__name__}: {e}")


def percentile(sorted_vals: Sequence[float], p: float) -> float:
    if not sorted_vals:
        return float("nan")
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    # Nearest-rank (inclusive), p in [0, 100].
    k = max(1, min(len(sorted_vals), int(round(p / 100.0 * len(sorted_vals)))))
    return sorted_vals[k - 1]


def probe(base: str, logo_id: str, ch: str | None, connect_timeout: float) -> None:
    url = logo_url(base, logo_id, ch, index=-1)
    print(f"==> probe GET {url}")
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=connect_timeout) as resp:
            body = resp.read(256)
            status = getattr(resp, "status", None) or resp.getcode()
    except urllib.error.URLError as e:
        not_listening(url, str(e.reason if getattr(e, "reason", None) else e))
    except TimeoutError as e:
        not_listening(url, str(e))
    except OSError as e:
        not_listening(url, str(e))
    if status != 200:
        print(f"error: probe expected HTTP 200, got {status}", file=sys.stderr)
        raise SystemExit(2)
    if b"<svg" not in body.lower():
        print("error: probe body missing <svg", file=sys.stderr)
        raise SystemExit(2)
    print(f"    listening (HTTP {status}, {len(body)}+ bytes)")
    print()


def run_bench(
    *,
    base: str,
    logo_id: str,
    ch: str | None,
    total: int,
    concurrency: int,
    connect_timeout: float,
    read_timeout: float,
    max_error_rate: float,
) -> int:
    print("Mode A /logo concurrent bench")
    print(f"  BASE_URL={base}")
    print(f"  path=/logo/<id>.svg" + (f"?ch={ch}" if ch else ""))
    print(f"  TOTAL={total}  CONCURRENCY={concurrency}")
    print(f"  max_error_rate={max_error_rate:.2%}")
    print()

    probe(base, logo_id, ch, connect_timeout)

    urls = [logo_url(base, logo_id, ch, i) for i in range(total)]
    samples: list[Sample] = []
    workers = max(1, min(concurrency, total))

    print(f"==> firing {total} GETs with {workers} workers…")
    t_wall0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [
            pool.submit(
                fetch_one,
                u,
                connect_timeout=connect_timeout,
                read_timeout=read_timeout,
            )
            for u in urls
        ]
        for fut in as_completed(futs):
            samples.append(fut.result())
    wall_s = time.perf_counter() - t_wall0

    ok_n = sum(1 for s in samples if s.ok)
    fail_n = total - ok_n
    # Connection-class failures (no HTTP status) — treat like not listening if all fail.
    conn_fails = [s for s in samples if s.status is None]
    lat_ok = sorted(s.latency_ms for s in samples if s.ok)
    lat_all = sorted(s.latency_ms for s in samples)

    def fmt_pct(vals: Sequence[float], p: float) -> str:
        if not vals:
            return "n/a"
        return f"{percentile(vals, p):.2f} ms"

    rps = total / wall_s if wall_s > 0 else float("inf")
    err_rate = fail_n / total if total else 0.0

    print()
    print("Results")
    print(f"  ok={ok_n}  fail={fail_n}  error_rate={err_rate:.2%}")
    print(f"  wall={wall_s:.3f}s  throughput≈{rps:.1f} req/s")
    print("  latency (OK requests):")
    print(f"    p50={fmt_pct(lat_ok, 50)}  p95={fmt_pct(lat_ok, 95)}  p99={fmt_pct(lat_ok, 99)}")
    if lat_ok:
        print(
            f"    min={lat_ok[0]:.2f} ms  max={lat_ok[-1]:.2f} ms  "
            f"mean={statistics.fmean(lat_ok):.2f} ms"
        )
    print("  latency (all requests):")
    print(f"    p50={fmt_pct(lat_all, 50)}  p95={fmt_pct(lat_all, 95)}  p99={fmt_pct(lat_all, 99)}")

    if fail_n:
        # Show a few distinct error samples.
        seen: set[str] = set()
        print("  sample errors:", file=sys.stderr)
        for s in samples:
            if s.ok:
                continue
            key = s.error or f"HTTP {s.status}"
            if key in seen:
                continue
            seen.add(key)
            print(f"    - {key}", file=sys.stderr)
            if len(seen) >= 5:
                break

    if fail_n == total and conn_fails:
        # Entire run failed to connect — companion likely died mid-bench.
        not_listening(base, conn_fails[0].error or "all requests failed to connect")

    if err_rate > max_error_rate:
        print(
            f"FAIL: error rate {err_rate:.2%} exceeds max {max_error_rate:.2%}",
            file=sys.stderr,
        )
        return 2

    print(f"PASS: /logo concurrent bench against {base}")
    return 0


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return int(raw)


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    return float(raw)


def main(argv: list[str] | None = None) -> int:
    env_full = os.environ.get("LOGO_BENCH_FULL", "").strip() in ("1", "true", "yes")
    parser = argparse.ArgumentParser(
        description=(
            "Concurrent GET /logo/<id>.svg latency bench for Mode A companion. "
            "Default TOTAL=1000 @ CONCURRENCY=200; use --full for 10000 soak."
        )
    )
    parser.add_argument(
        "--base-url",
        default=os.environ.get("BASE_URL", DEFAULT_BASE),
        help=f"Companion base URL (default {DEFAULT_BASE} or BASE_URL)",
    )
    parser.add_argument(
        "--id",
        default=os.environ.get("LOGO_ID", DEFAULT_ID),
        help=f"Logo id stem (default {DEFAULT_ID} or LOGO_ID); requests use <id>-N",
    )
    parser.add_argument(
        "--ch",
        default=os.environ.get("LOGO_CH", DEFAULT_CH),
        help=f"Optional ?ch= channel name (default {DEFAULT_CH!r}; empty to omit)",
    )
    parser.add_argument(
        "--total",
        type=int,
        default=None,
        help=f"Total requests (default {DEFAULT_TOTAL}, or TOTAL env; --full → {FULL_TOTAL})",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=None,
        help=f"In-flight workers (default {DEFAULT_CONCURRENCY} or CONCURRENCY)",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        default=env_full,
        help=f"Optional soak: TOTAL={FULL_TOTAL} (or set LOGO_BENCH_FULL=1)",
    )
    parser.add_argument(
        "--max-error-rate",
        type=float,
        default=env_float("MAX_ERROR_RATE", DEFAULT_MAX_ERROR_RATE),
        help=f"Fail if fail/total exceeds this (default {DEFAULT_MAX_ERROR_RATE})",
    )
    parser.add_argument(
        "--connect-timeout",
        type=float,
        default=env_float("CONNECT_TIMEOUT", DEFAULT_CONNECT_TIMEOUT),
        help=f"Connect timeout seconds (default {DEFAULT_CONNECT_TIMEOUT})",
    )
    parser.add_argument(
        "--read-timeout",
        type=float,
        default=env_float("READ_TIMEOUT", DEFAULT_READ_TIMEOUT),
        help=f"Read timeout seconds (default {DEFAULT_READ_TIMEOUT})",
    )
    args = parser.parse_args(argv)

    ch = args.ch
    if ch == "":
        ch = None

    if args.full:
        total = args.total if args.total is not None else env_int("TOTAL", FULL_TOTAL)
    else:
        total = args.total if args.total is not None else env_int("TOTAL", DEFAULT_TOTAL)

    concurrency = (
        args.concurrency
        if args.concurrency is not None
        else env_int("CONCURRENCY", DEFAULT_CONCURRENCY)
    )

    if total < 1:
        print("error: --total must be >= 1", file=sys.stderr)
        return 3
    if concurrency < 1:
        print("error: --concurrency must be >= 1", file=sys.stderr)
        return 3
    if not (0.0 <= args.max_error_rate <= 1.0):
        print("error: --max-error-rate must be in [0,1]", file=sys.stderr)
        return 3

    return run_bench(
        base=args.base_url,
        logo_id=args.id,
        ch=ch,
        total=total,
        concurrency=concurrency,
        connect_timeout=args.connect_timeout,
        read_timeout=args.read_timeout,
        max_error_rate=args.max_error_rate,
    )


if __name__ == "__main__":
    raise SystemExit(main())
