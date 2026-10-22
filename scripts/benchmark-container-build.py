#!/usr/bin/env python3
"""Benchmark native OCI builds and imported-cache reuse without publishing.

The two beta identities are diagnostic fixtures, never allocated releases. Only
Git-managed workspace files enter temporary contexts. Builders, containers and
local image tags created here are isolated and removed; OCI/cache evidence stays
in the new output directory. No registry destination is ever used.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.request import ProxyHandler, build_opener

import version_plan

ROOT = Path(__file__).resolve().parents[1]
PLATFORMS = {"linux/amd64", "linux/arm64"}
FRONTEND_MARKER = "\n<!-- Isolated container cache benchmark: frontend-only change. -->\n"


class BenchmarkError(RuntimeError):
    """A required benchmark or safety contract was not satisfied."""


def require(condition, message):
    if not condition:
        raise BenchmarkError(message)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def safe_diagnostic(value):
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = re.sub(r"[A-Za-z][A-Za-z0-9+.-]*://\S+", "[URL]", value)
    value = re.sub(r"(?i)(bearer\s+|(?:token|password|secret|authorization)[=: ]+)[^\s,;]+", r"\1[REDACTED]", value)
    return "".join(char for char in value if char in "\n\t" or ord(char) >= 32)[-4096:]


def command(args, *, cwd=None, timeout=120, check=True, diagnostic_path=None):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode and diagnostic_path:
        diagnostic_path.write_text(safe_diagnostic(result.stdout + "\n" + result.stderr))
    if check and result.returncode:
        suffix = "; see " + diagnostic_path.name if diagnostic_path else ""
        raise BenchmarkError("Command failed: " + " ".join(args[:3]) + suffix)
    return result


def cleanup(args):
    # A failed cleanup must not prevent the remaining owned resources being removed.
    try:
        command(args, check=False)
    except (OSError, subprocess.SubprocessError):
        print("Could not complete cleanup: " + " ".join(args[:3]), file=sys.stderr)


def copy_workspace(root, destination):
    """Include indexed files and their current bytes, never unrelated untracked files."""
    entries = command(["git", "ls-files", "--cached", "-z"], cwd=root).stdout.split("\0")
    inventory = {}
    for name in sorted(set(entries) - {""}):
        path = PurePosixPath(name)
        require(
            not path.is_absolute() and ".." not in path.parts and ".git" not in path.parts,
            "Unsafe indexed context path",
        )
        source = root / name
        # Git-managed links could lead outside the audited source tree.
        require(
            not any((root / Path(*path.parts[:index])).is_symlink() for index in range(1, len(path.parts) + 1)),
            "Symlinks are not benchmark inputs: " + name,
        )
        if not source.exists():
            continue  # Reflect an intentional deletion from the current workspace.
        require(source.is_file(), "Unsupported indexed context entry: " + name)
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        inventory[name] = {
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "executable": bool(source.stat().st_mode & stat.S_IXUSR),
        }
    for name in ("Dockerfile", ".release-policy.json", "index.html", "scripts/prepare-container-workspace.py"):
        require((destination / name).is_file(), "Required input is not Git-managed: " + name)
    return inventory


def require_native(platform):
    require(platform in PLATFORMS, "Unsupported native platform")
    architecture = command(["docker", "info", "--format", "{{json .Architecture}}"]).stdout
    architecture = json.loads(architecture)
    normalized = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(architecture)
    require(
        platform == "linux/" + str(normalized), "Requested platform must match the Docker daemon's native architecture"
    )


@contextmanager
def fresh_builder():
    name = "ottplay-benchmark-" + uuid.uuid4().hex
    # Never select this builder as the user's global/default builder.
    try:
        command(["docker", "buildx", "create", "--name", name, "--driver", "docker-container"], timeout=120)
        yield name
    finally:
        cleanup(["docker", "buildx", "rm", "--force", name])


def vertices_from_progress(path):
    """Read Buildx rawjson events, including BuildKit's batched vertex format."""
    vertices = {}
    for line in path.read_text(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # CLI diagnostics can accompany the JSON progress stream.
        if not isinstance(event, dict):
            continue
        batch = event.get("vertexes", event.get("vertices", [event]))
        if not isinstance(batch, list):
            continue
        for vertex in batch:
            if not isinstance(vertex, dict):
                continue
            identifier = vertex.get("id", vertex.get("digest"))
            if not isinstance(identifier, str):
                continue
            current = vertices.setdefault(identifier, {"id": identifier})
            for key in ("name", "started", "completed", "cached", "error"):
                if key in vertex:
                    current[key] = vertex[key]
    for vertex in vertices.values():
        if vertex.get("started") and vertex.get("completed"):
            start = datetime.fromisoformat(vertex["started"].replace("Z", "+00:00"))
            end = datetime.fromisoformat(vertex["completed"].replace("Z", "+00:00"))
            vertex["seconds"] = (end - start).total_seconds()
    return list(vertices.values())


def require_rust_cache(vertices, expected):
    matches = [
        v
        for v in vertices
        if "rust-build" in v.get("name", "") and "RUN cargo build " in v["name"] and "--locked" in v["name"]
    ]
    require(len(matches) == 1, "Expected exactly one locked target Rust build vertex")
    vertex = matches[0]
    require(
        bool(vertex.get("completed")) and not vertex.get("error"),
        "Target Rust build vertex did not finish successfully",
    )
    require(
        (vertex.get("cached") is True) == expected,
        "Target Rust build cache result differs from the required "
        + ("warm cache hit" if expected else "cold compile"),
    )
    return vertex


def build_case(context, output, name, platform, plan, cache, warm, archive):
    progress = output / (name + ".jsonl")
    log = output / (name + ".log")
    metadata = output / (name + "-metadata.json")
    with fresh_builder() as builder:
        args = [
            "docker",
            "buildx",
            "build",
            "--builder",
            builder,
            "--platform",
            platform,
            "--progress=rawjson",
            "--sbom=true",
            "--provenance=mode=max",
            "--tag",
            "ottplay-container-benchmark:" + plan["version"],
            "--label",
            "org.opencontainers.image.version=" + plan["version"],
            "--label",
            "org.opencontainers.image.revision=" + plan["source_sha"],
            "--output",
            "type=oci,oci-mediatypes=true,compression=gzip,dest=" + str(archive),
            "--metadata-file",
            str(metadata),
        ]
        if warm:
            require((cache / "index.json").is_file(), "Exported local cache is missing")
            args += ["--cache-from", "type=local,src=" + str(cache)]
        else:
            args += ["--cache-to", "type=local,dest=" + str(cache) + ",mode=max"]
        args += [str(context)]
        started = time.monotonic()
        with log.open("w") as stdout, progress.open("w") as stderr:
            result = subprocess.run(args, stdout=stdout, stderr=stderr, timeout=3600, check=False)
        wall = time.monotonic() - started
        require(result.returncode == 0, "Docker build failed; see " + progress.name)
    vertices = vertices_from_progress(progress)
    write_json(output / (name + "-vertices.json"), vertices)
    rust = require_rust_cache(vertices, warm)
    return {
        "case": name,
        "version": plan["version"],
        "wallSeconds": wall,
        "wallTimeScope": "Build/export command; builder create/remove excluded",
        "freshBuilder": True,
        "importedLocalCache": warm,
        "exportedLocalCache": not warm,
        "rustCached": rust.get("cached") is True,
        "rustVertex": rust,
        "progress": progress.name,
        "log": log.name,
        "cacheHits": sum(v.get("cached") is True for v in vertices),
    }


def inspect_archive(path, platform, version, revision):
    spec = importlib.util.spec_from_file_location("benchmark_oci_inspector", ROOT / "scripts/assemble-container-oci.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.inspect_native(path, platform, version, revision)


def docker_daemon_host():
    # Match Docker CLI precedence without changing the selected context. Skopeo
    # otherwise ignores Colima/Desktop contexts and uses /var/run/docker.sock.
    host = os.environ.get("DOCKER_HOST") if not os.environ.get("DOCKER_CONTEXT") else None
    if not host:
        host = command(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).stdout.strip()
    require(host.startswith("unix://"), "Benchmark requires a local Unix Docker daemon endpoint")
    return host


def epg_image_check(image, output):
    report = output / "epg-performance.json"
    diagnostic = output / "epg-performance.log"
    report.unlink(missing_ok=True)
    # subprocess.run kills a timed-out child immediately. Allow the checker to
    # unwind its SIGTERM handler and remove its Docker container before killing it.
    process = subprocess.Popen(
        [sys.executable, str(ROOT / "scripts/check-epg-performance.py"),
         "--image", image, "--output", str(report)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        try:
            stdout, stderr = process.communicate(timeout=180)
        except subprocess.TimeoutExpired as error:
            raise BenchmarkError("Exact OCI EPG check exceeded its overall time budget") from error
        if process.returncode:
            diagnostic.write_text(safe_diagnostic(stdout + "\n" + stderr))
            raise BenchmarkError("Exact OCI EPG check failed; see " + diagnostic.name)
        evidence = json.loads(report.read_text())
        require(evidence.get("passed") is True, "Exact OCI runtime failed EPG performance checks")
        return evidence
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                stdout, stderr = process.communicate(timeout=40)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate(timeout=5)
            diagnostic.write_text(safe_diagnostic(stdout + "\n" + stderr))


def smoke_archive(archive, platform, inspected):
    name = "ottplay-benchmark-" + uuid.uuid4().hex
    image = "ottplay-container-benchmark:" + uuid.uuid4().hex
    try:
        daemon = docker_daemon_host()
        command(
            [
                "skopeo",
                "copy",
                "--dest-daemon-host",
                daemon,
                "--override-os",
                "linux",
                "--override-arch",
                platform.split("/")[1],
                "oci-archive:" + str(archive),
                "docker-daemon:" + image,
            ],
            timeout=300,
            diagnostic_path=archive.parent / "smoke-import.log",
        )
        config_id = command(["docker", "image", "inspect", "--format", "{{.Id}}", image]).stdout.strip()
        require(config_id == inspected["config_digest"], "Loaded image differs from OCI image config")
        command(
            [
                "docker",
                "run",
                "--detach",
                "--name",
                name,
                "--publish",
                "127.0.0.1::8080",
                "--env",
                "EPG_URLS=http://127.0.0.1:9/unused",
                image,
            ]
        )
        mapping = json.loads(command(["docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", name]).stdout)
        bindings = mapping.get("8080/tcp", [])
        require(
            len(bindings) == 1 and bindings[0].get("HostIp") == "127.0.0.1",
            "Smoke container must publish only one loopback listener",
        )
        port = int(bindings[0]["HostPort"])
        require(
            port > 0 and port not in (8081, 8090, 8443, 8444, 8445, 8446),
            "Smoke listener did not receive an isolated ephemeral port",
        )
        uid = command(["docker", "exec", name, "id", "-u"]).stdout.strip()
        require(uid == "65532", "Runtime user is not the expected nonroot UID 65532")
        opener = build_opener(ProxyHandler({}))
        deadline = time.monotonic() + 30
        healthy = False
        while time.monotonic() < deadline:
            try:
                with opener.open("http://127.0.0.1:" + str(port) + "/health", timeout=2) as response:
                    healthy = response.status == 200
                    response.read(4096)
                if healthy:
                    break
            except OSError:
                pass
            time.sleep(0.2)
        require(healthy, "Exact OCI runtime did not pass its loopback health check")
        served = {}
        expected_files = inspected["critical_web_files"]
        require(
            set(expected_files) == {"index.html", "dist/player.js"},
            "OCI inspector must supply both critical frontend hashes",
        )
        for path, expected in sorted(expected_files.items()):
            with opener.open("http://127.0.0.1:" + str(port) + "/" + path, timeout=10) as response:
                require(response.status == 200, "Frontend request did not succeed: " + path)
                digest = hashlib.sha256()
                for block in iter(lambda: response.read(1024 * 1024), b""):
                    digest.update(block)
            require(digest.hexdigest() == expected, "Served frontend differs from OCI bytes: " + path)
            served[path] = digest.hexdigest()
        epg = epg_image_check(image, archive.parent)
        return {
            "healthStatus": 200,
            "uid": 65532,
            "loopbackOnly": True,
            "configDigest": config_id,
            "port": port,
            "servedSha256": served,
            "epgPerformance": epg,
        }
    finally:
        cleanup(["docker", "rm", "--force", name])
        cleanup(["docker", "image", "rm", image])


def benchmark(root, platform, output):
    require(not output.exists() and not output.is_symlink(), "--output must be a new directory")
    require("," not in str(output), "--output cannot contain commas in Buildx exporter paths")
    for binary in ("git", "docker", "skopeo"):
        require(shutil.which(binary), "Required executable is missing: " + binary)
    require_native(platform)
    command(["docker", "buildx", "version"])
    output.mkdir(parents=True)
    report = {
        "diagnosticOnly": True,
        "registryWrites": False,
        "platform": platform,
        "cases": [],
        "passed": False,
        "phase": "prepare",
    }
    try:
        revision = command(["git", "rev-parse", "HEAD"], cwd=root).stdout.strip()
        policy = json.loads((root / ".release-policy.json").read_bytes())
        base = version_plan.read_base_version(root, policy)
        floor = policy.get("versioning", {}).get("build_number_floor", 0)
        plans = [version_plan.create_plan(base, "beta", seq, revision, policy, floor + seq) for seq in (1, 2)]
        report.update(
            {
                "revision": revision,
                "version": plans[1]["version"],
                "plans": plans,
                "cachePolicy": "Cold export mode=max; warm builds import it in fresh builders",
            }
        )
        with tempfile.TemporaryDirectory(prefix="ottplay-container-benchmark-") as temporary:
            context = Path(temporary) / "context"
            context.mkdir()
            inventory = copy_workspace(root, context)
            write_json(output / "source-inventory.json", inventory)
            version_plan.sync_versions(context, policy, plans[0])
            cache = output / "cache"
            intermediate = Path(temporary) / "intermediate.oci.tar"
            for name, warm in (("cold-beta1", False), ("warm-same-beta1", True)):
                report["phase"] = name
                report["cases"].append(build_case(context, output, name, platform, plans[0], cache, warm, intermediate))
                intermediate.unlink()
            version_plan.sync_versions(context, policy, plans[1])
            with (context / "index.html").open("a") as html:
                html.write(FRONTEND_MARKER)
            archive = output / "native.oci.tar"
            report["phase"] = "warm-next-beta2-frontend"
            report["cases"].append(
                build_case(context, output, "warm-next-beta2-frontend", platform, plans[1], cache, True, archive)
            )
            report["phase"] = "inspect-oci"
            inspected = inspect_archive(archive, platform, plans[1]["version"], revision)
            report["archive"] = {"path": archive.name, **inspected}
            report["phase"] = "smoke-oci"
            report["smoke"] = smoke_archive(archive, platform, inspected)
            report["passed"] = True
            report["phase"] = "complete"
        return report
    except (BenchmarkError, OSError, ValueError, subprocess.SubprocessError) as error:
        report["error"] = {"type": type(error).__name__, "message": safe_diagnostic(str(error))}
        (output / "failure.log").write_text(
            report["phase"] + ": " + report["error"]["type"] + ": " + report["error"]["message"] + "\n"
        )
        raise
    finally:
        report["finishedAtUtc"] = datetime.now(timezone.utc).isoformat()
        write_json(output / "report.json", report)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=sorted(PLATFORMS), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        report = benchmark(ROOT, args.platform, args.output.absolute())
    except (BenchmarkError, OSError, ValueError, subprocess.SubprocessError) as error:
        message = (
            str(error)
            if isinstance(error, BenchmarkError)
            else "Native benchmark failed; inspect retained output evidence."
        )
        print(json.dumps({"passed": False, "message": message}), file=sys.stderr)
        return 1
    print(
        json.dumps(
            {
                "passed": report["passed"],
                "version": report["version"],
                "platform": report["platform"],
                "output": str(args.output.absolute()),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
