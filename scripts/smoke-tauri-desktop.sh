#!/usr/bin/env bash
# Mode B Tauri desktop-smoke helper (thin).
# Automates what FOSS can without a headed GUI in CI: toolchain checks,
# src-tauri/ presence, optional unsigned compile, optional companion curl on :8443,
# and optional command-queue curl on :18081+ when the desktop app is running.
# Human still marks the UI checklist in docs/mode-b-tauri-smoke.md.
#
# Usage:
#   ./scripts/smoke-tauri-desktop.sh --help
#   ./scripts/smoke-tauri-desktop.sh --check-src-tauri
#   ./scripts/smoke-tauri-desktop.sh --build
#   ./scripts/smoke-tauri-desktop.sh --check-companion
#   ./scripts/smoke-tauri-desktop.sh --check-companion --require-companion
#   ./scripts/smoke-tauri-desktop.sh --check-queue
#   ./scripts/smoke-tauri-desktop.sh --check-queue --require-queue
#   ./scripts/smoke-tauri-desktop.sh --require-cargo
#
# Env:
#   BASE_URL           Default http://127.0.0.1:8443 (OTTPLAY_WEB_URL companion).
#   CONNECT_TIMEOUT    curl connect timeout seconds (default 2).
#   DEVICE_ID          Unused for Tauri companion soft curl.
#
# Exit codes:
#   0  ok (queue/companion soft-skip counts as ok unless --require-*)
#   1  hard failure (missing required tool/dir, build failed, queue/companion required but down)
#   2  queue/companion smoke ran but contract assertion failed
#   3  usage / unknown flag / missing baseline deps
set +x # Never trace optional control credentials.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASE_URL="${BASE_URL:-${OTTPLAY_WEB_URL:-http://127.0.0.1:8443}}"
BASE_URL="${BASE_URL%/}"
DO_CHECK_SRC=0
DO_BUILD=0
DO_CHECK_COMPANION=0
REQUIRE_COMPANION=0
DO_CHECK_QUEUE=0
REQUIRE_QUEUE=0
REQUIRE_CARGO=0
# Default: always verify node/npm when no action flags given -> check-src-tauri + soft companion probe
EXPLICIT_ACTION=0

usage() {
  cat <<USAGE
smoke-tauri-desktop.sh — Mode B Tauri desktop-smoke helper (checklist companion).

Does NOT launch a headed GUI. Automates: toolchain checks, src-tauri/ presence,
optional unsigned CI build, companion soft/hard curl on :8443, and command-queue
optional authenticated probe on explicitly enabled Tauri loopback HTTP :18081+.
HTTP control is off by default; internal IPC does not require a listener. Human marks the UI checklist in
docs/mode-b-tauri-smoke.md.

Flags:
  --check-src-tauri         Verify src-tauri/ exists
  --build           Run: ( cd src-tauri && npx tauri build --ci ) — unsigned
  --check-companion                Soft curl companion at BASE_URL / OTTPLAY_WEB_URL (default :8443)
  --require-companion        With --check-companion: exit 1 if not listening (default: soft-skip)
  --check-queue              Check explicitly enabled HTTP control with QUEUE_HTTP_TOKEN
  --require-queue            With --check-queue: exit 1 if queue not listening
  --require-cargo            Fail if cargo/rustc missing (default: soft-skip)
  -h, --help                 Show this help

Env:
  BASE_URL / OTTPLAY_WEB_URL  Default http://127.0.0.1:8443 (debug companion).
  QUEUE_BASE_URL              Optional loopback queue URL (else authenticated --discover).
  QUEUE_HTTP_TOKEN / OTTPLAY_QUEUE_HTTP_TOKEN  Token for explicit HTTP opt-in, never logged.
  CONNECT_TIMEOUT             curl connect timeout seconds (default 2).
  COMMAND_JSON / DEVICE_ID    Forwarded to scripts/smoke-command-queue.sh when --check-queue runs.

Default (no action flags): --check-src-tauri + soft --check-companion probe.

Exit: 0 ok, 1 hard fail, 2 queue/companion assertion fail, 3 usage/deps.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-src-tauri) DO_CHECK_SRC=1; EXPLICIT_ACTION=1; shift ;;
    --build) DO_BUILD=1; EXPLICIT_ACTION=1; shift ;;
    --check-companion) DO_CHECK_COMPANION=1; EXPLICIT_ACTION=1; shift ;;
    --require-companion) REQUIRE_COMPANION=1; shift ;;
    --check-queue) DO_CHECK_QUEUE=1; EXPLICIT_ACTION=1; shift ;;
    --require-queue) REQUIRE_QUEUE=1; shift ;;
    --require-cargo) REQUIRE_CARGO=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 3
      ;;
  esac
done

if [[ "$EXPLICIT_ACTION" -eq 0 ]]; then
  DO_CHECK_SRC=1
  DO_CHECK_COMPANION=1
fi

need_cmd() {
  local c="$1"
  if ! command -v "$c" >/dev/null 2>&1; then
    echo "error: missing required command: $c" >&2
    exit 3
  fi
}

soft_cmd() {
  local c="$1"
  local label="${2:-$c}"
  if command -v "$c" >/dev/null 2>&1; then
    echo "ok: ${label}=$(command -v "$c")"
  else
    echo "soft-skip: ${label} not found (optional)"
  fi
}

# Baseline: node + npm always required
need_cmd node
need_cmd npm
echo "ok: node=$(command -v node)  npm=$(command -v npm)"

# cargo/rustc: soft unless --require-cargo
if [[ "$REQUIRE_CARGO" -eq 1 ]]; then
  if command -v cargo >/dev/null 2>&1 && command -v rustc >/dev/null 2>&1; then
    echo "ok: cargo=$(command -v cargo)  rustc=$(command -v rustc)"
  else
    echo "error: cargo/rustc not found (install Rust for Tauri builds)" >&2
    exit 1
  fi
else
  soft_cmd cargo "cargo"
  soft_cmd rustc "rustc"
fi

if [[ "$DO_CHECK_SRC" -eq 1 ]]; then
  missing=0
  if [[ ! -d "$ROOT/src-tauri" ]]; then
    echo "error: missing src-tauri/ — run 'npx tauri init' or use --build to scaffold" >&2
    missing=1
  else
    echo "ok: src-tauri/ present"
  fi
  if [[ ! -f "$ROOT/src-tauri/Cargo.toml" ]]; then
    echo "error: missing src-tauri/Cargo.toml — src-tauri/ incomplete" >&2
    missing=1
  else
    echo "ok: src-tauri/Cargo.toml present"
  fi
  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi
fi

if [[ "$DO_BUILD" -eq 1 ]]; then
  if [[ ! -d "$ROOT/src-tauri" ]]; then
    echo "error: missing src-tauri/ - run Tauri CLI init or --check-src-tauri first" >&2
    exit 1
  fi
  echo "running: unsigned CI build in src-tauri/"
  ( cd "$ROOT/src-tauri" && npx tauri build --ci )
  echo "ok: build finished"
fi

listening() {
  # TCP-only probe — do NOT HTTP GET /api/webhook/commands (that drains the queue).
  local url="$1"
  local host port
  host="$(python3 -c 'import sys,urllib.parse;u=urllib.parse.urlparse(sys.argv[1]);print(u.hostname or "")' "$url")"
  port="$(python3 -c 'import sys,urllib.parse;u=urllib.parse.urlparse(sys.argv[1]);print(u.port or (443 if u.scheme=="https" else 80))' "$url")"
  if [[ -z "$host" || -z "$port" ]]; then
    return 1
  fi
  if command -v curl >/dev/null 2>&1; then
    # Connect to root path; ignore HTTP status — only care that TCP works.
    curl --silent --output /dev/null --connect-timeout "${CONNECT_TIMEOUT:-2}" --max-time 5 \
      "http://${host}:${port}/" >/dev/null 2>&1
    return $?
  fi
  (echo >/dev/tcp/"$host"/"$port") >/dev/null 2>&1
}

if [[ "$DO_CHECK_COMPANION" -eq 1 ]]; then
  need_cmd curl
  probe_url="${BASE_URL}/"
  if ! listening "$probe_url"; then
    echo "soft-skip: companion not listening at ${BASE_URL}"
    echo "  hint: start companion on :8443 for debug webview, or soft-skip;"
    echo "        release builds embed frontendDist — companion optional"
    echo "        then re-run with --check-companion (or --check-companion --require-companion)"
    if [[ "$REQUIRE_COMPANION" -eq 1 ]]; then
      echo "error: --require-companion set and companion is down" >&2
      exit 1
    fi
  else
    set +e
    code="$(curl --silent --output /dev/null --write-out "%{http_code}" \
      --connect-timeout "${CONNECT_TIMEOUT:-2}" --max-time 5 "${BASE_URL}/" 2>/dev/null)"
    curl_ec=$?
    set -e
    if [[ "$curl_ec" -ne 0 || -z "$code" || "$code" == "000" ]]; then
      echo "error: companion check failed (curl_ec=$curl_ec http=$code)" >&2
      exit 2
    fi
    echo "ok: companion appears reachable at ${BASE_URL} (http ${code})"
  fi
fi

if [[ "$DO_CHECK_QUEUE" -eq 1 && -z "${QUEUE_HTTP_TOKEN:-${OTTPLAY_QUEUE_HTTP_TOKEN:-}}" ]]; then
  echo "soft-skip: native HTTP control is off by default; no token supplied"
  if [[ "$REQUIRE_QUEUE" -eq 1 ]]; then
    echo "error: --require-queue requires an explicitly enabled listener and token" >&2
    exit 3
  fi
  DO_CHECK_QUEUE=0
fi

if [[ "$DO_CHECK_QUEUE" -eq 1 ]]; then
  need_cmd curl
  if [[ ! -x "$ROOT/scripts/smoke-command-queue.sh" ]]; then
    echo "error: scripts/smoke-command-queue.sh not found or not executable" >&2
    if [[ "$REQUIRE_QUEUE" -eq 1 ]]; then
      exit 1
    fi
    echo "soft-skip: smoke-command-queue.sh missing"
  else
    echo "running: command-queue smoke against Tauri loopback (:18081+ / --discover)"
    # BASE_URL here is the web companion (:8443). Queue uses QUEUE_BASE_URL or discover.
    set +e
    if [[ -n "${QUEUE_BASE_URL:-}" ]]; then
      CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-2}" \
        DEVICE_ID="${DEVICE_ID:-}" \
        COMMAND_JSON="${COMMAND_JSON:-{\"command\":\"popup_message\",\"message\":\"tauri-smoke\",\"popup_duration\":3}}" \
        BASE_URL="$QUEUE_BASE_URL" \
        "$ROOT/scripts/smoke-command-queue.sh"
      cq_ec=$?
    else
      CONNECT_TIMEOUT="${CONNECT_TIMEOUT:-2}" \
        DEVICE_ID="${DEVICE_ID:-}" \
        COMMAND_JSON="${COMMAND_JSON:-{\"command\":\"popup_message\",\"message\":\"tauri-smoke\",\"popup_duration\":3}}" \
        "$ROOT/scripts/smoke-command-queue.sh" --discover --backend tauri
      cq_ec=$?
    fi
    set -e
    if [[ "$cq_ec" -ne 0 ]]; then
      # Only an absent optional listener is a soft-skip. Authentication,
      # configuration and response-contract failures must remain failures.
      if [[ "$cq_ec" -eq 1 && "$REQUIRE_QUEUE" -eq 0 ]]; then
        echo "soft-skip: optional command-queue listener unavailable"
      else
        echo "error: command-queue smoke failed" >&2
        exit "$cq_ec"
      fi
    else
      echo "ok: command-queue smoke passed (Tauri loopback)"
    fi
  fi
fi

echo "ok: tauri desktop-smoke helper finished"
echo "reminder: mark the human UI checklist in docs/mode-b-tauri-smoke.md"
exit 0
