const { defineConfig } = require("./tests/helpers/browser-test.cjs");

const port = Number(process.env.OTTP_DEVICE_TEST_PORT || 4179);

module.exports = defineConfig({
    expect: { timeout: 10000 },
    forbidOnly: !!process.env.CI,
    fullyParallel: true,
    outputDir: "build/device-browser-results",
    reporter: [
        ["list"],
        [
            "html",
            { open: "never", outputFolder: "build/device-browser-report" },
        ],
    ],
    retries: 0,
    testDir: "./tests/browser",
    testMatch: [
        "device-detection.spec.cjs",
        "media-runtime.spec.cjs",
        "playback-runtime.spec.cjs",
        "nas-library.spec.cjs",
        "plex-provider.spec.cjs",
        "media-channel-playlists.spec.cjs",
        "vportal-provider.spec.cjs",
        "strict-kiosk.spec.cjs",
        "stalker-profiles.spec.cjs",
        "pc2-playback.spec.cjs",
        "pc-random.spec.cjs",
        "window-controls.spec.cjs",
        "remote-diagnostics.spec.cjs",
        "remote-screenshot.spec.cjs",
        "remote-plex.spec.cjs",
        "remote-favorites.spec.cjs",
        "remote-doctor.spec.cjs",
        "standby-native.spec.cjs",
    ],
    timeout: 30000,
    use: {
        baseURL: "http://127.0.0.1:" + port,
        browserName: "chromium",
        headless: true,
        screenshot: "only-on-failure",
        serviceWorkers: "block",
        trace: "retain-on-failure",
        viewport: { height: 720, width: 1280 },
    },
    webServer: {
        command: "node tests/helpers/device-browser-server.cjs",
        env: { OTTP_DEVICE_TEST_PORT: String(port) },
        reuseExistingServer: false,
        timeout: 10000,
        url: "http://127.0.0.1:" + port + "/__device_test_health",
    },
    workers: process.env.CI ? 2 : undefined,
});
