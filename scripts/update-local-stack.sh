#!/usr/bin/env bash
# PUBLIC ENTRY POINT - update the local macOS stack.
#
# Rebuilds JS + Rust via install-ottplay-local-service.sh, reloads the local
# launchd agents, and verifies all four HTTP origins (:8443-8446).
#
# Usage: scripts/update-local-stack.sh
# Env: OTTPLAY_*, SKIP_HLS_RELOAD=1 (same as install-ottplay-local-service)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HLS_LABEL="${HLS_PROXY_LABEL:-com.hls-proxy}"
HLS_PLIST="$HOME/Library/LaunchAgents/$HLS_LABEL.plist"
DEST="${OTTPLAY_DEST:-$HOME/ottplay-foss-local}"

if [ ! -d "$DEST" ]; then
    echo "error: DEST missing; run install-local-stack first" >&2
    exit 1
fi

echo "[update] rebuild player and reload ottplay agent"
"$SCRIPT_DIR/install-ottplay-local-service.sh"

if [ "${SKIP_HLS_RELOAD:-0}" != "1" ] && [ -f "$HLS_PLIST" ]; then
    echo "[update] reload hls-proxy agent"
    launchctl unload "$HLS_PLIST" 2>/dev/null || true
    launchctl load "$HLS_PLIST"
    echo "  reloaded $HLS_LABEL"
fi

if [ -f "$HLS_PLIST" ]; then
    if curl --noproxy '*' -s -o /dev/null -m 3 "http://127.0.0.1:8090/" 2>/dev/null; then
        echo "hls-proxy :8090 ok"
    else
        echo "warning: hls-proxy :8090 not responding" >&2
    fi
fi
echo "=== local stack updated ==="
