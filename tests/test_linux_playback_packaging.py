#!/usr/bin/env python3
"""Regression checks for package binding, independent of a native build host."""

import importlib.util
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("packaging", ROOT / "scripts/package-linux-playback-compat.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


def elf_fixture(path, payload=b"same executable code"):
    names = b"\0.shstrtab\0.text\0.rodata\0.data\0.bss\0"
    records = [(0, 0, 0, b""), (1, 3, 0, names)]
    for name, data in ((".text", payload), (".rodata", b"constants"), (".data", b"data"), (".bss", b"")):
        records.append((names.index(name.encode()), 8 if name == ".bss" else 1,
                        6 if name == ".text" else 3, data))
    body = bytearray(64)
    headers = []
    for name, kind, flags, data in records:
        offset = len(body)
        body.extend(data)
        headers.append((name, kind, flags, 0, offset, len(data), 0, 0, 1, 0))
    section_offset = len(body)
    for header in headers:
        body.extend(struct.pack("<IIQQQQIIQQ", *header))
    body[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<Q", body, 40, section_offset)
    struct.pack_into("<HHH", body, 58, 64, len(headers), 1)
    path.write_bytes(body)


class PackagingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name).resolve()
        (self.output / "private/gstreamer-1.0").mkdir(parents=True)
        (self.output / "appimage-plugins").mkdir()
        plugin = self.output / "private/gstreamer-1.0/libgstplayback.so"
        elf_fixture(plugin)
        (self.output / "appimage-plugins/libgstplayback.so").write_bytes(plugin.read_bytes())
        (self.output / "corresponding-source.tar.xz").write_bytes(b"source archive fixture")
        self.runtime = {"schema": 1, "replacement_plugin_sha256": MOD.sha(plugin)}
        (self.output / "runtime-manifest.json").write_bytes(MOD.canonical(self.runtime))
        self.receipt = {"schema": 1, "runtime": self.runtime,
                        "runtime_manifest_sha256": MOD.sha(self.output / "runtime-manifest.json"),
                        "corresponding_source_sha256": MOD.sha(self.output / "corresponding-source.tar.xz"),
                        "appimage_plugins": {"libgstplayback.so": MOD.sha(plugin)}}
        (self.output / "build-receipt.json").write_bytes(MOD.canonical(self.receipt))

    def test_generated_config_is_linux_format_specific(self):
        env = self.output / "github-env"
        MOD.prepare(self.output, env)
        value = json.loads((self.output / "tauri-compat.conf.json").read_text())
        linux = value["bundle"]["linux"]
        self.assertEqual(set(linux), {"deb", "appimage"})
        self.assertIn(MOD.PRIVATE + "/gstreamer-1.0/libgstplayback.so", linux["deb"]["files"])
        self.assertNotIn(MOD.PRIVATE + "/gstreamer-1.0/libgstplayback.so", linux["appimage"]["files"])
        for packaging in linux.values():
            self.assertIn(MOD.DOC + "/corresponding-source.tar.xz", packaging["files"])
        self.assertIn("OTTPLAY_GST_COMPAT_MANIFEST_SHA256=" + self.receipt["runtime_manifest_sha256"], env.read_text())

    def test_rejects_changed_private_plugin(self):
        (self.output / "private/gstreamer-1.0/libgstplayback.so").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Private plugin changed"):
            MOD.read_inputs(self.output)

    def test_rejects_changed_staging_and_source(self):
        stage = self.output / "appimage-plugins/libgstplayback.so"
        stage.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Staged AppImage"):
            MOD.read_inputs(self.output)
        stage.write_bytes((self.output / "private/gstreamer-1.0/libgstplayback.so").read_bytes())
        (self.output / "corresponding-source.tar.xz").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "Corresponding source"):
            MOD.read_inputs(self.output)

    def test_rejects_rewritten_runtime_manifest(self):
        (self.output / "runtime-manifest.json").write_text(json.dumps(self.runtime, indent=2))
        with self.assertRaisesRegex(ValueError, "Runtime manifest changed"):
            MOD.read_inputs(self.output)

    def test_rejects_final_plugin_code_change_even_when_abi_matches(self):
        original = self.output / "private/gstreamer-1.0/libgstplayback.so"
        final = self.output / "final.so"
        elf_fixture(final, b"different code")
        contract = {key: True for key in ("class", "machine", "needed", "soname", "exports", "glibc_versions", "bind_now", "relro")}
        with patch.object(MOD.BUILDER, "inspect_elf", return_value=contract), self.assertRaisesRegex(ValueError, "code/static data changed"):
            MOD.verify_transformed_plugin(original, final)

    def test_accepts_payload_preserving_rpath_transform_only(self):
        original = self.output / "private/gstreamer-1.0/libgstplayback.so"
        final = self.output / "final.so"
        final.write_bytes(original.read_bytes() + b"appimage linker metadata")
        contract = {key: True for key in ("class", "machine", "needed", "soname", "exports", "glibc_versions", "bind_now", "relro")}
        with patch.object(MOD.BUILDER, "inspect_elf", return_value=contract), patch.object(MOD.BUILDER, "run", return_value="$ORIGIN/..:$ORIGIN"):
            self.assertEqual(MOD.verify_transformed_plugin(original, final)["sha256"], MOD.sha(final))
        with patch.object(MOD.BUILDER, "inspect_elf", return_value=contract), patch.object(MOD.BUILDER, "run", return_value="/tmp/untrusted"), self.assertRaisesRegex(ValueError, "search path"):
            MOD.verify_transformed_plugin(original, final)

    def test_rejects_truncated_elf(self):
        broken = self.output / "broken.so"
        broken.write_bytes(b"not ELF")
        with self.assertRaisesRegex(ValueError, "ELF64"):
            MOD.payload_sections(broken)

    def test_rejects_packaged_symlink_and_changed_file(self):
        source = self.output / "corresponding-source.tar.xz"
        root = self.output / "package"
        root.mkdir()
        (root / "source").symlink_to(source)
        with self.assertRaisesRegex(ValueError, "Missing packaged file"):
            MOD.verify_embedded(root, {"source": str(source)})
        (root / "source").unlink()
        (root / "source").write_bytes(b"wrong")
        with self.assertRaisesRegex(ValueError, "Packaged file changed"):
            MOD.verify_embedded(root, {"source": str(source)})


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        PackagingTests.setUp(self)
        sys.path.insert(0, str(ROOT / "scripts"))
        self.addCleanup(sys.path.remove, str(ROOT / "scripts"))
        import version_plan
        import version_receipt
        self.versions, self.receipts = version_plan, version_receipt
        self.root = self.output / "repo"
        self.root.mkdir()
        self.enterContext(patch.object(MOD, "ROOT", self.root))
        self.policy = {"repository": "example/project", "mode": "release", "version_file": "version",
                       "default_branch": "main", "validation_workflows": ["ci.yml"],
                       "versioning": {"schema": 1, "promotion": "promote-bytes", "build_number_floor": 0,
                                      "files": [{"path": "version", "format": "text", "value": "package"}]}}
        (self.root / "version").write_text("1.2.3\n")
        self.plan = version_plan.create_plan("1.2.3", "rc", 1, "a" * 40, self.policy, 1)
        (self.root / ".release-plan.json").write_bytes(MOD.canonical(self.plan))
        (self.root / ".release-policy.json").write_bytes(MOD.canonical(self.policy))
        files = version_plan.sync_versions(self.root, self.policy, self.plan)
        inputs = {"schema": 1, "source_sha": self.plan["source_sha"],
                  "plan_sha256": version_plan.plan_digest(self.plan), "files": files,
                  "effective_inputs_sha256": version_plan.effective_inputs_digest(files)}
        (self.root / ".release-inputs.json").write_bytes(MOD.canonical(inputs))
        self.assets = self.root / "release-assets/desktop-linux"
        self.assets.mkdir(parents=True)
        verification = {"schema": 1, "runtime": self.runtime,
                        "build_receipt_sha256": MOD.sha(self.output / "build-receipt.json"),
                        "product_acceptance_performed": False}
        for kind, name in (("deb", "app.deb"), ("appimage", "app.AppImage")):
            package = self.assets / name
            package.write_bytes(b"exact package fixture")
            verification[kind] = {"name": name, "size": package.stat().st_size, "sha256": MOD.sha(package)}
        (self.output / "package-verification.json").write_bytes(MOD.canonical(verification))
        self.receipt_path = self.assets / "release-inputs-desktop-linux.json"
        with patch.object(version_receipt, "capture_toolchain", return_value={"python": "test fixture"}):
            version_receipt.create_receipt(self.root / ".release-plan.json", self.root / ".release-inputs.json",
                                           self.assets, self.receipt_path)

    def test_normal_downstream_verifier_accepts_bound_augmented_receipt(self):
        original = json.loads(self.receipt_path.read_bytes())
        MOD.attach_receipt(self.output, self.receipt_path)
        augmented = json.loads(self.receipt_path.read_bytes())
        self.assertEqual({key: value for key, value in augmented.items() if key != "linux_playback_compat"}, original)
        evidence = augmented["linux_playback_compat"]
        self.assertEqual(evidence["source_sha"], self.plan["source_sha"])
        self.assertEqual(evidence["channel"], "rc")
        inventory = [{"name": path.name, "size": path.stat().st_size, "sha256": MOD.sha(path)}
                     for path in self.assets.iterdir()]
        result = self.receipts.verify_receipts(self.assets, self.plan, inventory, self.policy)
        manifest_identity = next(item for item in inventory if item["name"] == self.receipt_path.name)
        self.assertEqual(result[0]["sha256"], manifest_identity["sha256"])
        self.assertEqual(result[0]["inputs"]["linux_playback_compat"], evidence)
        # The ordinary outer manifest digest covers this evidence, not only package bytes.
        augmented["linux_playback_compat"]["channel"] = "stable"
        self.receipt_path.write_bytes(MOD.canonical(augmented))
        self.assertNotEqual(MOD.sha(self.receipt_path), manifest_identity["sha256"])

    def test_duplicate_attachment_cannot_overwrite_evidence(self):
        MOD.attach_receipt(self.output, self.receipt_path)
        before = self.receipt_path.read_bytes()
        with self.assertRaisesRegex(ValueError, "already attached"):
            MOD.attach_receipt(self.output, self.receipt_path)
        self.assertEqual(self.receipt_path.read_bytes(), before)

    def test_changed_staged_package_rejected_without_receipt_write(self):
        before = self.receipt_path.read_bytes()
        (self.assets / "app.deb").write_bytes(b"changed package fixture")
        with self.assertRaisesRegex(ValueError, "Staged package changed"):
            MOD.attach_receipt(self.output, self.receipt_path)
        self.assertEqual(self.receipt_path.read_bytes(), before)

    def test_foreign_plan_rejected_without_receipt_write(self):
        before = self.receipt_path.read_bytes()
        plan = dict(self.plan, source_sha="b" * 40)
        (self.root / ".release-plan.json").write_bytes(MOD.canonical(plan))
        with self.assertRaisesRegex(ValueError, "source SHA mismatch"):
            MOD.attach_receipt(self.output, self.receipt_path)
        self.assertEqual(self.receipt_path.read_bytes(), before)

    def test_size_bound_rejected_without_receipt_write(self):
        before = self.receipt_path.read_bytes()
        with patch.object(MOD, "MAX_EVIDENCE_BYTES", len(before) + 1), self.assertRaisesRegex(ValueError, "exceeds 1 MiB"):
            MOD.attach_receipt(self.output, self.receipt_path)
        self.assertEqual(self.receipt_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
