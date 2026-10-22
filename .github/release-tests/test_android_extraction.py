"""Capacitor APKs belong to every release channel; Play AABs remain separate."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import release_control as release
import version_plan

spec = importlib.util.spec_from_file_location("verify_android_apk", ROOT / "scripts/verify-android-apk.py")
apk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(apk)


class CapacitorReleaseTests(unittest.TestCase):
    def test_channels_keep_android_and_ios_version_contracts(self):
        policy = json.loads((ROOT / ".release-policy.json").read_text())
        self.assertIn("android/version.json", policy["version_companions"])
        artifacts = policy["versioning"]["artifacts"]
        self.assertEqual({row["field"] for row in artifacts if row["path"] == "ottplay-foss-android-full.apk"}, {"version", "versionCode"})
        self.assertEqual({row["field"] for row in artifacts if row["path"] == "ottplay-foss-android-api22.apk"}, {"version", "versionCode"})
        self.assertTrue(any(row["path"].endswith(".ipa") for row in artifacts))
        for channel, sequence in (("beta", 2), ("rc", 3), ("stable", None)):
            plan = version_plan.create_plan("1.1.53", channel, sequence, "a" * 40, policy, build_number=10154)
            self.assertEqual(plan["channel"], channel)
        build = (ROOT / ".github/workflows/release-build.yml").read_text()
        self.assertIn("npm run android:full:release", build)
        self.assertIn("npm run android:api22:release", build)
        self.assertIn("--pattern ottplay-foss-android-api22.apk", build)
        self.assertIn("npm run build:ios", build)
        self.assertIn("scripts/sign-android-apk.py", build)
        self.assertFalse((ROOT / ".github/workflows/play-bundle.yml").exists())

    def test_apks_stage_but_aabs_remain_blocked(self):
        for extension in ("apk", "APK", "aab", "AaB"):
            with self.subTest(extension=extension), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source, target = root / "source", root / "target"
                source.mkdir(); target.mkdir()
                (source / f"player.{extension}").write_bytes(b"release bytes")
                if extension.lower() == "aab":
                    with self.assertRaisesRegex(Exception, "Play Store AAB"):
                        release.stage_assets(source, target)
                    self.assertEqual(list(target.iterdir()), [])
                else:
                    release.stage_assets(source, target)
                    self.assertEqual((target / f"player.{extension}").read_bytes(), b"release bytes")

    def test_real_manifest_must_match_bundle_identity_and_sdk(self):
        version = {"versionName": "1.1.53-beta.26", "versionCode": 10154}
        valid = "package: name='play.ott.foss' versionCode='10154' versionName='1.1.53-beta.26'\nsdkVersion:'24'\ntargetSdkVersion:'36'\nlaunchable-activity: name='play.ott.foss.MainActivity'\n"
        apk.verify_badging(valid, version)
        compat = valid.replace("sdkVersion:'24'", "sdkVersion:'22'")
        apk.verify_badging(compat, version, 22)
        with self.assertRaises(ValueError):
            apk.verify_badging(compat, version)
        with self.assertRaises(ValueError):
            apk.verify_badging(valid, version, 22)
        for before, after in (("10154", "10153"), ("beta.26", "beta.25"), ("play.ott.foss'", "other.app'"), ("sdkVersion:'24'", "sdkVersion:'26'"), ("targetSdkVersion:'36'", "targetSdkVersion:'35'"), ("MainActivity", "WrongActivity")):
            with self.subTest(before=before), self.assertRaises(ValueError):
                apk.verify_badging(valid.replace(before, after), version)


if __name__ == "__main__":
    unittest.main()
