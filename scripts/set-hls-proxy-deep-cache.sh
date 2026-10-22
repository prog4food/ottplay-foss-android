#!/usr/bin/env bash
# Switch local hls-proxy caching between "deep" (mobile/cellular) and default.
#
# Why: in a moving car the phone hops cells / changes IP constantly; players
# go silent or stutter because the proxied window is shallow and any hiccup
# kills the fetch. Deep mode widens the buffered window and makes the proxy
# tolerant of stalls instead of aborting the stream.
#
# Usage: scripts/set-hls-proxy-deep-cache.sh [on|off|status]   (default: on)
# Env overrides: HLS_PROXY_DIR, HLS_PROXY_LABEL
set -euo pipefail

DEST="${HLS_PROXY_DIR:-$HOME/hls-proxy}"
LABEL="${HLS_PROXY_LABEL:-com.hls-proxy}"
CONF="$DEST/local.json"
MODE="${1:-on}"

# Keys absent from local.json mean "use built-in default" -> off just deletes them.
DEEP='{
  "chunksToCache": 30,
  "chunksForClient": 24,
  "fastStartChunks": 4,
  "streamTimeout": 300000,
  "httpResponseStallTimeout": 15000,
  "increaseStallTimeoutInCaseOfFailureMultiplier": 0.5,
  "getTsChunkRetries": 5,
  "getPlaylistRetries": 5,
  "delayBeforeRetryIfFailed": 1000,
  "brokenSequenceBehavior": "repeat",
  "minDownloadSpeed": 4000,
  "speedCheckMultiplier": 0.1,
  "maxDownloadSlotsAvailable": 6,
  "fetchIntervalMultiplier": 1.2
}'

[ -f "$CONF" ] || { echo "error: $CONF not found (run sync-hls-proxy-config.sh first)" >&2; exit 1; }

apply() {
    cp -p "$CONF" "$CONF.bak"
    python3 - "$CONF" "$MODE" "$DEEP" <<'EOF'
import json, sys
p, mode, deep = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
d = json.load(open(p))
if mode == "on":
    d.update(deep)                       # deep overrides win over synced values
else:                                    # off
    for k in deep:                       # delete -> back to built-in defaults
        d.pop(k, None)
json.dump(d, open(p, "w"), indent=4, ensure_ascii=False)
EOF
}

status() {
    python3 - "$CONF" "$DEEP" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
deep = json.loads(sys.argv[2])
for k, v in deep.items():
    cur = d.get(k, f"<default>")
    mark = "deep" if d.get(k) == v else "std "
    print(f"{mark}  {k} = {cur}")
EOF
}

case "$MODE" in
    on|off)
        apply
        echo "deep cache $MODE: $CONF (backup: $CONF.bak)"
        ;;
    status)
        status
        exit 0
        ;;
    *)
        echo "usage: $0 [on|off|status]" >&2
        exit 1
        ;;
esac

# Config is read at startup -> bounce the launchd agent if installed.
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="$(python3 -c "import json; print(json.load(open('$CONF'))['SERVER']['port'])")"
if [ -f "$PLIST" ]; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
    sleep 2
    if curl -s -o /dev/null -m 5 "http://127.0.0.1:$PORT/"; then
        echo "restarted: $LABEL responding on http://127.0.0.1:$PORT/"
    else
        echo "warning: $LABEL not responding yet — check ~/Library/Logs/hls-proxy.log" >&2
        exit 1
    fi
else
    echo "service not installed — restart manually: cd $DEST && ./hls-proxy"
fi
