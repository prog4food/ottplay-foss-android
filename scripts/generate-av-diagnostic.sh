#!/usr/bin/env bash
# Original synthetic A/V fixture. No downloaded/provider media.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="${1:-$ROOT/diagnostics/av-v1.mp4}"
mkdir -p "$(dirname "$OUTPUT")"
# Stereo, -26 dBFS peak: left 0-2 s; right 2-4 s; both 4-6 s;
# final two seconds silent. The corresponding half flashes on each beep.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=640x360:rate=25:duration=8' \
  -f lavfi -i 'aevalsrc=0.05*sin(2*PI*440*t)*lt(mod(t\,1)\,0.15)*(lt(t\,2)+between(t\,4\,5.99))|0.05*sin(2*PI*880*t)*lt(mod(t\,1)\,0.15)*between(t\,2\,5.99):s=48000:d=8:c=stereo' \
  -vf "drawbox=x=0:y=0:w=320:h=100:color=white:t=fill:enable='lt(mod(t,1),0.15)*(lt(t,2)+between(t,4,5.99))',drawbox=x=320:y=0:w=320:h=100:color=white:t=fill:enable='lt(mod(t,1),0.15)*between(t,2,5.99)'" \
  -map 0:v:0 -map 1:a:0 -map_metadata -1 -c:v libx264 -profile:v baseline \
  -level:v 3.0 -pix_fmt yuv420p -preset medium -crf 28 -g 50 -keyint_min 50 \
  -sc_threshold 0 -c:a aac -b:a 96k -ac 2 -ar 48000 -movflags +faststart \
  -shortest "$OUTPUT"
python3 "$ROOT/scripts/check-av-diagnostic.py" "$OUTPUT"
