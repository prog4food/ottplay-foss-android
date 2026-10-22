#!/usr/bin/env bash
# Thin wrapper to install-local-stack.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$SCRIPT_DIR/install-local-stack.sh" "$@"
