#!/usr/bin/env bash
# Mode A companion POST /m3u/cp.php upstream header parity smoke.
# See scripts/smoke-m3u-stream-proxy-headers.py for UA/Referer contract notes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONUNBUFFERED=1
exec python3 "$ROOT/scripts/smoke-m3u-stream-proxy-headers.py" "$@"
