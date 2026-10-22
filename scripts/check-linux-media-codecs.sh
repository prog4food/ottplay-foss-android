#!/usr/bin/env bash
# Validate the Linux build image's codecs against the checked-in H.264/AAC TS.
# This is a codec preflight, not a native WebKit or desktop acceptance test.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
for plugin in playback typefindfunctions isomp4 soup mpegtsdemux videoparsersbad audioparsers libav; do
  gst-inspect-1.0 "$plugin" >/dev/null
done
# The maintained adaptive demuxer and its legacy counterpart serve different
# GStreamer playback graphs; require at least one HLS factory.
if ! gst-inspect-1.0 hlsdemux2 >/dev/null 2>&1; then
  gst-inspect-1.0 hlsdemux >/dev/null
fi
# Require actual decoded buffers on both branches as well as clean EOS.
# An empty fixture or a pipeline that never exposes a stream must not pass.
log="$(mktemp)"
trap 'rm -f -- "$log"' EXIT
if ! timeout 30s gst-launch-1.0 -v \
  filesrc location="$ROOT/tests/fixtures/media-runtime/segment00.ts" ! tsdemux name=demux \
  demux. ! queue ! h264parse ! avdec_h264 ! identity name=decoded_video silent=false ! fakesink sync=false \
  demux. ! queue ! aacparse ! avdec_aac ! identity name=decoded_audio silent=false ! fakesink sync=false >"$log" 2>&1; then
  cat "$log"
  exit 1
fi
for stream in video audio; do
  if ! grep -q "GstIdentity:decoded_${stream}: last-message = chain" "$log"; then
    cat "$log"
    echo "No decoded $stream buffers observed" >&2
    exit 1
  fi
done
echo "Linux media codec preflight passed: decoded video and audio buffers, clean EOS"
