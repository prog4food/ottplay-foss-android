const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
    expect: { timeout: 10000 },
    forbidOnly: !!process.env.CI,
    fullyParallel: true,
    outputDir: "build/native-ui-results",
    projects: [
        { name: "chromium", use: { browserName: "chromium" } },
        { name: "webkit", use: { browserName: "webkit" } },
    ],
    reporter: [
        ["list"],
        ["html", { open: "never", outputFolder: "build/native-ui-report" }],
    ],
    retries: 0,
    testDir: "./tests/browser",
    testMatch: ["channel-list-csp.spec.cjs", "localized-keyboard.spec.cjs"],
    timeout: 30000,
    use: {
        headless: true,
        screenshot: "only-on-failure",
        serviceWorkers: "block",
        trace: "retain-on-failure",
        viewport: { height: 720, width: 1280 },
    },
    workers: process.env.CI ? 2 : undefined,
});
