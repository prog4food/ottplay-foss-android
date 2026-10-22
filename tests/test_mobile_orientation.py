"""Check the native landscape contract without a simulator or device."""

import plistlib
import re
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ANDROID = "{http://schemas.android.com/apk/res/android}"


class MobileOrientationTests(unittest.TestCase):
    """Keep launch metadata and native controller orientation policies aligned."""

    def test_android_launcher_and_native_overlay_share_landscape(self):
        """Both landscape directions apply to the launcher and its video overlay."""
        manifest = ET.parse(ROOT / "android/app/src/main/AndroidManifest.xml")
        candidates = manifest.findall("./application/activity") + manifest.findall("./application/activity-alias")
        launchers = [
            activity for activity in candidates
            if any(
                intent.find(f"action[@{ANDROID}name='android.intent.action.MAIN']") is not None
                and intent.find(f"category[@{ANDROID}name='android.intent.category.LAUNCHER']") is not None
                for intent in activity.findall("intent-filter")
            )
        ]
        self.assertEqual(len(launchers), 1)
        activity = launchers[0]
        self.assertEqual(activity.tag, "activity")
        self.assertEqual(activity.get(ANDROID + "name"), ".MainActivity")
        self.assertEqual(activity.get(ANDROID + "screenOrientation"), "sensorLandscape")
        self.assertEqual(activity.get(ANDROID + "supportsPictureInPicture"), "true")
        properties = {p.get(ANDROID + "name"): p.get(ANDROID + "value") for p in activity.findall("property")}
        self.assertEqual(properties.get("android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY"), "true")
        home = manifest.find(f"./application/activity-alias[@{ANDROID}name='.HomeActivity']")
        self.assertIsNotNone(home)
        self.assertEqual(home.get(ANDROID + "targetActivity"), activity.get(ANDROID + "name"))

    def test_iphone_and_ipad_launch_masks_exclude_portrait(self):
        """Both device families declare exactly the two landscape orientations."""
        with (ROOT / "ios/App/App/Info.plist").open("rb") as handle:
            info = plistlib.load(handle)
        orientations = {"UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"}
        for key in ("UISupportedInterfaceOrientations", "UISupportedInterfaceOrientations~ipad"):
            self.assertEqual(set(info[key]), orientations)
            self.assertEqual(len(info[key]), 2)
        self.assertIs(info["UIRequiresFullScreen"], True)

    def test_ios_scene_and_storyboard_use_constrained_controller(self):
        """Scene and storyboard launch paths both use the landscape bridge."""
        scene = (ROOT / "ios/App/App/SceneDelegate.swift").read_text()
        self.assertIn("rootViewController = MainViewController()", scene)
        storyboard = ET.parse(ROOT / "ios/App/App/Base.lproj/Main.storyboard")
        initial = storyboard.getroot().get("initialViewController")
        controller = storyboard.find(f".//viewController[@id='{initial}']")
        self.assertIsNotNone(controller)
        self.assertEqual(controller.get("customClass"), "MainViewController")
        source = (ROOT / "ios/App/App/MainViewController.swift").read_text()
        self.assertRegex(
            source, r"supportedInterfaceOrientations:\s*UIInterfaceOrientationMask\s*\{\s*\.landscape\s*\}"
        )
        self.assertRegex(source, r"shouldAutorotate:\s*Bool\s*\{\s*true")

    def test_presented_ios_players_obey_application_mask(self):
        """Native fullscreen controllers intersect with the application mask."""
        source = (ROOT / "ios/App/App/AppDelegate.swift").read_text()
        self.assertTrue(
            re.search(
                r"supportedInterfaceOrientationsFor\s+window:\s*UIWindow\?\)"
                r"\s*->\s*UIInterfaceOrientationMask\s*\{\s*\.landscape\s*\}",
                source,
            )
        )


if __name__ == "__main__":
    unittest.main()
