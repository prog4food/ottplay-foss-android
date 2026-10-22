#!/usr/bin/env bash
# PUBLIC ENTRY POINT - install the local macOS stack (idempotent).
#   1. pull live hls-proxy config from Synology docker
#   2. install hls-proxy launchd agent (:8090)
#   3. install the single player process (~/ottplay-foss-local, HTTP :8443-8446)
#      - one port per browser origin for isolated player settings
#      - ports configurable through OTTPLAY_HTTP_PORTS; no listener on :8095
#      - sync code, build the player and binary, replace the launchd agent
# Every step is idempotent and safe to run over a live stack.
#
# Usage: scripts/install-local-stack.sh
# Env: SKIP_SYNC=1 (skip step 1), SYNC_ONLY=1 (only refresh config)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${SYNC_ONLY:-0}" = "1" ]; then
    exec "$SCRIPT_DIR/sync-hls-proxy-config.sh"
fi

[ "${SKIP_SYNC:-0}" = "1" ] || "$SCRIPT_DIR/sync-hls-proxy-config.sh"

"$SCRIPT_DIR/install-hls-proxy-service.sh"
"$SCRIPT_DIR/install-ottplay-local-service.sh"

echo
echo "=== local stack installed ==="
echo "hls-proxy :8090 | player HTTP :${OTTPLAY_HTTP_PORTS:-8443 8444 8445 8446}"
