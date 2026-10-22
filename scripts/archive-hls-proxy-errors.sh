#!/usr/bin/env bash
# Slice ERROR/WARN lines from hls-proxy.log into a permanent daily archive.
# Streams with rg (does not load the full log into memory).
#
# Usage: scripts/archive-hls-proxy-errors.sh
# Env: HLS_PROXY_LOG, HLS_PROXY_ERROR_ARCHIVE
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The installer also copies this script to the selected archive's bin directory.
if [ "$(basename "$SCRIPT_DIR")" = "bin" ]; then
  DEFAULT_ARCHIVE="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  DEFAULT_ARCHIVE="$(cd "$SCRIPT_DIR/.." && pwd)/.local-artifacts/debug-archive"
fi
LOG="${HLS_PROXY_LOG:-$HOME/Library/Logs/hls-proxy.log}"
ARCHIVE="${HLS_PROXY_ERROR_ARCHIVE:-$DEFAULT_ARCHIVE}"

# Prefer absolute rg so launchd (minimal PATH) still works.
if [ -x /opt/homebrew/bin/rg ]; then
  RG=/opt/homebrew/bin/rg
elif [ -x /usr/local/bin/rg ]; then
  RG=/usr/local/bin/rg
elif command -v rg >/dev/null 2>&1; then
  RG="$(command -v rg)"
else
  echo "error: rg (ripgrep) not found" >&2
  exit 1
fi

mkdir -p "$ARCHIVE"

if [ ! -f "$LOG" ]; then
  echo "warning: log missing: $LOG — nothing to archive" >&2
  exit 0
fi

# UTC today and yesterday (macOS date -v, GNU date -d fallback).
TODAY_UTC="$(date -u +%Y-%m-%d)"
if YESTERDAY_UTC="$(date -u -v-1d +%Y-%m-%d 2>/dev/null)"; then
  :
else
  YESTERDAY_UTC="$(date -u -d 'yesterday' +%Y-%m-%d)"
fi

for D in "$YESTERDAY_UTC" "$TODAY_UTC"; do
  OUT="$ARCHIVE/hls-proxy-$D-errors.log"
  # -N: no line numbers; stream match only (empty file OK / overwrite = idempotent).
  "$RG" -N --no-heading '^\['"$D"'T.*(ERROR|WARN)' "$LOG" > "$OUT" || true
  COUNT="$(wc -l < "$OUT" | tr -d ' ')"
  echo "archived $COUNT ERROR/WARN lines → $OUT"
done
