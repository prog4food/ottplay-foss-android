const assert = require("node:assert/strict");
const { test } = require("node:test");
const inventory = require("../.github/browser-compatibility.json");
const {
    scenarioPattern,
    selectProfile,
    verifyCapabilities,
} = require("../scripts/browser-compatibility-profile.cjs");
const mse = {
    aacMse: true,
    h264Mse: true,
    managedMediaSource: false,
    mediaSource: true,
    nativeHls: "",
    webkitMediaSource: false,
};
const unavailable = {
    aacMse: false,
    h264Mse: false,
    managedMediaSource: false,
    mediaSource: false,
    nativeHls: "",
    webkitMediaSource: false,
};
test("scenario matching treats regex punctuation literally", () => {
    const pattern = scenarioPattern(["hls.js", "a(b)c", "[x]+?", "a\\b"]);
    for (const title of ["hls.js", "a(b)c", "[x]+?", "a\\b"]) {
        assert.equal(pattern.test("suite " + title), true, title);
    }
    for (const title of ["hlsXjs", "abc", "xxx", "hls.js extra"]) {
        assert.equal(pattern.test(title), false, title);
    }
});
function runtime(row) {
    return {
        browserVersion: row.browser_version,
        channel: row.channel || "",
        engine: row.engine,
        platform: row.os.startsWith("windows-")
            ? "win32"
            : row.os.startsWith("macos-")
              ? "darwin"
              : "linux",
        playwrightVersion: row.playwright,
        target: row.id,
    };
}
function profileFor(row) {
    const value = runtime(row);
    return selectProfile(
        value,
        value.platform,
        ["macos-15-intel", "ubuntu-26.04"].includes(row.os) ? "x64" : "arm64"
    );
}
test("all 35 exact targets retain mandatory UI with 32 HLS targets and three explicit limitations", () => {
    let uiOnly = 0,
        scenarioCount = 0,
        requiredScenarios = 0;
    assert.equal(inventory.length, 35);
    for (const row of inventory) {
        const profile = profileFor(row);
        verifyCapabilities(
            profile,
            profile.media === "required" ? mse : unavailable
        );
        scenarioCount += profile.scenarios.length;
        if (row.tier === "required")
            requiredScenarios += profile.scenarios.length;
        if (profile.media === "not-applicable") uiOnly++;
    }
    assert.equal(uiOnly, 3);
    assert.equal(scenarioCount, 166);
    assert.equal(requiredScenarios, 25);
});
test("wrong platform, engine, generation, channel and unknown target are rejected", () => {
    const row = inventory.find(
        (item) => item.id === "windows-2022-webkit-1-64-0"
    );
    for (const patch of [
        { platform: "linux" },
        { engine: "chromium" },
        { playwrightVersion: "1.63.0" },
        { browserVersion: "26.6" },
        { channel: "chrome" },
        { target: "windows-2022-webkit-future" },
    ]) {
        assert.throws(() =>
            selectProfile({ ...runtime(row), ...patch }, "win32")
        );
    }
    assert.throws(() => selectProfile(runtime(row), "linux"));
});
test("a newly available Windows WebKit capability requires an explicit profile upgrade", () => {
    const profile = profileFor(
        inventory.find((item) => item.id === "windows-2022-webkit-1-64-0")
    );
    for (const patch of [
        { mediaSource: true },
        { webkitMediaSource: true },
        { managedMediaSource: true },
        { nativeHls: "maybe" },
        { nativeHls: "probably" },
    ]) {
        assert.throws(() =>
            verifyCapabilities(profile, { ...unavailable, ...patch })
        );
    }
});
test("loss of required MSE or either codec cannot downgrade a full media profile", () => {
    const profile = profileFor(inventory[0]);
    for (const patch of [
        { mediaSource: false },
        { h264Mse: false },
        { aacMse: false },
    ]) {
        assert.throws(() => verifyCapabilities(profile, { ...mse, ...patch }));
    }
    assert.throws(() => verifyCapabilities(profile, unavailable));
    verifyCapabilities(profile, {
        ...mse,
        mediaSource: false,
        webkitMediaSource: true,
    });
    verifyCapabilities(profile, {
        ...mse,
        managedMediaSource: true,
        mediaSource: false,
    });
});

// Compare every available-API combination against the actual pinned HLS helper.
// A dependency or player preference change must explicitly update this contract.
test("capability probe follows the candidate HLS instance backend, including fallback order", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const vm = require("node:vm");
    const ts = require("typescript");
    const Hls = require("hls.js");
    const {
        readBrowserMediaCapabilities,
    } = require("../scripts/browser-media-capabilities.cjs");
    assert.equal(Hls.version, "1.7.3");
    assert.equal(Hls.DefaultConfig.preferManagedMediaSource, false);
    const player = fs.readFileSync(
        path.join(__dirname, "../src/core/index.ts"),
        "utf8"
    );
    assert.equal(
        player.includes("preferManagedMediaSource"),
        false,
        "Review probe selection when the player overrides the HLS default"
    );
    const actual = ts.transpileModule(
        fs.readFileSync(
            path.join(
                path.dirname(require.resolve("hls.js/package.json")),
                "src/utils/mediasource-helper.ts"
            ),
            "utf8"
        ),
        { compilerOptions: { module: ts.ModuleKind.CommonJS } }
    ).outputText;
    for (let mask = 0; mask < 8; mask++) {
        const calls = [];
        const scope = { Hls };
        for (const [index, name] of [
            "MediaSource",
            "ManagedMediaSource",
            "WebKitMediaSource",
        ].entries()) {
            if (mask & (1 << index)) {
                scope[name] = class {
                    static isTypeSupported(type) {
                        calls.push([name, type]);
                        return true;
                    }
                };
            }
        }
        const context = { exports: {}, self: scope };
        vm.runInNewContext(actual, context);
        const selected = context.exports.getMediaSource(
            Hls.DefaultConfig.preferManagedMediaSource
        );
        const expected =
            ["MediaSource", "ManagedMediaSource", "WebKitMediaSource"].find(
                (name) => scope[name] && scope[name] === selected
            ) || "none";
        const result = vm.runInNewContext(
            "(" + readBrowserMediaCapabilities.toString() + ")()",
            {
                document: { createElement: () => ({ canPlayType: () => "" }) },
                window: scope,
            }
        );
        assert.equal(result.mseBackend, expected);
        assert.equal(result.h264Mse, !!selected);
        assert.equal(result.aacMse, !!selected);
        assert.deepEqual(
            calls.map(([name]) => name),
            selected ? [expected, expected] : []
        );
    }
    for (const preference of [undefined, true]) {
        assert.throws(
            () =>
                vm.runInNewContext(
                    "(" + readBrowserMediaCapabilities.toString() + ")()",
                    {
                        window: {
                            Hls: {
                                DefaultConfig: {
                                    preferManagedMediaSource: preference,
                                },
                            },
                        },
                    }
                ),
            /backend preference changed/
        );
    }
});

test("historical macOS WebKit targets require Intel without reducing playback coverage", () => {
    const targets = inventory.filter((row) => row.os === "macos-15-intel");
    assert.deepEqual(targets.map((row) => row.id).sort(), [
        "macos-15-intel-webkit-1-62-1",
        "macos-15-intel-webkit-1-63-0",
    ]);
    for (const row of targets) {
        const value = runtime(row);
        const profile = selectProfile(value, "darwin", "x64");
        assert.equal(profile.media, "required");
        assert.equal(profile.scenarios.length, 5);
        for (const arch of ["arm64", "ia32", ""]) {
            assert.throws(() => selectProfile(value, "darwin", arch));
        }
    }
});

test("all Linux WebKit generations retain complete playback on reviewed Ubuntu 26.04", () => {
    const targets = inventory.filter(
        (row) => row.os.startsWith("ubuntu-") && row.engine === "webkit"
    );
    assert.deepEqual(targets.map((row) => row.id).sort(), [
        "ubuntu-26-04-webkit-1-62-1",
        "ubuntu-26-04-webkit-1-63-0",
        "ubuntu-26-04-webkit-1-64-0",
    ]);
    for (const row of targets) {
        assert.equal(row.os, "ubuntu-26.04");
        const value = runtime(row);
        const profile = selectProfile(value, "linux", "x64");
        assert.equal(profile.media, "required");
        assert.equal(profile.scenarios.length, 5);
        for (const arch of ["arm64", "ia32", ""]) {
            assert.throws(() => selectProfile(value, "linux", arch));
        }
    }
});

test("frontend WebKit host guard rejects another distro, version or architecture", () => {
    const { verifyHost } = require("../scripts/check-linux-webkit-host.cjs");
    const release = 'ID=ubuntu\nVERSION_ID="26.04"\n';
    assert.deepEqual(verifyHost("linux", "x64", release), {
        architecture: "x64",
        os: "ubuntu",
        version: "26.04",
    });
    for (const [platform, architecture, source] of [
        ["darwin", "x64", release],
        ["linux", "arm64", release],
        ["linux", "x64", release.replace("ubuntu", "debian")],
        ["linux", "x64", release.replace("26.04", "24.04")],
        ["linux", "x64", ""],
    ]) {
        assert.throws(() => verifyHost(platform, architecture, source));
    }
});
