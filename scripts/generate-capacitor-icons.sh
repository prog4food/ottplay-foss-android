#!/bin/bash
set -e
cd "$(dirname "$0")/.."
SRC="src-tauri/icons"
# iOS 1024 marketing icon
cp "$SRC/ios/AppIcon-512@2x.png" ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
echo "Icons regenerated from $SRC"
