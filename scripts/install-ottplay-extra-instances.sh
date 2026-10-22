#!/usr/bin/env bash
# Install Dock/launcher wrapper .apps for OttPlay FOSS instances 2/3/4.
#
# Each wrapper shares the binary + Resources from /Applications/OttPlay FOSS.app
# but sets OTTPLAY_INSTANCE=N (isolated app data + WKWebView store) and
# OTTPLAY_QUEUE_PORT=$((18080+N)). Unique CFBundleIdentifier is Dock-only;
# the real binary still uses com.ottplay.foss paths keyed by OTTPLAY_INSTANCE.
set -euo pipefail

MAIN_APP="${OTTPLAY_MAIN_APP:-/Applications/OttPlay FOSS.app}"
MAIN_BIN="$MAIN_APP/Contents/MacOS/ottplay-tauri"

if [[ ! -x "$MAIN_BIN" ]]; then
  echo "error: main app binary missing: $MAIN_BIN" >&2
  echo "Build/install OttPlay FOSS.app first." >&2
  exit 1
fi

# Refuse to wrap a wrapper (previous HOME-based attempt replaced the Mach-O).
if file "$MAIN_BIN" | grep -qi 'Mach-O'; then
  :
else
  echo "error: $MAIN_BIN is not a Mach-O binary (looks like a script wrapper)." >&2
  echo "Reinstall the real OttPlay FOSS.app before creating instance launchers." >&2
  exit 1
fi

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$MAIN_APP/Contents/Info.plist" 2>/dev/null || echo "1.1.38")"

install_one() {
  local n="$1"
  local app="/Applications/OttPlay FOSS ${n}.app"
  local port=$((18080 + n))
  local contents="$app/Contents"
  local macos="$contents/MacOS"
  local ident="com.ottplay.foss.inst${n}"

  rm -rf "$app"
  mkdir -p "$macos"
  ln -sfn "$MAIN_APP/Contents/Resources" "$contents/Resources"

  cat > "$contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>OttPlay FOSS ${n}</string>
  <key>CFBundleExecutable</key>
  <string>ottplay-tauri</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${ident}</string>
  <key>CFBundleName</key>
  <string>OttPlay FOSS ${n}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
</dict>
</plist>
PLIST

  printf 'APPL????' > "$contents/PkgInfo"

  cat > "$macos/ottplay-tauri" <<SH
#!/bin/bash
exec env OTTPLAY_INSTANCE=${n} OTTPLAY_QUEUE_PORT=${port} "${MAIN_BIN}" "\$@"
SH
  chmod +x "$macos/ottplay-tauri"
  echo "installed $app (OTTPLAY_INSTANCE=${n} OTTPLAY_QUEUE_PORT=${port})"
}

for n in 2 3 4; do
  install_one "$n"
done

echo "Done. Launch main + wrappers; data under ~/Library/Application Support/com.ottplay.foss.{2,3,4}"
