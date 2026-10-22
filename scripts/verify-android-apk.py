#!/usr/bin/env python3
"""Check the real APK manifest, independently of bundled frontend metadata."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def verify_badging(badging, version, min_sdk=24):
    package = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging, re.M)
    if not package or package.groups() != ("play.ott.foss", str(version["versionCode"]), version["versionName"]):
        raise ValueError("APK application ID/version differs from android/version.json")
    if min_sdk not in (22, 24) or not re.search(r"^sdkVersion:'" + str(min_sdk) + "'$", badging, re.M):
        raise ValueError("APK minimum SDK differs from its runtime target")
    if not re.search(r"^targetSdkVersion:'36'$", badging, re.M):
        raise ValueError("Unexpected Android target SDK")
    if "launchable-activity: name='play.ott.foss.MainActivity'" not in badging:
        raise ValueError("APK launcher is missing")


def main():
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        raise ValueError("ANDROID_HOME is required to verify APK metadata")
    aapt = Path(sdk) / "build-tools/36.0.0" / ("aapt.exe" if os.name == "nt" else "aapt")
    badging = subprocess.check_output([str(aapt), "dump", "badging", sys.argv[1]], text=True)
    verify_badging(badging, json.loads((ROOT / "android/version.json").read_text()), int(sys.argv[2]) if len(sys.argv) > 2 else 24)
    print("PASS APK manifest: package, version, SDK and launcher")


if __name__ == "__main__":
    main()
