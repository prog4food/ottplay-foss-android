#!/usr/bin/env bash
# Mode A companion XMLTV / EPG cache warm-up smoke.
# See scripts/smoke-xmltv-cache-refresh.py for defaults / --restart-cmd.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONUNBUFFERED=1
exec python3 "$ROOT/scripts/smoke-xmltv-cache-refresh.py" "$@"
