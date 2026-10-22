#!/usr/bin/env bash
# Regenerate the hosted, silent demo; no downloads or provider streams required.
set -euo pipefail
DEMO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.local-artifacts/demo-media"
mkdir -p "$DEMO_ROOT"
ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i 'testsrc2=size=640x360:rate=20' -t 24 \
    -c:v libx264 -preset medium -crf 25 -pix_fmt yuv420p -g 40 \
    -keyint_min 40 -sc_threshold 0 -movflags +faststart \
    "$DEMO_ROOT/pattern.mp4"
ffmpeg -hide_banner -loglevel error -y -i "$DEMO_ROOT/pattern.mp4" \
    -c copy -hls_time 2 -hls_playlist_type vod \
    "$DEMO_ROOT/pattern.m3u8"
