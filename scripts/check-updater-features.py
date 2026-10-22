#!/usr/bin/env python3
"""Verify updater archive support against Cargo's resolved target graphs."""

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {
    "x86_64-pc-windows-msvc": {"tauri-plugin-updater", "reqwest", "rustls"},
    "aarch64-apple-darwin": {"tauri-plugin-updater", "tar", "flate2"},
    "x86_64-unknown-linux-gnu": {"tauri-plugin-updater", "tar", "flate2"},
}

for target, required in TARGETS.items():
    result = subprocess.run(
        ["cargo", "tree", "--locked", "--target", target, "-p", "ottplay-tauri",
         "--edges", "normal", "--prefix", "none", "--format", "{p}"],
        cwd=ROOT, text=True, capture_output=True, check=True,
    )
    packages = {line.split()[0] for line in result.stdout.splitlines() if line.strip()}
    missing = required - packages
    if missing:
        raise SystemExit(f"{target}: missing required updater packages: {sorted(missing)}")
    if "zip" in packages:
        raise SystemExit(f"{target}: unexpected ZIP extraction dependency")
    print(f"PASS {target}: required updater transports present; ZIP extraction absent")
