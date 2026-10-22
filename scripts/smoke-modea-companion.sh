#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONUNBUFFERED=1
export MODEA_SMOKE_CHECKS="${MODEA_SMOKE_CHECKS:-$ROOT/scripts/modea-smoke-checks.json}"
exec python3 "$ROOT/scripts/smoke-modea-companion.py" "$@"
