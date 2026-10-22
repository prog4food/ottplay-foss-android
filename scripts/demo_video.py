#!/usr/bin/env python3
"""Prepare and render local demo recordings with the pinned video-use skill."""

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REVISION = "9575612f066aa517354790a645fd90f9f95a743b"
ROOT = Path(__file__).resolve().parents[1]


def installation():
    root = Path(os.environ.get("VIDEO_USE_HOME", Path.home() / ".codex/skills/video-use"))
    python = root / ".venv/bin/python"
    marker = root / "UPSTREAM_REVISION"
    if not marker.exists() or marker.read_text().strip() != REVISION:
        raise ValueError("Install the pinned video-use revision; see docs/demo-video.md")
    if not python.is_file() or not (root / "helpers/render.py").is_file():
        raise ValueError("Run uv sync in VIDEO_USE_HOME; see docs/demo-video.md")
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            raise ValueError(f"{tool} is required")
    return root, python


def prepare(source):
    source = source.resolve(strict=True)
    if not source.is_file():
        raise ValueError("Select a local video file")
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(source)],
        check=True,
        capture_output=True,
        text=True,
    )
    duration = float(json.loads(probe.stdout)["format"]["duration"])
    if not 0 < duration < 86400:
        raise ValueError("The video duration must be between zero and 24 hours")
    edit = source.parent / "edit"
    edit.mkdir(exist_ok=True)
    if (edit / "edl.json").exists() or (edit / "project.md").exists():
        raise ValueError("An edit already exists here; continue it instead of replacing it")
    data = {
        "sources": {"screen": str(source)},
        "ranges": [{"source": "screen", "start": 0, "end": duration}],
        "overlays": [],
    }
    (edit / "edl.json").write_text(json.dumps(data, indent=2) + "\n")
    (edit / "project.md").write_text(
        f"# {ROOT.name} demo\n\nSource: {source.name}\n\n"
        "Status: unedited full-length recording. Choose a demo scenario from docs/demo-video.md, "
        "then review the cut list before rendering. Keep credentials and private data out of public demos.\n"
    )
    print(edit / "edl.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("doctor")
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("source", type=Path)
    render_parser = commands.add_parser("render")
    render_parser.add_argument("edl", type=Path)
    render_parser.add_argument("--final", action="store_true")
    render_parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args()
    try:
        root, python = installation()
        if args.command == "doctor":
            subprocess.run([str(python), "-c", "import requests, PIL, numpy, matplotlib, librosa"], check=True)
            print(f"video-use {REVISION}: local rendering ready; ffmpeg and ffprobe available.")
            configured = bool(os.environ.get("ELEVENLABS_API_KEY"))
            if not configured and (root / ".env").is_file():
                configured = any(
                    line.startswith("ELEVENLABS_API_KEY=") and len(line.split("=", 1)[1].strip().strip("\"'")) > 0
                    for line in (root / ".env").read_text().splitlines()
                )
            print(
                "Transcription: "
                + (
                    "key configured (not validated)."
                    if configured
                    else "requires ELEVENLABS_API_KEY; local rendering does not."
                )
            )
        elif args.command == "prepare":
            prepare(args.source)
        else:
            edl = args.edl.resolve(strict=True)
            if edl.parent.name != "edit":
                raise ValueError("Keep the EDL in the recording folder's edit/ directory")
            data = json.loads(edl.read_text())
            if not data.get("ranges") or not data.get("sources"):
                raise ValueError("The EDL needs at least one source and range")
            output = edl.parent / ("final.mp4" if args.final else "preview.mp4")
            if output.exists() and not args.overwrite:
                raise ValueError("Output exists; use --overwrite to replace this generated video")
            command = [str(python), str(root / "helpers/render.py"), str(edl), "-o", str(output)]
            if not args.final:
                command.append("--preview")
            # Browser screencasts are silent. Avoid a futile loudness pass and
            # preserve normalization for recordings that actually contain audio.
            has_audio = False
            for source in data["sources"].values():
                media = Path(source)
                if not media.is_absolute():
                    media = edl.parent / media
                probe = subprocess.run(
                    ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index",
                     "-of", "json", str(media.resolve(strict=True))],
                    check=True, capture_output=True, text=True,
                )
                has_audio |= bool(json.loads(probe.stdout).get("streams"))
            if not has_audio:
                command.append("--no-loudnorm")
            subprocess.run(command, check=True, cwd=root)
            subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration,size", "-of", "json", str(output)],
                check=True,
            )
        return 0
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Demo video: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
