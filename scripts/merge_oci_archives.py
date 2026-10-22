#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Merge native BuildKit OCI exports offline without rebuilding or publishing."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import stat
import tarfile
import tempfile
import zlib
from contextlib import ExitStack, suppress
from pathlib import Path

try:
    from compression import zstd
except ImportError:  # Python < 3.14 has no standard-library Zstandard decoder.
    zstd = None


BLOB_PREFIX = "blobs/sha256/"
DIGEST_PREFIX = "sha256:"
REFERENCE_TYPE = "vnd.docker.reference.type"
INDEX = "application/vnd.oci.image.index.v1+json"
MANIFEST = "application/vnd.oci.image.manifest.v1+json"
CONFIG = "application/vnd.oci.image.config.v1+json"
EMPTY_CONFIG = "application/vnd.oci.empty.v1+json"
ATTESTATION = "application/vnd.docker.attestation.manifest.v1+json"
IN_TOTO = "application/vnd.in-toto+json"
PROVENANCE_TYPES = {
    "https://slsa.dev/provenance/v0.2",
    "https://slsa.dev/provenance/v1",
}
LAYER_TYPES = {
    "application/vnd.oci.image.layer.v1.tar",
    "application/vnd.oci.image.layer.v1.tar+gzip",
    "application/vnd.oci.image.layer.v1.tar+zstd",
}
PLATFORMS = ("linux/amd64", "linux/arm64")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
MAX_JSON = 2_000_000
MAX_ATTESTATION_JSON = 16 * 1024 * 1024
MAX_JSON_TOTAL = 32_000_000
CHUNK = 1024 * 1024
MAX_LAYER_BYTES = 8 * 1024**3
MAX_ROOTFS_BYTES = 32 * 1024**3
COMPRESSION_ERRORS = (OSError, EOFError, zlib.error) + (
    (zstd.ZstdError,) if zstd is not None else ()
)


def require(condition, message):
    """Reject invalid inputs even when Python assertions are disabled."""
    if not condition:
        raise ValueError(message)


def canonical(value):
    """Use stable JSON bytes for newly assembled metadata only."""
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), allow_nan=False
    ).encode()


def identity(stream):
    """Hash arbitrarily large payloads with bounded memory."""
    digest, size = hashlib.sha256(), 0
    for chunk in iter(lambda: stream.read(CHUNK), b""):
        digest.update(chunk)
        size += len(chunk)
    return {"sha256": digest.hexdigest(), "size": size}


def document(raw, *, max_bytes=MAX_JSON):
    """Reject duplicate JSON keys and non-standard numeric constants."""

    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, "Duplicate OCI JSON key")
            result[key] = value
        return result

    def invalid_constant(value):
        raise ValueError(f"Invalid OCI JSON constant: {value}")

    require(len(raw) <= max_bytes, "Oversized OCI JSON")
    try:
        result = json.loads(
            raw, object_pairs_hook=pairs, parse_constant=invalid_constant
        )
    except (RecursionError, UnicodeDecodeError) as error:
        raise ValueError("Invalid OCI JSON") from error
    require(isinstance(result, dict), "OCI JSON must be an object")
    return result


def member_name(entry):
    """Normalize tar's optional ./ prefix without accepting unsafe aliases."""
    name = entry.name
    while name.startswith("./"):
        name = name[2:]
    if entry.isdir():
        name = name.rstrip("/")
    require(
        name
        and not name.startswith("/")
        and "\\" not in name
        and "\0" not in name
        and all(part not in {"", ".", ".."} for part in name.split("/")),
        "Unsafe OCI archive member",
    )
    return name


class Archive:
    """Keep a checked archive open; never extract untrusted filesystem objects."""

    def __init__(self, path, platform, version, revision, stack):
        self.path = Path(path)
        self.platform = platform
        self.version = version
        self.revision = revision
        self.members = {}
        self.blobs = {}
        self.leaves = []
        self.images = []
        self.attestations = []
        self.visited = 0
        self.metadata_bytes = 0
        self.metadata_names = set()
        self.attestation_names = set()
        self.layer_identities = {}
        self.rootfs_bytes = 0
        require(not self.path.is_symlink(), "Input archive must not be a symlink")
        descriptor = os.open(
            self.path,
            os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0),
        )
        self.stream = stack.enter_context(os.fdopen(descriptor, "rb"))
        self.initial_stat = os.fstat(self.stream.fileno())
        require(stat.S_ISREG(self.initial_stat.st_mode), "Input must be a regular file")
        self.archive_identity = identity(self.stream)
        self.stream.seek(0)
        # BuildKit exports uncompressed OCI tar files. Refuse compressed outer
        # archives so metadata inspection cannot expand a compression bomb.
        self.tar = stack.enter_context(
            tarfile.open(fileobj=self.stream, mode="r:")  # noqa: SIM115 - ExitStack owns it.
        )
        self.inventory()
        layout = self.read_json("oci-layout")
        require(layout.get("imageLayoutVersion") == "1.0.0", "Invalid OCI layout")
        root = self.read_json("index.json")
        self.walk_index(root, 0)
        self.validate_complete_graph()
        self.unchanged()

    def validate_complete_graph(self):
        """Keep the native-input contract overridable only by explicit validators."""
        require(len(self.images) == 1, "Expected exactly one runnable image per input")
        for attestation in self.attestations:
            require(
                attestation["subject"] == self.images[0]["descriptor"],
                "OCI attestation subject differs from runnable image",
            )

    def inventory(self):
        """Check every outer member and every blob, including unreferenced blobs."""
        seen = set()
        for count, entry in enumerate(self.tar):
            require(count < 100_000, "Too many OCI archive members")
            name = member_name(entry)
            require(name not in seen, "Duplicate OCI archive member")
            seen.add(name)
            require(
                (entry.isdir() or entry.isreg()) and not entry.issparse(),
                "OCI members must be regular files or directories",
            )
            if entry.isdir():
                require(name in {"blobs", "blobs/sha256"}, "Unexpected OCI directory")
                continue
            self.members[name] = entry
            if name.startswith("blobs/"):
                require(
                    re.fullmatch(r"blobs/sha256/[0-9a-f]{64}", name),
                    "Unsupported OCI blob path",
                )
                with self.tar.extractfile(entry) as stream:
                    checked = identity(stream)
                require(
                    checked["size"] == entry.size
                    and checked["sha256"] == name.rsplit("/", 1)[1],
                    "OCI blob digest or size mismatch",
                )
                self.blobs[name] = entry
            # OCI permits extension files (for example Docker manifest.json).
            # Safe regular extension files are ignored, never copied or executed.

    def read_json(self, name, *, max_bytes=MAX_JSON):
        self.metadata_names.add(name)
        entry = self.members.get(name)
        require(
            entry is not None and 0 < entry.size <= max_bytes,
            f"Missing or oversized OCI metadata: {name}",
        )
        with self.tar.extractfile(entry) as stream:
            raw = stream.read(max_bytes + 1)
        require(len(raw) == entry.size, "Truncated OCI metadata")
        self.metadata_bytes += len(raw)
        require(self.metadata_bytes <= MAX_JSON_TOTAL, "Too much OCI metadata")
        return document(raw, max_bytes=max_bytes)

    def blob(self, descriptor, media_types, metadata=False):
        require(isinstance(descriptor, dict), "OCI descriptor must be an object")
        digest, size = descriptor.get("digest"), descriptor.get("size")
        require(
            isinstance(digest, str) and DIGEST.fullmatch(digest),
            "Invalid OCI descriptor digest",
        )
        require(type(size) is int and size >= 0, "Invalid OCI descriptor size")
        require(
            descriptor.get("mediaType") in media_types, "Unsupported OCI media type"
        )
        require("urls" not in descriptor, "External OCI content is not supported")
        require(
            "data" not in descriptor
            or (
                descriptor.get("mediaType") == EMPTY_CONFIG
                and descriptor["data"] == "e30="
            ),
            "Unsupported embedded OCI content",
        )
        name = BLOB_PREFIX + digest[7:]
        require(
            name in self.blobs and self.blobs[name].size == size,
            "Missing OCI blob or descriptor size mismatch",
        )
        return self.read_json(name) if metadata else None

    @staticmethod
    def descriptor_key(descriptor):
        return {key: descriptor[key] for key in ("mediaType", "digest", "size")}

    def walk_index(self, data, depth):
        require(
            type(data.get("schemaVersion")) is int
            and data["schemaVersion"] == 2
            and data.get("mediaType", INDEX) == INDEX,
            "Invalid OCI index schema",
        )
        require(
            "subject" not in data and "artifactType" not in data,
            "Unexpected index artifact",
        )
        manifests = data.get("manifests")
        require(
            isinstance(manifests, list) and 0 < len(manifests) <= 1024,
            "Invalid OCI index manifest list",
        )
        for child in manifests:
            self.walk(child, depth)

    def walk(self, descriptor, depth):
        self.visited += 1
        require(depth <= 8 and self.visited <= 1024, "OCI graph exceeds limits")
        data = self.blob(descriptor, {INDEX, MANIFEST}, metadata=True)
        media = descriptor["mediaType"]
        require(
            type(data.get("schemaVersion")) is int
            and data["schemaVersion"] == 2
            and data.get("mediaType", media) == media,
            "OCI manifest schema or media type mismatch",
        )
        if media == INDEX:
            self.walk_index(data, depth + 1)
            return
        annotations = descriptor.get("annotations", {})
        require(
            isinstance(annotations, dict)
            and all(
                isinstance(key, str) and isinstance(value, str)
                for key, value in annotations.items()
            ),
            "Invalid OCI annotations",
        )
        if (
            annotations.get(REFERENCE_TYPE) == "attestation-manifest"
            or data.get("artifactType") == ATTESTATION
        ):
            self.attestation(descriptor, data, annotations)
        else:
            require(
                "artifactType" not in descriptor
                and "artifactType" not in data
                and "subject" not in data
                and REFERENCE_TYPE not in annotations,
                "Unexpected OCI image artifact",
            )
            self.image(descriptor, data)
        require(
            all(item["digest"] != descriptor["digest"] for item in self.leaves),
            "Duplicate OCI manifest descriptor",
        )
        self.leaves.append(descriptor)

    def image(self, descriptor, data):
        config = data.get("config")
        details = self.blob(config, {CONFIG}, metadata=True)
        platform = descriptor.get("platform")
        expected_os, expected_arch = self.platform.split("/")
        require(
            isinstance(platform, dict)
            and platform.get("os") == details.get("os") == expected_os
            and platform.get("architecture")
            == details.get("architecture")
            == expected_arch,
            "OCI platform differs from expected native input",
        )
        variants = {None, "v8"} if expected_arch == "arm64" else {None}
        require(
            platform.get("variant") in variants and details.get("variant") in variants,
            "Unsupported OCI platform variant",
        )
        require(
            not any(
                platform.get(key) or details.get(key)
                for key in ("os.version", "os.features", "features")
            ),
            "Unexpected OCI platform requirements",
        )
        config_body = details.get("config")
        require(isinstance(config_body, dict), "Missing OCI runtime config")
        labels = config_body.get("Labels")
        require(
            isinstance(labels, dict)
            and labels.get("org.opencontainers.image.version") == self.version
            and labels.get("org.opencontainers.image.revision") == self.revision,
            "OCI image version or revision label mismatch",
        )
        layers = data.get("layers")
        require(isinstance(layers, list) and len(layers) <= 4096, "Invalid OCI layers")
        for layer in layers:
            self.blob(layer, LAYER_TYPES)
        rootfs = details.get("rootfs")
        require(
            isinstance(rootfs, dict)
            and rootfs.get("type") == "layers"
            and isinstance(rootfs.get("diff_ids"), list)
            and len(rootfs["diff_ids"]) == len(layers)
            and all(
                isinstance(item, str) and DIGEST.fullmatch(item)
                for item in rootfs["diff_ids"]
            ),
            "Invalid OCI root filesystem identity",
        )
        for layer, expected_digest in zip(layers, rootfs["diff_ids"]):
            require(
                self.layer_digest(layer) == expected_digest,
                "OCI layer content differs from config rootfs diff_id",
            )
        self.images.append(
            {
                "descriptor": self.descriptor_key(descriptor),
                "config_sha256": config["digest"][7:],
            }
        )

    def layer_digest(self, descriptor):
        """Bind the archived filesystem bytes to the config used by native smoke."""
        key = (descriptor["digest"], descriptor["mediaType"])
        if key in self.layer_identities:
            checked, size = self.layer_identities[key]
            self.rootfs_bytes += size
            require(
                self.rootfs_bytes <= MAX_ROOTFS_BYTES,
                "OCI root filesystem exceeds expanded size limit",
            )
            return checked
        with ExitStack() as stack:
            stream = stack.enter_context(
                self.tar.extractfile(self.blobs[BLOB_PREFIX + descriptor["digest"][7:]])
            )
            if descriptor["mediaType"].endswith("+gzip"):
                stream = stack.enter_context(gzip.GzipFile(fileobj=stream))
            elif descriptor["mediaType"].endswith("+zstd"):
                require(
                    zstd is not None,
                    "Zstandard OCI validation requires Python 3.14+ with compression.zstd",
                )
                stream = stack.enter_context(
                    zstd.ZstdFile(
                        stream, options={zstd.DecompressionParameter.window_log_max: 27}
                    )
                )
            digest, size = hashlib.sha256(), 0
            try:
                for chunk in iter(lambda: stream.read(CHUNK), b""):
                    size += len(chunk)
                    require(
                        size <= MAX_LAYER_BYTES, "OCI layer exceeds expanded size limit"
                    )
                    require(
                        self.rootfs_bytes + size <= MAX_ROOTFS_BYTES,
                        "OCI root filesystem exceeds expanded size limit",
                    )
                    digest.update(chunk)
            except COMPRESSION_ERRORS as error:
                raise ValueError("Invalid compressed OCI layer") from error
        self.rootfs_bytes += size
        checked = DIGEST_PREFIX + digest.hexdigest()
        self.layer_identities[key] = (checked, size)
        return checked

    def attestation(self, descriptor, data, annotations):
        platform = descriptor.get("platform")
        require(
            isinstance(platform, dict)
            and platform.get("os") == platform.get("architecture") == "unknown"
            and annotations.get(REFERENCE_TYPE) in {None, "attestation-manifest"},
            "Invalid OCI attestation platform",
        )
        reference = annotations.get("vnd.docker.reference.digest")
        config = data.get("config")
        if data.get("artifactType") is not None:
            require(
                data["artifactType"] == ATTESTATION
                and descriptor.get("artifactType") in {None, ATTESTATION},
                "Invalid OCI attestation artifact type",
            )
            details = self.blob(config, {EMPTY_CONFIG}, metadata=True)
            require(
                details == {}
                and config["size"] == 2
                and config["digest"]
                == DIGEST_PREFIX + hashlib.sha256(b"{}").hexdigest(),
                "Invalid OCI attestation empty config",
            )
            subject = data.get("subject")
            self.blob(subject, {MANIFEST})
            subject_platform = subject.get("platform")
            require(
                subject_platform is None
                or (
                    isinstance(subject_platform, dict)
                    and subject_platform.get("os", "linux") == "linux"
                    and subject_platform.get(
                        "architecture", self.platform.split("/")[1]
                    )
                    == self.platform.split("/")[1]
                ),
                "Attestation subject platform differs from image",
            )
            subject = self.descriptor_key(subject)
            require(
                reference in {None, subject["digest"]},
                "Attestation reference differs from subject",
            )
        else:
            require(
                "artifactType" not in descriptor and "subject" not in data,
                "Invalid legacy OCI attestation",
            )
            details = self.blob(config, {CONFIG}, metadata=True)
            require(
                details.get("os") == details.get("architecture") == "unknown",
                "Attestation config contains a runnable image",
            )
            require(
                isinstance(reference, str) and DIGEST.fullmatch(reference),
                "Missing attestation reference",
            )
            name = BLOB_PREFIX + reference[7:]
            require(name in self.blobs, "Missing attestation subject blob")
            subject = {
                "mediaType": MANIFEST,
                "digest": reference,
                "size": self.blobs[name].size,
            }
        layers = data.get("layers")
        require(
            isinstance(layers, list) and 0 < len(layers) <= 4096,
            "Invalid attestation layers",
        )
        predicate_types = set()
        for layer in layers:
            self.blob(layer, {IN_TOTO})
            name = BLOB_PREFIX + layer["digest"][7:]
            # SBOM statements can exceed structural OCI metadata without
            # relaxing the manifest/config/index or aggregate byte budgets.
            statement = self.read_json(name, max_bytes=MAX_ATTESTATION_JSON)
            subjects = statement.get("subject")
            require(
                statement.get("_type")
                in {
                    "https://in-toto.io/Statement/v0.1",
                    "https://in-toto.io/Statement/v1",
                }
                and isinstance(statement.get("predicateType"), str)
                and bool(statement["predicateType"])
                and isinstance(subjects, list)
                and subjects
                and all(isinstance(item, dict) for item in subjects)
                and any(
                    isinstance(item.get("digest"), dict)
                    and item["digest"].get("sha256") == subject["digest"][7:]
                    for item in subjects
                ),
                "Attestation statement subject differs from image",
            )
            predicate_types.add(statement["predicateType"])
            self.attestation_names.add(name)
        self.attestations.append(
            {
                "digest": descriptor["digest"],
                "subject": subject,
                "predicate_types": sorted(predicate_types),
            }
        )

    def unchanged(self):
        current = os.fstat(self.stream.fileno())
        require(
            (current.st_size, current.st_mtime_ns, current.st_ctime_ns)
            == (
                self.initial_stat.st_size,
                self.initial_stat.st_mtime_ns,
                self.initial_stat.st_ctime_ns,
            ),
            "OCI input changed during assembly",
        )


def add_file(archive, name, size, stream):
    """Normalize only outer tar headers; image blob bytes stay unchanged."""
    entry = tarfile.TarInfo(name)
    entry.size, entry.mode, entry.mtime = size, 0o644, 0
    archive.addfile(entry, stream)


def merge_archives(inputs, output, version, revision):
    """Assemble exactly two verified native inputs, then atomically publish output."""
    require(
        set(inputs) == set(PLATFORMS),
        "Inputs must contain exactly linux/amd64 and linux/arm64",
    )
    require(
        isinstance(version, str)
        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.+-]{0,127}", version),
        "Invalid image version",
    )
    require(
        isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{40}", revision),
        "Invalid source revision",
    )
    output = Path(output)
    require(not os.path.lexists(output), "Output already exists")
    require(output.parent.is_dir(), "Output parent must exist")
    with ExitStack() as stack:
        archives = [
            Archive(inputs[platform], platform, version, revision, stack)
            for platform in PLATFORMS
        ]
        leaves = [item for archive in archives for item in archive.leaves]
        # Runtime images precede attestations, and order never depends on inputs.
        leaves.sort(
            key=lambda item: (
                item["platform"]["os"] == "unknown",
                item["platform"]["architecture"],
                item["digest"],
            )
        )
        inner = canonical({"schemaVersion": 2, "mediaType": INDEX, "manifests": leaves})
        inner_digest = hashlib.sha256(inner).hexdigest()
        root = canonical(
            {
                "schemaVersion": 2,
                "mediaType": INDEX,
                "manifests": [
                    {
                        "mediaType": INDEX,
                        "digest": DIGEST_PREFIX + inner_digest,
                        "size": len(inner),
                    }
                ],
            }
        )
        generated = {
            "oci-layout": canonical({"imageLayoutVersion": "1.0.0"}),
            "index.json": root,
            BLOB_PREFIX + inner_digest: inner,
        }
        blobs = {}
        for archive in archives:
            for name, entry in archive.blobs.items():
                if name in blobs:
                    require(
                        blobs[name][1].size == entry.size, "Conflicting shared OCI blob"
                    )
                blobs[name] = (archive, entry)
        descriptor, temporary = tempfile.mkstemp(
            prefix=".oci-merge-", dir=output.parent
        )
        try:
            with os.fdopen(descriptor, "wb") as stream:
                with tarfile.open(
                    fileobj=stream, mode="w", format=tarfile.USTAR_FORMAT
                ) as merged:
                    for name in sorted(set(generated) | set(blobs)):
                        if name in generated:
                            raw = generated[name]
                            add_file(merged, name, len(raw), io.BytesIO(raw))
                        else:
                            source, entry = blobs[name]
                            with source.tar.extractfile(entry) as content:
                                add_file(merged, name, entry.size, content)
                stream.flush()
                os.fsync(stream.fileno())
            for archive in archives:
                archive.unchanged()
            with open(temporary, "rb") as stream:
                output_identity = identity(stream)
            result = {
                "schema": 1,
                "version": version,
                "revision": revision,
                "images": {
                    archive.platform: {
                        "platform": archive.platform,
                        "config_digest": DIGEST_PREFIX
                        + archive.images[0]["config_sha256"],
                        "manifest_digest": archive.images[0]["descriptor"]["digest"],
                        "provenance_digests": [
                            item["digest"]
                            for item in archive.attestations
                            if PROVENANCE_TYPES.intersection(item["predicate_types"])
                        ],
                        "attestation_digests": [
                            item["digest"] for item in archive.attestations
                        ],
                    }
                    for archive in archives
                },
                "inputs": [
                    {
                        "platform": archive.platform,
                        "name": archive.path.name,
                        **archive.archive_identity,
                        "image": archive.images[0],
                        "attestations": archive.attestations,
                    }
                    for archive in archives
                ],
                "output": {
                    "name": output.name,
                    **output_identity,
                    "index_sha256": inner_digest,
                },
            }
            # link is an atomic no-clobber operation, including when another
            # process creates the destination after our initial existence check.
            os.link(temporary, output)
            return result
        finally:
            # A cleanup failure must not turn a successful publication into an
            # exception or hide the original failure. Hidden orphans are not
            # selected by the final release payload glob.
            with suppress(OSError):
                os.unlink(temporary)


def confined_cli_path(root, value, new=False):
    """Validate CLI paths inside the installed checkout before content I/O."""
    root = root.resolve(strict=True)
    candidate = value if value.is_absolute() else Path.cwd() / value
    require(
        not any(part == ".." or part.casefold() == ".git" for part in candidate.parts),
        "CLI paths must not traverse parent or Git directories",
    )
    resolved = candidate.resolve(strict=not new)
    require(
        resolved.is_relative_to(root) and resolved != root,
        "CLI path must stay inside the script checkout",
    )
    require(
        not any(part.casefold() == ".git" for part in resolved.relative_to(root).parts),
        "CLI paths must not access Git directories",
    )
    # Permit system aliases above the checkout (macOS /var -> /private/var),
    # but reject caller-selected file and directory symlinks within it.
    for component in (candidate, *candidate.parents):
        require(
            not (component.is_symlink() and component.resolve().is_relative_to(root)),
            "CLI path must not contain a symlink",
        )
    if new:
        require(
            not os.path.lexists(resolved) and resolved.parent.is_dir(),
            "CLI output must be a new file in an existing directory",
        )
    else:
        require(resolved.is_file(), "CLI input must be a regular file")
    return resolved


def main():
    """Expose the same offline assembler to CI and local operators."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--input", action="append", required=True, metavar="PLATFORM=PATH"
    )
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--revision", required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    inputs = {}
    for value in args.input:
        platform, separator, path = value.partition("=")
        require(
            separator and path and platform not in inputs,
            "Invalid or duplicate --input",
        )
        inputs[platform] = confined_cli_path(root, Path(path))
    output = confined_cli_path(root, args.output, new=True)
    print(
        json.dumps(
            merge_archives(inputs, output, args.version, args.revision),
            sort_keys=True,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
