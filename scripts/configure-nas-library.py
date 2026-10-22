#!/usr/bin/env python3
"""Configure the installed macOS player without printing Plex/client credentials."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import secrets
import shlex
import subprocess
import tempfile
from urllib.parse import urlencode, urlsplit
import xml.etree.ElementTree as ET


def private_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".nas-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plex-url", required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--synology", help="Existing SSH host alias, e.g. synology")
    source.add_argument("--token-file", type=Path, help="Private file containing the Plex token")
    parser.add_argument("--plex-preferences", default="/volume1/PlexMediaServer/AppData/Plex Media Server/Preferences.xml")
    parser.add_argument("--player-url", required=True, help="Player origin reachable by other devices")
    parser.add_argument("--plist", type=Path, default=Path.home() / "Library/LaunchAgents/com.ottplay-foss-local.plist")
    parser.add_argument("--connections", type=Path, default=Path.home() / ".config/ottplay/nas-library.json")
    parser.add_argument("--restart", action="store_true")
    args = parser.parse_args()
    for value in (args.plex_url, args.player_url):
        try:
            parsed = urlsplit(value)
            port = parsed.port
        except ValueError:
            parser.error("URLs must have a valid HTTP(S) hostname and port")
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username is not None or parsed.password is not None
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or (port is not None and port == 0)
                or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value)
                or "\\" in value):
            parser.error("URLs must be HTTP(S) origins without credentials or paths")
    config = plistlib.loads(args.plist.read_bytes())
    env = config.setdefault("EnvironmentVariables", {})
    if args.synology:
        if args.synology.startswith("-") or any(c.isspace() for c in args.synology):
            parser.error("Invalid SSH alias")
        # Capture stdout privately. Neither the token nor Preferences.xml is logged.
        result = subprocess.run([
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", args.synology,
            "sudo -n cat " + shlex.quote(args.plex_preferences),
        ], capture_output=True, timeout=30, check=False)
        if result.returncode:
            raise SystemExit("Could not read Plex preferences through the configured SSH connection")
        token = ET.fromstring(result.stdout).get("PlexOnlineToken", "")
    else:
        token = args.token_file.read_text().strip()
    if not token or any(c in token for c in "\r\n"):
        raise SystemExit("Plex token is absent or invalid")
    env["OTTPLAY_PLEX_URL"] = args.plex_url.rstrip("/")
    env["OTTPLAY_PLEX_TOKEN"] = token
    env.setdefault("OTTPLAY_NAS_KEY", secrets.token_urlsafe(36))
    if not re.fullmatch(r'[^\[\]\s<>"\\\x00-\x1f\x7f]{32,1024}', env["OTTPLAY_NAS_KEY"]):
        raise SystemExit("Existing OTTPLAY_NAS_KEY must contain 32–1024 VPortal-compatible characters")
    backup = args.plist.parent / ".ottplay-backups" / (args.plist.name + ".before-nas")
    if not backup.exists():
        private_write(backup, args.plist.read_bytes())
    private_write(args.plist, plistlib.dumps(config))
    base = args.player_url.rstrip("/")
    key = env["OTTPLAY_NAS_KEY"]
    private_write(args.connections, (json.dumps({
        "player": base + "/",
        "vportal": "portal::[key:" + key + "]" + base + "/nas/api",
        "playlist": base + "/nas/playlist.m3u?" + urlencode({"key": key}),
    }, ensure_ascii=False, indent=2) + "\n").encode())
    if args.restart:
        # kickstart reuses launchd's cached environment. Reload the changed plist.
        domain = "gui/" + str(os.getuid())
        subprocess.run(["launchctl", "bootout", domain + "/" + config["Label"]],
                       capture_output=True, check=False)
        subprocess.run(["launchctl", "bootstrap", domain, str(args.plist)], check=True)
    print("NAS configuration saved; existing listeners and service options preserved.")
    print("Private connection links: " + str(args.connections))
    print("macOS may ask to allow ottplay-server to access devices on the local network.")
    if not args.restart:
        print("Restart the player service after deploying the NAS-capable binary.")


if __name__ == "__main__":
    main()
