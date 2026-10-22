#!/usr/bin/env bash
# Smoke-test the Mode A / Mode B / Capacitor command-queue HTTP contract via curl.
#
# Contract (mirrors local_proxy.py, src-tauri/src/commands/queue.rs,
# MobileCommandQueue on iOS/Android):
#   GET  /api/webhook/health     (alias GET /webhook/health) — Mode B Cap/Tauri
#   POST /api/webhook/commands  (alias POST /webhook/notify)
#   GET  /api/webhook/commands  (alias GET  /webhook/poll)
#   Authorization: Bearer <device-code> for every request
#   Optional ?device_id=<id> selects a native queue partition (ignored by Mode A)
#   Body: JSON object with a "command" field (Content-Type: application/json)
#   Response POST: {"status":"ok","queued":N}
#   Response GET:  JSON array of pending commands (drained; expire >60s)
#
# HTTP remote is off by default. Optional authenticated checks target loopback.
# No explicit target/token means a successful skip, without a network request.
# Cap + Tauri both prefer :18081 and fall back through :18082..=18090 when busy;
# use --discover or BASE_URL when both run on one Mac.
# Mode A companion (local_proxy.py) usually listens on :8081 — override BASE_URL.
#
# Usage:
#   ./scripts/smoke-command-queue.sh
#   OTTPLAY_QUEUE_HTTP_TOKEN=<device-code> BASE_URL=http://127.0.0.1:8081 ./scripts/smoke-command-queue.sh
#   BASE_URL=http://127.0.0.1:18082 ./scripts/smoke-command-queue.sh  # Tauri if Cap holds 18081
#   ./scripts/smoke-command-queue.sh --discover
#   ./scripts/smoke-command-queue.sh --discover --backend tauri
#   DEVICE_ID=dev_abc123 ./scripts/smoke-command-queue.sh
#   ./scripts/smoke-command-queue.sh --aliases
#   ./scripts/smoke-command-queue.sh --help
#
# Exit codes:
#   0  smoke passed
#   1  queue not listening / connection failed
#   2  unexpected HTTP/JSON response
#   3  usage / missing dependency
set +x # Never echo the optional token, including when invoked with bash -x.
set -euo pipefail

QUEUE_HTTP_TOKEN="${QUEUE_HTTP_TOKEN:-${OTTPLAY_QUEUE_HTTP_TOKEN:-}}"
AUTH_CONFIG=""
cleanup_auth() { [[ -z "$AUTH_CONFIG" ]] || rm -f "$AUTH_CONFIG"; }
trap cleanup_auth EXIT

BASE_URL_DEFAULT="http://127.0.0.1:18081"
BASE_URL_SET=0
if [[ -n "${BASE_URL+x}" && -n "${BASE_URL}" ]]; then
  BASE_URL_SET=1
fi
BASE_URL="${BASE_URL:-$BASE_URL_DEFAULT}"
DEVICE_ID="${DEVICE_ID:-}"
COMMAND_JSON="${COMMAND_JSON:-{\"command\":\"popup_message\",\"message\":\"cmd-queue smoke\",\"popup_duration\":3}}"
CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-2}"
DISCOVER_FROM="${DISCOVER_FROM:-18081}"
DISCOVER_TO="${DISCOVER_TO:-18090}"
TEST_ALIASES=0
DO_DISCOVER=0
BACKEND_FILTER="${BACKEND_FILTER:-}"

usage() {
  cat <<'USAGE'
smoke-command-queue.sh — POST then GET /api/webhook/commands against a live queue.

Env:
  BASE_URL          Default http://127.0.0.1:18081 (Mode B Tauri / Cap).
                    Mode A local_proxy.py: http://127.0.0.1:8081 (or LAN host:8081).
                    When Cap+Tauri both run, second app is often :18082 — set BASE_URL
                    or use --discover.
  QUEUE_HTTP_TOKEN  Required device code for explicitly enabled HTTP control in all modes.
                    Also accepts OTTPLAY_QUEUE_HTTP_TOKEN. Never printed.
                    Only loopback BASE_URL is accepted when a token is supplied.
  DEVICE_ID         Optional native queue partition; Mode A ignores this compatibility field.
  COMMAND_JSON      JSON body to enqueue (default: popup_message smoke).
  CONNECT_TIMEOUT   curl --connect-timeout seconds (default 2).
  DISCOVER_FROM/TO  Port range for --discover (default 18081-18090).
  BACKEND_FILTER    Optional with --discover: tauri | capacitor (same as --backend).

Flags:
  --discover        Probe GET /api/webhook/health on DISCOVER_FROM..TO; list backends;
                    if BASE_URL unset and exactly one match (or --backend filters to one),
                    use it; if multiple, print them and exit 3 unless BASE_URL is set.
  --backend NAME    With --discover, keep only backend=NAME (tauri|capacitor).
  --aliases         Also smoke POST /webhook/notify and GET /webhook/poll.
  -h, --help        Show this help.

Native HTTP is off by default; normal playback uses internal IPC and needs no listener.
This script never enables HTTP control. Without a token and without an explicit BASE_URL it skips.
An explicit BASE_URL without a token is a usage error; all queues require authentication.
For a deliberately enabled native listener, provide its token through the environment
and its selected loopback URL through BASE_URL, or use authenticated --discover.
Tauri opt-in: enable Local HTTP remote control in player settings; use its device code.
Capacitor opt-in: enable Local HTTP remote control in player settings; use its device code.
The smoke enqueues and drains commands; use a dedicated test player/proxy.
Mode A local_proxy.py requires OTTPLAY_QUEUE_HTTP_ENABLED=1 and its player's device
code in OTTPLAY_QUEUE_HTTP_TOKEN. Run this smoke on the proxy host using loopback.

USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --aliases) TEST_ALIASES=1; shift ;;
    --discover) DO_DISCOVER=1; shift ;;
    --backend)
      if [[ $# -lt 2 ]]; then
        echo "error: --backend needs a value (tauri|capacitor)" >&2
        exit 3
      fi
      BACKEND_FILTER="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 3
      ;;
  esac
done

if ! command -v curl >/dev/null 2>&1; then
  echo "error: curl is required" >&2
  exit 3
fi

# A normal native installation has no HTTP listener. Do not require one for smoke.
if [[ -z "$QUEUE_HTTP_TOKEN" ]]; then
  if [[ "$BASE_URL_SET" -eq 0 ]]; then
    echo "soft-skip: HTTP control is off by default; no explicit authenticated target"
    exit 0
  fi
  echo "error: an explicit command queue target requires its device code in QUEUE_HTTP_TOKEN" >&2
  exit 3
fi

curl_auth=()
if [[ -n "$QUEUE_HTTP_TOKEN" ]]; then
  if [[ ${#QUEUE_HTTP_TOKEN} -lt 32 || ${#QUEUE_HTTP_TOKEN} -gt 256 || "$QUEUE_HTTP_TOKEN" =~ [^A-Za-z0-9_-] ]]; then
    echo "error: HTTP device code must be 32-256 URL-safe ASCII characters" >&2
    exit 3
  fi
  if ! python3 - "$BASE_URL" <<'URLCHECK'
import sys, urllib.parse
try:
    u = urllib.parse.urlsplit(sys.argv[1])
    assert u.scheme in ('http', 'https') and u.hostname in ('127.0.0.1', 'localhost', '::1')
    assert not (u.username or u.password or u.query or u.fragment) and u.path in ('', '/')
    assert u.port is None or 0 < u.port < 65536
except (AssertionError, ValueError):
    sys.exit(1)
URLCHECK
  then
    echo "error: authenticated queue smoke requires a loopback origin URL" >&2
    exit 3
  fi
  AUTH_CONFIG="$(umask 077; mktemp -t ott-cq-auth.XXXXXX)"
  printf 'header = "Authorization: Bearer %s"\n' "$QUEUE_HTTP_TOKEN" >"$AUTH_CONFIG"
  curl_auth=(--config "$AUTH_CONFIG" --noproxy '*')
fi

health_matches() {
  python3 -c 'import json,sys
try:
    data=json.load(sys.stdin)
    sys.exit(0 if data.get("backend") in ("tauri", "capacitor") else 1)
except (ValueError, AttributeError):
    sys.exit(1)'
}

# Strip trailing slash from base.
BASE_URL="${BASE_URL%/}"

curl_probe=(
  --silent
  --show-error
  --connect-timeout "$CONNECT_TIMEOUT"
  --max-time 5
  -w "\n%{http_code}"
)

# Probe Mode B health endpoints on DISCOVER_FROM..TO.
# Prints lines: port\tbackend\turl  (backend may be unknown if only commands respond).
discover_queues() {
  local port raw url health code body http_code backend
  for port in $(seq "$DISCOVER_FROM" "$DISCOVER_TO"); do
    url="http://127.0.0.1:${port}"
    health="${url}/api/webhook/health"
    set +e
    raw="$(curl "${curl_auth[@]+"${curl_auth[@]}"}" "${curl_probe[@]}" -X GET -H 'Accept: application/json' "$health" 2>/dev/null)"
    code=$?
    set -e
    if [[ $code -ne 0 || -z "$raw" ]]; then
      continue
    fi
    if [[ "$raw" == *$'\n'* ]]; then
      http_code="${raw##*$'\n'}"
      body="${raw%$'\n'*}"
    else
      body=""
      http_code="$raw"
    fi
    if [[ "$http_code" != "200" ]]; then
      continue
    fi
    if ! printf '%s' "$body" | health_matches; then
      continue
    fi
    backend="$(printf '%s' "$body" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  print(d.get("backend") or "unknown")
except Exception:
  print("unknown")
' 2>/dev/null || echo unknown)"
    printf '%s\t%s\t%s\n' "$port" "$backend" "$url"
  done
}

if [[ "$DO_DISCOVER" -eq 1 ]]; then
  echo "Discovering Mode B command queues on 127.0.0.1:${DISCOVER_FROM}-${DISCOVER_TO} ..."
  # Bash 3.2-compatible (macOS /bin/bash): no mapfile.
  FOUND_FILE="$(mktemp -t ott-cq-discover.XXXXXX)"
  discover_queues >"$FOUND_FILE" || true
  if [[ ! -s "$FOUND_FILE" ]]; then
    rm -f "$FOUND_FILE"
    echo "not listening: no ottplay-command-queue health on :${DISCOVER_FROM}-${DISCOVER_TO}" >&2
    echo "hint: native HTTP is normally disabled; this check only covers explicit opt-in. Mode A uses explicit BASE_URL." >&2
    exit 1
  fi
  FILTERED_FILE="$(mktemp -t ott-cq-filtered.XXXXXX)"
  : >"$FILTERED_FILE"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    port="$(printf '%s' "$line" | cut -f1)"
    backend="$(printf '%s' "$line" | cut -f2)"
    url="$(printf '%s' "$line" | cut -f3)"
    if [[ -n "$BACKEND_FILTER" && "$backend" != "$BACKEND_FILTER" ]]; then
      continue
    fi
    printf '%s\n' "$line" >>"$FILTERED_FILE"
    echo "  found: ${url}  backend=${backend}  port=${port}"
  done <"$FOUND_FILE"
  rm -f "$FOUND_FILE"
  if [[ ! -s "$FILTERED_FILE" ]]; then
    rm -f "$FILTERED_FILE"
    echo "error: no queues matched --backend ${BACKEND_FILTER}" >&2
    exit 1
  fi
  FILTERED_COUNT="$(wc -l <"$FILTERED_FILE" | tr -d ' ')"
  if [[ "$BASE_URL_SET" -eq 1 ]]; then
    echo "  using BASE_URL=${BASE_URL} (explicit)"
  elif [[ "$FILTERED_COUNT" -eq 1 ]]; then
    BASE_URL="$(cut -f3 "$FILTERED_FILE" | head -n 1)"
    echo "  using discovered BASE_URL=${BASE_URL}"
  else
    echo "error: multiple Mode B queues listening; set BASE_URL or --backend" >&2
    echo "examples:" >&2
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ -z "$line" ]] && continue
      url="$(printf '%s' "$line" | cut -f3)"
      backend="$(printf '%s' "$line" | cut -f2)"
      echo "  BASE_URL=${url} ./scripts/smoke-command-queue.sh   # ${backend}" >&2
    done <"$FILTERED_FILE"
    rm -f "$FILTERED_FILE"
    exit 3
  fi
  rm -f "$FILTERED_FILE"
  echo
fi

qs=""
if [[ -n "$DEVICE_ID" ]]; then
  # Query-only; native + proxy do not read device id from headers/body.
  qs="?device_id=$(python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$DEVICE_ID" 2>/dev/null || printf '%s' "$DEVICE_ID")"
fi

primary_post="${BASE_URL}/api/webhook/commands${qs}"
primary_get="${BASE_URL}/api/webhook/commands${qs}"
alias_post="${BASE_URL}/webhook/notify${qs}"
alias_get="${BASE_URL}/webhook/poll${qs}"

curl_common=(
  --silent
  --show-error
  --connect-timeout "$CONNECT_TIMEOUT"
  --max-time 10
  -w "\n%{http_code}"
)

not_listening() {
  local url="$1"
  local detail="${2:-}"
  echo "not listening: cannot reach ${url}" >&2
  if [[ -n "$detail" ]]; then
    echo "  detail: ${detail}" >&2
  fi
  echo "hint: native HTTP is normally disabled; verify only an explicitly enabled listener;" >&2
  echo "      Cap+Tauri dual-run: ./scripts/smoke-command-queue.sh --discover" >&2
  echo "      for Android emulator/device use: adb forward tcp:18081 tcp:18081" >&2
  echo "      override with BASE_URL=... (Mode A often http://127.0.0.1:8081)" >&2
  exit 1
}

# Returns body\nhttp_code on stdout; sets CURL_EC to curl exit status.
do_curl() {
  local out ec
  set +e
  out="$(curl "${curl_auth[@]+"${curl_auth[@]}"}" "${curl_common[@]}" "$@" 2>/tmp/ott-cq-smoke-curl.err)"
  ec=$?
  set -e
  if [[ $ec -ne 0 ]]; then
    return 1
  fi
  printf '%s' "$out"
  return 0
}

# Parse curl output that ends with a newline + HTTP status code.
# Sets globals BODY and CODE. Avoids pipe-subshell so callers see the values.
split_body_code() {
  local raw="$1"
  if [[ "$raw" == *$'\n'* ]]; then
    CODE="${raw##*$'\n'}"
    BODY="${raw%$'\n'*}"
  else
    BODY=""
    CODE="$raw"
  fi
}

post_and_check() {
  local url="$1"
  local label="$2"
  local raw err
  echo "==> POST ${label}: ${url}"
  if ! raw="$(do_curl -X POST -H 'Content-Type: application/json' -d "$COMMAND_JSON" "$url")"; then
    err="$(cat /tmp/ott-cq-smoke-curl.err 2>/dev/null || true)"
    not_listening "$url" "$err"
  fi
  BODY=""; CODE=""
  split_body_code "$raw"
  if [[ "$CODE" != "200" ]]; then
    echo "error: POST ${label} expected HTTP 200, got ${CODE}" >&2
    echo "body: ${BODY}" >&2
    exit 2
  fi
  if ! printf '%s' "$BODY" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
    echo "error: POST ${label} response missing status=ok" >&2
    echo "body: ${BODY}" >&2
    exit 2
  fi
  if ! printf '%s' "$BODY" | grep -q '"queued"'; then
    echo "error: POST ${label} response missing queued count" >&2
    echo "body: ${BODY}" >&2
    exit 2
  fi
  echo "    ok: ${BODY}"
}

get_and_check() {
  local url="$1"
  local label="$2"
  local expect_nonempty="$3" # 1 = expect at least one command with our marker
  local raw err
  echo "==> GET  ${label}: ${url}"
  if ! raw="$(do_curl -X GET -H 'Accept: application/json' "$url")"; then
    err="$(cat /tmp/ott-cq-smoke-curl.err 2>/dev/null || true)"
    not_listening "$url" "$err"
  fi
  BODY=""; CODE=""
  split_body_code "$raw"
  if [[ "$CODE" != "200" ]]; then
    echo "error: GET ${label} expected HTTP 200, got ${CODE}" >&2
    echo "body: ${BODY}" >&2
    exit 2
  fi
  # Must be a JSON array.
  if [[ "${BODY}" != \[* ]]; then
    echo "error: GET ${label} expected JSON array" >&2
    echo "body: ${BODY}" >&2
    exit 2
  fi
  if [[ "$expect_nonempty" == "1" ]]; then
    if ! printf '%s' "$BODY" | grep -q 'popup_message'; then
      echo "error: GET ${label} did not return the enqueued popup_message" >&2
      echo "body: ${BODY}" >&2
      echo "hint: another poller may have drained the queue (player polls ~10s);" >&2
      echo "      re-run quickly, or stop the player poller / use a unique DEVICE_ID." >&2
      exit 2
    fi
  fi
  echo "    ok: ${BODY}"
}

echo "Command queue smoke"
echo "  BASE_URL=${BASE_URL}"
if [[ -n "$DEVICE_ID" ]]; then
  echo "  DEVICE_ID=${DEVICE_ID}"
else
  echo "  DEVICE_ID=(default authenticated queue)"
fi
echo

# Probe reachability with health if present, else cheap GET drain.
health_url="${BASE_URL}/api/webhook/health"
echo "==> probe GET ${health_url}"
if raw="$(do_curl -X GET -H 'Accept: application/json' "$health_url")"; then
  BODY=""; CODE=""
  split_body_code "$raw"
  if [[ "$CODE" == "200" ]] && printf '%s' "$BODY" | health_matches; then
    echo "    listening (health: ${BODY})"
  else
    echo "    health not Mode B (http ${CODE}); falling back to commands probe"
    echo "==> probe GET ${primary_get}"
    if ! raw="$(do_curl -X GET -H 'Accept: application/json' "$primary_get")"; then
      err="$(cat /tmp/ott-cq-smoke-curl.err 2>/dev/null || true)"
      not_listening "$primary_get" "$err"
    fi
    BODY=""; CODE=""
    split_body_code "$raw"
    if [[ "$CODE" != "200" ]]; then
      echo "error: probe GET expected HTTP 200, got ${CODE}" >&2
      echo "body: ${BODY}" >&2
      exit 2
    fi
    echo "    listening (probe body: ${BODY})"
  fi
else
  echo "    health unreachable; falling back to commands probe"
  echo "==> probe GET ${primary_get}"
  if ! raw="$(do_curl -X GET -H 'Accept: application/json' "$primary_get")"; then
    err="$(cat /tmp/ott-cq-smoke-curl.err 2>/dev/null || true)"
    not_listening "$primary_get" "$err"
  fi
  BODY=""; CODE=""
  split_body_code "$raw"
  if [[ "$CODE" != "200" ]]; then
    echo "error: probe GET expected HTTP 200, got ${CODE}" >&2
    echo "body: ${BODY}" >&2
    exit 2
  fi
  echo "    listening (probe body: ${BODY})"
fi
echo

post_and_check "$primary_post" "/api/webhook/commands"
get_and_check "$primary_get" "/api/webhook/commands" 1

if [[ "$TEST_ALIASES" -eq 1 ]]; then
  echo
  post_and_check "$alias_post" "/webhook/notify"
  get_and_check "$alias_get" "/webhook/poll" 1
fi

echo
echo "PASS: command queue POST→GET smoke against ${BASE_URL}"
rm -f /tmp/ott-cq-smoke-curl.err
