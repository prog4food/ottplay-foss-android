#!/usr/bin/env bash
# Thin wrapper to update-local-stack.sh (kept for old muscle memory).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/update-local-stack.sh" "$@"
