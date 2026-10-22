#!/usr/bin/env bash
set -euo pipefail
sudo apt-get update
sudo apt-get install -y libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
  gstreamer1.0-libav gstreamer1.0-tools

# WebKitGTK only suggests some codecs on Ubuntu. Verify the actual bundled
# decoder path before building any media-player package.
bash scripts/check-linux-media-codecs.sh
