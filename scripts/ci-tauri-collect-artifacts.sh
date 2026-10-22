#!/usr/bin/env bash
# Collect Tauri desktop bundles into tauri-artifacts/ for release upload.
# On macOS: always produce .app.zip (ditto) + copy .dmg; fail if either missing.
# Dest names replace spaces with '.' so GitHub asset URLs match README
# (OttPlay.FOSS_aarch64-apple-darwin.app.zip).
set -euo pipefail

TARGET="${TAURI_TARGET:-}"
mkdir -p tauri-artifacts
shopt -s nullglob

resolve_base() {
  local candidates=()
  if [ -n "$TARGET" ]; then
    candidates=(
      "target/$TARGET/release/bundle"
      "src-tauri/target/$TARGET/release/bundle"
    )
  else
    candidates=(
      "target/release/bundle"
      "src-tauri/target/release/bundle"
    )
  fi
  local c
  for c in "${candidates[@]}"; do
    if [ -d "$c" ]; then
      echo "$c"
      return 0
    fi
  done
  # Default even if missing — caller will fail loudly on macOS
  echo "${candidates[0]}"
}

BASE="$(resolve_base)"
echo "Collect base: $BASE (TAURI_TARGET=${TARGET:-host})"

# Verify the complete bundle, not just the linker's executable signature, before
# publishing any of the archives produced from it.
if [[ "${RUNNER_OS:-}" == "macOS" ]]; then
  for app in "$BASE"/macos/*.app; do
    codesign --verify --deep --strict --verbose=2 "$app"
  done
fi

verify_app_zip() {
  local archive="$1" app_name="$2" extracted
  extracted="$(mktemp -d "${TMPDIR:-/tmp}/ottplay-app-zip.XXXXXX")"
  if ! ditto -x -k "$archive" "$extracted" \
    || ! codesign --verify --deep --strict --verbose=2 "$extracted/$app_name"; then
    rm -rf "$extracted"
    return 1
  fi
  rm -rf "$extracted"
}

# Stable release asset name: spaces → dots (matches softprops/GitHub normalize)
sanitize_name() {
  local s="$1"
  s="${s// /.}"
  echo "$s"
}

copy_one() {
  local f="$1"
  local name ext base dest stem ext_stem base_stem
  name="$(basename "$f")"
  # Preserve multi-dot names like .app.tar.gz / .AppImage.sig
  if [[ "$name" == *.app.tar.gz.sig ]]; then
    dest="tauri-artifacts/$(sanitize_name "${name%.app.tar.gz.sig}${TARGET:+_${TARGET}}").app.tar.gz.sig"
  elif [[ "$name" == *.app.tar.gz ]]; then
    dest="tauri-artifacts/$(sanitize_name "${name%.app.tar.gz}${TARGET:+_${TARGET}}").app.tar.gz"
  elif [[ "$name" == *.sig ]]; then
    # e.g. foo.AppImage.sig / foo.msi.sig / foo-setup.exe.sig
    stem="${name%.sig}"
    ext_stem="${stem##*.}"
    base_stem="${stem%.*}"
    dest="tauri-artifacts/$(sanitize_name "${base_stem}${TARGET:+_${TARGET}}").${ext_stem}.sig"
  else
    ext="${name##*.}"
    base="${name%.*}"
    dest="tauri-artifacts/$(sanitize_name "${base}${TARGET:+_${TARGET}}").${ext}"
  fi
  cp -v "$f" "$dest"
}

for f in \
  "$BASE"/dmg/*.dmg \
  "$BASE"/deb/*.deb \
  "$BASE"/rpm/*.rpm \
  "$BASE"/appimage/*.AppImage \
  "$BASE"/appimage/*.AppImage.sig \
  "$BASE"/msi/*.msi \
  "$BASE"/msi/*.msi.sig \
  "$BASE"/nsis/*.exe \
  "$BASE"/nsis/*.exe.sig \
  "$BASE"/macos/*.app.tar.gz \
  "$BASE"/macos/*.app.tar.gz.sig
do
  copy_one "$f"
done

if [[ "${RUNNER_OS:-}" == "macOS" ]]; then
  for app in "$BASE"/macos/*.app; do
    app_base="$(basename "$app" .app)"
    dest="tauri-artifacts/$(sanitize_name "${app_base}${TARGET:+_${TARGET}}").app.zip"
    ditto -c -k --sequesterRsrc --keepParent "$app" "$dest"
    verify_app_zip "$dest" "$(basename "$app")"
    echo "Zipped $app -> $dest"
  done
fi

echo Collected:
ls -la tauri-artifacts/ || true

if [[ "${RUNNER_OS:-}" == "macOS" ]]; then
  zips=(tauri-artifacts/*.app.zip)
  dmgs=(tauri-artifacts/*.dmg)
  if [ ${#zips[@]} -eq 0 ] || [ ${#dmgs[@]} -eq 0 ]; then
    echo "ERROR: macOS release requires both .app.zip and .dmg under tauri-artifacts/" >&2
    echo "Looking under BASE=$BASE ..." >&2
    ls -la "$BASE" 2>/dev/null || true
    ls -la "$BASE/macos" 2>/dev/null || true
    ls -la "$BASE/dmg" 2>/dev/null || true
    find target src-tauri/target -path '*/bundle/macos/*' -o -path '*/bundle/dmg/*' 2>/dev/null | head -40 || true
    exit 1
  fi
elif [ -z "$(ls -A tauri-artifacts 2>/dev/null)" ]; then
  echo "No desktop bundles produced for this matrix entry"
  exit 0
fi
