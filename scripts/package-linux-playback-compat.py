#!/usr/bin/env python3
"""Bind the private Linux compatibility build to Tauri and verify final packages."""

import argparse
import hashlib
import importlib.util
import json
import os
import re
import struct
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVATE = "usr/lib/ottplay-foss/compat/noble"
DOC = "usr/share/doc/ottplay-foss/linux-playback-compat"
MAX_EVIDENCE_BYTES = 1024 * 1024
SPEC = importlib.util.spec_from_file_location("compat_builder", ROOT / "scripts/build-linux-playback-compat.py")
BUILDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILDER)
require = BUILDER.require
sha = BUILDER.sha


def read_inputs(output):
    receipt = json.loads((output / "build-receipt.json").read_text())
    runtime = json.loads((output / "runtime-manifest.json").read_text())
    require(receipt["schema"] == 1 and receipt["runtime"] == runtime, "Build/runtime manifest mismatch")
    require(sha(output / "runtime-manifest.json") == receipt["runtime_manifest_sha256"], "Runtime manifest changed")
    require(sha(output / "private/gstreamer-1.0/libgstplayback.so") == runtime["replacement_plugin_sha256"],
            "Private plugin changed")
    require(sha(output / "corresponding-source.tar.xz") == receipt["corresponding_source_sha256"],
            "Corresponding source changed")
    require(BUILDER.plugin_inventory(output / "appimage-plugins") == receipt["appimage_plugins"],
            "Staged AppImage plugins changed")
    return receipt, runtime


def files_map(output):
    common = {
        f"{DOC}/corresponding-source.tar.xz": str(output / "corresponding-source.tar.xz"),
        f"{DOC}/build-receipt.json": str(output / "build-receipt.json"),
    }
    for name in ("README.md", "COPYING", "debian-copyright", "sources.json"):
        common[f"{DOC}/{name}"] = str(ROOT / "packaging/linux-playback-compat" / name)
    deb = dict(common)
    deb[f"{PRIVATE}/runtime-manifest.json"] = str(output / "runtime-manifest.json")
    deb[f"{PRIVATE}/gstreamer-1.0/libgstplayback.so"] = str(output / "private/gstreamer-1.0/libgstplayback.so")
    return deb, common


def prepare(output, github_env):
    receipt, _ = read_inputs(output)
    deb, appimage = files_map(output)
    config = output / "tauri-compat.conf.json"
    BUILDER.write_json(config, {"bundle": {"linux": {
        "deb": {"files": deb}, "appimage": {"files": appimage}}}})
    values = {
        "OTTPLAY_GST_COMPAT_MANIFEST_SHA256": receipt["runtime_manifest_sha256"],
        "OTTPLAY_GST_COMPAT_CONFIG": str(config),
        "GSTREAMER_PLUGINS_DIR": str(output / "appimage-plugins"),
    }
    require(all("\n" not in value and "\r" not in value for value in values.values()), "Invalid build path")
    with github_env.open("a", encoding="utf-8") as stream:
        for key, value in values.items():
            stream.write(f"{key}={value}\n")


def payload_sections(path):
    """Code and static data must survive stripping/RPATH changes byte for byte.

    Dynamic string/symbol/hash tables and offsets are linker metadata and can
    legitimately move when linuxdeploy sets the AppImage-relative RUNPATH.
    Their public ABI is checked independently with readelf/nm.
    """
    data = path.read_bytes()
    require(data[:6] == b"\x7fELF\x02\x01", "Expected little-endian ELF64 plugin")
    offset = struct.unpack_from("<Q", data, 40)[0]
    size, count, names_index = struct.unpack_from("<HHH", data, 58)
    require(size == 64 and 0 < count < 1000 and names_index < count, "Invalid ELF section table")
    require(offset + size * count <= len(data), "Truncated ELF section table")
    headers = [struct.unpack_from("<IIQQQQIIQQ", data, offset + size * i) for i in range(count)]
    names_header = headers[names_index]
    names = data[names_header[4]:names_header[4] + names_header[5]]
    wanted = {".text", ".rodata", ".data", ".data.rel.ro", ".bss", ".init_array", ".fini_array",
              ".eh_frame", ".eh_frame_hdr", ".init", ".fini"}
    result = {}
    for header in headers:
        name = names[header[0]:].split(b"\0", 1)[0].decode("ascii")
        if name not in wanted:
            continue
        require(name not in result, "Duplicate ELF payload section")
        if header[1] == 8:  # SHT_NOBITS has a size but no on-disk payload.
            digest = None
        else:
            require(header[4] + header[5] <= len(data), "Truncated ELF payload")
            digest = hashlib.sha256(data[header[4]:header[4] + header[5]]).hexdigest()
        result[name] = {"size": header[5], "sha256": digest, "flags": header[2]}
    require({".text", ".rodata", ".data", ".bss"} <= set(result), "Missing playback payload sections")
    return result


def verify_transformed_plugin(original, final):
    before, after = BUILDER.inspect_elf(original), BUILDER.inspect_elf(final)
    for key in ("class", "machine", "needed", "soname", "exports", "glibc_versions", "bind_now", "relro"):
        require(before[key] == after[key], "AppImage plugin contract changed: " + key)
    require(after["bind_now"] and after["relro"], "AppImage plugin lost hardening")
    sections = payload_sections(original)
    require(payload_sections(final) == sections, "AppImage plugin code/static data changed")
    rpath = BUILDER.run(["patchelf", "--print-rpath", str(final)]).strip()
    require(rpath == "$ORIGIN/..:$ORIGIN", "Unexpected AppImage plugin search path")
    return {"sha256": sha(final), "elf": after, "payload_sections": sections, "rpath": rpath}


def verify_embedded(root, expected):
    for destination, source in expected.items():
        path = root / destination
        require(path.is_file() and not path.is_symlink(), "Missing packaged file: " + destination)
        require(sha(path) == sha(Path(source)), "Packaged file changed: " + destination)


def verify_deb_ownership(package, expected):
    # Read the actual archive headers: extraction alone loses root ownership.
    process = subprocess.Popen(["dpkg-deb", "--fsys-tarfile", str(package)], stdout=subprocess.PIPE)
    found = set()
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            for member in archive:
                name = member.name.removeprefix("./").rstrip("/")
                relevant = name in expected or any(destination.startswith(name + "/") for destination in expected)
                if relevant:
                    require(member.uid == member.gid == 0 and member.mode & 0o022 == 0,
                            "Private package path is not root-owned/protected: " + name)
                    require(member.isfile() or member.isdir(), "Linked private package path: " + name)
                    found.add(name)
        require(process.wait(timeout=30) == 0, "Could not inspect DEB archive")
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
    require(set(expected) <= found, "DEB archive is missing private files")


def verify(output, artifacts):
    receipt, runtime = read_inputs(output)
    deb_map, image_map = files_map(output)
    debs = list(artifacts.glob("*.deb"))
    images = list(artifacts.glob("*.AppImage"))
    require(len(debs) == len(images) == 1, "Expected one DEB and one AppImage for this architecture")
    result = {"schema": 1, "runtime": runtime, "build_receipt_sha256": sha(output / "build-receipt.json"),
              "product_acceptance_performed": False}
    with tempfile.TemporaryDirectory(prefix="package-check-", dir=output) as temporary:
        work = Path(temporary)
        debroot = work / "deb"
        BUILDER.run(["dpkg-deb", "-x", str(debs[0]), str(debroot)])
        verify_embedded(debroot, deb_map)
        verify_deb_ownership(debs[0], deb_map)
        result["deb"] = {"name": debs[0].name, "sha256": sha(debs[0]), "size": debs[0].stat().st_size,
                         "private_files_verified": True}
        # Runs only the trusted AppImage extraction stub, never the player.
        BUILDER.run([str(images[0]), "--appimage-extract"], cwd=work, timeout=180)
        imageroot = work / "squashfs-root"
        verify_embedded(imageroot, image_map)
        plugin = imageroot / "usr/lib/gstreamer-1.0/libgstplayback.so"
        require(plugin.is_file() and not plugin.is_symlink(), "Missing bundled playback plugin")
        result["appimage"] = {"name": images[0].name, "sha256": sha(images[0]), "size": images[0].stat().st_size,
                              "plugin": verify_transformed_plugin(output / "private/gstreamer-1.0/libgstplayback.so", plugin)}
        require(set(receipt["appimage_plugins"]) <= {p.name for p in plugin.parent.iterdir()},
                "AppImage dropped staged plugins")
    BUILDER.write_json(output / "package-verification.json", result)


def canonical(value):
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def evidence_file(path):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= MAX_EVIDENCE_BYTES,
            "Evidence must be a bounded regular file")
    raw = path.read_bytes()
    value = json.loads(raw)
    require(raw == canonical(value), "Evidence must use the builder's canonical JSON encoding")
    return value, hashlib.sha256(raw).hexdigest()


def attach_receipt(output, receipt_path):
    # Keep the generic release-toolkit files unchanged. Its existing versioned
    # receipt permits additional evidence and is itself hashed by the manifest.
    from version_plan import validate_plan
    from version_receipt import verify_receipt_evidence

    base = (ROOT / "release-assets").resolve()
    resolved = receipt_path.resolve(strict=True)
    require(resolved.is_relative_to(base) and resolved != base, "Receipt must stay in release-assets")
    require(not any(path.is_symlink() for path in (receipt_path, *receipt_path.parents)),
            "Receipt path must not contain symlinks")
    require(re.fullmatch(r"release-inputs-desktop-[A-Za-z0-9._-]+\.json", receipt_path.name),
            "Expected a desktop release receipt")
    outer, _ = evidence_file(receipt_path)
    require("linux_playback_compat" not in outer, "Compatibility evidence is already attached")
    plan = json.loads((ROOT / ".release-plan.json").read_text())
    policy = json.loads((ROOT / ".release-policy.json").read_text())
    validate_plan(plan, policy=policy, source_sha=outer.get("source_sha"))
    verify_receipt_evidence(outer, plan, receipt_path.name, policy)
    build, runtime = read_inputs(output)
    runtime_data, runtime_sha = evidence_file(output / "runtime-manifest.json")
    build_data, build_sha = evidence_file(output / "build-receipt.json")
    verification, verification_sha = evidence_file(output / "package-verification.json")
    require(build_data == build and runtime_data == runtime, "Build evidence changed")
    require(verification["schema"] == 1 and verification["runtime"] == runtime
            and verification["build_receipt_sha256"] == build_sha
            and verification["product_acceptance_performed"] is False,
            "Package verification belongs to a different build")
    artifacts = {entry["name"]: entry for entry in outer["artifacts"]}
    require(len(artifacts) == len(outer["artifacts"]), "Duplicate release artifact")
    for kind, suffix in (("deb", ".deb"), ("appimage", ".AppImage")):
        item = verification[kind]
        require(item["name"].endswith(suffix) and Path(item["name"]).name == item["name"],
                "Invalid verified package name")
        require([name for name in artifacts if name.endswith(suffix)] == [item["name"]],
                "Expected exactly the verified package in this release receipt")
        require(artifacts[item["name"]] == {key: item[key] for key in ("name", "size", "sha256")},
                "Verified package differs from release receipt")
        staged = receipt_path.parent / item["name"]
        require(staged.is_file() and not staged.is_symlink()
                and staged.stat().st_size == item["size"] and sha(staged) == item["sha256"],
                "Staged package changed after verification")
    outer["linux_playback_compat"] = {
        "schema": 1, "source_sha": plan["source_sha"], "channel": plan["channel"],
        "plan_sha256": outer["plan_sha256"],
        "runtime_manifest": runtime, "runtime_manifest_sha256": runtime_sha,
        "source_build": build, "source_build_sha256": build_sha,
        "package_verification": verification, "package_verification_sha256": verification_sha,
    }
    encoded = canonical(outer)
    require(len(encoded) <= MAX_EVIDENCE_BYTES, "Augmented release receipt exceeds 1 MiB")
    # Atomic replacement only after every source, package and size check passes.
    with tempfile.NamedTemporaryFile(dir=receipt_path.parent, prefix=".compat-receipt-", delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(temporary, receipt_path)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("prepare", "verify", "attach-receipt"))
    parser.add_argument("--output", type=Path, default=ROOT / "build/linux-playback-compat")
    parser.add_argument("--artifacts", type=Path, default=ROOT / "tauri-artifacts")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    if args.operation == "prepare":
        prepare(args.output.resolve(), Path(os.environ["GITHUB_ENV"]))
    elif args.operation == "verify":
        verify(args.output.resolve(), args.artifacts.resolve())
    else:
        require(args.receipt is not None, "--receipt is required")
        attach_receipt(args.output.resolve(), args.receipt.absolute())


if __name__ == "__main__":
    main()
