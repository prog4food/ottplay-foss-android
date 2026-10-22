#!/usr/bin/env bash
# Alias: compile Tauri, install to /Applications, and launch (same as ./build-local.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$ROOT/build-local.sh" "$@"
