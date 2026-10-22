const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawnSync } = require("node:child_process");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { inlineScripts } = require("../scripts/html-scripts.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay Samsung launch "));
const root = path.join(tmp, "project [test] with spaces");
const sdk = path.join(tmp, "SDK [test] with spaces");
const foreignCwd = path.join(tmp, "unrelated working directory");
const generated = path.join(root, "build/device-tizen-simulator");
const generatedEntry = path.join(generated, "index.html");
const generatedManifest = path.join(generated, "config.xml");
const log = path.join(tmp, "calls.jsonl");
const tools = path.join(tmp, "fake tools");
const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ name, args: process.argv.slice(2) })+'\\n');
if (name === 'uname') console.log('Darwin');
else if (name === 'curl') {
    const args = process.argv.slice(2);
    const urls = args.filter((arg) => /^https?:/.test(arg));
    if (urls.length !== 1) process.exit(97);
    // Real curl treats query brackets as glob syntax unless globbing is disabled.
    if (urls[0].includes('[') && !args.includes('--globoff') && !args.includes('-g')) process.exit(3);
    if (urls[0] === process.env.CURL_FAIL_URL) process.exit(22);
    if (args.includes('--output')) fs.writeFileSync(args[args.indexOf('--output') + 1], 'mock pinned archive');
}
else if (name === 'python3') console.log('vendor/resources/nwjs.app');
else if (name === 'ditto') {
    if (process.env.MOCK_EXTRACT_FAIL === '1') process.exit(1);
    const executable = path.join(process.argv.at(-1), 'vendor/resources/nwjs.app/Contents/MacOS/nwjs');
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.copyFileSync(process.argv[1], executable);
    fs.chmodSync(executable, 0o755);
}
else if (name !== 'nwjs') process.exit(98);
`;
function executable(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fake, { mode: 0o755 });
}
function calls() {
    return fs
        .readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
}
function run(mode, args = [], success = true, extraEnv = {}) {
    fs.writeFileSync(log, "");
    const env = { ...process.env };
    delete env.OTTP_PLAYER_URL;
    delete env.CURL_FAIL_URL;
    const result = spawnSync(
        "bash",
        [path.join(root, "scripts", `${mode}-tizen-simulator.sh`), ...args],
        {
            cwd: foreignCwd,
            encoding: "utf8",
            env: {
                ...env,
                CALL_LOG: log,
                PATH: tools + path.delimiter + process.env.PATH,
                TIZEN_SIMULATOR_SDK: sdk,
                ...extraEnv,
            },
            timeout: 15000,
        }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, success ? 0 : 1, result.stdout + result.stderr);
    return result.stdout + result.stderr;
}

function prepare(playerUrl, success = true, args = []) {
    const env = { ...process.env };
    delete env.OTTP_PLAYER_URL;
    if (playerUrl !== undefined) env.OTTP_PLAYER_URL = playerUrl;
    const result = spawnSync(
        process.execPath,
        [path.join(root, "scripts/prepare-tizen-simulator.cjs"), ...args],
        { cwd: foreignCwd, encoding: "utf8", env, timeout: 15000 }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, success ? 0 : 1, result.stdout + result.stderr);
    return result.stdout + result.stderr;
}

try {
    fs.mkdirSync(foreignCwd);
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    for (const name of [
        "setup-tizen-simulator.sh",
        "run-tizen-simulator.sh",
        "prepare-tizen-simulator.cjs",
    ])
        fs.copyFileSync(
            path.join(__dirname, "../scripts", name),
            path.join(root, "scripts", name)
        );
    for (const name of ["curl", "ditto", "uname"])
        executable(path.join(tools, name));
    const appBundle = path.join(sdk, "tools/sec-tv-simulator/nwjs.app");
    executable(path.join(appBundle, "Contents/MacOS/nwjs"));
    const appDirectory = path.join(tmp, "local Tizen app");
    fs.mkdirSync(appDirectory);
    const app = path.join(appDirectory, "local app [test] #1.html");
    fs.writeFileSync(app, "<!doctype html><title>Local test</title>");
    const manifest = path.join(appDirectory, "config.xml");
    const manifestContent = `<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets" xmlns:tizen="http://tizen.org/ns/widgets"
        id="https://example.org/ottplay-test" version="1.0.0">
    <tizen:application id="OttPlayTst.Test" package="OttPlayTst" required_version="2.3"/>
    <content src="local app [test] #1.html"/>
    <name>Launcher test</name>
</widget>`;

    for (const args of [
        ["--app", app],
        ["--app", app, "--dry-run"],
    ]) {
        assert.match(
            run("run", args, false),
            /manifest not found:.*config\.xml/
        );
        assert.equal(calls().length, 0);
    }
    fs.mkdirSync(manifest);
    assert.match(
        run("run", ["--app", app], false),
        /manifest not found:.*config\.xml/
    );
    assert.equal(calls().length, 0);
    assert.match(
        run(
            "run",
            ["--sdk", path.join(tmp, "missing SDK"), "--home", "--dry-run"],
            false
        ),
        /Simulator not found/
    );
    assert.equal(calls().length, 0);
    fs.rmdirSync(manifest);
    fs.writeFileSync(manifest, manifestContent);

    assert.equal(
        prepare(undefined, true, ["--print-url"]).trim(),
        "http://127.0.0.1:8443/"
    );
    assert.equal(
        fs.existsSync(generated),
        false,
        "Printing the URL does not prepare an app"
    );
    run("run", ["--home"], true, { OTTP_PLAYER_URL: "invalid and ignored" });
    assert.deepEqual(calls(), [{ args: [], name: "nwjs" }]);
    assert.equal(
        fs.existsSync(generated),
        false,
        "Home does not prepare an app"
    );
    assert.match(run("run", ["--home", "--dry-run"]), /nwjs/);
    assert.equal(calls().length, 0);
    assert.match(run("run", ["--app", app, "--dry-run"]), /--file=file:/);
    assert.equal(calls().length, 0);
    assert.equal(fs.readFileSync(manifest, "utf8"), manifestContent);
    run("run", ["--app", app], true, {
        OTTP_PLAYER_URL: "invalid and ignored",
    });
    assert.deepEqual(calls(), [
        { args: ["--file=" + pathToFileURL(app).href], name: "nwjs" },
    ]);
    assert.equal(
        fs.existsSync(generated),
        false,
        "Explicit app does not prepare a wrapper"
    );
    assert.equal(fs.readFileSync(manifest, "utf8"), manifestContent);
    for (const directory of [sdk, path.dirname(appBundle), appBundle]) {
        run("run", ["--sdk", directory, "--home"]);
        assert.deepEqual(calls(), [{ args: [], name: "nwjs" }]);
    }
    const nestedSdk = path.join(tmp, "nested vendor package");
    const relativeApp = "vendor/resources/nwjs.app";
    executable(path.join(nestedSdk, relativeApp, "Contents/MacOS/nwjs"));
    const marker = path.join(nestedSdk, "simulator-app-path.txt");
    fs.writeFileSync(marker, relativeApp + "\n");
    run("run", ["--sdk", nestedSdk, "--app", app]);
    assert.deepEqual(calls()[0].args, ["--file=" + pathToFileURL(app).href]);
    for (const invalid of [
        "",
        "..",
        "../outside/nwjs.app",
        "vendor/../nwjs.app",
        "vendor/..",
        "/tmp/nwjs.app",
        "vendor\\nwjs.app",
        "vendor/nwjs.app\nextra",
        "vendor/not-an-app",
    ]) {
        fs.writeFileSync(marker, invalid + "\n");
        assert.match(
            run("run", ["--sdk", nestedSdk, "--home", "--dry-run"], false),
            /Invalid local simulator path marker/
        );
        assert.equal(calls().length, 0);
    }
    const apk = path.join(tmp, "app.apk");
    fs.writeFileSync(apk, "not HTML");
    for (const invalid of [apk, "http://127.0.0.1:8095/", tmp]) {
        assert.match(run("run", ["--app", invalid], false), /HTML/);
        assert.equal(calls().length, 0);
    }
    assert.match(run("run", ["--app"], false), /requires a value/);
    assert.match(run("run", ["--app", "--dry-run"], false), /requires a value/);
    assert.match(
        run("run", ["--sdk", path.join(tmp, "missing SDK"), "--home"], false),
        /Simulator not found/
    );
    assert.equal(calls().length, 0);

    for (const args of [
        ["--home", "--app", app],
        ["--app", app, "--home"],
        ["--home", "--url", "http://localhost:8095/"],
        ["--url", "http://localhost:8095/", "--home"],
        ["--app", app, "--url", "http://localhost:8095/"],
        ["--url", "http://localhost:8095/", "--app", app],
    ]) {
        run("run", args, false);
        assert.equal(
            calls().length,
            0,
            "Conflicting launch modes do not invoke external tools"
        );
        assert.equal(fs.existsSync(generated), false);
    }
    assert.match(run("run", ["--url"], false), /requires a value/);
    assert.match(run("run", ["--url", "--dry-run"], false), /requires a value/);
    for (const invalid of [
        "invalid",
        "file:///etc/passwd",
        "http://user:secret@localhost/",
    ]) {
        for (const [args, env] of [
            [["--url", invalid], {}],
            [["--dry-run"], { OTTP_PLAYER_URL: invalid }],
        ]) {
            assert.match(
                run("run", args, false, env),
                /HTTP\(S\).*without credentials/
            );
            assert.equal(calls().length, 0);
            assert.equal(
                fs.existsSync(generated),
                false,
                "Invalid target cannot prepare an app"
            );
        }
        assert.match(
            prepare(invalid, false, ["--print-url"]),
            /HTTP\(S\).*without credentials/
        );
        assert.equal(fs.existsSync(generated), false);
    }

    assert.match(run("run", ["--dry-run"]), /--file=file:/);
    assert.equal(
        calls().length,
        0,
        "Dry run prepares files without curl or the SDK"
    );
    assert.equal(fs.existsSync(path.join(foreignCwd, "build")), false);
    assert.equal(redirectTarget(), "http://127.0.0.1:8443/");
    run("run");
    function assertServerLaunch(target) {
        const actual = calls();
        assert.deepEqual(
            actual.map((call) => call.name),
            ["curl", "curl", "nwjs"]
        );
        assert.deepEqual(
            actual
                .slice(0, 2)
                .map((call) => call.args.find((arg) => /^https?:/.test(arg))),
            [new URL(target).origin + "/health", new URL(target).href]
        );
        assert.deepEqual(actual[2].args, [
            "--file=" + pathToFileURL(generatedEntry).href,
        ]);
        assert.equal(redirectTarget(), new URL(target).href);
    }
    assertServerLaunch("http://127.0.0.1:8443/");
    const customUrl =
        "http://localhost:8095/f/samsung/tizen/?config[provider]=m3u&label=space [test]";
    run("run", [], true, { OTTP_PLAYER_URL: customUrl });
    assertServerLaunch(customUrl);
    run("run", ["--url", customUrl], true, {
        OTTP_PLAYER_URL: "invalid but overridden",
    });
    assertServerLaunch(customUrl);
    run("run", ["--url", customUrl, "--dry-run"]);
    assert.equal(calls().length, 0);
    assert.equal(redirectTarget(), new URL(customUrl).href);
    for (const failedUrl of [
        "http://localhost:8095/health",
        new URL(customUrl).href,
    ]) {
        run("run", ["--url", customUrl], false, { CURL_FAIL_URL: failedUrl });
        const requests = calls();
        assert(
            requests.every((call) => call.name === "curl"),
            "Failed preflight must not launch the SDK"
        );
        assert.equal(requests.length, failedUrl.endsWith("/health") ? 1 : 2);
    }

    assert.match(prepare(), /Player target: http:\/\/127\.0\.0\.1:8443\//);
    const xml = new JSDOM(fs.readFileSync(generatedManifest, "utf8"), {
        contentType: "text/xml",
    });
    try {
        const document = xml.window.document;
        assert.equal(document.documentElement.localName, "widget");
        assert.equal(
            document.querySelector("content").getAttribute("src"),
            "index.html"
        );
        const tizen = "http://tizen.org/ns/widgets";
        const application = document.getElementsByTagNameNS(
            tizen,
            "application"
        )[0];
        assert(
            application
                .getAttribute("id")
                .startsWith(application.getAttribute("package") + ".")
        );
        assert.equal(
            document
                .getElementsByTagNameNS(tizen, "profile")[0]
                .getAttribute("name"),
            "tv-samsung"
        );
        assert(
            Array.from(
                document.getElementsByTagNameNS(tizen, "privilege")
            ).some(
                (item) =>
                    item.getAttribute("name") ===
                    "http://tizen.org/privilege/tv.inputdevice"
            )
        );
    } finally {
        xml.window.close();
    }
    function redirectTarget() {
        const html = fs.readFileSync(generatedEntry, "utf8");
        const scripts = inlineScripts(html);
        assert.equal(scripts.length, 1);
        let target;
        vm.runInNewContext(scripts[0], {
            location: {
                replace: (url) => {
                    target = url;
                },
            },
        });
        return target;
    }
    assert.equal(redirectTarget(), "http://127.0.0.1:8443/");
    const hostileUrl =
        "http://localhost:8095/?q=</script><script>alert(1)</script>";
    prepare(hostileUrl);
    assert.equal(redirectTarget(), new URL(hostileUrl).href);
    const preparedHtml = fs.readFileSync(generatedEntry, "utf8");
    const preparedXml = fs.readFileSync(generatedManifest, "utf8");
    for (const invalid of [
        "invalid",
        "file:///etc/passwd",
        "http://user:secret@localhost:8095/",
    ]) {
        assert.match(
            prepare(invalid, false),
            /HTTP\(S\) URL without credentials/
        );
        assert.equal(fs.readFileSync(generatedEntry, "utf8"), preparedHtml);
        assert.equal(fs.readFileSync(generatedManifest, "utf8"), preparedXml);
    }
    assert.match(
        run("run", ["--app", generatedEntry, "--dry-run"]),
        /--file=file:/
    );
    assert.equal(calls().length, 0);

    const cache = path.join(tmp, "new cache");
    const destination = path.join(tmp, "new destination");
    assert.match(
        run("setup", [
            "--cache",
            cache,
            "--destination",
            destination,
            "--dry-run",
        ]),
        /tv-samsung-websimulator-core_10\.0\.6_macos-64\.zip/
    );
    assert.equal(calls().length, 0);
    assert.equal(fs.existsSync(cache), false);
    assert.equal(fs.existsSync(destination), false);
    fs.mkdirSync(destination);
    const sentinel = path.join(destination, "preserve.txt");
    fs.writeFileSync(sentinel, "keep existing SDK");
    assert.match(
        run("setup", ["--destination", destination], false),
        /refusing to overwrite/
    );
    assert.equal(fs.readFileSync(sentinel, "utf8"), "keep existing SDK");
    assert.equal(calls().length, 0);
    const link = path.join(tmp, "existing SDK link");
    fs.symlinkSync(destination, link);
    assert.match(
        run("setup", ["--destination", link], false),
        /refusing to overwrite/
    );
    assert.equal(calls().length, 0);
    assert.match(run("setup", ["--destination"], false), /requires a value/);
    assert.match(
        run("setup", ["--cache", "--dry-run"], false),
        /requires a value/
    );
    assert.equal(calls().length, 0);

    fs.mkdirSync(cache);
    fs.writeFileSync(
        path.join(cache, "tv-samsung-websimulator-core_10.0.6_macos-64.zip"),
        "partial download"
    );
    assert.match(
        run(
            "setup",
            [
                "--cache",
                cache,
                "--destination",
                path.join(tmp, "invalid archive destination"),
            ],
            false
        ),
        /Archive size differs/
    );
    assert.deepEqual(calls(), [{ args: ["-s"], name: "uname" }]);

    // Mock only vendor archive verification/extraction from here on. The real
    // shell setup and launcher still run end-to-end without network or SDKs.
    executable(path.join(tools, "python3"));
    const fakeHome = path.join(tmp, "clean home");
    fs.mkdirSync(fakeHome);
    const bootstrapEnv = { HOME: fakeHome, TIZEN_SIMULATOR_SDK: "" };
    const autoDestination = path.join(
        fakeHome,
        ".local/share/ottplay/tizen-tv-simulator/10.0.6"
    );
    const defaultCache = path.join(root, "build/vendor-tools/samsung");
    const archiveName = "tv-samsung-websimulator-core_10.0.6_macos-64.zip";
    const bootstrapPlan = run(
        "run",
        ["--home", "--dry-run"],
        true,
        bootstrapEnv
    );
    assert.match(bootstrapPlan, /Download:/);
    assert.match(
        bootstrapPlan,
        /10\.0\.6\/data\/tools\/sec-tv-simulator\/nwjs\.app\/Contents\/MacOS\/nwjs/
    );
    assert.equal(calls().length, 0);
    assert.equal(fs.existsSync(autoDestination), false);
    assert.equal(fs.existsSync(defaultCache), false);
    run("run", ["--home"], true, bootstrapEnv);
    assert.deepEqual(
        calls().map((call) => call.name),
        ["uname", "curl", "python3", "ditto", "nwjs"]
    );
    assert.equal(
        fs.existsSync(path.join(autoDestination, "simulator-app-path.txt")),
        true
    );
    assert.equal(
        fs.existsSync(path.join(defaultCache, archiveName)),
        false,
        "New successful downloads do not occupy disk twice"
    );
    run("run", ["--home"], true, bootstrapEnv);
    assert.deepEqual(
        calls().map((call) => call.name),
        ["nwjs"],
        "Installed default is reused"
    );
    assert.match(
        run("setup", ["--destination", autoDestination]),
        /already installed/
    );
    assert.equal(calls().length, 0, "Setup itself is idempotent");

    const studioHome = path.join(tmp, "studio home");
    executable(
        path.join(
            studioHome,
            "tizen-studio/tools/sec-tv-simulator/nwjs.app/Contents/MacOS/nwjs"
        )
    );
    fs.mkdirSync(
        path.join(studioHome, ".local/share/ottplay/tizen-tv-simulator/10.0.6"),
        { recursive: true }
    );
    run("run", ["--home"], true, { HOME: studioHome, TIZEN_SIMULATOR_SDK: "" });
    assert.deepEqual(
        calls().map((call) => call.name),
        ["nwjs"],
        "A working Studio simulator is reused even if the local directory is incomplete"
    );
    for (const args of [[], ["--dry-run"]]) {
        assert.match(
            run("setup", args, true, {
                HOME: studioHome,
                TIZEN_SIMULATOR_SDK: "",
            }),
            /already installed:.*tizen-studio/
        );
        assert.equal(
            calls().length,
            0,
            "Standalone setup reuses Studio without a duplicate download"
        );
    }
    assert.match(
        run("setup", [], true, { HOME: studioHome }),
        /already installed:/
    );
    assert.equal(
        calls().length,
        0,
        "Standalone setup respects a valid configured SDK"
    );
    assert.match(
        run("setup", [], false, {
            HOME: studioHome,
            TIZEN_SIMULATOR_SDK: path.join(tmp, "missing configured SDK"),
        }),
        /Simulator not found at TIZEN_SIMULATOR_SDK/
    );
    assert.equal(calls().length, 0);
    assert.match(
        run(
            "setup",
            ["--destination", path.join(tmp, "explicit new SDK"), "--dry-run"],
            true,
            { HOME: studioHome }
        ),
        /Download:/
    );
    assert.equal(
        calls().length,
        0,
        "Explicit destination overrides discovery and configured SDK"
    );

    const keptCache = path.join(tmp, "kept cache");
    run("setup", [
        "--destination",
        path.join(tmp, "kept installation"),
        "--cache",
        keptCache,
        "--keep-archive",
    ]);
    assert.equal(fs.existsSync(path.join(keptCache, archiveName)), true);
    run("setup", [
        "--destination",
        path.join(tmp, "cached installation"),
        "--cache",
        keptCache,
    ]);
    assert.equal(
        fs.existsSync(path.join(keptCache, archiveName)),
        true,
        "Pre-existing archives are preserved"
    );
    assert.equal(
        calls().some((call) => call.name === "curl"),
        false
    );

    const failedDestination = path.join(tmp, "failed installation");
    const failedCache = path.join(tmp, "failed cache");
    run(
        "setup",
        ["--destination", failedDestination, "--cache", failedCache],
        false,
        { MOCK_EXTRACT_FAIL: "1" }
    );
    assert.equal(
        fs.existsSync(failedDestination),
        false,
        "Extraction failure does not publish a partial installation"
    );
    assert.equal(
        fs.existsSync(path.join(failedCache, archiveName)),
        true,
        "Failed extraction retains the download for retry"
    );
    assert.equal(
        fs
            .readdirSync(tmp)
            .some((name) => name.startsWith(".tizen-simulator-extract.")),
        false
    );
    console.log("Samsung TV Simulator setup/launcher integration tests passed");
} finally {
    fs.rmSync(tmp, { force: true, recursive: true });
}
