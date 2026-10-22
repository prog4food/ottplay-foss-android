#!/usr/bin/env python3
"""Build an app-private Noble playback plugin; never install into the host.

Inputs and host plugin identities are deliberately pinned. A security update
requires reviewing sources.json, not silently retaining an older replacement.
"""

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
CONFIG = REPO / "packaging/linux-playback-compat"
MAX_EXTRACTED_BYTES = 100 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def run(args, *, cwd=None, env=None, timeout=120):
    try:
        return subprocess.run(args, cwd=cwd, env=env, timeout=timeout, check=True,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT).stdout
    except subprocess.CalledProcessError as error:
        # Preserve the compiler/loader diagnosis in CI instead of hiding it in
        # CalledProcessError.output while reporting only the command's status.
        print(error.stdout, file=sys.stderr)
        raise


def validate_host(config, os_release, machine, package_version, plugin_hash):
    require(os_release.get("ID") == "ubuntu" and os_release.get("VERSION_ID") == "24.04",
            "Compatibility plugin must be built on Ubuntu 24.04")
    require(machine in config["architectures"], "Unsupported native build architecture")
    require(package_version == config["source_package_version"],
            "Installed GStreamer package changed; review the pinned compatibility inputs")
    require(plugin_hash == config["architectures"][machine]["original_plugin_sha256"],
            "Installed playback plugin differs from the reviewed official package")


def fetch(item, destination, cache=None):
    require(item["url"].startswith("https://ports.ubuntu.com/ubuntu-ports/pool/main/"),
            "Unexpected source download origin")
    # A source archive can be rebuilt offline; cached inputs receive the same checks.
    if cache is not None:
        with (cache / item["name"]).open("rb") as stream:
            data = stream.read(item["size"] + 1)
    else:
        # Read one extra byte to reject oversized responses without unbounded memory.
        with urllib.request.urlopen(item["url"], timeout=60) as response:
            require(response.url.startswith("https://ports.ubuntu.com/ubuntu-ports/"),
                    "Source download redirected outside the pinned origin")
            data = response.read(item["size"] + 1)
    require(len(data) == item["size"], "Source download size mismatch: " + item["name"])
    require(hashlib.sha256(data).hexdigest() == item["sha256"],
            "Source download digest mismatch: " + item["name"])
    destination.write_bytes(data)


def extract_source(archive, destination):
    with tarfile.open(archive, "r:xz") as source:
        members = source.getmembers()
        require(len(members) <= 10000, "Too many source archive members")
        require(sum(member.size for member in members) <= MAX_EXTRACTED_BYTES,
                "Source archive expands beyond its bound")
        for member in members:
            name = Path(member.name)
            require(not name.is_absolute() and ".." not in name.parts,
                    "Source archive contains an unsafe path")
            # These pinned source archives need no links or special devices.
            require(member.isfile() or member.isdir(), "Source archive contains a non-regular entry")
        source.extractall(destination, members=members, filter="data")


def patch_source(source, config):
    lines = (source / "debian/patches/series").read_text().splitlines()
    names = [line.split("#", 1)[0].strip() for line in lines]
    names = [name for name in names if name]
    require(names == [patch["name"] for patch in config["distribution_patches"]],
            "Distribution security patch series changed")
    for item in config["distribution_patches"]:
        patch = source / "debian/patches" / item["name"]
        require(sha(patch) == item["sha256"], "Distribution patch digest mismatch")
        run(["patch", "--batch", "--fuzz=0", "-p1", "-i", str(patch)], cwd=source)
    implementation = source / "gst/playback/gststreamsynchronizer.c"
    require(sha(implementation) == config["source_before_sha256"], "Unexpected unpatched source")
    for name, digest in config["patches"].items():
        require(sha(CONFIG / name) == digest, "Backport provenance mismatch")
    run(["patch", "--batch", "--fuzz=0", "-p1", "-i", str(CONFIG / "backport.patch")], cwd=source)
    require(sha(implementation) == config["source_after_sha256"], "Unexpected patched source")


def inspect_elf(plugin):
    header = run(["readelf", "-h", str(plugin)])
    dynamic = run(["readelf", "-dW", str(plugin)])
    programs = run(["readelf", "-lW", str(plugin)])
    versions = run(["readelf", "-VW", str(plugin)])
    exports = run(["nm", "-D", "--defined-only", str(plugin)])
    return {
        "class": re.search(r"Class:\s+(\S+)", header).group(1),
        "machine": re.search(r"Machine:\s+(.+)", header).group(1).strip(),
        "needed": sorted(re.findall(r"\(NEEDED\).*?\[(.*?)\]", dynamic)),
        "soname": re.findall(r"\(SONAME\).*?\[(.*?)\]", dynamic),
        "exports": sorted(line.split()[-1] for line in exports.splitlines() if line.strip()),
        "glibc_versions": sorted(set(re.findall(r"\bGLIBC_[0-9.]+", versions))),
        "bind_now": "BIND_NOW" in dynamic or any(
            "(FLAGS_1)" in line and "NOW" in line.split() for line in dynamic.splitlines()),
        "relro": "GNU_RELRO" in programs,
        "has_rpath": "(RPATH)" in dynamic or "(RUNPATH)" in dynamic,
    }


def validate_elf(original, replacement, machine):
    require(replacement["class"] == "ELF64" and replacement["machine"] == machine,
            "Replacement ELF architecture mismatch")
    for key in ("class", "machine", "needed", "soname", "exports"):
        require(original[key] == replacement[key], "Replacement ELF contract changed: " + key)
    require(set(replacement["glibc_versions"]) <= set(original["glibc_versions"]),
            "Replacement requires additional glibc symbol versions")
    require(replacement["bind_now"] and replacement["relro"], "Replacement lost Debian hardening")
    require(not replacement["has_rpath"], "Replacement has a runtime search path")


def validate_regression(result):
    require(result == {"variant": "patched", "audio_segment_blocked": False,
                       "expected_blocked": False, "audio_segment_accepted": True,
                       "released_for_cleanup": False},
            "Playback stream-start/flush regression did not complete and accept the segment")


def plugin_inventory(directory):
    paths = sorted(directory.iterdir())
    require(paths and len(paths) < 1000, "Unexpected GStreamer plugin directory size")
    # Ubuntu's -dev package adds this header directory beside the runtime plugins.
    # It is not a plugin and must not be copied into the AppImage runtime.
    plugins = []
    for path in paths:
        require(not path.is_symlink(), "Linked GStreamer plugin directory entry: " + path.name)
        if path.name == "include":
            require(path.is_dir(), "Unexpected GStreamer development entry: " + path.name)
            continue
        require(path.is_file(), "Unexpected GStreamer plugin directory entry: " + path.name)
        plugins.append(path)
    require(plugins, "GStreamer plugin directory contains no runtime plugins")
    require(sum(path.stat().st_size for path in plugins) < 500 * 1024 * 1024,
            "GStreamer plugin directory exceeds copy bound")
    return {path.name: sha(path) for path in plugins}


def source_archive(destination, files):
    """Reproducible archive metadata; actual source and complete build recipe travel together."""
    with tarfile.open(destination, "w:xz", format=tarfile.PAX_FORMAT) as archive:
        for name, path in sorted(files.items()):
            info = archive.gettarinfo(str(path), arcname="linux-playback-compat/" + name)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = 0
            info.mode = 0o644
            with path.open("rb") as stream:
                archive.addfile(info, stream)


def build(output, source_cache=None):
    require(platform.system() == "Linux", "Linux build host required")
    config = json.loads((CONFIG / "sources.json").read_text())
    require(config["schema"] == 1, "Unknown compatibility input schema")
    machine = platform.machine()
    require(machine in config["architectures"], "Unsupported native build architecture")
    arch = config["architectures"][machine]
    plugin_dir = Path("/usr/lib") / arch["triplet"] / "gstreamer-1.0"
    original = plugin_dir / "libgstplayback.so"
    package_version = run(["dpkg-query", "-W", "-f=${Version}",
                           "gstreamer1.0-plugins-base:" + arch["debian"]]).strip()
    validate_host(config, platform.freedesktop_os_release(), machine, package_version, sha(original))
    require(not output.exists(), "Output already exists; retain evidence and choose a fresh directory")
    output.mkdir(parents=True)
    inventory = plugin_inventory(plugin_dir)
    original_elf = inspect_elf(original)
    packages_before = run(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${Architecture}\n"])
    with tempfile.TemporaryDirectory(prefix=".playback-build-", dir=output.parent) as temporary:
        work = Path(temporary)
        downloaded = {}
        for item in config["source_files"]:
            downloaded[item["name"]] = work / item["name"]
            fetch(item, downloaded[item["name"]], source_cache)
        extract_source(downloaded["gst-plugins-base1.0_1.24.2.orig.tar.xz"], work)
        source = work / "gst-plugins-base-1.24.2"
        extract_source(downloaded["gst-plugins-base1.0_1.24.2-1ubuntu0.5.debian.tar.xz"], source)
        require(sha(source / "COPYING") == sha(CONFIG / "COPYING"), "Upstream license changed")
        require(sha(source / "debian/copyright") == sha(CONFIG / "debian-copyright"),
                "Distribution copyright changed")
        patch_source(source, config)
        build_env = dict(os.environ, DEB_BUILD_MAINT_OPTIONS="hardening=+all",
                         DEB_LDFLAGS_MAINT_APPEND="-Wl,-O1 -Wl,-z,defs")
        flags = {key: run(["dpkg-buildflags", "--get", key], env=build_env).strip()
                 for key in ("CPPFLAGS", "CFLAGS", "LDFLAGS")}
        # dpkg's default mapping covers the caller's cwd, not this random build
        # directory. Normalize both emitted __FILE__ values and debug records.
        flags["CFLAGS"] += " " + shlex.join([
            f"-ffile-prefix-map={work}=/usr/src/ottplay-playback-compat",
            f"-fdebug-prefix-map={work}=/usr/src/ottplay-playback-compat",
        ])
        build_env.update(CFLAGS=flags["CPPFLAGS"] + " " + flags["CFLAGS"], LDFLAGS=flags["LDFLAGS"])
        build_dir = work / "build"
        setup = ["meson", "setup", str(build_dir), str(source), "--buildtype=release",
                 "-Dauto_features=disabled", "-Dplayback=enabled", "-Dtests=disabled",
                 "-Dtools=disabled", "-Dexamples=disabled", "-Dintrospection=disabled",
                 "-Dnls=disabled", "-Dorc=disabled", "-Dpackage-name=Ubuntu app-private compatibility build",
                 "-Dpackage-origin=https://ports.ubuntu.com/ubuntu-ports/"]
        (output / "meson.log").write_text(run(setup, env=build_env, timeout=300))
        (output / "ninja.log").write_text(run(
            ["ninja", "-C", str(build_dir), "-j2", "gst/playback/libgstplayback.so"], timeout=900))
        private_dir = output / "private/gstreamer-1.0"
        private_dir.mkdir(parents=True)
        replacement = private_dir / "libgstplayback.so"
        shutil.copy2(build_dir / "gst/playback/libgstplayback.so", replacement)
        run(["patchelf", "--remove-rpath", str(replacement)])
        replacement_elf = inspect_elf(replacement)
        validate_elf(original_elf, replacement_elf, arch["elf_machine"])
        linkage = run(["ldd", "-r", str(replacement)])
        require("not found" not in linkage and "undefined symbol" not in linkage, "Plugin linkage failed")
        (output / "linkage.txt").write_text(linkage)
        scanner_env = dict(os.environ, GST_PLUGIN_PATH_1_0=str(private_dir),
                           GST_PLUGIN_SYSTEM_PATH_1_0=str(plugin_dir),
                           GST_REGISTRY=str(work / "registry.bin"))
        scanner = run(["gst-inspect-1.0", str(replacement)], env=scanner_env)
        loaded = re.findall(r"^\s*Filename\s+(.+)$", scanner, flags=re.MULTILINE)
        require(loaded == [str(replacement)], "Scanner did not load the staged plugin")
        (output / "scanner.txt").write_text(scanner)
        regression_source = CONFIG / "regression.c"
        require(sha(regression_source) == config["regression_source_sha256"],
                "Stream synchronizer regression source changed")
        regression = output / "regression-check"
        gst_flags = shlex.split(run(["pkg-config", "--cflags", "--libs", "gstreamer-1.0"]))
        run(["cc", "-Wall", "-Wextra", "-Werror", "-O2", str(regression_source),
             "-o", str(regression), *gst_flags])
        regression_env = dict(os.environ, GST_PLUGIN_SYSTEM_PATH_1_0="",
                              GST_PLUGIN_PATH_1_0=str(private_dir),
                              GST_REGISTRY=str(work / "regression-registry.bin"))
        regression_result = json.loads(run([str(regression), str(replacement), "patched"],
                                           env=regression_env, timeout=15))
        validate_regression(regression_result)
        write_json(output / "regression.json", regression_result)
        require(plugin_inventory(plugin_dir) == inventory, "Host plugins changed during build")
        appimage = output / "appimage-plugins"
        appimage.mkdir()
        for name in inventory:
            shutil.copy2(replacement if name == "libgstplayback.so" else plugin_dir / name, appimage / name)
        expected = dict(inventory, **{"libgstplayback.so": sha(replacement)})
        require(plugin_inventory(appimage) == expected, "AppImage plugin staging mismatch")
        runtime = {"schema": 1, "os_id": "ubuntu", "os_version": "24.04", "architecture": machine,
                   "source_package_version": config["source_package_version"],
                   "original_plugin_sha256": inventory["libgstplayback.so"],
                   "replacement_plugin_sha256": sha(replacement)}
        write_json(output / "runtime-manifest.json", runtime)
        sources = {"sources/" + name: path for name, path in downloaded.items()}
        sources.update({"packaging/linux-playback-compat/" + path.name: path
                        for path in CONFIG.iterdir() if path.is_file()})
        sources["scripts/build-linux-playback-compat.py"] = Path(__file__).resolve()
        source_archive(output / "corresponding-source.tar.xz", sources)
        packages_after = run(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${Architecture}\n"])
        require(packages_after == packages_before, "Host packages changed during build")
        (output / "builder-packages.tsv").write_text(packages_before)
        write_json(output / "build-receipt.json", {
            "schema": 1, "runtime": runtime, "source_inputs": config,
            "builder_sha256": sha(Path(__file__)), "configuration_sha256": sha(CONFIG / "sources.json"),
            "debian_hardening_flags": flags, "original_elf": original_elf,
            "replacement_elf": replacement_elf, "original_plugins": inventory,
            "appimage_plugins": expected, "runtime_manifest_sha256": sha(output / "runtime-manifest.json"),
            "corresponding_source_sha256": sha(output / "corresponding-source.tar.xz"),
            "builder_packages_sha256": sha(output / "builder-packages.tsv"),
            "scanner_output_sha256": sha(output / "scanner.txt"),
            "linkage_output_sha256": sha(output / "linkage.txt"),
            "regression_source_sha256": sha(regression_source),
            "regression_binary_sha256": sha(regression),
            "regression_result": regression_result,
            "source_implementation_sha256": sha(source / "gst/playback/gststreamsynchronizer.c"),
            "host_packages_unchanged": True, "host_plugins_unchanged": True,
            "meson_command": setup, "product_acceptance_performed": False,
        })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("build/linux-playback-compat"))
    parser.add_argument("--source-cache", type=Path, help="Directory containing the three pinned source files")
    args = parser.parse_args()
    build(args.output.resolve(), args.source_cache)


if __name__ == "__main__":
    main()
