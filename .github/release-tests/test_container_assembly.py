"""Validate native OCI assembly, attestation preservation and served web parity."""

import copy
import gzip
import importlib.util
import io
import json
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
SPEC = importlib.util.spec_from_file_location("container_assembly", ROOT / "scripts/assemble-container-oci.py")
assembly = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(assembly)
VERSION = "1.1.43-beta.2"
REVISION = "a" * 40
SPDX = "https://spdx.dev/Document"
SLSA = "https://slsa.dev/provenance/v1"


def layer_bytes(files):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, value in files.items():
            entry = tarfile.TarInfo(name)
            if isinstance(value, bytes):
                entry.size = len(value)
                archive.addfile(entry, io.BytesIO(value))
            elif value is None:
                entry.type = tarfile.DIRTYPE
                archive.addfile(entry)
            else:
                entry.type, entry.linkname = tarfile.SYMTYPE, value
                archive.addfile(entry)
    return output.getvalue()


def native_entries(
    arch,
    *,
    version=VERSION,
    revision=REVISION,
    artifact=False,
    web=None,
    predicates=(SPDX, SLSA),
    subject=None,
    later_layers=(),
    user="65532",
    empty_subjects=False,
    artifact_subject=True,
):
    entries = {"oci-layout": assembly.canonical({"imageLayoutVersion": "1.0.0"})}

    def blob(raw, media):
        if not isinstance(raw, bytes):
            raw = assembly.canonical(raw)
        identity = assembly.sha256(raw)
        entries["blobs/sha256/" + identity] = raw
        return {"mediaType": media, "digest": "sha256:" + identity, "size": len(raw)}

    web = (
        {
            "app/index.html": b"player",
            "app/dist/player.js": b"var player = true;",
            "app/js/runtime-polyfills.js": b"runtime",
        }
        if web is None
        else web
    )
    layers, diff_ids = [], []
    for files in [{**web, "app/ottplay-server": arch.encode()}, *later_layers]:
        layer = layer_bytes(files)
        diff_ids.append("sha256:" + assembly.sha256(layer))
        layers.append(blob(gzip.compress(layer, mtime=0), "application/vnd.oci.image.layer.v1.tar+gzip"))
    config = {
        "architecture": arch,
        "os": "linux",
        "rootfs": {"type": "layers", "diff_ids": diff_ids},
        "config": {
            "User": user,
            "Labels": {"org.opencontainers.image.version": version, "org.opencontainers.image.revision": revision},
        },
    }
    image = blob(
        {
            "schemaVersion": 2,
            "mediaType": assembly.MANIFEST,
            "config": blob(config, "application/vnd.oci.image.config.v1+json"),
            "layers": layers,
        },
        assembly.MANIFEST,
    )
    image["platform"] = {"os": "linux", "architecture": arch}
    attestations = []
    for predicate in predicates:
        statement = {
            "_type": "https://in-toto.io/Statement/v1",
            "predicateType": predicate,
            "subject": []
            if empty_subjects
            else [{"name": "native", "digest": {"sha256": subject or image["digest"][7:]}}],
            "predicate": {"fixture": predicate},
        }
        attestations.append(blob(statement, "application/vnd.in-toto+json"))
    if artifact:
        attest_config = blob({}, "application/vnd.oci.empty.v1+json")
        attest_config["data"] = "e30="
    else:
        attest_config = blob({"architecture": "unknown", "os": "unknown"}, "application/vnd.oci.image.config.v1+json")
    attestation = {"schemaVersion": 2, "mediaType": assembly.MANIFEST, "config": attest_config, "layers": attestations}
    if artifact:
        attestation["artifactType"] = assembly.ATTESTATION
        if artifact_subject:
            attestation["subject"] = {key: image[key] for key in ("mediaType", "digest", "size")}
    attestation_descriptor = blob(attestation, assembly.MANIFEST)
    attestation_descriptor.update(
        platform={"os": "unknown", "architecture": "unknown"},
        annotations={
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": image["digest"],
        },
    )
    leaves = [image, attestation_descriptor]
    nested = blob({"schemaVersion": 2, "mediaType": assembly.INDEX, "manifests": leaves}, assembly.INDEX)
    nested["annotations"] = {"org.opencontainers.image.ref.name": "fixture"}
    entries["index.json"] = assembly.canonical({"schemaVersion": 2, "mediaType": assembly.INDEX, "manifests": [nested]})
    return entries, leaves


def write_archive(path, entries, extra=()):
    with tarfile.open(path, "w") as archive:
        for name, raw in list(entries.items()) + list(extra):
            if isinstance(raw, tarfile.TarInfo):
                archive.addfile(raw)
            else:
                assembly.add_bytes(archive, name, raw)


def read_archive(path):
    with tarfile.open(path) as archive:
        return {entry.name: archive.extractfile(entry).read() for entry in archive if entry.isfile()}


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.paths = {"linux/amd64": self.directory / "amd64.tar", "linux/arm64": self.directory / "arm64.tar"}
        self.entries = {}
        self.leaves = {}
        for platform, path in self.paths.items():
            self.entries[platform], self.leaves[platform] = native_entries(
                platform.split("/")[1], artifact=platform.endswith("arm64")
            )
            write_archive(path, self.entries[platform])
        self.output = self.directory / "combined.tar"

    def assemble(self):
        return assembly.assemble(self.paths, self.output, VERSION, REVISION)

    def test_preserves_every_blob_and_original_image_and_attestation_descriptor(self):
        report = self.assemble()
        combined = read_archive(self.output)
        root = json.loads(combined["index.json"])
        self.assertEqual(len(root["manifests"]), 1)
        index = json.loads(combined["blobs/sha256/" + root["manifests"][0]["digest"][7:]])
        self.assertEqual(index["manifests"], self.leaves["linux/amd64"] + self.leaves["linux/arm64"])
        for entries in self.entries.values():
            for name, raw in entries.items():
                if name.startswith("blobs/"):
                    self.assertEqual(combined[name], raw)
        self.assertEqual(report["web_files"], 3)
        self.assertEqual([item["platform"] for item in report["platforms"]], ["linux/amd64", "linux/arm64"])
        _, images = assembly.version_plan._oci_metadata(
            self.output, ("config", "Labels", "org.opencontainers.image.version"), VERSION
        )
        self.assertEqual({image["architecture"] for image in images}, {"amd64", "arm64"})

    def test_deterministic_output_and_native_inspection_identity(self):
        first = self.assemble()
        second = assembly.assemble(
            dict(reversed(list(self.paths.items()))), self.directory / "second.tar", VERSION, REVISION
        )
        self.assertEqual(first["archive_sha256"], second["archive_sha256"])
        checked = assembly.inspect_native(self.paths["linux/amd64"], "linux/amd64", VERSION, REVISION)
        image = self.leaves["linux/amd64"][0]
        manifest = json.loads(self.entries["linux/amd64"]["blobs/sha256/" + image["digest"][7:]])
        self.assertEqual(checked["image_digest"], image["digest"])
        self.assertEqual(checked["config_digest"], manifest["config"]["digest"])
        self.assertEqual(checked["configured_user"], "65532")
        self.assertEqual(checked["critical_web_files"]["index.html"], assembly.sha256(b"player"))

    def test_missing_or_duplicate_platform_and_existing_output_fail(self):
        with self.assertRaises(ValueError):
            assembly.assemble({"linux/amd64": self.paths["linux/amd64"]}, self.output, VERSION, REVISION)
        self.paths["linux/arm64"] = self.paths["linux/amd64"]
        with self.assertRaisesRegex(ValueError, "expected runnable platform"):
            self.assemble()
        self.output.write_bytes(b"preserve me")
        with self.assertRaisesRegex(ValueError, "already exist"):
            self.assemble()
        self.assertEqual(self.output.read_bytes(), b"preserve me")

    def test_version_revision_sbom_provenance_subject_and_web_mismatches_fail(self):
        cases = [
            {"version": "1.1.43"},
            {"revision": "b" * 40},
            {"predicates": (SLSA,)},
            {"predicates": (SPDX,)},
            {"subject": "0" * 64},
            {"user": "root"},
            {"user": ""},
            {"web": {"app/index.html": b"different", "app/dist/player.js": b"different"}},
        ]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                entries, _ = native_entries("arm64", **arguments)
                write_archive(self.paths["linux/arm64"], entries)
                with self.assertRaises(ValueError):
                    self.assemble()
                self.assertFalse(self.output.exists())

    def test_tampered_layer_duplicate_path_traversal_and_symlink_fail(self):
        original = self.entries["linux/amd64"]
        changed = copy.deepcopy(original)
        layer_name = next(name for name, raw in changed.items() if raw.startswith(b"\x1f\x8b"))
        changed[layer_name] = changed[layer_name][:-1] + bytes([changed[layer_name][-1] ^ 1])
        link = tarfile.TarInfo("blobs/sha256/" + "0" * 64)
        link.type, link.linkname = tarfile.SYMTYPE, "/tmp/outside"
        cases = [
            (changed, ()),
            (original, (("index.json", original["index.json"]),)),
            (original, (("../outside", b"bad"),)),
            (original, ((link.name, link),)),
        ]
        for entries, extra in cases:
            with self.subTest(extra=extra):
                write_archive(self.paths["linux/amd64"], entries, extra)
                with self.assertRaises(ValueError):
                    self.assemble()
                self.assertFalse(self.output.exists())

    def test_web_whiteout_preserves_same_layer_replacement_and_rejects_links(self):
        web = {"app/index.html": b"player", "app/dist/player.js": b"var player = true;"}
        for platform, path in self.paths.items():
            entries, _ = native_entries(
                platform.split("/")[1],
                web={**web, "app/dist/old.js": b"obsolete"},
                later_layers=({"app/dist/player.js": web["app/dist/player.js"], "app/dist/.wh..wh..opq": b""},),
            )
            write_archive(path, entries)
        self.assertEqual(self.assemble()["web_files"], 2)
        self.output.unlink()
        entries, _ = native_entries("arm64", web={**web, "app/js/link.js": "/etc/passwd"})
        write_archive(self.paths["linux/arm64"], entries)
        with self.assertRaisesRegex(ValueError, "regular file"):
            self.assemble()

    def test_cli_rejects_duplicate_input_without_output(self):
        command = [
            sys.executable,
            str(ROOT / "scripts/assemble-container-oci.py"),
            "--input",
            "linux/amd64=" + str(self.paths["linux/amd64"]),
            "--input",
            "linux/amd64=" + str(self.paths["linux/amd64"]),
            "--version",
            VERSION,
            "--revision",
            REVISION,
            "--output",
            str(self.output),
        ]
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate --input", result.stderr)
        self.assertFalse(self.output.exists())

    def test_root_whiteouts_remove_inherited_web_root(self):
        for whiteout in [".wh.app", ".wh..wh..opq"]:
            with self.subTest(whiteout=whiteout):
                entries, _ = native_entries("arm64", later_layers=({whiteout: b""},))
                write_archive(self.paths["linux/arm64"], entries)
                with self.assertRaisesRegex(ValueError, "complete player web root"):
                    self.assemble()
                self.assertFalse(self.output.exists())

    def test_web_file_directory_replacement_fails_but_directory_merge_preserves_children(self):
        for path in ["app/index.html", "app/js/runtime-polyfills.js"]:
            with self.subTest(path=path):
                entries, _ = native_entries("arm64", later_layers=({path: None},))
                write_archive(self.paths["linux/arm64"], entries)
                with self.assertRaisesRegex(ValueError, "file cannot be replaced by a directory"):
                    self.assemble()
                self.assertFalse(self.output.exists())
        entries, _ = native_entries("arm64", later_layers=({"app/dist": None, "app/js": None},))
        write_archive(self.paths["linux/arm64"], entries)
        self.assertEqual(self.assemble()["web_files"], 3)

    def test_unnamed_oci_artifact_statements_use_verified_manifest_subject(self):
        for platform, path in self.paths.items():
            entries, _ = native_entries(platform.split("/")[1], artifact=True, empty_subjects=True)
            write_archive(path, entries)
            checked = assembly.inspect_native(path, platform, VERSION, REVISION)
            self.assertEqual(checked["predicate_types"], sorted([SPDX, SLSA]))
        self.assertEqual(len(self.assemble()["platforms"]), 2)

    def test_empty_or_wrong_subjects_without_valid_oci_artifact_binding_fail(self):
        for arguments in [
            {"empty_subjects": True},
            {"artifact": True, "empty_subjects": True, "artifact_subject": False},
            {"artifact": True, "subject": "0" * 64},
        ]:
            with self.subTest(arguments=arguments):
                entries, _ = native_entries("arm64", **arguments)
                write_archive(self.paths["linux/arm64"], entries)
                with self.assertRaises((ValueError, assembly.version_plan.VersionError)):
                    self.assemble()
                self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
