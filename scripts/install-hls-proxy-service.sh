#!/usr/bin/env bash
# Install hls-proxy as a macOS launchd user agent (~/Library/LaunchAgents).
# Starts at login, restarts on crash (KeepAlive). Loopback-only access.
#
# Usage: scripts/install-hls-proxy-service.sh
# Env overrides: HLS_PROXY_DIR, HLS_PROXY_LABEL
set -euo pipefail

DEST="${HLS_PROXY_DIR:-$HOME/hls-proxy}"
LABEL="${HLS_PROXY_LABEL:-com.hls-proxy}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -x "$DEST/hls-proxy" ] || { echo "error: $DEST/hls-proxy not found" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hls-proxy-lib.sh
source "$SCRIPT_DIR/hls-proxy-lib.sh"

# Binary downloaded from the net: drop quarantine + ad-hoc sign (arm64 kills unsigned).
xattr -d com.apple.quarantine "$DEST/hls-proxy" 2>/dev/null || true
codesign -s - --force "$DEST/hls-proxy" 1>&2

# Ensure loopback-only config (idempotent; run sync script first to refresh from docker).
hls_proxy_apply_loopback "$DEST/local.json"
PORT="$(python3 -c "import json,sys; print(json.load(open('$DEST/local.json'))['SERVER']['port'])")"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$DEST/hls-proxy</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$DEST/</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$HOME/Library/Logs/hls-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>$HOME/Library/Logs/hls-proxy.log</string>
</dict>
</plist>
EOF

# Stop any manually started instance holding the port.
# shellcheck disable=SC2046  # pids are numeric, splitting is safe
kill $(lsof -t -iTCP:"$PORT" -sTCP:LISTEN) 2>/dev/null || true
sleep 1

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

sleep 3
# launchctl list prints: \t"PID" = 2888;   (leading whitespace collapses $1)
PID="$(launchctl list "$LABEL" 2>/dev/null | awk -F'[ =;]+' '/"PID"/{print $2}')"
if [ -n "$PID" ] && curl -s -o /dev/null -w '' -m 5 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    echo "installed: $PLIST (label $LABEL, pid $PID, port $PORT)"
    echo "loopback OK: http://127.0.0.1:$PORT/   LAN requests get 403 (whitelist)"
    echo "log: ~/Library/Logs/hls-proxy.log"
else
    echo "warning: service loaded but not responding yet — check ~/Library/Logs/hls-proxy.log" >&2
    launchctl list "$LABEL" 2>/dev/null || true
    exit 1
fi
