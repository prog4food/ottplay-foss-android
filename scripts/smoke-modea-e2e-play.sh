#!/usr/bin/env bash
# Mode A companion E2E play-path smoke (HTTP / stream readiness — not headed UI).
# See scripts/smoke-modea-e2e-play.py for checks / MEDIA_URL notes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONUNBUFFERED=1
exec python3 "$ROOT/scripts/smoke-modea-e2e-play.py" "$@"
