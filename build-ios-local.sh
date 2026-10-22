#!/usr/bin/env bash
# Build OttPlay FOSS Capacitor iOS archive / unsigned IPA for sideload.
# Pattern mirrors inverter-desktop/build-ios-local.sh (Cap Xcode project under ios/).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

OUTPUT_DIR="dist/ios"
PROJECT="ios/App/App.xcodeproj"
SCHEME="App"
BUNDLE_ID="play.ott.foss"
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")

usage() {
  echo "Usage: $0 [--clean] [--dev] [--update-deps]"
  echo "  --clean        Clean DerivedData / prior archives"
  echo "  --dev          Debug configuration"
  echo "  --update-deps  npm update before building"
  echo ""
  echo "Default: unsigned Release archive → dist/ios/*.ipa (no Apple Developer Program required)."
  echo "User has no paid Apple Developer certs — keep builds unsigned/sideload-friendly."
  exit 1
}

CLEAN=false
RELEASE=true
UPDATE_DEPS=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --clean) CLEAN=true; shift ;;
    --dev) RELEASE=false; shift ;;
    --update-deps) UPDATE_DEPS=true; shift ;;
    --help|-h) usage ;;
    *) usage ;;
  esac
done

echo "╔═════════════════════════════════════════════════════╗"
echo "║  OttPlay FOSS — iOS (Capacitor) local build         ║"
echo "╠═════════════════════════════════════════════════════╣"
echo "║  1. Xcode check                                     ║"
echo "║  2. npm ci + build:mobile                           ║"
echo "║  3. xcodebuild archive (iphoneos, unsigned)         ║"
echo "║  4. Package .ipa → dist/ios/                        ║"
echo "╚═════════════════════════════════════════════════════╝"
echo "  version=$VERSION bundle=$BUNDLE_ID"
echo ""

command -v xcodebuild >/dev/null 2>&1 || { echo "  ✗ xcodebuild missing"; exit 1; }
echo "  ✓ $(xcodebuild -version | head -1)"

if [[ "$CLEAN" == true ]]; then
  echo "===> Cleaning..."
  rm -rf ios/build dist/ios
  echo "  ✓ Cleaned"
fi

if [[ "$UPDATE_DEPS" == true ]]; then
  npm update && npm install
else
  npm ci
fi

echo ""
echo "===> Building web + Capacitor sync..."
npm run build:mobile

CONFIG=Release
[[ "$RELEASE" == true ]] || CONFIG=Debug
DERIVED_DATA="$ROOT/ios/build/DerivedData"
ARCHIVE_PATH="$ROOT/ios/build/OttPlayFOSS.xcarchive"
rm -rf "$DERIVED_DATA" "$ARCHIVE_PATH"

echo ""
echo "===> xcodebuild archive ($CONFIG)..."
# CODE_SIGNING_ALLOWED=NO for unsigned / free Apple ID sideload path
xcodebuild clean archive \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -sdk iphoneos \
  -configuration "$CONFIG" \
  -archivePath "$ARCHIVE_PATH" \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY=- \
  ONLY_ACTIVE_ARCH=NO \
  ARCHS=arm64

APP_DIR="$ARCHIVE_PATH/Products/Applications"
if [[ ! -d "$APP_DIR" ]]; then
  echo "  ✗ No .app in archive" >&2
  exit 1
fi

echo ""
echo "===> Packaging .ipa..."
rm -rf Payload
mkdir Payload
cp -R "$APP_DIR/"*.app Payload/
IPA_NAME="ottplay-foss-${VERSION}-unsigned.ipa"
[[ "$RELEASE" == true ]] || IPA_NAME="ottplay-foss-${VERSION}-debug-unsigned.ipa"
zip -qr "$IPA_NAME" Payload
rm -rf Payload
mkdir -p "$OUTPUT_DIR"
mv "$IPA_NAME" "$OUTPUT_DIR/"

echo ""
echo "========================================"
echo "  iOS build complete!"
echo "  Artifacts: $OUTPUT_DIR/"
ls -1 "$OUTPUT_DIR"
echo "  Sideload via AltStore / Sideloadly / TrollStore"
echo "========================================"
date
