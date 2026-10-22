"""Keep system font rendering without disabling unrelated AndroidX Startup users."""
from pathlib import Path
import copy
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ANDROID = "{http://schemas.android.com/apk/res/android}"
TOOLS = "{http://schemas.android.com/tools}"
STARTUP = "androidx.startup.InitializationProvider"
EMOJI = "androidx.emoji2.text.EmojiCompatInitializer"


def verify_source_policy(manifest):
    app = manifest.find("application")
    providers = [p for p in app.findall("provider") if p.get(ANDROID + "name") == STARTUP]
    assert len(providers) == 1, "Missing explicit Startup merge policy"
    provider = providers[0]
    assert provider.get(TOOLS + "node") == "merge", "Other Startup initializers must remain enabled"
    assert provider.get(ANDROID + "authorities") == "${applicationId}.androidx-startup"
    assert provider.get(ANDROID + "exported") == "false"
    entries = provider.findall("meta-data")
    assert len(entries) == 1, "Do not alter unrelated Startup metadata"
    assert entries[0].get(ANDROID + "name") == EMOJI
    assert entries[0].get(TOOLS + "node") == "remove", "Automatic font loading must be removed"
    assert entries[0].get(ANDROID + "value") is None


class EmojiPolicyTests(unittest.TestCase):
    def setUp(self):
        self.manifest = ET.parse(ROOT / "android/app/src/main/AndroidManifest.xml").getroot()

    def test_common_policy_removes_only_emoji_initializer(self):
        verify_source_policy(self.manifest)
        providers = self.manifest.find("application").findall("provider")
        self.assertTrue(any(p.get(ANDROID + "name") == "androidx.core.content.FileProvider" for p in providers))

    def test_both_editions_preserve_common_startup_policy(self):
        for edition in ("full", "play"):
            overlay = ET.parse(ROOT / f"android/app/src/{edition}/AndroidManifest.xml").getroot()
            app = overlay.find("application")
            self.assertIn(app.get(TOOLS + "node"), (None, "merge"))
            for provider in app.findall("provider"):
                if provider.get(ANDROID + "name") == STARTUP:
                    self.assertIn(provider.get(TOOLS + "node"), (None, "merge"))
                    for item in provider.findall("meta-data"):
                        if item.get(ANDROID + "name") == EMOJI:
                            self.assertEqual(item.get(TOOLS + "node"), "remove")

    def test_policy_rejects_disabling_all_startup(self):
        for mutation in ("remove", "replace", "removeAll"):
            changed = copy.deepcopy(self.manifest)
            provider = next(p for p in changed.find("application").findall("provider") if p.get(ANDROID + "name") == STARTUP)
            provider.set(TOOLS + "node", mutation)
            with self.assertRaises(AssertionError):
                verify_source_policy(changed)

    def test_policy_rejects_wrong_or_reenabled_initializer(self):
        for attribute, value in ((ANDROID + "name", "androidx.lifecycle.ProcessLifecycleInitializer"), (TOOLS + "node", "merge")):
            changed = copy.deepcopy(self.manifest)
            provider = next(p for p in changed.find("application").findall("provider") if p.get(ANDROID + "name") == STARTUP)
            provider.find("meta-data").set(attribute, value)
            with self.assertRaises(AssertionError):
                verify_source_policy(changed)


if __name__ == "__main__":
    unittest.main()
