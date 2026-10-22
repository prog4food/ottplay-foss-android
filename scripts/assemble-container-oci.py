#!/usr/bin/env python3
"""Join native OttPlay OCI exports without rewriting image or attestation blobs."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import tarfile
import tempfile
from contextlib import ExitStack
from pathlib import Path

import version_plan

INDEX = "application/vnd.oci.image.index.v1+json"
MANIFEST = "application/vnd.oci.image.manifest.v1+json"
ATTESTATION = "application/vnd.docker.attestation.manifest.v1+json"
PLATFORMS = {"linux/amd64", "linux/arm64"}
WEB_FILES = {"app/index.html", "app/favicon.ico", "app/build-info.json"}
WEB_DIRS = {"app/dist", "app/fonts", "app/js", "app/devices", "app/styles", "app/images", "app/locales", "app/providers"}
LAYER_TYPES = {
    "application/vnd.oci.image.layer.v1.tar",
    "application/vnd.oci.image.layer.v1.tar+gzip",
    "application/vnd.docker.image.rootfs.diff.tar",
    "application/vnd.docker.image.rootfs.diff.tar.gzip",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return version_plan.json_bytes(value)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def stream_digest(stream):
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(block)
    return digest.hexdigest()


class DigestReader:
    def __init__(self, stream):
        self.stream, self.digest = stream, hashlib.sha256()

    def read(self, size=-1):
        raw = self.stream.read(size)
        self.digest.update(raw)
        return raw


def archive_name(name):
    while name.startswith("./"):
        name = name[2:]
    require(name and "\\" not in name and not name.startswith("/"), "Unsafe archive path")
    require(all(part not in {"", ".", ".."} for part in name.split("/")), "Unsafe archive path")
    return name


def web_path(name):
    return name in WEB_FILES or any(name.startswith(directory + "/") for directory in WEB_DIRS)


class NativeArchive:
    def __init__(self, archive, path, platform, version, revision):
        self.archive, self.path, self.platform = archive, path, platform
        self.members = {}
        seen = set()
        for count, member in enumerate(archive):
            require(count < 100_000, "OCI archive has too many entries")
            if member.isdir() and member.name.rstrip("/") in {"", "."}:
                continue
            name = archive_name(member.name.rstrip("/"))
            require(name not in seen, "Duplicate OCI archive entry")
            seen.add(name)
            if member.isdir():
                require(name in {"blobs", "blobs/sha256"}, "Unexpected OCI directory")
                continue
            require(member.isfile(), "OCI archive entry must be a regular file")
            require(
                name in {"oci-layout", "index.json"} or re.fullmatch(r"blobs/sha256/[0-9a-f]{64}", name),
                "Unexpected OCI archive file",
            )
            self.members[name] = member
            if name.startswith("blobs/"):
                with archive.extractfile(member) as stream:
                    require(stream_digest(stream) == name.rsplit("/", 1)[1], "OCI blob content digest mismatch")
        require(self.json_file("oci-layout").get("imageLayoutVersion") == "1.0.0", "Unsupported OCI layout")
        # Reuse the release validator for configs, all descriptors and both BuildKit attestation formats.
        for label, expected in [("version", version), ("revision", revision)]:
            _, images = version_plan._oci_metadata(
                path, ("config", "Labels", "org.opencontainers.image." + label), expected
            )
            require(
                len(images) == 1 and images[0]["os"] + "/" + images[0]["architecture"] == platform,
                "Native archive must contain exactly its one expected runnable platform",
            )
        self.leaves = []
        self.walk(self.json_file("index.json"), 0)
        runnable = [descriptor for descriptor in self.leaves if not self.is_attestation(descriptor)]
        require(len(runnable) == 1, "Native archive must have one runnable manifest")
        self.image = runnable[0]
        self.config = self.blob(self.blob(self.image)["config"])
        self.user = self.config.get("config", {}).get("User")
        require(self.user in {"nonroot", "65532"}, "Native image must retain its configured nonroot user")
        self.validate_attestations()
        self.web = self.web_snapshot()

    def read(self, name, limit=32_000_000):
        member = self.members.get(name)
        require(member is not None and member.size <= limit, "Missing or oversized OCI metadata")
        with self.archive.extractfile(member) as stream:
            raw = stream.read(limit + 1)
        require(len(raw) == member.size, "Truncated OCI metadata")
        return raw

    def json_file(self, name):
        value = json.loads(self.read(name))
        require(isinstance(value, dict), "OCI metadata must be a JSON object")
        return value

    def blob_name(self, descriptor):
        identity = descriptor.get("digest", "")
        require(re.fullmatch(r"sha256:[0-9a-f]{64}", identity), "Unsupported OCI blob digest")
        name = "blobs/sha256/" + identity[7:]
        member = self.members.get(name)
        require(
            member is not None and type(descriptor.get("size")) is int and member.size == descriptor["size"],
            "OCI blob size mismatch",
        )
        return name

    def blob(self, descriptor):
        return self.json_file(self.blob_name(descriptor))

    def walk(self, index, depth):
        require(depth <= 8 and index.get("schemaVersion") == 2, "Invalid OCI index")
        require(index.get("mediaType", INDEX) == INDEX, "Only OCI indexes can be assembled")
        descriptors = index.get("manifests")
        require(isinstance(descriptors, list) and 0 < len(descriptors) <= 1024, "Invalid OCI manifest list")
        for descriptor in descriptors:
            require(len(self.leaves) < 1024, "OCI manifest graph is too large")
            if descriptor.get("mediaType") == INDEX:
                self.walk(self.blob(descriptor), depth + 1)
            else:
                require(descriptor.get("mediaType") == MANIFEST, "Only OCI manifests can be assembled")
                self.leaves.append(descriptor)

    def is_attestation(self, descriptor):
        return (
            descriptor.get("annotations", {}).get("vnd.docker.reference.type") == "attestation-manifest"
            or self.blob(descriptor).get("artifactType") == ATTESTATION
        )

    def validate_attestations(self):
        self.predicates = set()
        self.attestations = []
        for descriptor in self.leaves:
            if not self.is_attestation(descriptor):
                continue
            manifest = self.blob(descriptor)
            reference = descriptor.get("annotations", {}).get("vnd.docker.reference.digest")
            subject = manifest.get("subject", {}).get("digest")
            require((reference or subject) == self.image["digest"], "Attestation is not bound to its native image")
            # Unnamed BuildKit OCI exports omit statement subjects. The verified
            # OCI artifact subject still binds their statements to this image.
            # https://github.com/moby/buildkit/blob/9a16a73a42d124083021137bf62e38532c8ba46d/exporter/containerimage/writer.go#L326-L340
            artifact_bound = manifest.get("artifactType") == ATTESTATION and subject == self.image["digest"]
            for layer in manifest["layers"]:
                statement = self.blob(layer)
                require(
                    statement.get("_type") in {"https://in-toto.io/Statement/v0.1", "https://in-toto.io/Statement/v1"},
                    "Unsupported attestation statement",
                )
                subjects = statement.get("subject")
                require(
                    isinstance(subjects, list)
                    and (subjects or artifact_bound)
                    and all(
                        isinstance(item, dict) and item.get("digest", {}).get("sha256") == self.image["digest"][7:]
                        for item in subjects
                    ),
                    "Attestation statement has a different subject",
                )
                predicate = statement.get("predicateType")
                require(isinstance(predicate, str), "Attestation predicate type is missing")
                self.predicates.add(predicate)
            self.attestations.append(descriptor["digest"])
        require("https://spdx.dev/Document" in self.predicates, "Native image is missing its SBOM")
        require(
            bool(self.predicates & {"https://slsa.dev/provenance/v0.2", "https://slsa.dev/provenance/v1"}),
            "Native image is missing build provenance",
        )

    def web_snapshot(self):
        result = {}
        for descriptor in self.blob(self.image)["layers"]:
            changes, removed = {}, []
            require(descriptor.get("mediaType") in LAYER_TYPES, "Unsupported layer encoding for web parity")
            with (
                self.archive.extractfile(self.members[self.blob_name(descriptor)]) as raw,
                tarfile.open(fileobj=raw, mode="r|*") as layer,
            ):
                for count, member in enumerate(layer):
                    require(count < 200_000, "Image layer has too many entries")
                    if member.isdir() and member.name.rstrip("/") in {"", "."}:
                        continue
                    name = archive_name(member.name.rstrip("/"))
                    if name in {".wh.app", ".wh..wh..opq"}:
                        removed.append("app")
                        continue
                    if name == "app":
                        require(member.isdir(), "Application root must remain a directory")
                        continue
                    if not name.startswith("app/"):
                        continue
                    parent, leaf = name.rsplit("/", 1)
                    if leaf.startswith(".wh."):
                        target = parent if leaf == ".wh..wh..opq" else parent + "/" + leaf[4:]
                        removed.append(target)
                    elif web_path(name) or name in WEB_DIRS:
                        if member.isdir():
                            require(
                                name not in result and name not in changes,
                                "Served web file cannot be replaced by a directory",
                            )
                        else:
                            require(name not in WEB_DIRS, "Served web directory cannot be replaced by a file or link")
                            require(member.isfile(), "Served web asset must be a regular file")
                            with layer.extractfile(member) as stream:
                                changes[name] = stream_digest(stream)
            for target in removed:
                result = {
                    key: value for key, value in result.items() if key != target and not key.startswith(target + "/")
                }
            result.update(changes)
        require(
            "app/index.html" in result and "app/dist/player.js" in result, "Image has no complete player web root"
        )
        return result


def add_bytes(archive, name, raw):
    member = tarfile.TarInfo(name)
    member.size, member.mode = len(raw), 0o644
    archive.addfile(member, io.BytesIO(raw))


def inspect_native(path, platform, version, revision):
    """Validate one native export and return identities for a local runtime smoke test."""
    path = Path(path)
    require(platform in PLATFORMS and path.is_file() and not path.is_symlink(), "Invalid native OCI input")
    with tarfile.open(path, "r:*") as archive:
        item = NativeArchive(archive, path, platform, version, revision)
        return {
            "platform": platform,
            "version": version,
            "revision": revision,
            "image_digest": item.image["digest"],
            "config_digest": item.blob(item.image)["config"]["digest"],
            "configured_user": item.user,
            "attestation_digests": item.attestations,
            "predicate_types": sorted(item.predicates),
            "web_files": len(item.web),
            "web_manifest_sha256": sha256(canonical(item.web)),
            "critical_web_files": {name: item.web["app/" + name] for name in ["index.html", "dist/player.js"]},
        }


def assemble(inputs, output, version, revision):
    require(set(inputs) == PLATFORMS, "Assembly requires exactly linux/amd64 and linux/arm64")
    require(re.fullmatch(r"[0-9a-f]{40}", revision), "An exact source revision is required")
    require(version and re.fullmatch(r"[0-9A-Za-z.+-]+", version), "Invalid image version")
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "Output must not already exist")
    output.parent.mkdir(parents=True, exist_ok=True)
    with ExitStack() as stack:
        native = []
        for platform, path in sorted(inputs.items()):
            path = Path(path)
            require(path.is_file() and not path.is_symlink(), "Input must be a regular OCI archive")
            archive = stack.enter_context(tarfile.open(path, "r:*"))
            native.append(NativeArchive(archive, path, platform, version, revision))
        require(native[0].web == native[1].web, "Native platform web assets differ")
        leaves = [descriptor for item in native for descriptor in item.leaves]
        require(len({item["digest"] for item in leaves}) == len(leaves), "Duplicate image or attestation manifest")
        blobs = {}
        for item in native:
            for name, member in item.members.items():
                if name.startswith("blobs/"):
                    if name in blobs:
                        require(blobs[name][1].size == member.size, "Conflicting shared OCI blob")
                    else:
                        blobs[name] = (item.archive, member)
        combined = canonical({"schemaVersion": 2, "mediaType": INDEX, "manifests": leaves})
        identity = sha256(combined)
        root = canonical(
            {
                "schemaVersion": 2,
                "mediaType": INDEX,
                "manifests": [
                    {
                        "mediaType": INDEX,
                        "digest": "sha256:" + identity,
                        "size": len(combined),
                        "annotations": {"org.opencontainers.image.ref.name": version},
                    }
                ],
            }
        )
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".oci-assembly-", delete=False) as handle:
            temporary = Path(handle.name)
        try:
            with tarfile.open(temporary, "w", format=tarfile.USTAR_FORMAT) as target:
                add_bytes(target, "oci-layout", canonical({"imageLayoutVersion": "1.0.0"}))
                add_bytes(target, "index.json", root)
                for directory in ["blobs", "blobs/sha256"]:
                    member = tarfile.TarInfo(directory)
                    member.type, member.mode = tarfile.DIRTYPE, 0o755
                    target.addfile(member)
                combined_name = "blobs/sha256/" + identity
                for name, (source, member) in sorted(blobs.items()):
                    require(name != combined_name, "Combined index unexpectedly collides with an input blob")
                    copied = tarfile.TarInfo(name)
                    copied.size, copied.mode = member.size, 0o644
                    with source.extractfile(member) as stream:
                        checked = DigestReader(stream)
                        target.addfile(copied, checked)
                        require(
                            checked.digest.hexdigest() == name.rsplit("/", 1)[1],
                            "Input OCI blob changed during assembly",
                        )
                add_bytes(target, combined_name, combined)
            for label, expected in [("version", version), ("revision", revision)]:
                _, images = version_plan._oci_metadata(
                    temporary, ("config", "Labels", "org.opencontainers.image." + label), expected
                )
                require(
                    sorted(image["os"] + "/" + image["architecture"] for image in images) == sorted(PLATFORMS),
                    "Assembled archive does not contain exactly both expected platforms",
                )
            temporary.replace(output)
        finally:
            temporary.unlink(missing_ok=True)
        with output.open("rb") as stream:
            archive_digest = stream_digest(stream)
        return {
            "schema": 1,
            "version": version,
            "revision": revision,
            "index_digest": "sha256:" + identity,
            "output": str(output),
            "archive_sha256": archive_digest,
            "preserved_blob_count": len(blobs),
            "web_files": len(native[0].web),
            "web_manifest_sha256": sha256(canonical(native[0].web)),
            "platforms": [
                {
                    "platform": item.platform,
                    "image_digest": item.image["digest"],
                    "attestation_digests": item.attestations,
                    "predicate_types": sorted(item.predicates),
                }
                for item in native
            ],
        }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", action="append", required=True, metavar="PLATFORM=ARCHIVE")
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    inputs = {}
    for value in args.input:
        platform, separator, path = value.partition("=")
        require(separator and path and platform not in inputs, "Invalid or duplicate --input")
        inputs[platform] = path
    result = assemble(inputs, args.output, args.version, args.revision)
    if args.report:
        require(not args.report.exists() and not args.report.is_symlink(), "Report must not already exist")
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
