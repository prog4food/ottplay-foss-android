#!/usr/bin/env python3
"""Reject Android types unavailable when Capacitor reflects plugin methods.

SDK guards inside methods cannot protect synthetic lambda parameter types:
Class.getDeclaredMethods resolves those types while the bridge starts. Inspect
compiled method descriptors, including private/synthetic methods, against the
SDK's API history. Android lint checks method bodies separately.
"""
import os
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET


def verify(compiled, minimum, sdk):
    history = ET.parse(sdk / "platforms/android-36/data/api-versions.xml")
    introduced = {entry.attrib["name"]: int(entry.get("since", "1"))
                  for entry in history.getroot().findall("class")}
    plugins = sorted(compiled.rglob("*Plugin.class"))
    if not plugins:
        raise ValueError("No compiled Capacitor plugins found")
    java_home = os.environ.get("JAVA_HOME")
    javap = str(Path(java_home) / "bin/javap") if java_home else "javap"
    failures = []
    for plugin in plugins:
        text = subprocess.check_output([javap, "-p", "-s", str(plugin)], text=True)
        for descriptor in re.findall(r"descriptor:\s+(\([^\n]+)", text):
            for name in re.findall(r"L(android/[^;]+);", descriptor):
                since = introduced.get(name)
                if since is None or since > minimum:
                    failures.append(f"{plugin.name}: {name} requires API {since or 'unknown'}")
    if failures:
        raise ValueError("Plugin reflection is incompatible with API " + str(minimum) + ":\n" + "\n".join(failures))
    print(f"PASS {len(plugins)} compiled plugin signatures on API {minimum}, including synthetic callbacks")


if __name__ == "__main__":
    sdk = Path(os.environ.get("ANDROID_HOME") or os.environ["ANDROID_SDK_ROOT"])
    verify(Path(sys.argv[1]), int(sys.argv[2]), sdk)
