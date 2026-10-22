#!/usr/bin/env bash
# Install nightly LaunchAgent that archives hls-proxy ERROR/WARN lines.
# Copies the archive script into the repo's .local-artifacts/debug-archive/bin/.
# The agent receives its selected archive path explicitly, including overrides.
# Runs daily at 07:00 local (including weekends — car trips).
#
# Usage: scripts/install-hls-proxy-error-archive-service.sh
# Env: HLS_PROXY_ERROR_ARCHIVE, HLS_PROXY_ERROR_ARCHIVE_LABEL
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$SCRIPT_DIR/archive-hls-proxy-errors.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARCHIVE_ROOT="${HLS_PROXY_ERROR_ARCHIVE:-$REPO_ROOT/.local-artifacts/debug-archive}"
case "$ARCHIVE_ROOT" in
  /*) ;;
  *) ARCHIVE_ROOT="$PWD/$ARCHIVE_ROOT" ;;
esac
BIN_DIR="$ARCHIVE_ROOT/bin"
INSTALLED="$BIN_DIR/archive-hls-proxy-errors.sh"
LABEL="${HLS_PROXY_ERROR_ARCHIVE_LABEL:-com.ottplay.hls-proxy-error-archive}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
AGENT_LOG="$HOME/Library/Logs/com.ottplay.hls-proxy-error-archive.log"

[ -f "$SRC" ] || { echo "error: missing $SRC" >&2; exit 1; }

mkdir -p "$BIN_DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$ARCHIVE_ROOT"
cp "$SRC" "$INSTALLED"
chmod +x "$INSTALLED"

xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'
}
ARCHIVE_ROOT_XML="$(xml_escape "$ARCHIVE_ROOT")"
INSTALLED_XML="$(xml_escape "$INSTALLED")"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$INSTALLED_XML</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HLS_PROXY_ERROR_ARCHIVE</key>
        <string>$ARCHIVE_ROOT_XML</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>7</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$AGENT_LOG</string>
    <key>StandardErrorPath</key>
    <string>$AGENT_LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  :
else
  launchctl load "$PLIST"
fi

echo "installed: $PLIST"
echo "label: $LABEL"
echo "script: $INSTALLED"
echo "runs daily at 07:00 local → $ARCHIVE_ROOT/hls-proxy-YYYY-MM-DD-errors.log"
echo "agent log: $AGENT_LOG"
