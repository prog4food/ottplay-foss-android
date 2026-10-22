#!/usr/bin/env bash
# Mode B Capacitor device-smoke helper (thin).
# Automates what FOSS can without a booted simulator in CI: toolchain checks,
# native project dir presence, optional build/sync/open, and command-queue curl
# against Cap loopback when listening. Human still marks the UI checklist in
# docs/mode-b-device-smoke.md.
#
# Usage:
#   ./scripts/smoke-capacitor-device.sh --help
#   ./scripts/smoke-capacitor-device.sh --check-native
#   ./scripts/smoke-capacitor-device.sh --build-sync
#   ./scripts/smoke-capacitor-device.sh --queue
#   ./scripts/smoke-capacitor-device.sh --queue --require-queue
#   ./scripts/smoke-capacitor-device.sh --check-ios-tools
#   ./scripts/smoke-capacitor-device.sh --check-android-tools
#   ./scripts/smoke-capacitor-device.sh --adb-forward
#   ./scripts/smoke-capacitor-device.sh --open-ios
#   ./scripts/smoke-capacitor-device.sh --open-android
#
# Env:
#   BASE_URL           Default http://127.0.0.1:18081 (Cap / Tauri loopback).
#                      Cap+Tauri dual-run: set BASE_URL or use smoke-command-queue.sh --discover.
#   CONNECT_TIMEOUT    Passed through to smoke-command-queue.sh when set.
#   DEVICE_ID          Optional; passed through to smoke-command-queue.sh.
#
# Exit codes:
#   0  ok (queue soft-skip counts as ok unless --require-queue)
#   1  hard failure (missing required tool/dir, build/sync failed, queue required but down)
#   2  queue smoke ran but contract assertion failed
#   3  usage / unknown flag / missing baseline deps
set +x # Never trace optional control credentials.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BASE_URL="${BASE_URL:-http://127.0.0.1:18081}"
DO_CHECK_NATIVE=0
DO_BUILD_SYNC=0
DO_SYNC_ONLY=0
DO_QUEUE=0
REQUIRE_QUEUE=0
QUEUE_ALIASES=0
CHECK_IOS_TOOLS=0
CHECK_ANDROID_TOOLS=0
REQUIRE_IOS_TOOLS=0
REQUIRE_ANDROID_TOOLS=0
DO_ADB_FORWARD=0
DO_OPEN_IOS=0
DO_OPEN_ANDROID=0
# Default: always verify node/npm when no action flags given → check-native only; HTTP control is off by default
EXPLICIT_ACTION=0

usage() {
  cat <<USAGE
smoke-capacitor-device.sh — Mode B Capacitor device-smoke helper (checklist companion).

Does NOT boot simulators/emulators (flaky in CI). Prefer docs/mode-b-device-smoke.md
for the human UI checklist; this script automates build/sync/open helpers, dir
presence, toolchain checks, and command-queue curl when Cap is listening.

Flags:
  --check-native         Verify the active ios/ project directory exists
  --build-sync           Run: npm run build:mobile (iOS only)
  --sync-only            Run: npm run cap:sync  (no vite rebuild)
  --queue                Check explicitly enabled HTTP control with QUEUE_HTTP_TOKEN
  --require-queue        With --queue: exit 1 if not listening (default: soft-skip)
  --aliases              Pass --aliases through to smoke-command-queue.sh
  --check-ios-tools      Warn if xcrun missing (soft)
  --check-android-tools  Warn if adb missing (soft)
  --require-ios-tools    Fail if xcrun missing
  --require-android-tools Fail if adb missing
  --adb-forward          Run: adb forward tcp:18081 tcp:18081
  --open-ios             Run: npm run cap:ios
  --open-android         Open the Capacitor Android project in Android Studio
  -h, --help             Show this help

Env:
  BASE_URL  Default http://127.0.0.1:18081
  QUEUE_HTTP_TOKEN / OTTPLAY_QUEUE_HTTP_TOKEN  Token for explicit HTTP opt-in, never logged.
  DEVICE_ID / CONNECT_TIMEOUT / COMMAND_JSON — forwarded to smoke-command-queue.sh

Default (no action flags): --check-native only; HTTP control remains disabled.

Exit: 0 ok, 1 hard fail, 2 queue assertion fail, 3 usage/deps.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-native) DO_CHECK_NATIVE=1; EXPLICIT_ACTION=1; shift ;;
    --build-sync) DO_BUILD_SYNC=1; EXPLICIT_ACTION=1; shift ;;
    --sync-only) DO_SYNC_ONLY=1; EXPLICIT_ACTION=1; shift ;;
    --queue) DO_QUEUE=1; EXPLICIT_ACTION=1; shift ;;
    --require-queue) REQUIRE_QUEUE=1; shift ;;
    --aliases) QUEUE_ALIASES=1; shift ;;
    --check-ios-tools) CHECK_IOS_TOOLS=1; EXPLICIT_ACTION=1; shift ;;
    --check-android-tools) CHECK_ANDROID_TOOLS=1; EXPLICIT_ACTION=1; shift ;;
    --require-ios-tools) REQUIRE_IOS_TOOLS=1; CHECK_IOS_TOOLS=1; EXPLICIT_ACTION=1; shift ;;
    --require-android-tools) REQUIRE_ANDROID_TOOLS=1; CHECK_ANDROID_TOOLS=1; EXPLICIT_ACTION=1; shift ;;
    --adb-forward) DO_ADB_FORWARD=1; EXPLICIT_ACTION=1; shift ;;
    --open-ios) DO_OPEN_IOS=1; EXPLICIT_ACTION=1; shift ;;
    --open-android) DO_OPEN_ANDROID=1; EXPLICIT_ACTION=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 3
      ;;
  esac
done

if [[ "$EXPLICIT_ACTION" -eq 0 ]]; then
  DO_CHECK_NATIVE=1
fi

need_cmd() {
  local c="$1"
  if ! command -v "$c" >/dev/null 2>&1; then
    echo "error: missing required command: $c" >&2
    exit 3
  fi
}

# Baseline: node + package manager always required for Cap workflow honesty
need_cmd node
need_cmd npm

echo "ok: node=$(command -v node)  npm=$(command -v npm)"

if [[ "$CHECK_IOS_TOOLS" -eq 1 || "$REQUIRE_IOS_TOOLS" -eq 1 ]]; then
  if command -v xcrun >/dev/null 2>&1; then
    echo "ok: xcrun=$(command -v xcrun)"
  else
    if [[ "$REQUIRE_IOS_TOOLS" -eq 1 ]]; then
      echo "error: xcrun not found (install Xcode / CLT)" >&2
      exit 1
    fi
    echo "soft-skip: xcrun not found (iOS Simulator tools unavailable on this host)"
  fi
fi

if [[ "$CHECK_ANDROID_TOOLS" -eq 1 || "$REQUIRE_ANDROID_TOOLS" -eq 1 ]]; then
  if command -v adb >/dev/null 2>&1; then
    echo "ok: adb=$(command -v adb)"
  else
    if [[ "$REQUIRE_ANDROID_TOOLS" -eq 1 ]]; then
      echo "error: adb not found (install Android platform-tools)" >&2
      exit 1
    fi
    echo "soft-skip: adb not found (Android emulator/device tools unavailable)"
  fi
fi

if [[ "$DO_CHECK_NATIVE" -eq 1 ]]; then
  missing=0
  if [[ ! -d "$ROOT/ios" ]]; then
    echo "error: missing ios/ — run npm run build:mobile or npm run cap:sync first" >&2
    missing=1
  else
    echo "ok: ios/ present"
  fi
  if [[ "$missing" -ne 0 ]]; then
    exit 1
  fi
fi

if [[ "$DO_BUILD_SYNC" -eq 1 ]]; then
  echo "running: npm run build:mobile"
  npm run build:mobile
  echo "ok: build-sync finished"
fi

if [[ "$DO_SYNC_ONLY" -eq 1 ]]; then
  echo "running: npm run cap:sync"
  npm run cap:sync
  echo "ok: sync-only finished"
fi

if [[ "$DO_ADB_FORWARD" -eq 1 ]]; then
  need_cmd adb
  echo "running: adb forward tcp:18081 tcp:18081"
  adb forward tcp:18081 tcp:18081
  echo "ok: port forward set"
fi

if [[ "$DO_OPEN_IOS" -eq 1 ]]; then
  echo "running: npm run cap:ios"
  npm run cap:ios
fi

if [[ "$DO_OPEN_ANDROID" -eq 1 ]]; then
  npm run cap:android
fi

queue_listening() {
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

if [[ "$DO_QUEUE" -eq 1 && -z "${QUEUE_HTTP_TOKEN:-${OTTPLAY_QUEUE_HTTP_TOKEN:-}}" ]]; then
  echo "soft-skip: native HTTP control is off by default; no token supplied"
  if [[ "$REQUIRE_QUEUE" -eq 1 ]]; then
    echo "error: --require-queue requires an explicitly enabled listener and token" >&2
    exit 3
  fi
  DO_QUEUE=0
fi

if [[ "$DO_QUEUE" -eq 1 ]]; then
  need_cmd curl
  QUEUE_SH="$ROOT/scripts/smoke-command-queue.sh"
  if [[ ! -x "$QUEUE_SH" && ! -f "$QUEUE_SH" ]]; then
    echo "error: missing $QUEUE_SH" >&2
    exit 3
  fi
  BASE_URL="${BASE_URL%/}"
  probe_url="${BASE_URL}/api/webhook/commands"
  if ! queue_listening "$probe_url"; then
    echo "soft-skip: command queue not listening at ${BASE_URL}"
    echo "  hint: normal playback does not need HTTP; this check covers explicit opt-in only;"
    echo "        Android host curl needs: adb forward tcp:18081 tcp:18081"
    echo "        then re-run with --queue (or --queue --require-queue)"
    if [[ "$REQUIRE_QUEUE" -eq 1 ]]; then
      echo "error: --require-queue set and queue is down" >&2
      exit 1
    fi
  else
    echo "ok: queue appears reachable at ${BASE_URL} — running smoke-command-queue.sh"
    set +e
    args=()
    if [[ "$QUEUE_ALIASES" -eq 1 ]]; then
      args+=(--aliases)
    fi
    BASE_URL="$BASE_URL" "$QUEUE_SH" "${args[@]+"${args[@]}"}"
    qc=$?
    set -e
    case "$qc" in
      0) echo "ok: command-queue smoke passed" ;;
      1)
        if [[ "$REQUIRE_QUEUE" -eq 1 ]]; then
          echo "error: queue smoke reported not listening" >&2
          exit 1
        fi
        echo "soft-skip: queue smoke reported not listening"
        ;;
      2)
        echo "error: queue smoke assertion failed" >&2
        exit 2
        ;;
      3)
        echo "error: queue smoke usage/deps failed" >&2
        exit 3
        ;;
      *)
        echo "error: queue smoke exited $qc" >&2
        exit 1
        ;;
    esac
  fi
fi

echo "ok: capacitor device-smoke helper finished"
echo "reminder: mark the human UI checklist in docs/mode-b-device-smoke.md"
exit 0
