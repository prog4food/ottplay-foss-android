#!/usr/bin/env bash
# Pull live hls-proxy config from the Synology docker container to local Mac.
#
# Container zloi78-hls-proxy-1 keeps its config at /opt/hlsp INSIDE the image
# layer (no bind mount): local.json is the live config, default.json/groups.json
# and plugins/ ship with it. This script copies those to ~/hls-proxy so the
# local arm64 binary runs with the same configuration as the container.
#
# Usage: scripts/sync-hls-proxy-config.sh
# Env overrides: HLS_PROXY_HOST, HLS_PROXY_CONTAINER, HLS_PROXY_DIR
set -euo pipefail

HOST="${HLS_PROXY_HOST:-synology}"
CONTAINER="${HLS_PROXY_CONTAINER:-zloi78-hls-proxy-1}"
DEST="${HLS_PROXY_DIR:-$HOME/hls-proxy}"
SRC=/opt/hlsp

if [ ! -x "$DEST/hls-proxy" ]; then
    echo "error: $DEST/hls-proxy not found (local hls-proxy checkout expected)" >&2
    exit 1
fi

tmp=$(mktemp -d "$DEST/.sync-tmp.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

# Single tar stream over ssh; sudo -n works for this user on the Synology.
# Full docker path: sudo resets PATH on Synology (SC2029 expansion is intentional).
ssh "$HOST" "sudo -n /usr/local/bin/docker exec $CONTAINER tar cf - -C $SRC local.json groups.json default.json plugins" \
    | tar xf - -C "$tmp"

for f in local.json groups.json default.json; do
    [ -f "$DEST/$f" ] && cp -p "$DEST/$f" "$DEST/$f.bak"
    mv "$tmp/$f" "$DEST/$f"
done

if [ -d "$DEST/plugins" ]; then
    rm -rf "$DEST/plugins.bak"
    mv "$DEST/plugins" "$DEST/plugins.bak"
fi
mv "$tmp/plugins" "$DEST/plugins"

# Docker config serves the LAN (address 0.0.0.0). For local use re-apply the
# loopback-only patch on top; LOCAL_ONLY=0 keeps the docker values untouched.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hls-proxy-lib.sh
source "$SCRIPT_DIR/hls-proxy-lib.sh"
if [ "${LOCAL_ONLY:-1}" = "1" ]; then
    hls_proxy_apply_loopback "$DEST/local.json"
    # Pin local port: docker container maps 8080->9999; on macOS we use 8090 to
    # avoid colliding with the player HTTP origins on 8443-8446. Set
    # HLS_PROXY_LOCAL_PORT=0 to inherit from the docker config instead.
    LOCAL_PORT="${HLS_PROXY_LOCAL_PORT:-8090}"
    if [ "$LOCAL_PORT" != "0" ]; then
        python3 - "$DEST/local.json" "$LOCAL_PORT" <<'EOF'
import json, sys
p, port = sys.argv[1], int(sys.argv[2])
d = json.load(open(p))
d.setdefault("SERVER", {})["port"] = port
json.dump(d, open(p, "w"), indent=4, ensure_ascii=False)
EOF
        echo "local port pinned: $LOCAL_PORT (HLS_PROXY_LOCAL_PORT=0 to inherit)"
    fi
    echo "loopback-only patch applied (LOCAL_ONLY=0 to skip)"
fi

echo "synced: $HOST:$CONTAINER:$SRC -> $DEST"
echo "previous versions saved as *.bak / plugins.bak"
echo "run locally: cd $DEST && ./hls-proxy   # port 8090 per local.json (container maps 8080->9999)"
