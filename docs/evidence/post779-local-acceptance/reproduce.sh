#!/usr/bin/env bash
set -euo pipefail
cd "${1:?Pass the OTT repository directory with its final production dist}"
export GITHUB_SHA="$(git rev-parse HEAD)"
export OTTP_DEVICE_TEST_PORT=4189
export CI_PLAYWRIGHT_MODULE="$(node -p 'require("node:path").dirname(require.resolve("playwright/package.json"))')"
export OTT_LOCAL_ACCEPTANCE_ROOT="$PWD/.compatibility/local-${GITHUB_SHA:0:8}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OTT_LOCAL_ACCEPTANCE_ROOT"
printf 'Local acceptance evidence: %s\n' "$OTT_LOCAL_ACCEPTANCE_ROOT"
test ! -e browser-candidate-web
node -e 'if(require(process.env.CI_PLAYWRIGHT_MODULE+"/package.json").version!=="1.64.0")throw Error("Expected Playwright 1.64.0")'
npm run package:modea > "$OTT_LOCAL_ACCEPTANCE_ROOT/package.log" 2>&1
export CI_BROWSER_DIAGNOSTICS="$OTT_LOCAL_ACCEPTANCE_ROOT"
python3 scripts/prepare_browser_candidate.py build/packages browser-candidate-web > "$OTT_LOCAL_ACCEPTANCE_ROOT/prepare.log" 2>&1
for OTT_LOCAL_ENGINE in chromium firefox webkit; do
    export OTT_LOCAL_ENGINE
    export CI_BROWSER_DIAGNOSTICS="$OTT_LOCAL_ACCEPTANCE_ROOT/$OTT_LOCAL_ENGINE"
    export CI_BROWSER_EVIDENCE="$CI_BROWSER_DIAGNOSTICS/result.json"
    mkdir -p "$CI_BROWSER_DIAGNOSTICS"
    cp "$OTT_LOCAL_ACCEPTANCE_ROOT/candidate.json" "$CI_BROWSER_DIAGNOSTICS/candidate.json"
    node <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const modulePath = process.env.CI_PLAYWRIGHT_MODULE;
const engine = process.env.OTT_LOCAL_ENGINE;
(async () => {
    assert.equal(process.platform, 'darwin', 'This local recipe selects a macOS profile');
    const playwrightVersion = require(path.join(modulePath, 'package.json')).version;
    assert.equal(playwrightVersion, '1.64.0');
    assert.equal(require(path.join(modulePath, '../playwright-core/package.json')).version, playwrightVersion);
    const actualOs = {
        product: execFileSync('sw_vers', ['-productName'], { encoding: 'utf8' }).trim(),
        version: execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
        build: execFileSync('sw_vers', ['-buildVersion'], { encoding: 'utf8' }).trim(),
    };
    const browser = await require(modulePath)[engine].launch({ headless: true });
    try {
        const runtime = {
            schema: 1,
            target: 'macos-15-' + engine + '-1-64-0',
            engine, channel: '', playwrightVersion,
            browserVersion: browser.version(), platform: process.platform,
            sourceSha: process.env.GITHUB_SHA,
            runId: 'local-' + path.basename(process.env.OTT_LOCAL_ACCEPTANCE_ROOT),
            runAttempt: '1', releaseChannel: '', candidateArtifactId: '',
            qualificationScope: 'local development acceptance, not GitHub-hosted matrix qualification',
            githubHosted: false, actualOs,
            declaredProfileOs: 'macos-15',
            profileOsMatchesActual: actualOs.version.split('.')[0] === '15',
        };
        require(path.resolve('scripts/browser-compatibility-profile.cjs')).selectProfile(runtime);
        fs.writeFileSync(path.join(process.env.CI_BROWSER_DIAGNOSTICS, 'runtime.json'), JSON.stringify(runtime, null, 2) + '\n');
        console.log('Probed', engine, runtime.browserVersion, JSON.stringify(actualOs));
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
NODE
    node scripts/browser-acceptance.cjs > "$CI_BROWSER_DIAGNOSTICS/acceptance.log" 2>&1
    printf '%s acceptance passed; evidence: %s\n' "$OTT_LOCAL_ENGINE" "$CI_BROWSER_EVIDENCE"
done
