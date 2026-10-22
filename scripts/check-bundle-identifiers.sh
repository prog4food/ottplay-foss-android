#!/usr/bin/env bash
# Validate the classic ES5 declarations and publications used by plugins/boot.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="${1:-${ROOT}/dist/player.js}"

if [[ ! -f "$BUNDLE" ]]; then
  echo "error: missing built bundle — run the Vite build first" >&2
  exit 1
fi

exec node "${ROOT}/scripts/check-bundle-identifiers.cjs" "$BUNDLE"
