#!/usr/bin/env bash
# Build OttPlay FOSS for iOS Simulator, boot a sim, install, and launch.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PROJECT="ios/App/App.xcodeproj"
SCHEME="App"
BUNDLE_ID="play.ott.foss"
DERIVED_DATA="$ROOT/ios/build/SimDerivedData"
DEVICE_NAME="${IOS_SIM_DEVICE:-iPhone 16}"

CLEAN=false
UPDATE_DEPS=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=true; shift ;;
    --update-deps) UPDATE_DEPS=true; shift ;;
    --device) DEVICE_NAME="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--clean] [--update-deps] [--device 'iPhone 16']"
      echo "Env: IOS_SIM_DEVICE (default: iPhone 16)"
      exit 0
      ;;
    *) echo "Unknown: $1" >&2; exit 1 ;;
  esac
done

echo "╔═════════════════════════════════════════════════════╗"
echo "║  OttPlay FOSS — iOS Simulator build & launch        ║"
echo "╚═════════════════════════════════════════════════════╝"

command -v xcodebuild >/dev/null 2>&1 || { echo "✗ xcodebuild missing"; exit 1; }
command -v xcrun >/dev/null 2>&1 || { echo "✗ xcrun missing"; exit 1; }

if [[ "$CLEAN" == true ]]; then
  rm -rf "$DERIVED_DATA"
fi

if [[ "$UPDATE_DEPS" == true ]]; then
  npm update && npm install
else
  npm ci
fi

echo "===> build:mobile..."
npm run build:mobile

echo "===> Finding simulator: $DEVICE_NAME"
UDID=$(xcrun simctl list devices available | awk -v n="$DEVICE_NAME" '
  $0 ~ n && $0 ~ /\([A-F0-9-]{36}\)/ {
    if (match($0, /\([A-F0-9-]{36}\)/)) {
      print substr($0, RSTART+1, RLENGTH-2); exit
    }
  }')
if [[ -z "${UDID:-}" ]]; then
  echo "  ✗ No available simulator matching '$DEVICE_NAME'" >&2
  echo "  Available:" >&2
  xcrun simctl list devices available | grep -E 'iPhone|iPad' | head -20 >&2
  exit 1
fi
echo "  ✓ UDID=$UDID"

echo "===> Booting Simulator..."
open -a Simulator || true
xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b

echo "===> xcodebuild for iphonesimulator..."
rm -rf "$DERIVED_DATA"
xcodebuild build \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "id=$UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY=-

APP_PATH=$(find "$DERIVED_DATA/Build/Products" -type d -name '*.app' | head -1 || true)
if [[ -z "${APP_PATH:-}" ]]; then
  echo "  ✗ .app not found under DerivedData" >&2
  exit 1
fi
echo "  ✓ APP=$APP_PATH"

echo "===> Install + launch $BUNDLE_ID..."
xcrun simctl uninstall "$UDID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl launch "$UDID" "$BUNDLE_ID"

echo ""
echo "========================================"
echo "  Simulator running: $DEVICE_NAME ($UDID)"
echo "  Bundle: $BUNDLE_ID"
echo "========================================"
date
