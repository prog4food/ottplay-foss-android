#!/usr/bin/env python3
"""Verify actual encoded media: video, duration, audible stereo routing and silence."""
import array
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def check(path):
    data = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ]))
    video = [s for s in data["streams"] if s["codec_type"] == "video"]
    audio = [s for s in data["streams"] if s["codec_type"] == "audio"]
    assert len(video) == len(audio) == 1, "Expected one video and one audio stream"
    assert video[0]["codec_name"] == "h264" and video[0]["pix_fmt"] == "yuv420p"
    assert (video[0]["width"], video[0]["height"]) == (640, 360)
    assert audio[0]["codec_name"] == "aac" and audio[0]["channels"] == 2
    assert abs(float(data["format"]["duration"]) - 8) < 0.1
    pcm = array.array("f")
    pcm.frombytes(subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-f", "f32le",
        "-ac", "2", "-ar", "48000", "-"
    ]))
    if sys.byteorder != "little":
        pcm.byteswap()
    energies = []
    for start, end in [(0.04, 0.10), (2.04, 2.10), (4.04, 4.10), (6.5, 7.5)]:
        energies.append([sum(v * v for v in pcm[int(start*48000)*2+c:int(end*48000)*2:2]) /
                         int((end-start)*48000) for c in range(2)])
    assert energies[0][0] > 0.0005 and energies[0][1] < 0.000001, "Left channel not isolated"
    assert energies[1][1] > 0.0005 and energies[1][0] < 0.000001, "Right channel not isolated"
    assert min(energies[2]) > 0.0005, "Both channels must be audible"
    assert max(energies[3]) < 0.000001, "Final interval must be silent"
    assert max(abs(v) for v in pcm) < 0.08, "Diagnostic tone exceeds intended peak"
    print(json.dumps({"fixture": path.name, "bytes": path.stat().st_size,
                      "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                      "duration_seconds": 8, "channels": 2, "verified": True}))


if __name__ == "__main__":
    check(Path(sys.argv[1] if len(sys.argv) > 1 else "diagnostics/av-v1.mp4"))
