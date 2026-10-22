#!/usr/bin/env bash
# Player half of the local macOS stack (called by install-local-stack.sh).
# Syncs repo to ~/ottplay-foss-local, builds player + Rust binary, and installs
# one LAN-accessible launchd agent with four independent HTTP browser origins.
#
# Prefer: scripts/install-local-stack.sh
# Usage: scripts/install-ottplay-local-service.sh
# Env overrides: OTTPLAY_SRC, OTTPLAY_DEST, OTTPLAY_HTTP_PORTS
#                (default "8443 8444 8445 8446"), OTTPLAY_LABEL,
#                OTTPLAY_RUST_SRC (default source repo), OTTPLAY_DEBUG_ARCHIVE.
# HTTP allows legacy portals and media that do not support HTTPS. Each port
# remains a separate browser origin with independent player settings.
# Existing certificates and keychain trust are left untouched.
# Binds all IPv4 interfaces (--host 0.0.0.0), including loopback and LAN.
# Package downloads bypass inherited proxies and package-manager proxy settings.
#
# Optional remote text entry (swop) — do NOT commit private Worker hostnames:
#   export SWOP_BASE_URL=https://your-worker.example
#   export SWOP_INSTALLATION_TOKEN=... # server-only installation credential
# Register this installation and its exact LAN/localhost origins on the Worker.
# Re-running preserves the credential in the mode-0600 launchd plist; browsers
# receive only {"swopBaseUrl":"/swop"}, never a server credential or shared ID.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${OTTPLAY_SRC:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SRC="$(cd "$SRC" && pwd)"
DEBUG_ARCHIVE="${OTTPLAY_DEBUG_ARCHIVE:-$SRC/.local-artifacts/debug-archive}"
case "$DEBUG_ARCHIVE" in
    /*) ;;
    *) DEBUG_ARCHIVE="$PWD/$DEBUG_ARCHIVE" ;;
esac
RUST_SRC="${OTTPLAY_RUST_SRC:-$SRC}"
DEST="${OTTPLAY_DEST:-$HOME/ottplay-foss-local}"
HTTP_PORTS="${OTTPLAY_HTTP_PORTS-8443 8444 8445 8446}"
LABEL_BASE="${OTTPLAY_LABEL:-com.ottplay-foss-local}"
BIN="$DEST/ottplay-server"

if [ -n "${OTTPLAY_PORT:-}" ] || [ -n "${OTTPLAY_HTTPS_PORTS:-}" ]; then
    echo "error: use OTTPLAY_HTTP_PORTS; OTTPLAY_PORT and OTTPLAY_HTTPS_PORTS are retired" >&2
    exit 1
fi
# Reject invalid lists before syncing files or touching launchd.
python3 - "$HTTP_PORTS" "$LABEL_BASE" <<'PYCONFIG'
import re
import sys
import os
import plistlib
from pathlib import Path
from urllib.parse import urlsplit
ports = sys.argv[1].split()
if (not ports or any(not re.fullmatch(r"[0-9]+", p) for p in ports)
        or any(not 1 <= int(p) <= 65535 for p in ports)
        or len({int(p) for p in ports}) != len(ports)
        or 8095 in {int(p) for p in ports}):
    sys.exit("error: OTTPLAY_HTTP_PORTS must contain distinct ports 1-65535, excluding retired port 8095")
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]*", sys.argv[2]):
    sys.exit("error: invalid OTTPLAY_LABEL")
saved = Path.home() / "Library/LaunchAgents" / (sys.argv[2] + ".plist")
swop = plistlib.loads(saved.read_bytes()).get("EnvironmentVariables", {}) if saved.exists() else {}
for key in ("SWOP_BASE_URL", "SWOP_INSTALLATION_TOKEN"):
    if os.environ.get(key, "").strip():
        swop[key] = os.environ[key].strip()
if swop.get("SWOP_INSTALLATION_TOKEN"):
    upstream = urlsplit(swop.get("SWOP_BASE_URL", ""))
    if (len(swop["SWOP_INSTALLATION_TOKEN"]) < 32
            or any(c in swop["SWOP_INSTALLATION_TOKEN"] for c in "\r\n")
            or upstream.scheme != "https" or not upstream.hostname
            or upstream.username is not None or upstream.password is not None
            or upstream.query or upstream.fragment):
        sys.exit("error: SWOP requires an HTTPS SWOP_BASE_URL and a valid SWOP_INSTALLATION_TOKEN")
PYCONFIG

for tool in rsync node npm cargo python3; do
    command -v "$tool" >/dev/null || { echo "error: $tool not found" >&2; exit 1; }
done

# Office shells may inject proxy variables on every launch. Keep the reset local
# to package downloads; explicit npm/Cargo options also override proxy config files.
without_download_proxy() (
    unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy PROXY proxy
    unset NPM_CONFIG_PROXY NPM_CONFIG_HTTPS_PROXY npm_config_proxy npm_config_https_proxy
    unset CARGO_HTTP_PROXY
    export NO_PROXY='*' no_proxy='*'
    "$@"
)

echo "[1/5] sync $SRC -> $DEST"
mkdir -p "$DEST"
# Preserve live debug flag/log across --delete. Keep source-local artifacts out
# of DEST; the service receives the source archive path explicitly below.
# Anchor native project exclusions so platform adapters and licenses are copied.
rsync -a --delete \
    --exclude .git --exclude node_modules --exclude logs --exclude .local-artifacts \
    --exclude target --exclude build --exclude .herenow --exclude .cache \
    --exclude .local-ops --exclude ottplay-server \
    --exclude /android --exclude /ios --exclude .env --exclude '.env.*' \
    --exclude '*.local.py' --exclude 'certs' --exclude 'local' \
    --exclude 'debug.enabled' --exclude 'debug-playback.log' --exclude 'debug-playback.log.1' \
    "$SRC/" "$DEST/"

echo "[2/5] npm ci + build"
cd "$DEST"
without_download_proxy npm ci --proxy=null --https-proxy=null --no-audit --no-fund 1>&2
npm run build 1>&2

echo "[3/5] build Rust binary"
mkdir -p "$DEST"
(cd "$RUST_SRC" && without_download_proxy cargo --config 'http.proxy=""' build --locked --release -p ottplay-server 1>&2)

echo "[4/5] launchd service (HTTP ports: $HTTP_PORTS)"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
DOMAIN="gui/$(id -u)"
LABEL="$LABEL_BASE"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# LaunchAgent environment may contain private values. Never place its backup
# under the publicly served /local tree.
mkdir -p "$DEST/.local-artifacts/service-backups"
BACKUP_DIR="$(mktemp -d "$DEST/.local-artifacts/service-backups/install.XXXXXX")"

stop_service() {
    local target="$DOMAIN/$1"
    local status_error
    status_error="$(mktemp)"
    launchctl bootout "$target" 2>/dev/null || true
    for _ in $(seq 1 30); do
        if ! LC_ALL=C launchctl print "$target" >/dev/null 2>"$status_error"; then
            case "$(cat "$status_error")" in
                *"Could not find service"*) rm -f "$status_error"; return ;;
                *) rm -f "$status_error"; echo "error: cannot inspect service: $1" >&2; return 1 ;;
            esac
        fi
        sleep 1
    done
    rm -f "$status_error"
    echo "error: service did not unload: $1" >&2
    return 1
}

# Retire owned legacy jobs and archive their plists outside LaunchAgents, so
# their old HTTP/TLS listeners cannot return on the next login.
stop_service "$LABEL"
for plist in "$HOME/Library/LaunchAgents/${LABEL_BASE}-"*.plist; do
    [ -f "$plist" ] || continue
    launch_name="$(/usr/libexec/PlistBuddy -c "Print :Label" "$plist")"
    case "$launch_name" in
        "$LABEL_BASE"-*) ;;
        *) echo "error: unexpected legacy service label in $plist" >&2; exit 1 ;;
    esac
    stop_service "$launch_name"
    mv "$plist" "$BACKUP_DIR/"
done
[ ! -f "$PLIST" ] || cp -p "$PLIST" "$BACKUP_DIR/"
[ ! -f "$BIN" ] || cp -p "$BIN" "$BACKUP_DIR/ottplay-server"

cp "$RUST_SRC/target/release/ottplay-server" "$BIN.new"
chmod +x "$BIN.new"
mv -f "$BIN.new" "$BIN"
# plistlib handles paths safely and preserves operator-specific environment,
# logging and launchd options from an existing installation.
python3 - "$PLIST" "$BIN" "$DEST" "$LABEL" "$DEBUG_ARCHIVE" "$HTTP_PORTS" <<'PYPLIST'
import os
from pathlib import Path
import plistlib
import sys
path, binary, dest, label, archive, ports = sys.argv[1:]
p = Path(path)
config = plistlib.loads(p.read_bytes()) if p.exists() else {}
config.update(Label=label, ProgramArguments=[binary, "--host", "0.0.0.0"] +
              [value for port in ports.split() for value in ("--port", str(int(port)))],
              WorkingDirectory=dest, RunAtLoad=True, KeepAlive=True)
env = config.setdefault("EnvironmentVariables", {})
env.setdefault("EPG_URLS", "http://epg.it999.ru/epg2.xml.gz")
env["OTTPLAY_DEBUG_ARCHIVE"] = archive
for key in ("SWOP_BASE_URL", "SWOP_INSTALLATION_TOKEN",
            "OTTPLAY_PLEX_URL", "OTTPLAY_PLEX_TOKEN", "OTTPLAY_NAS_KEY",
            "OTTPLAY_NAS_BROWSER_HOSTS"):
    if os.environ.get(key, "").strip():
        env[key] = os.environ[key].strip()
if env.get("SWOP_INSTALLATION_TOKEN"):
    # This public file contains only a same-origin path. The Rust endpoint also
    # generates it dynamically so a stale static config cannot bypass the relay.
    local = Path(dest) / "local"
    local.mkdir(parents=True, exist_ok=True)
    (local / "swop.json").write_text('{"swopBaseUrl":"/swop"}\n')
    os.chmod(local / "swop.json", 0o644)
log = str(Path.home() / "Library/Logs" / (label + ".log"))
config.setdefault("StandardOutPath", log)
config.setdefault("StandardErrorPath", log)
new = p.with_suffix(".plist.new")
with os.fdopen(os.open(new, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as output:
    os.fchmod(output.fileno(), 0o600)
    output.write(plistlib.dumps(config))
new.replace(p)
PYPLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "  loaded $LABEL (HTTP ports: $HTTP_PORTS)"

echo "[5/5] verify"
ok=""
for _ in $(seq 1 60); do
    all_up=1
    for HTTP_PORT in $HTTP_PORTS; do
        code="$(curl --noproxy '*' -m 3 -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HTTP_PORT/health")" || all_up=0
        [ "$code" = "200" ] || all_up=0
    done
    [ "$all_up" = "1" ] && { ok=1; break; }
    sleep 3
done
if [ -z "$ok" ]; then
    echo "error: not all HTTP ports responding; inspect ~/Library/Logs/${LABEL}.log" >&2
    echo "previous service configuration and binary retained at: $BACKUP_DIR" >&2
    exit 1
fi
python3 - <<'PYRETIRED'
import errno
import socket
for host in ("127.0.0.1", "::1"):
    try:
        with socket.create_connection((host, 8095), timeout=1):
            raise SystemExit("error: retired player port 8095 is still listening; inspect its owner")
    except OSError as error:
        if error.errno not in (errno.ECONNREFUSED, errno.EAFNOSUPPORT):
            raise SystemExit("error: cannot verify that retired player port 8095 is closed")
PYRETIRED
for p in $HTTP_PORTS; do
    echo "installed: http://127.0.0.1:$p/"
done
echo "LAN / Media Station X: use this Mac's LAN IP or hostname with the same ports."
echo "log: ~/Library/Logs/${LABEL}.log"
