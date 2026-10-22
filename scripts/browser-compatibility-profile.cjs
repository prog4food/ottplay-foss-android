const assert = require("node:assert/strict");
const inventory = require("../.github/browser-compatibility.json");

// Explicitly reviewed platform limitations, never inferred from a failed test.
const UI_ONLY_TARGETS = new Set([
    "windows-2022-webkit-1-62-1",
    "windows-2022-webkit-1-63-0",
    "windows-2022-webkit-1-64-0",
]);
const UI_SCENARIOS = [
    "Plex shows a localized animated loader through slow startup and reload: _eng",
    "Plex shows a localized animated loader through slow startup and reload: _rus",
];
const MEDIA_SCENARIOS = [
    "Plex aspect persists through media changes and reload: hls.js",
    "Plex aspect persists through media changes and reload: video.js",
    "Plex aspect persists through media changes and strict kiosk natural episode end and reload: hls.js",
];

function selectProfile(
    runtime,
    platform = process.platform,
    architecture = process.arch
) {
    const target = inventory.find((row) => row.id === runtime.target);
    assert.ok(target, "Unknown browser inventory target");
    assert.equal(runtime.engine, target.engine, "Browser engine mismatch");
    assert.equal(
        runtime.channel,
        target.channel || "",
        "Browser channel mismatch"
    );
    assert.equal(
        runtime.playwrightVersion,
        target.playwright,
        "Browser generation mismatch"
    );
    if (target.browser_version !== "installed") {
        assert.equal(
            runtime.browserVersion,
            target.browser_version,
            "Pinned browser version mismatch"
        );
    }
    const expectedPlatform = target.os.startsWith("windows-")
        ? "win32"
        : target.os.startsWith("macos-")
          ? "darwin"
          : "linux";
    assert.equal(
        platform,
        expectedPlatform,
        "Actual operating system mismatch"
    );
    assert.equal(
        runtime.platform,
        platform,
        "Recorded operating system mismatch"
    );
    if (target.os === "macos-15-intel") {
        assert.equal(
            architecture,
            "x64",
            "Actual Intel runner architecture mismatch"
        );
    }
    if (target.os === "ubuntu-26.04") {
        assert.equal(
            architecture,
            "x64",
            "Actual Ubuntu WebKit runner architecture mismatch"
        );
    }
    const uiOnly = UI_ONLY_TARGETS.has(target.id);
    assert.equal(
        uiOnly,
        platform === "win32" && target.engine === "webkit",
        "Windows WebKit generation needs explicit capability review"
    );
    return {
        media: uiOnly ? "not-applicable" : "required",
        name: uiOnly ? "windows-webkit-ui" : "ui-and-hls",
        reason: uiOnly
            ? "Windows WebKit has no MediaSource API or native HLS"
            : null,
        scenarios: uiOnly
            ? UI_SCENARIOS
            : [...UI_SCENARIOS, ...MEDIA_SCENARIOS],
    };
}

function verifyCapabilities(profile, capabilities) {
    if (profile.media === "not-applicable") {
        assert.equal(
            capabilities.mediaSource,
            false,
            "MSE appeared: promote the reviewed UI-only profile"
        );
        assert.equal(
            capabilities.webkitMediaSource,
            false,
            "WebKit MSE appeared: promote the reviewed UI-only profile"
        );
        assert.equal(
            capabilities.managedMediaSource,
            false,
            "Managed MSE appeared: promote the reviewed UI-only profile"
        );
        assert.equal(
            capabilities.nativeHls,
            "",
            "Native HLS appeared: promote the reviewed UI-only profile"
        );
    } else {
        assert.ok(
            capabilities.managedMediaSource ||
                capabilities.mediaSource ||
                capabilities.webkitMediaSource,
            "Required MediaSource capability disappeared"
        );
        assert.equal(
            capabilities.h264Mse,
            true,
            "Required H.264 MSE capability disappeared"
        );
        assert.equal(
            capabilities.aacMse,
            true,
            "Required AAC MSE capability disappeared"
        );
    }
}

function scenarioPattern(scenarios) {
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(?:" + scenarios.map(escape).join("|") + ")$");
}

module.exports = { scenarioPattern, selectProfile, verifyCapabilities };
