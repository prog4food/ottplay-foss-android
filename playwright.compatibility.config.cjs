const path = require("node:path");
const fs = require("node:fs");
const { defineConfig } = require("./tests/helpers/browser-test.cjs");
const {
    scenarioPattern,
    selectProfile,
} = require("./scripts/browser-compatibility-profile.cjs");
const base = require("./playwright.config.cjs");
const output = process.env.CI_BROWSER_DIAGNOSTICS;
const runtime = JSON.parse(fs.readFileSync(path.join(output, "runtime.json")));
const profile = selectProfile(runtime);
module.exports = defineConfig({
    ...base,
    grep: scenarioPattern(profile.scenarios),
    outputDir: path.join(output, "test-results"),
    projects: [
        {
            name: runtime.target,
            use: {
                browserName: runtime.engine,
                channel: runtime.channel || undefined,
            },
        },
    ],
    reporter: [
        ["list"],
        ["json", { outputFile: path.join(output, "playwright.json") }],
    ],
    retries: 0,
    testMatch: ["plex-provider.spec.cjs"],
    workers: 1,
});
