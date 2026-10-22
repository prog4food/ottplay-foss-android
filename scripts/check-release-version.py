#!/usr/bin/env python3
"""Check the committed base or the exact frozen candidate version overlay."""

import sys
from pathlib import Path

from release_version_adapter import checked_version

root = Path(__file__).resolve().parents[1]
version, channel = sys.argv[1:]
actual = checked_version(root, version, channel)
print(f"Validated base {version} for {channel}; package version {actual}")
