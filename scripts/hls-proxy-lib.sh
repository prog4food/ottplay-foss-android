#!/usr/bin/env bash
# Shared helper for hls-proxy local scripts: loopback-only config patch.
# Sourced by sync-hls-proxy-config.sh and install-hls-proxy-service.sh.
#
# hls-proxy "SERVER.address" is NOT a bind address (socket stays on *:PORT);
# access control is done via SERVER.whitelist. Loopback-only = whitelist
# 127.0.0.1/32 (+ ::1 when the key already exists). Idempotent.
hls_proxy_apply_loopback() {
    local conf="$1"
    python3 - "$conf" <<'EOF'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
srv = d.setdefault("SERVER", {})
srv["address"] = "127.0.0.1"          # advertise/ACL hint, docs: "localhost only"
srv["whitelist"] = "127.0.0.1/32"     # hard source-IP restriction
json.dump(d, open(p, "w"), indent=4, ensure_ascii=False)
EOF
}
