#!/usr/bin/env bash
# Mode A companion concurrent GET /logo/<id>.svg latency bench (smoke).
# See scripts/smoke-logo-concurrent-bench.py for defaults / --full soak.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONUNBUFFERED=1
exec python3 "$ROOT/scripts/smoke-logo-concurrent-bench.py" "$@"
