#!/usr/bin/env bash
# Remove the hls-proxy launchd user agent and stop the service.
# Config/binary in ~/hls-proxy are left untouched.
#
# Usage: scripts/uninstall-hls-proxy-service.sh
# Env overrides: HLS_PROXY_LABEL
set -euo pipefail

LABEL="${HLS_PROXY_LABEL:-com.hls-proxy}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm -f "$PLIST"
    echo "removed: $PLIST"
else
    echo "not installed: $PLIST not found"
fi

pkill -f "$HOME/hls-proxy/hls-proxy" 2>/dev/null && echo "stopped leftover process" || true
echo "done (~/hls-proxy kept; reinstall with install-hls-proxy-service.sh)"
