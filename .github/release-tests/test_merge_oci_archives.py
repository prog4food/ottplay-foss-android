# Vendored release toolkit; change the toolkit source, then render again.
# ruff: noqa
# mypy: ignore-errors
# pylint: skip-file
# fmt: off
"""Exercise native OCI assembly without Docker, registry access or extraction."""

import gzip
import hashlib
import importlib.util
import io
import json
# Tests run the local Python interpreter with explicit fixture argv and no shell.
import subprocess  # nosec B404
import sys
import tarfile
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/merge_oci_archives.py"
SPEC = importlib.util.spec_from_file_location("merge_oci_archives", SCRIPT)
oci = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(oci)
VERSION = "0.1.6-beta.1"
REVISION = "1234567890" * 4


class MergeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / "merged.oci.tar"

    @staticmethod
    def blob(entries, content, media):
        raw = content if isinstance(content, bytes) else oci.canonical(content)
        digest = "sha256:" + hashlib.sha256(raw).hexdigest()
        entries["blobs/sha256/" + digest[7:]] = raw
        return {"mediaType": media, "digest": digest, "size": len(raw)}

    @staticmethod
    def layer_bytes():
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as archive:
            data = b"shared filesystem layer\n"
            entry = tarfile.TarInfo("fixture.txt")
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
        return stream.getvalue()

    def fixture(
        self,
        architecture,
        nested=True,
        attestation=None,
        *,
        layer_content=None,
        layer_media="application/vnd.oci.image.layer.v1.tar",
        diff_id=None,
        attestation_size=None,
    ):
        entries = {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}'}
        layer = self.blob(
            entries,
            self.layer_bytes() if layer_content is None else layer_content,
            layer_media,
        )
        config = self.blob(
            entries,
            {
                "architecture": architecture,
                "os": "linux",
                "config": {
                    "Labels": {
                        "org.opencontainers.image.version": VERSION,
                        "org.opencontainers.image.revision": REVISION,
                    }
                },
                "rootfs": {
                    "type": "layers",
                    "diff_ids": [
                        diff_id
                        or "sha256:" + hashlib.sha256(self.layer_bytes()).hexdigest()
                    ],
                },
            },
            oci.CONFIG,
        )
        image = self.blob(
            entries,
            {
                "schemaVersion": 2,
                "mediaType": oci.MANIFEST,
                "config": config,
                "layers": [layer],
            },
            oci.MANIFEST,
        )
        image["platform"] = {"os": "linux", "architecture": architecture}
        manifests = [image]
        if attestation:
            statement_raw = oci.canonical(
                {
                    "_type": "https://in-toto.io/Statement/v1",
                    "subject": [
                        {"name": "_", "digest": {"sha256": image["digest"][7:]}}
                    ],
                    "predicateType": "https://slsa.dev/provenance/v1",
                    "predicate": {},
                }
            )
            if attestation_size is not None:
                statement_raw = statement_raw.ljust(attestation_size, b" ")
            statement = self.blob(entries, statement_raw, oci.IN_TOTO)
            data = {
                "schemaVersion": 2,
                "mediaType": oci.MANIFEST,
                "layers": [statement],
            }
            if attestation == "artifact":
                data["artifactType"] = oci.ATTESTATION
                data["subject"] = oci.Archive.descriptor_key(image)
                data["config"] = self.blob(entries, {}, oci.EMPTY_CONFIG)
                data["config"]["data"] = "e30="
            else:
                data["config"] = self.blob(
                    entries, {"os": "unknown", "architecture": "unknown"}, oci.CONFIG
                )
            attest = self.blob(entries, data, oci.MANIFEST)
            attest["platform"] = {"os": "unknown", "architecture": "unknown"}
            attest["annotations"] = {
                "vnd.docker.reference.type": "attestation-manifest",
                "vnd.docker.reference.digest": image["digest"],
            }
            manifests.append(attest)
        if nested:
            manifests = [
                self.blob(
                    entries,
                    {
                        "schemaVersion": 2,
                        "mediaType": oci.INDEX,
                        "manifests": manifests,
                    },
                    oci.INDEX,
                )
            ]
        entries["index.json"] = oci.canonical(
            {"schemaVersion": 2, "mediaType": oci.INDEX, "manifests": manifests}
        )
        return entries

    def archive(self, name, entries, extras=()):
        path = self.root / name
        with tarfile.open(path, "w") as archive:
            for member, raw in entries.items():
                entry = tarfile.TarInfo(member)
                entry.size, entry.mtime, entry.uid = len(raw), 123456, 456
                archive.addfile(entry, io.BytesIO(raw))
            for entry, raw in extras:
                archive.addfile(entry, io.BytesIO(raw) if raw is not None else None)
        return path

    def inputs(self, amd64=None, arm64=None, extras=()):
        return {
            "linux/amd64": self.archive(
                "amd64.tar",
                amd64 if amd64 is not None else self.fixture("amd64"),
                extras,
            ),
            "linux/arm64": self.archive(
                "arm64.tar", arm64 if arm64 is not None else self.fixture("arm64")
            ),
        }

    def merge(self, inputs=None, output=None):
        return oci.merge_archives(
            inputs or self.inputs(), output or self.output, VERSION, REVISION
        )

    @staticmethod
    def load(path):
        with tarfile.open(path) as archive:
            return {entry.name: archive.extractfile(entry).read() for entry in archive}

    def rewrite_manifest(self, entries, mutate, index=0):
        root = json.loads(entries["index.json"])
        descriptor = root["manifests"][index]
        old = descriptor["digest"]
        body = json.loads(entries["blobs/sha256/" + old[7:]])
        mutate(body)
        replacement = self.blob(entries, body, oci.MANIFEST)
        descriptor.update(replacement)
        entries["index.json"] = oci.canonical(root)

    def test_attestation_size_boundary_preserves_raw_statement(self):
        for kind in ("legacy", "artifact"):
            with self.subTest(kind=kind):
                entries = self.fixture("amd64", attestation=kind,
                                       attestation_size=oci.MAX_ATTESTATION_JSON)
                name = next(name for name, raw in entries.items()
                            if len(raw) == oci.MAX_ATTESTATION_JSON)
                output = self.root / f"{kind}.tar"
                self.merge(self.inputs(amd64=entries), output)
                self.assertEqual(self.load(output)[name], entries[name])
        entries = self.fixture("amd64", attestation="artifact",
                               attestation_size=oci.MAX_ATTESTATION_JSON + 1)
        with self.assertRaisesRegex(ValueError, "oversized OCI metadata"):
            self.merge(self.inputs(amd64=entries))
        self.assertFalse(self.output.exists())

    def test_structural_json_size_boundary_is_unchanged(self):
        for name in ("oci-layout", "index.json"):
            for extra in (0, 1):
                with self.subTest(name=name, extra=extra):
                    entries = self.fixture("amd64")
                    entries[name] = entries[name].ljust(oci.MAX_JSON + extra, b" ")
                    path = self.archive("boundary.tar", entries)
                    with ExitStack() as stack:
                        if extra:
                            with self.assertRaisesRegex(ValueError, "oversized OCI metadata"):
                                oci.Archive(path, "linux/amd64", VERSION, REVISION, stack)
                        else:
                            oci.Archive(path, "linux/amd64", VERSION, REVISION, stack)

    def test_metadata_aggregate_size_boundary_is_unchanged(self):
        path = self.archive("aggregate.tar", self.fixture("amd64"))
        with ExitStack() as stack:
            archive = oci.Archive(path, "linux/amd64", VERSION, REVISION, stack)
            size = archive.members["oci-layout"].size
            archive.metadata_bytes = oci.MAX_JSON_TOTAL - size
            archive.read_json("oci-layout")
            self.assertEqual(archive.metadata_bytes, oci.MAX_JSON_TOTAL)
            archive.metadata_bytes = oci.MAX_JSON_TOTAL - size + 1
            with self.assertRaisesRegex(ValueError, "Too much OCI metadata"):
                archive.read_json("oci-layout")

    def test_deterministic_merge_preserves_blobs_and_one_root_reference(self):
        amd64 = self.fixture("amd64", attestation="legacy")
        arm64 = self.fixture("arm64", attestation="artifact")
        inputs = self.inputs(amd64, arm64)
        result = self.merge(inputs)
        second = self.root / "second.tar"
        self.merge(dict(reversed(list(inputs.items()))), second)
        self.assertEqual(self.output.read_bytes(), second.read_bytes())
        merged = self.load(self.output)
        root = json.loads(merged["index.json"])
        self.assertEqual(len(root["manifests"]), 1)
        inner = json.loads(merged["blobs/sha256/" + root["manifests"][0]["digest"][7:]])
        self.assertEqual(len(inner["manifests"]), 4)
        self.assertEqual(
            [entry["platform"]["architecture"] for entry in inner["manifests"][:2]],
            ["amd64", "arm64"],
        )
        for entries in (amd64, arm64):
            for name, raw in entries.items():
                if name.startswith("blobs/"):
                    self.assertEqual(merged[name], raw)
        self.assertEqual(
            result["output"]["sha256"],
            hashlib.sha256(self.output.read_bytes()).hexdigest(),
        )
        self.assertEqual(set(result["images"]), set(oci.PLATFORMS))
        self.assertTrue(
            result["images"]["linux/amd64"]["config_digest"].startswith("sha256:")
        )
        self.assertEqual(len(result["images"]["linux/arm64"]["attestation_digests"]), 1)
        with tarfile.open(self.output) as archive:
            for entry in archive:
                self.assertEqual(
                    (entry.mtime, entry.uid, entry.gid, entry.mode), (0, 0, 0, 0o644)
                )

    def test_direct_indexes_and_safe_extension_files(self):
        entries = self.fixture("amd64", nested=False)
        entries["manifest.json"] = b"ignored extension"
        self.merge(self.inputs(entries, self.fixture("arm64", nested=False)))
        self.assertNotIn("manifest.json", self.load(self.output))

    def test_corrupt_layer_with_unchanged_length_fails(self):
        entries = self.fixture("amd64")
        layer = next(name for name, raw in entries.items() if raw == self.layer_bytes())
        entries[layer] = b"X" + entries[layer][1:]
        inputs = self.inputs(entries)
        with self.assertRaisesRegex(ValueError, "blob digest"):
            self.merge(inputs)
        self.assertFalse(self.output.exists())

    def test_missing_blob_and_wrong_descriptor_size_fail(self):
        entries = self.fixture("amd64", nested=False)
        layer = next(name for name, raw in entries.items() if raw == self.layer_bytes())
        del entries[layer]
        inputs = self.inputs(entries)
        with self.assertRaisesRegex(ValueError, "Missing OCI blob"):
            self.merge(inputs)
        entries = self.fixture("amd64", nested=False)
        self.rewrite_manifest(entries, lambda body: body["layers"][0].update(size=999))
        inputs = self.inputs(entries)
        with self.assertRaisesRegex(ValueError, "size mismatch"):
            self.merge(inputs)

    def test_wrong_missing_and_duplicate_platforms_fail(self):
        inputs = {"linux/amd64": self.archive("one.tar", self.fixture("amd64"))}
        with self.assertRaisesRegex(ValueError, "exactly linux"):
            self.merge(inputs)
        inputs = self.inputs(arm64=self.fixture("amd64"))
        with self.assertRaisesRegex(ValueError, "platform differs"):
            self.merge(inputs)
        entries = self.fixture("amd64", nested=False)
        root = json.loads(entries["index.json"])
        root["manifests"].append(root["manifests"][0])
        entries["index.json"] = oci.canonical(root)
        inputs = self.inputs(entries)
        with self.assertRaisesRegex(ValueError, "Duplicate OCI manifest"):
            self.merge(inputs)

    def test_version_and_revision_must_match_every_native_image(self):
        for field in (
            "org.opencontainers.image.version",
            "org.opencontainers.image.revision",
        ):
            entries = self.fixture("amd64", nested=False)

            def change(body, entries=entries, field=field):
                config = body["config"]
                details = json.loads(entries["blobs/sha256/" + config["digest"][7:]])
                details["config"]["Labels"][field] = "wrong"
                body["config"] = self.blob(entries, details, oci.CONFIG)

            self.rewrite_manifest(entries, change)
            inputs = self.inputs(entries)
            with (
                self.subTest(field=field),
                self.assertRaisesRegex(ValueError, "label mismatch"),
            ):
                self.merge(inputs)

    def test_unsafe_members_links_and_duplicates_fail(self):
        for name, kind in (
            ("../escape", tarfile.REGTYPE),
            ("/escape", tarfile.REGTYPE),
            ("link", tarfile.SYMTYPE),
            ("hard", tarfile.LNKTYPE),
            ("device", tarfile.CHRTYPE),
            ("./index.json", tarfile.REGTYPE),
        ):
            entry = tarfile.TarInfo(name)
            entry.type, entry.linkname = (
                kind,
                "index.json" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else "",
            )
            entry.size = 0
            inputs = self.inputs(extras=[(entry, b"")])
            with (
                self.subTest(name=name),
                self.assertRaisesRegex(ValueError, "Unsafe|regular|Duplicate"),
            ):
                self.merge(inputs)

    def test_foreign_layer_or_url_is_not_accepted(self):
        for change in (
            {
                "mediaType": "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip"
            },
            {"urls": ["https://example.invalid/layer"]},
        ):
            entries = self.fixture("amd64", nested=False)
            self.rewrite_manifest(
                entries, lambda body, change=change: body["layers"][0].update(change)
            )
            inputs = self.inputs(entries)
            with (
                self.subTest(change=change),
                self.assertRaisesRegex(ValueError, "media type|External"),
            ):
                self.merge(inputs)

    def test_attestation_subject_and_reference_must_identify_image(self):
        for kind in ("legacy", "artifact"):
            entries = self.fixture("amd64", nested=False, attestation=kind)
            root = json.loads(entries["index.json"])
            root["manifests"][1]["annotations"]["vnd.docker.reference.digest"] = (
                "sha256:" + "f" * 64
            )
            entries["index.json"] = oci.canonical(root)
            inputs = self.inputs(entries)
            with (
                self.subTest(kind=kind),
                self.assertRaisesRegex(
                    ValueError, "attestation subject|reference differs"
                ),
            ):
                self.merge(inputs)

    def test_attestation_statement_and_subject_platform_are_bound(self):
        for change in ("statement", "platform"):
            entries = self.fixture("amd64", nested=False, attestation="artifact")

            def mutate(body, change=change, entries=entries):
                if change == "platform":
                    body["subject"]["platform"] = {
                        "os": "linux",
                        "architecture": "arm64",
                    }
                else:
                    layer = body["layers"][0]
                    statement = json.loads(
                        entries["blobs/sha256/" + layer["digest"][7:]]
                    )
                    statement["subject"][0]["digest"]["sha256"] = "0" * 64
                    body["layers"] = [self.blob(entries, statement, oci.IN_TOTO)]

            self.rewrite_manifest(entries, mutate, index=1)
            inputs = self.inputs(entries)
            with (
                self.subTest(change=change),
                self.assertRaisesRegex(ValueError, "subject.*differs"),
            ):
                self.merge(inputs)

    def test_layer_diff_id_must_match_even_with_valid_blob_hashes(self):
        for content, media in (
            (self.layer_bytes(), "application/vnd.oci.image.layer.v1.tar"),
            (
                gzip.compress(self.layer_bytes()),
                "application/vnd.oci.image.layer.v1.tar+gzip",
            ),
        ):
            entries = self.fixture(
                "amd64",
                layer_content=content,
                layer_media=media,
                diff_id="sha256:" + "f" * 64,
            )
            inputs = self.inputs(entries)
            with (
                self.subTest(media=media),
                self.assertRaisesRegex(ValueError, "diff_id"),
            ):
                self.merge(inputs)
            self.assertFalse(self.output.exists())

    def test_gzip_layers_are_verified_without_changing_their_bytes(self):
        content = gzip.compress(self.layer_bytes())
        entries = self.fixture(
            "amd64",
            layer_content=content,
            layer_media="application/vnd.oci.image.layer.v1.tar+gzip",
        )
        self.merge(self.inputs(entries))
        name = oci.BLOB_PREFIX + hashlib.sha256(content).hexdigest()
        self.assertEqual(self.load(self.output)[name], content)

    def test_corrupt_compression_fails_despite_matching_blob_digest(self):
        valid = gzip.compress(self.layer_bytes())
        for content in (b"not gzip", valid[:-3], valid[:-8] + b"badcrc!!"):
            entries = self.fixture(
                "amd64",
                layer_content=content,
                layer_media="application/vnd.oci.image.layer.v1.tar+gzip",
            )
            inputs = self.inputs(entries)
            with (
                self.subTest(content=content[-8:]),
                self.assertRaisesRegex(ValueError, "compressed OCI"),
            ):
                self.merge(inputs)
            self.assertFalse(self.output.exists())

    def test_expanded_layer_and_rootfs_limits_fail_before_output(self):
        entries = self.fixture(
            "amd64",
            layer_content=gzip.compress(self.layer_bytes()),
            layer_media="application/vnd.oci.image.layer.v1.tar+gzip",
        )
        for name in ("MAX_LAYER_BYTES", "MAX_ROOTFS_BYTES"):
            inputs = self.inputs(entries)
            with (
                self.subTest(limit=name),
                mock.patch.object(oci, name, 100),
                self.assertRaisesRegex(ValueError, "expanded size"),
            ):
                self.merge(inputs)
            self.assertFalse(self.output.exists())

    def test_repeated_layers_count_toward_expanded_rootfs_limit(self):
        entries = self.fixture("amd64", nested=False)

        def repeat(body):
            body["layers"] *= 2
            config = body["config"]
            details = json.loads(entries[oci.BLOB_PREFIX + config["digest"][7:]])
            details["rootfs"]["diff_ids"] *= 2
            body["config"] = self.blob(entries, details, oci.CONFIG)

        self.rewrite_manifest(entries, repeat)
        inputs = self.inputs(entries)
        with (
            mock.patch.object(oci, "MAX_ROOTFS_BYTES", len(self.layer_bytes()) + 1),
            self.assertRaisesRegex(ValueError, "root filesystem exceeds"),
        ):
            self.merge(inputs)
        self.assertFalse(self.output.exists())

    def test_zstd_without_decoder_fails_closed(self):
        entries = self.fixture(
            "amd64",
            layer_content=b"zstd fixture",
            layer_media="application/vnd.oci.image.layer.v1.tar+zstd",
        )
        inputs = self.inputs(entries)
        with (
            mock.patch.object(oci, "zstd", None),
            self.assertRaisesRegex(ValueError, "requires Python"),
        ):
            self.merge(inputs)
        self.assertFalse(self.output.exists())

    @unittest.skipIf(oci.zstd is None, "Requires standard-library Zstandard")
    def test_zstd_layers_are_verified_and_corruption_is_rejected(self):
        content = oci.zstd.compress(self.layer_bytes())
        entries = self.fixture(
            "amd64",
            layer_content=content,
            layer_media="application/vnd.oci.image.layer.v1.tar+zstd",
        )
        self.merge(self.inputs(entries))
        self.output.unlink()
        for invalid in (content[:-3], b"not zstd"):
            entries = self.fixture(
                "amd64",
                layer_content=invalid,
                layer_media="application/vnd.oci.image.layer.v1.tar+zstd",
            )
            inputs = self.inputs(entries)
            with (
                self.subTest(invalid=invalid),
                self.assertRaisesRegex(ValueError, "compressed OCI"),
            ):
                self.merge(inputs)
            self.assertFalse(self.output.exists())

    def test_provenance_is_distinguished_from_other_attestations(self):
        for predicate in (
            "https://slsa.dev/provenance/v0.2",
            "https://slsa.dev/provenance/v1",
            "https://spdx.dev/Document",
        ):
            with self.subTest(predicate=predicate):
                entries = self.fixture("amd64", nested=False, attestation="artifact")

                def mutate(body, entries=entries, predicate=predicate):
                    layer = body["layers"][0]
                    statement = json.loads(
                        entries["blobs/sha256/" + layer["digest"][7:]]
                    )
                    statement["predicateType"] = predicate
                    body["layers"] = [self.blob(entries, statement, oci.IN_TOTO)]

                self.rewrite_manifest(entries, mutate, index=1)
                result = self.merge(self.inputs(entries))
                details = result["images"]["linux/amd64"]
                self.assertEqual(len(details["attestation_digests"]), 1)
                expected = (
                    details["attestation_digests"]
                    if predicate in oci.PROVENANCE_TYPES
                    else []
                )
                self.assertEqual(details["provenance_digests"], expected)
                self.assertEqual(
                    result["inputs"][0]["attestations"][0]["predicate_types"],
                    [predicate],
                )
                self.output.unlink()

    def test_no_runnable_image_and_unsupported_variant_fail(self):
        entries = self.fixture("amd64", nested=False, attestation="legacy")
        root = json.loads(entries["index.json"])
        root["manifests"] = root["manifests"][1:]
        entries["index.json"] = oci.canonical(root)
        inputs = self.inputs(entries)
        with self.assertRaisesRegex(ValueError, "exactly one runnable"):
            self.merge(inputs)
        entries = self.fixture("amd64", nested=False)
        root = json.loads(entries["index.json"])
        root["manifests"][0]["platform"]["variant"] = "v3"
        entries["index.json"] = oci.canonical(root)
        inputs = self.inputs(entries)
        with self.assertRaisesRegex(ValueError, "variant"):
            self.merge(inputs)

    def test_input_symlink_and_oversized_json_are_rejected(self):
        inputs = self.inputs()
        link = self.root / "input-link.tar"
        link.symlink_to(inputs["linux/amd64"])
        inputs["linux/amd64"] = link
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.merge(inputs)
        entries = self.fixture("amd64")
        entries["oci-layout"] = b" " * (oci.MAX_JSON + 1)
        inputs = self.inputs(entries)
        with self.assertRaisesRegex(ValueError, "oversized"):
            self.merge(inputs)

    def test_input_mutation_during_assembly_never_publishes(self):
        inputs = self.inputs()
        original_add = oci.add_file
        changed = False

        def mutate(archive, name, size, stream):
            nonlocal changed
            original_add(archive, name, size, stream)
            if not changed:
                with inputs["linux/amd64"].open("ab") as source:
                    source.write(b"mutation")
                changed = True

        with (
            mock.patch.object(oci, "add_file", side_effect=mutate),
            self.assertRaisesRegex(ValueError, "changed during assembly"),
        ):
            self.merge(inputs)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob(".oci-merge-*")), [])

    def test_graph_depth_duplicate_json_and_invalid_descriptor_fail(self):
        entries = self.fixture("amd64")
        for _ in range(10):
            descriptor = self.blob(
                entries, json.loads(entries["index.json"]), oci.INDEX
            )
            entries["index.json"] = oci.canonical(
                {"schemaVersion": 2, "manifests": [descriptor]}
            )
        inputs = self.inputs(entries)
        with self.assertRaisesRegex(ValueError, "graph exceeds"):
            self.merge(inputs)
        entries = self.fixture("amd64")
        entries["oci-layout"] = (
            b'{"imageLayoutVersion":"1.0.0","imageLayoutVersion":"1.0.0"}'
        )
        inputs = self.inputs(entries)
        with self.assertRaisesRegex(ValueError, "Duplicate OCI JSON"):
            self.merge(inputs)
        entries = self.fixture("amd64", nested=False)
        root = json.loads(entries["index.json"])
        root["manifests"][0]["size"] = True
        entries["index.json"] = oci.canonical(root)
        inputs = self.inputs(entries)
        with self.assertRaisesRegex(ValueError, "descriptor size"):
            self.merge(inputs)

    def test_existing_output_symlink_and_publish_race_never_overwrite(self):
        inputs = self.inputs()
        self.output.write_bytes(b"existing")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.merge(inputs)
        self.assertEqual(self.output.read_bytes(), b"existing")
        self.output.unlink()
        self.output.symlink_to(self.root / "missing")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.merge(inputs)
        self.output.unlink()
        original_link = oci.os.link

        def race(source, destination):
            Path(destination).write_bytes(b"raced")
            return original_link(source, destination)

        with (
            mock.patch.object(oci.os, "link", side_effect=race),
            self.assertRaises(FileExistsError),
        ):
            self.merge(inputs)
        self.assertEqual(self.output.read_bytes(), b"raced")
        self.assertEqual(list(self.root.glob(".oci-merge-*")), [])

    def test_cleanup_failure_cannot_invalidate_published_archive(self):
        inputs = self.inputs()
        with mock.patch.object(
            oci.os, "unlink", side_effect=PermissionError("cleanup denied")
        ):
            result = self.merge(inputs)
        self.assertEqual(
            result["output"]["sha256"],
            hashlib.sha256(self.output.read_bytes()).hexdigest(),
        )
        self.assertEqual(len(list(self.root.glob(".oci-merge-*"))), 1)

    def test_cleanup_failure_preserves_original_publication_error(self):
        inputs = self.inputs()
        with (
            mock.patch.object(
                oci.os, "link", side_effect=FileExistsError("output raced")
            ),
            mock.patch.object(
                oci.os, "unlink", side_effect=PermissionError("cleanup denied")
            ),
            self.assertRaisesRegex(FileExistsError, "output raced"),
        ):
            self.merge(inputs)
        self.assertFalse(self.output.exists())

    def test_failed_write_leaves_no_output_or_temporary_file(self):
        inputs = self.inputs()
        with (
            mock.patch.object(oci, "add_file", side_effect=OSError("disk full")),
            self.assertRaisesRegex(OSError, "disk full"),
        ):
            self.merge(inputs)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob(".oci-merge-*")), [])

    def test_cli_and_duplicate_input_rejection(self):
        inputs = self.inputs()
        script = self.installed_cli()
        arguments = [
            sys.executable,
            str(script),
            "--version",
            VERSION,
            "--revision",
            REVISION,
            "--output",
            str(self.output),
        ]
        for platform, path in inputs.items():
            arguments += ["--input", f"{platform}={path}"]
        # The argv above selects this interpreter and a copied local fixture script.
        result = subprocess.run(arguments, capture_output=True, text=True, check=True)  # nosec B603
        self.assertEqual(json.loads(result.stdout)["revision"], REVISION)
        # Append a literal duplicate-input flag to the same local fixture invocation.
        duplicate = subprocess.run(  # nosec B603
            arguments + ["--input", f"linux/amd64={inputs['linux/amd64']}"],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(duplicate.returncode, 0)
        self.assertIn("duplicate --input", duplicate.stderr)

    def installed_cli(self):
        """Install the standalone command in a disposable checkout."""
        scripts = self.root / "scripts"
        scripts.mkdir()
        script = scripts / SCRIPT.name
        script.write_bytes(SCRIPT.read_bytes())
        return script

    def cli_call(self, script, inputs, output, cwd=None):
        arguments = [
            sys.executable,
            str(script),
            "--version",
            VERSION,
            "--revision",
            REVISION,
            "--output",
            str(output),
        ]
        for platform, path in inputs.items():
            arguments.extend(["--input", f"{platform}={path}"])
        # The argv above selects this interpreter and a copied local fixture script.
        return subprocess.run(  # nosec B603
            arguments,
            capture_output=True,
            text=True,
            check=False,
            cwd=cwd,
        )

    def test_cli_relative_paths_work_inside_checkout(self):
        inputs = {platform: path.name for platform, path in self.inputs().items()}
        result = self.cli_call(
            self.installed_cli(), inputs, self.output.name, self.root
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["revision"], REVISION)
        self.assertTrue(self.output.is_file())

    def test_cli_outside_paths_are_rejected_before_content_io(self):
        script = self.installed_cli()
        inputs = self.inputs()
        # Invalid contents make an accidental read observable as a tar error.
        inputs["linux/amd64"].write_bytes(b"must not parse this archive")
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory)
            outside_input = outside / "input.tar"
            outside_input.write_bytes(b"outside file remains unchanged")
            outside_output = outside / "output.tar"
            for invalid_inputs, output in (
                ({**inputs, "linux/amd64": outside_input}, self.output),
                (inputs, outside_output),
            ):
                with self.subTest(output=output):
                    result = self.cli_call(script, invalid_inputs, output)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("inside the script checkout", result.stderr)
                    self.assertEqual(
                        outside_input.read_bytes(), b"outside file remains unchanged"
                    )
                    self.assertFalse(self.output.exists())
                    self.assertFalse(outside_output.exists())
                    self.assertEqual(list(self.root.glob(".oci-merge-*")), [])

    def test_cli_symlinks_and_traversal_are_rejected_without_writes(self):
        script = self.installed_cli()
        inputs = self.inputs()
        link = self.root / "input-link.tar"
        link.symlink_to(inputs["linux/amd64"])
        directory = self.root / "assets"
        directory.mkdir()
        directory_link = self.root / "assets-link"
        directory_link.symlink_to(directory, target_is_directory=True)
        git = self.root / ".git"
        git.mkdir()
        git_input = git / "input.tar"
        git_input.write_bytes(b"Git contents remain unchanged")
        cases = [
            ({**inputs, "linux/amd64": link}, self.output, "symlink"),
            (inputs, directory_link / "output.tar", "symlink"),
            (
                {**inputs, "linux/amd64": directory / ".." / "amd64.tar"},
                self.output,
                "traverse",
            ),
            (inputs, directory / ".." / self.output.name, "traverse"),
            ({**inputs, "linux/amd64": git_input}, self.output, "Git directories"),
            (inputs, git / "output.tar", "Git directories"),
        ]
        for invalid_inputs, output, expected in cases:
            with self.subTest(output=output, expected=expected):
                result = self.cli_call(script, invalid_inputs, output)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(expected, result.stderr)
                self.assertFalse(self.output.exists())
                self.assertFalse((directory / "output.tar").exists())
                self.assertFalse((git / "output.tar").exists())
                self.assertEqual(
                    git_input.read_bytes(), b"Git contents remain unchanged"
                )
                self.assertEqual(list(self.root.glob(".oci-merge-*")), [])


if __name__ == "__main__":
    unittest.main()
