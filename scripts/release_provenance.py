#!/usr/bin/env python3
# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Preserve and verify detached BuildKit evidence for repeatable runnable OCI archives."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import re
import stat
import tarfile
import tempfile
from contextlib import ExitStack, suppress
from pathlib import Path

if __package__:
    from . import merge_oci_archives as oci
    from . import version_plan
else:
    import merge_oci_archives as oci
    import version_plan

REQUIRED_PAIRS = ()
MAX_SIDECAR = 48_000_000
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")
INDEX_JSON = "index.json"
SHA256_PREFIX = "sha256:"
require = oci.require


def policy_pairs(policy):
    """Read an opt-in contract; generated consumers also pin its exact requirements."""
    require(isinstance(policy, dict), "Provenance policy must be an object")
    pairs = policy.get("detached_provenance", [])
    require(isinstance(pairs, list) and len(pairs) <= 16, "Invalid provenance pairs")
    seen = set()
    for pair in pairs:
        require(isinstance(pair, dict) and set(pair) == {"image", "sidecar", "platforms"},
                "Invalid provenance pair fields")
        for field in ("image", "sidecar"):
            name = pair[field]
            require(isinstance(name, str) and NAME.fullmatch(name), "Invalid provenance filename")
            require(name.casefold() not in seen, "Duplicate provenance filename")
            seen.add(name.casefold())
        require(pair["image"].endswith(".oci.tar") and pair["sidecar"].endswith(".provenance.json"),
                "Provenance pair must name an OCI tar and provenance JSON")
        require(pair["platforms"] == list(oci.PLATFORMS), "Provenance requires both exact platforms")
        require(policy.get("sign_releases") is True, "Detached provenance requires release signing")
        config = version_plan.validate_policy(policy)
        matches = [item for item in config.get("artifacts", []) if item["path"] == pair["image"]]
        require(len(matches) == 1 and matches[0]["format"] == "oci", "Provenance image must be declared once")
    require(not REQUIRED_PAIRS or tuple(pairs) == REQUIRED_PAIRS,
            "Provenance policy differs from generated requirements")
    return tuple(pairs)


def pair_version(policy, pair, plan):
    declaration = next(item for item in policy["versioning"]["artifacts"] if item["path"] == pair["image"])
    return version_plan.projected_value(plan, declaration)


def document(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, "Duplicate provenance JSON key")
            value[key] = item
        return value

    def invalid(value):
        raise ValueError(f"Invalid provenance JSON constant: {value}")

    require(len(raw) <= MAX_SIDECAR, "Oversized provenance sidecar")
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)
    except (RecursionError, UnicodeDecodeError) as error:
        raise ValueError("Invalid provenance JSON") from error
    require(isinstance(value, dict), "Provenance sidecar must be an object")
    return value


def read_snapshot(path, limit):
    """Read a bounded, regular, unaliased FD without following or waiting on swaps."""
    path = Path(path)
    require(not path.is_symlink(), "Snapshot must not be a symlink")
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1,
                "Snapshot must be a regular unaliased file")
        require(0 < before.st_size <= limit, "Oversized or empty snapshot")
        raw = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        require((before.st_size, before.st_mtime_ns, before.st_ctime_ns, before.st_nlink) ==
                (after.st_size, after.st_mtime_ns, after.st_ctime_ns, after.st_nlink) and
                len(raw) == before.st_size, "Snapshot changed while reading")
    return raw


def read_sidecar(path, expected=None):
    """Compare the exact captured bytes with their authenticated identity."""
    raw = read_snapshot(path, MAX_SIDECAR)
    if expected is not None:
        require(expected == {"name": path.name, "size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()},
                "Provenance sidecar differs from authenticated inventory")
    return document(raw)


def decode(encoded, budget, *, max_bytes=oci.MAX_JSON):
    require(isinstance(encoded, str) and len(encoded) <= 4 * ((max_bytes + 2) // 3),
            "Oversized encoded provenance blob")
    require(budget[0] + (len(encoded) // 4) * 3 - encoded.count("=") <= oci.MAX_JSON_TOTAL,
            "Too much decoded provenance metadata")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise ValueError("Invalid provenance base64") from error
    require(base64.b64encode(raw).decode() == encoded and 0 < len(raw) <= max_bytes,
            "Noncanonical or oversized provenance blob")
    budget[0] += len(raw)
    require(budget[0] <= oci.MAX_JSON_TOTAL, "Too much decoded provenance metadata")
    return raw


def runtime_metadata(descriptors):
    leaves = [descriptors[platform] for platform in oci.PLATFORMS]
    inner = oci.canonical({"schemaVersion": 2, "mediaType": oci.INDEX, "manifests": leaves})
    digest = hashlib.sha256(inner).hexdigest()
    root = oci.canonical({"schemaVersion": 2, "mediaType": oci.INDEX, "manifests": [
        {"mediaType": oci.INDEX, "digest": SHA256_PREFIX + digest, "size": len(inner)}]})
    return {"oci-layout": oci.canonical({"imageLayoutVersion": "1.0.0"}),
            INDEX_JSON: root, oci.BLOB_PREFIX + digest: inner}, digest


class RuntimeArchive(oci.Archive):
    """An explicitly separate validator for the deterministic two-platform output."""

    def __init__(self, path, version, revision, stack):
        self.descriptors = {}
        self.layer_names = set()
        super().__init__(path, None, version, revision, stack)
        require(self.initial_stat.st_nlink == 1, "Runnable archive must be unaliased")
        generated, self.index_digest = runtime_metadata(self.descriptors)
        for name, expected in generated.items():
            entry = self.members.get(name)
            require(entry is not None, "Missing canonical OCI metadata")
            with self.tar.extractfile(entry) as stream:
                require(stream.read(oci.MAX_JSON + 1) == expected, "Noncanonical runnable OCI index")
        used = self.metadata_names | self.layer_names
        require(set(self.members) == used, "Unexpected unreferenced runnable OCI member")

    def image(self, descriptor, data):
        platform = descriptor.get("platform", {})
        require(isinstance(platform, dict), "Invalid runnable OCI platform")
        name = f"{platform.get('os')}/{platform.get('architecture')}"
        require(name in oci.PLATFORMS and name not in self.descriptors, "Duplicate or unexpected runnable platform")
        self.platform = name
        super().image(descriptor, data)
        self.descriptors[name] = descriptor
        self.layer_names.update(oci.BLOB_PREFIX + item["digest"][7:] for item in data["layers"])
        self.platform = None

    def attestation(self, *_args):
        raise ValueError("Runnable archive must detach its attestations")

    def validate_complete_graph(self):
        require(set(self.descriptors) == set(oci.PLATFORMS) and len(self.images) == 2,
                "Runnable archive must contain both exact platforms")


class OverlayTar:
    def __init__(self, runtime, metadata):
        self.runtime = runtime
        self.metadata = metadata

    def extractfile(self, entry):
        if entry.name in self.metadata:
            return io.BytesIO(self.metadata[entry.name])
        return self.runtime.tar.extractfile(entry)


class EvidenceArchive(oci.Archive):
    """Validate the original input graph using raw metadata and unchanged runtime layers."""

    def __init__(self, runtime, metadata, platform, version, revision):
        self.runtime = runtime
        self.platform, self.version, self.revision = platform, version, revision
        self.members, self.blobs = dict(runtime.members), dict(runtime.blobs)
        self.leaves, self.images, self.attestations = [], [], []
        self.visited, self.metadata_bytes, self.rootfs_bytes = 0, 0, 0
        self.metadata_names, self.layer_identities = set(), {}
        self.attestation_names = set()
        for name, raw in metadata.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(raw)
            self.members[name] = entry
            if name.startswith(oci.BLOB_PREFIX):
                self.blobs[name] = entry
        self.tar = OverlayTar(runtime, metadata)
        require(self.read_json("oci-layout").get("imageLayoutVersion") == "1.0.0", "Invalid original OCI layout")
        self.walk_index(self.read_json(INDEX_JSON), 0)
        self.validate_complete_graph()
        require(self.images[0]["descriptor"] == oci.Archive.descriptor_key(runtime.descriptors[platform]),
                "Provenance subject differs from runnable platform")
        require(any(oci.PROVENANCE_TYPES.intersection(item["predicate_types"]) for item in self.attestations),
                "Platform is missing BuildKit provenance")
        self.unchanged()

    def unchanged(self):
        self.runtime.unchanged()


def verify_pair(directory, pair, plan, policy, expected=None):
    """Expected source/plan come from the validated caller, never from the sidecar."""
    if expected is not None:
        require(pair["image"] in expected and pair["sidecar"] in expected, "Authenticated inventory lacks provenance pair")
    data = read_sidecar(directory / pair["sidecar"], expected[pair["sidecar"]] if expected is not None else None)
    require(set(data) == {"schema", "source_sha", "plan_sha256", "image", "inputs", "blobs"},
            "Invalid provenance sidecar fields")
    require(type(data["schema"]) is int and data["schema"] == 1 and
            data["source_sha"] == plan["source_sha"] and data["plan_sha256"] == version_plan.plan_digest(plan),
            "Provenance source or frozen plan mismatch")
    require(isinstance(data["blobs"], dict) and len(data["blobs"]) <= 4096, "Invalid provenance blob inventory")
    metadata, budget = {}, [0]
    for digest, encoded in data["blobs"].items():
        require(SHA.fullmatch(digest), "Invalid provenance blob digest")
        # Blob roles are established by EvidenceArchive's graph replay below;
        # it retains the smaller structural limit for every non-statement.
        raw = decode(encoded, budget, max_bytes=oci.MAX_ATTESTATION_JSON)
        require(hashlib.sha256(raw).hexdigest() == digest, "Provenance blob digest mismatch")
        metadata[oci.BLOB_PREFIX + digest] = raw
    inputs = data["inputs"]
    require(isinstance(inputs, list) and len(inputs) == len(oci.PLATFORMS), "Invalid original OCI inputs")
    require([item.get("platform") for item in inputs if isinstance(item, dict)] == list(oci.PLATFORMS),
            "Missing, duplicate or unordered original platform")
    used = set()
    with ExitStack() as stack:
        runtime = RuntimeArchive(directory / pair["image"], pair_version(policy, pair, plan), plan["source_sha"], stack)
        if expected is not None:
            require(expected[pair["image"]] == {"name": pair["image"], **runtime.archive_identity},
                    "Runnable archive differs from authenticated inventory")
        require(data["image"] == {"name": pair["image"], **runtime.archive_identity,
                                   "index_sha256": runtime.index_digest}, "Detached provenance image binding mismatch")
        for item in inputs:
            require(set(item) == {"platform", "index", "layout"}, "Invalid original input fields")
            overlay = {**metadata, INDEX_JSON: decode(item["index"], budget),
                       "oci-layout": decode(item["layout"], budget)}
            checked = EvidenceArchive(runtime, overlay, item["platform"], runtime.version, plan["source_sha"])
            used.update(checked.metadata_names & set(metadata))
        require(used == set(metadata), "Unreferenced provenance metadata blob")
        runtime.unchanged()
    return {"image": pair["image"], "sidecar": pair["sidecar"], "plan_sha256": data["plan_sha256"],
            "source_sha": plan["source_sha"]}


def verify_all(directory, policy, plan, payloads=None):
    pairs = policy_pairs(policy)
    if not pairs:
        return []
    version_plan.validate_plan(plan, policy, plan.get("source_sha"))
    expected = None
    if payloads is not None:
        expected = {item["name"]: item for item in payloads}
        require(len(expected) == len(payloads), "Duplicate authenticated payload")
    return [verify_pair(Path(directory), pair, plan, policy, expected) for pair in pairs]


def verify_staged(directory, policy, plan):
    """A build target may own no pair, but may never stage half of one."""
    pairs = policy_pairs(policy)
    if not pairs:
        return []
    directory = Path(directory)
    version_plan.validate_plan(plan, policy, plan.get("source_sha"))
    present = {path.name for path in directory.iterdir()}
    checked = []
    for pair in pairs:
        names = {pair["image"], pair["sidecar"]}
        selected = names & present
        require(not selected or selected == names, "Staged target contains a partial provenance pair")
        if selected:
            checked.append(verify_pair(directory, pair, plan, policy))
    return checked


def read_raw(archive, name):
    entry = archive.members[name]
    limit = oci.MAX_ATTESTATION_JSON if name in archive.attestation_names else oci.MAX_JSON
    require(entry.size <= limit, "Oversized original metadata")
    with archive.tar.extractfile(entry) as stream:
        raw = stream.read(limit + 1)
    require(len(raw) == entry.size, "Truncated original metadata")
    return raw


def collect_runtime_inputs(archives):
    """Separate runnable blobs from the exact original graph metadata."""
    descriptors, runtime_blobs, metadata, originals = {}, {}, {}, []
    for archive in archives:
        require(any(oci.PROVENANCE_TYPES.intersection(item["predicate_types"]) for item in archive.attestations),
                "Platform is missing BuildKit provenance")
        image = next(item for item in archive.leaves if item["digest"] == archive.images[0]["descriptor"]["digest"])
        descriptors[archive.platform] = image
        image_name = oci.BLOB_PREFIX + image["digest"][7:]
        manifest = archive.read_json(image_name)
        names = {image_name, oci.BLOB_PREFIX + manifest["config"]["digest"][7:]}
        names.update(oci.BLOB_PREFIX + item["digest"][7:] for item in manifest["layers"])
        for name in names:
            runtime_blobs[name] = (archive, archive.blobs[name])
        for name in sorted(archive.metadata_names):
            if name.startswith(oci.BLOB_PREFIX):
                raw = read_raw(archive, name)
                require(name not in metadata or metadata[name] == raw, "Conflicting original metadata")
                metadata[name] = raw
        originals.append({"platform": archive.platform,
                          "index": base64.b64encode(read_raw(archive, INDEX_JSON)).decode(),
                          "layout": base64.b64encode(read_raw(archive, "oci-layout")).decode()})
    return descriptors, runtime_blobs, metadata, originals


def write_runtime_archive(path, generated, runtime_blobs):
    """Write deterministic metadata and stream the unchanged runnable payloads."""
    with path.open("xb") as stream:
        with tarfile.open(fileobj=stream, mode="w", format=tarfile.USTAR_FORMAT) as tar:
            for name in sorted(set(generated) | set(runtime_blobs)):
                if name in generated:
                    raw = generated[name]
                    oci.add_file(tar, name, len(raw), io.BytesIO(raw))
                else:
                    archive, entry = runtime_blobs[name]
                    with archive.tar.extractfile(entry) as content:
                        oci.add_file(tar, name, entry.size, content)
        stream.flush()
        os.fsync(stream.fileno())


def detach(inputs, output, sidecar, policy, plan, expected_inputs=None):
    """Create a no-clobber pair; preserve all original graph metadata bytes."""
    pairs = policy_pairs(policy)
    pair = next((item for item in pairs if item["image"] == output.name and item["sidecar"] == sidecar.name), None)
    require(pair is not None, "Output pair is not declared by provenance policy")
    require(set(inputs) == set(oci.PLATFORMS), "Require both single-platform inputs")
    require(output.parent == sidecar.parent and output.parent.is_dir(), "Pair needs one existing output directory")
    require(not os.path.lexists(output) and not os.path.lexists(sidecar), "Output pair already exists")
    version_plan.validate_plan(plan, policy, plan.get("source_sha"))
    version, revision = pair_version(policy, pair, plan), plan["source_sha"]
    with ExitStack() as stack:
        archives = [oci.Archive(inputs[name], name, version, revision, stack) for name in oci.PLATFORMS]
        if expected_inputs is not None:
            require(set(expected_inputs) == set(oci.PLATFORMS), "Native input identities are incomplete")
            for archive in archives:
                actual = {"name": archive.path.name, **archive.archive_identity,
                          "config_digest": SHA256_PREFIX + archive.images[0]["config_sha256"]}
                require(actual == expected_inputs[archive.platform],
                        "Native OCI input differs from verified receipt or smoke image")
        descriptors, runtime_blobs, metadata, originals = collect_runtime_inputs(archives)
        native_evidence = {
            "inputs": [{"platform": archive.platform, "name": archive.path.name,
                        **archive.archive_identity} for archive in archives],
            "images": {archive.platform: {
                "platform": archive.platform,
                "config_digest": SHA256_PREFIX + archive.images[0]["config_sha256"],
                "manifest_digest": archive.images[0]["descriptor"]["digest"],
                "attestation_digests": [item["digest"] for item in archive.attestations],
                "provenance_digests": [item["digest"] for item in archive.attestations
                                       if oci.PROVENANCE_TYPES.intersection(item["predicate_types"])],
            } for archive in archives},
        }
        generated, index_digest = runtime_metadata(descriptors)
        # Both files are prepared and semantically checked before either final name appears.
        temporary = stack.enter_context(tempfile.TemporaryDirectory(prefix=".detached-", dir=output.parent))
        staging = Path(temporary)
        write_runtime_archive(staging / output.name, generated, runtime_blobs)
        for archive in archives:
            archive.unchanged()
        with (staging / output.name).open("rb") as stream:
            image_identity = oci.identity(stream)
        data = {"schema": 1, "source_sha": revision, "plan_sha256": version_plan.plan_digest(plan),
                "image": {"name": output.name, **image_identity, "index_sha256": index_digest},
                "inputs": originals, "blobs": {name[len(oci.BLOB_PREFIX):]: base64.b64encode(raw).decode()
                                              for name, raw in sorted(metadata.items())}}
        raw = oci.canonical(data) + b"\n"
        require(len(raw) <= MAX_SIDECAR, "Oversized generated provenance")
        with (staging / sidecar.name).open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        verify_pair(staging, pair, plan, policy)
        linked = []
        try:
            for path in (output, sidecar):
                os.link(staging / path.name, path)
                linked.append(path)
        except OSError:
            for path in linked:
                with suppress(OSError):
                    staged_path = staging / path.name
                    if os.path.samestat(path.stat(), staged_path.stat()):
                        path.unlink()
            raise
    return {"image": output.name, "sidecar": sidecar.name, "source_sha": revision,
            "plan_sha256": version_plan.plan_digest(plan), **image_identity, **native_evidence}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("detach", "verify"))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--input", action="append", default=[], metavar="PLATFORM=PATH")
    parser.add_argument("--image")
    parser.add_argument("--sidecar")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    policy = json.loads((root / ".release-policy.json").read_text())
    plan = version_plan.validate_plan(json.loads((root / ".release-plan.json").read_text()), policy)
    # Reuse established CLI confinement for every caller-supplied path.
    directory = args.directory.resolve(strict=True)
    require(directory.is_dir() and directory.is_relative_to(root) and not args.directory.is_symlink(),
            "Provenance directory must stay inside the checkout")
    if args.action == "verify":
        print(json.dumps(verify_all(directory, policy, plan), indent=2))
        return
    require(isinstance(args.image, str) and NAME.fullmatch(args.image) and
            isinstance(args.sidecar, str) and NAME.fullmatch(args.sidecar), "Invalid output pair")
    inputs = {}
    for item in args.input:
        platform, separator, path = item.partition("=")
        require(separator and platform not in inputs, "Invalid or duplicate input")
        inputs[platform] = oci.confined_cli_path(root, Path(path))
    output = oci.confined_cli_path(root, directory / args.image, new=True)
    sidecar = oci.confined_cli_path(root, directory / args.sidecar, new=True)
    print(json.dumps(detach(inputs, output, sidecar, policy, plan), indent=2))


if __name__ == "__main__":
    main()
