"""Exercise release signing selection and reject incomplete macOS archives."""
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
COLLECT = ROOT / "scripts/ci-tauri-collect-artifacts.sh"
TARGET = "aarch64-apple-darwin"
LINUX_CONFIG = {"bundle": {"linux": {"deb": {"depends": ["fixture-linux-dependency"]}}}}


def clean_env():
    return {key: value for key, value in os.environ.items()
            if not key.startswith(("APPLE_", "SIGN_APPLE_", "TAURI_", "CSC_", "OTTPLAY_GST_"))}


def executable(path, code):
    path.write_text(f"#!{sys.executable}\n" + code)
    path.chmod(0o755)


class SigningSelection(unittest.TestCase):
    def invoke(self, runner_os, notarize, private_config=True, **extra):
        workflow = yaml.safe_load((ROOT / ".github/workflows/release-build.yml").read_text())
        step = next(item for item in workflow["jobs"]["tauri"]["steps"] if item.get("name") == "Build desktop package")
        script = step["run"].replace("${{ steps.signs.outputs.apple_notarize }}", notarize)
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            output = directory / "invocation.json"
            executable(directory / "npx", "import json,os,sys\nfrom pathlib import Path\n"
                       "Path(os.environ['FIXTURE_OUTPUT']).write_text(json.dumps({'argv':sys.argv[1:],"
                       "'identity':os.environ.get('APPLE_SIGNING_IDENTITY'),'certificate':os.environ.get('APPLE_CERTIFICATE')}))\n")
            env = clean_env() | {"PATH": str(directory) + os.pathsep + os.environ["PATH"],
                                "RUNNER_OS": runner_os, "TAURI_TARGET": TARGET,
                                "FIXTURE_OUTPUT": str(output), **extra}
            config_path = directory / "private playback.json"
            if runner_os == "Linux" and private_config:
                config_path.write_text(json.dumps(LINUX_CONFIG))
                env["OTTPLAY_GST_COMPAT_CONFIG"] = str(config_path)
            result = subprocess.run(["bash", "-eu", "-o", "pipefail", "-c", script],
                                    cwd=directory, env=env, capture_output=True, text=True, check=True)
            self.assertNotIn("fixture-private", result.stdout + result.stderr)
            invocation = json.loads(output.read_text())
            config_args = [invocation["argv"][i + 1] for i, arg in enumerate(invocation["argv"]) if arg == "--config"]
            configs = [json.loads(config_path.read_text() if arg == str(config_path) else arg) for arg in config_args]
        self.assertEqual(invocation["argv"][:3], ["tauri", "build", "--ci"])
        return invocation, configs

    def test_unsigned_macos_signs_bundle_before_all_tauri_packagers(self):
        _, configs = self.invoke("macOS", "false", TAURI_SIGNING="true")
        self.assertIn({"bundle": {"macOS": {"signingIdentity": "-"}}}, configs)
        self.assertIn({"bundle": {"createUpdaterArtifacts": True}}, configs)

    def test_developer_id_and_notarization_are_preserved(self):
        invocation, configs = self.invoke("macOS", "true", SIGN_APPLE_CERTIFICATE="fixture-private-cert",
            SIGN_APPLE_CERTIFICATE_PASSWORD="fixture-private-pass", SIGN_APPLE_SIGNING_IDENTITY="Developer ID Application: Fixture",
            SIGN_APPLE_ID="fixture@example.invalid", SIGN_APPLE_APP_SPECIFIC_PASSWORD="fixture-private-notary",
            SIGN_APPLE_TEAM_ID="FIXTURETEAM")
        self.assertEqual(invocation["identity"], "Developer ID Application: Fixture")
        self.assertEqual(invocation["certificate"], "fixture-private-cert")
        self.assertFalse(any("macOS" in config.get("bundle", {}) for config in configs))

    def test_existing_explicit_signing_and_other_platforms_are_not_overridden(self):
        for runner, extra in [("Linux", {}), ("Windows", {}),
                              ("macOS", {"APPLE_SIGNING_IDENTITY": "Developer ID Application: Existing"}),
                              ("macOS", {"APPLE_CERTIFICATE": "fixture-private-existing"})]:
            with self.subTest(runner=runner, extra=list(extra)):
                _, configs = self.invoke(runner, "false", **extra)
                self.assertFalse(any("macOS" in config.get("bundle", {}) for config in configs))

    def test_linux_private_config_is_preserved_with_updater_signing(self):
        _, configs = self.invoke("Linux", "false", TAURI_SIGNING="true")
        self.assertEqual(configs, [LINUX_CONFIG, {"bundle": {"createUpdaterArtifacts": True}}])

    def test_linux_build_rejects_missing_private_config(self):
        with self.assertRaises(subprocess.CalledProcessError) as raised:
            self.invoke("Linux", "false", private_config=False)
        self.assertIn("Missing private playback package config", raised.exception.stderr)


class CollectionGuards(unittest.TestCase):
    def test_bad_source_or_roundtrip_signature_blocks_collection(self):
        for failure in ("original", "roundtrip", "none"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                bundle = root / "target" / TARGET / "release/bundle"
                app = bundle / "macos/OttPlay FOSS.app"
                app.mkdir(parents=True)
                (bundle / "dmg").mkdir()
                (bundle / "dmg/Fixture.dmg").write_bytes(b"test placeholder; no DMG validation implied")
                bin_dir = root / "bin"
                bin_dir.mkdir()
                executable(bin_dir / "codesign", "import os,sys\nfrom pathlib import Path\n"
                    "phase='roundtrip' if 'ottplay-app-zip.' in sys.argv[-1] else 'original'\n"
                    "with Path(os.environ['FIXTURE_EVENTS']).open('a') as f:f.write(phase+'\\n')\n"
                    "sys.exit(9 if os.environ['FAIL_VERIFY']==phase else 0)\n")
                executable(bin_dir / "ditto", "import sys\nfrom pathlib import Path\n"
                    "if '-c' in sys.argv:Path(sys.argv[-1]).write_bytes(b'fixture zip')\n")
                env = clean_env() | {"PATH": str(bin_dir) + os.pathsep + os.environ["PATH"], "RUNNER_OS": "macOS",
                    "TAURI_TARGET": TARGET, "TMPDIR": str(root), "FAIL_VERIFY": failure, "FIXTURE_EVENTS": str(root / "events")}
                result = subprocess.run(["bash", str(COLLECT)], cwd=root, env=env, capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode == 0, failure == "none", result.stdout + result.stderr)
                self.assertEqual((root / "events").read_text().splitlines(), ["original"] if failure == "original" else ["original", "roundtrip"])
                self.assertFalse(list(root.glob("ottplay-app-zip.*")), "Only our temporary extraction must be removed")
                if failure == "original":
                    self.assertFalse(list((root / "tauri-artifacts").glob("*.zip")))


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("xcrun") and shutil.which("codesign"), "Real macOS signing fixture")
class MacOSRoundtrip(unittest.TestCase):
    def test_real_adhoc_bundle_survives_collect_and_zip_without_running_app(self):
        with tempfile.TemporaryDirectory(prefix="ottplay-signing-fixture-") as temporary:
            root = Path(temporary)
            bundle = root / "target" / TARGET / "release/bundle"
            app = bundle / "macos/OttPlay FOSS.app"
            (app / "Contents/MacOS").mkdir(parents=True)
            (app / "Contents/Resources").mkdir()
            info = {"CFBundleIdentifier": "invalid.example.ottplay-signing-fixture", "CFBundleExecutable": "fixture",
                    "CFBundlePackageType": "APPL", "CFBundleName": "Fixture", "CFBundleVersion": "1.0.0"}
            (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
            (app / "Contents/Resources/proof.txt").write_text("Signed resource survives packaging.\n")
            source = root / "fixture.c"
            source.write_text("int main(void) { return 0; }\n")
            subprocess.run(["xcrun", "clang", str(source), "-o", str(app / "Contents/MacOS/fixture")], check=True, capture_output=True)
            (bundle / "dmg").mkdir()
            (bundle / "dmg/Fixture.dmg").write_bytes(b"test placeholder; no DMG validation implied")
            env = clean_env() | {"RUNNER_OS": "macOS", "TAURI_TARGET": TARGET}
            unsigned = subprocess.run(["bash", str(COLLECT)], cwd=root, env=env, capture_output=True, text=True, check=False)
            self.assertNotEqual(unsigned.returncode, 0, "Linker signature alone is not a valid signed app bundle")
            subprocess.run(["codesign", "--force", "--sign", "-", "--timestamp=none", "--options", "runtime", str(app)],
                           check=True, capture_output=True)
            subprocess.run(["bash", str(COLLECT)], cwd=root, env=env, check=True, capture_output=True)
            archive = root / "tauri-artifacts" / f"OttPlay.FOSS_{TARGET}.app.zip"
            extracted = root / "verified"
            subprocess.run(["ditto", "-x", "-k", str(archive), str(extracted)], check=True)
            signed_app = extracted / app.name
            self.assertTrue((signed_app / "Contents/_CodeSignature/CodeResources").is_file())
            self.assertEqual((signed_app / "Contents/Resources/proof.txt").read_bytes(), (app / "Contents/Resources/proof.txt").read_bytes())
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(signed_app)], check=True, capture_output=True)
            (signed_app / "Contents/Resources/proof.txt").write_text("tampered")
            changed = subprocess.run(["codesign", "--verify", "--deep", "--strict", str(signed_app)], capture_output=True, check=False)
            self.assertNotEqual(changed.returncode, 0, "Resource integrity must actually be checked")


if __name__ == "__main__":
    unittest.main()
