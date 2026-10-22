// Exercise the real shell launcher with a local HTTP companion and a fake CLI.
// Vendor software is not installed or started by this test.
const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const nativeLauncher = require("../scripts/launch-webos-simulator.cjs");

const exec = promisify(execFile);
const root = path.resolve(__dirname, "..");
const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), "ottplay webos launcher ")
);
const capture = path.join(fixture, "cli args.json");
const bootstrapCapture = path.join(fixture, "setup args.json");
const sdk = path.join(fixture, "SDK with spaces");
const cli = path.join(fixture, "ares launch");
const app = path.join(fixture, "build/device-webos-simulator");
const script = path.join(fixture, "scripts/run-webos-simulator.sh");
const env = {
    ...process.env,
    BOOTSTRAP_CAPTURE: bootstrapCapture,
    CAPTURE_FILE: capture,
    HOME: path.join(fixture, "home"),
    MOCK_CLI: cli,
};
for (const key of [
    "WEBOS_VERSION",
    "WEBOS_SDK_PATH",
    "WEBOS_CLI",
    "OTTP_PLAYER_URL",
    "OTTP_DEVICE_TEST_PORT",
    "LG_WEBOS_TV_SDK_HOME",
])
    delete env[key];
env.WEBOS_CLI = cli;
for (const file of [
    "scripts/run-webos-simulator.sh",
    "scripts/prepare-webos-simulator.cjs",
    "images/player-logo.png",
]) {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(fixture, file));
}
// This fixture isolates shell routing; real native argv execution is covered below.
fs.writeFileSync(
    path.join(fixture, "scripts/launch-webos-simulator.cjs"),
    'require("node:fs").writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));\n'
);
fs.mkdirSync(sdk);
fs.mkdirSync(env.HOME);
// Keep a globally installed ares-launch from escaping the fixture.
const toolBin = path.join(fixture, "tools");
fs.mkdirSync(toolBin);
for (const name of [
    "bash",
    "cat",
    "dirname",
    "basename",
    "curl",
    "mkdir",
    "mktemp",
    "rm",
    "mv",
    "uname",
    "python3",
    "ditto",
    "npm",
]) {
    const executable = process.env.PATH.split(path.delimiter)
        .map((directory) => path.join(directory, name))
        .find((candidate) => {
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                return true;
            } catch (_) {
                return false;
            }
        });
    if (executable) fs.symlinkSync(executable, path.join(toolBin, name));
}
fs.symlinkSync(process.execPath, path.join(toolBin, "node"));
env.PATH = toolBin;
function createSimulator(directory, version = "26", release = "1.5.0") {
    const name = `webOS_TV_${version}_Simulator_${release}`;
    const executable = path.join(
        directory,
        name + ".app",
        "Contents/MacOS",
        name
    );
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}
createSimulator(sdk, "25", "1.4.4");
fs.writeFileSync(
    cli,
    '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.CAPTURE_FILE, JSON.stringify(process.argv.slice(2)));\n',
    { mode: 0o755 }
);
const setupScript = path.join(fixture, "scripts/setup-webos-simulator.sh");
fs.writeFileSync(
    setupScript,
    `#!/usr/bin/env bash
set -euo pipefail
node - "$@" <<'JS'
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.BOOTSTRAP_CAPTURE, JSON.stringify(args));
if (process.env.FAIL_BOOTSTRAP) process.exit(31);
const destination = args[args.indexOf('--destination') + 1];
const version = args[args.indexOf('--version') + 1];
if (!args.includes('--cli-only')) {
    const name = 'webOS_TV_' + version + '_Simulator_1.5.0';
    const binary = path.join(destination, name + '.app', 'Contents/MacOS', name);
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, '#!/bin/sh\\nexit 0\\n', {mode: 0o755});
}
JS
`,
    { mode: 0o755 }
);

async function run(args, extraEnv = {}) {
    return exec("bash", [script, ...args], {
        env: { ...env, ...extraEnv },
        timeout: 15000,
    });
}
async function rejects(args, pattern, extraEnv = {}) {
    await assert.rejects(run(args, extraEnv), (error) =>
        pattern.test(error.stderr)
    );
    assert(!fs.existsSync(capture), "Failed preflight must not launch the SDK");
}

let healthStatus = 200;
const requests = [];
const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(request.url === "/health" ? healthStatus : 200);
    response.end(
        request.url === "/health"
            ? "ok"
            : "<!doctype html><title>Player</title>"
    );
});

(async () => {
    try {
        const help = await run(["--help"]);
        assert(help.stdout.includes("http://127.0.0.1:8443/"));
        await run(["--dry-run"]);
        assert(!fs.existsSync(bootstrapCapture), "Dry run must not bootstrap");
        await rejects(["--no-install", "--dry-run"], /is missing/);
        assert(
            fs
                .readFileSync(path.join(app, "index.html"), "utf8")
                .includes('location.replace("http://127.0.0.1:8443/")')
        );
        assert(!fs.existsSync(capture));
        assert(
            !fs.existsSync(path.join(fixture, "dist")),
            "Hosted launcher needs no local build"
        );
        await run(["--dry-run"], { OTTP_DEVICE_TEST_PORT: "4179" });
        assert(
            fs
                .readFileSync(path.join(app, "index.html"), "utf8")
                .includes("127.0.0.1:4179")
        );
        await run(
            [
                "--dry-run",
                "--url",
                "http://localhost:8095/?q=</script><script>",
            ],
            { OTTP_DEVICE_TEST_PORT: "invalid" }
        );
        assert.equal(
            (
                fs
                    .readFileSync(path.join(app, "index.html"), "utf8")
                    .match(/<\/script>/g) || []
            ).length,
            1
        );
        await rejects(
            ["--url", "file:///etc/passwd", "--dry-run"],
            /HTTP\(S\)/
        );
        await rejects(
            ["--url", "http://user:secret@localhost/", "--dry-run"],
            /without credentials/
        );
        await rejects(
            ["--version", "26;echo injected", "--dry-run"],
            /positive integer/
        );
        await rejects(["--url"], /requires a value/);
        await rejects(["--sdk", "--dry-run"], /requires a value/);
        await rejects(["--unknown"], /Unknown option/);

        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
        const origin = "http://127.0.0.1:" + server.address().port;
        const managedSdk = path.join(
            env.HOME,
            ".local/share/ottplay/webos-tv-simulator/26"
        );
        fs.mkdirSync(path.join(env.HOME, ".webos/tv"), { recursive: true });
        fs.writeFileSync(
            path.join(env.HOME, ".webos/tv/simulator-config.json"),
            JSON.stringify({ 26: path.join(fixture, "deleted installation") })
        );
        await run(["--url", origin], { WEBOS_CLI: "" });
        assert.deepEqual(
            JSON.parse(fs.readFileSync(bootstrapCapture, "utf8")),
            ["--version", "26", "--destination", managedSdk]
        );
        assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), [
            "26",
            managedSdk,
            app,
        ]);
        assert(
            !fs.existsSync(
                path.join(env.HOME, ".local/share/ottplay/webos-cli")
            ),
            "Default launch must never install the vulnerable external CLI"
        );
        fs.unlinkSync(capture);
        fs.unlinkSync(bootstrapCapture);
        await run(["--url", origin], { WEBOS_CLI: "" });
        assert(
            !fs.existsSync(bootstrapCapture),
            "Second launch must reuse installed tools"
        );
        fs.unlinkSync(capture);
        const alternateSdk = path.join(fixture, "another registered SDK");
        createSimulator(alternateSdk);
        fs.writeFileSync(
            path.join(env.HOME, ".webos/tv/simulator-config.json"),
            JSON.stringify({ 26: alternateSdk })
        );
        await run(["--url", origin]);
        assert.equal(
            JSON.parse(fs.readFileSync(capture, "utf8"))[3],
            alternateSdk
        );
        assert(
            !fs.existsSync(bootstrapCapture),
            "Registered SDK should be reused"
        );
        fs.unlinkSync(capture);

        const missingSdk = path.join(fixture, "missing explicit SDK");
        await assert.rejects(
            run(["--url", origin, "--sdk", missingSdk], {
                FAIL_BOOTSTRAP: "1",
            }),
            (error) => error.code === 31
        );
        assert(!fs.existsSync(capture), "Failed setup must not launch");
        fs.unlinkSync(bootstrapCapture);
        requests.length = 0;
        const args = [
            "--url",
            origin + "/f/lg/webos/?config[provider]=m3u",
            "--sdk",
            sdk,
            "--version",
            "25",
        ];
        await run(args);
        assert.deepEqual(JSON.parse(fs.readFileSync(capture, "utf8")), [
            "-s",
            "25",
            "-sp",
            sdk,
            app,
        ]);
        assert.deepEqual(requests, [
            "/health",
            "/f/lg/webos/?config[provider]=m3u",
        ]);
        fs.unlinkSync(capture);
        healthStatus = 503;
        await rejects(args, /companion is unavailable/);
        await rejects(
            ["--url", origin, "--sdk", missingSdk],
            /companion is unavailable/
        );
        assert(
            !fs.existsSync(bootstrapCapture),
            "Unavailable server must not trigger downloads"
        );
        await new Promise((resolve) => server.close(resolve));
        await rejects(args, /companion is unavailable/);

        // Exercise the real installer's no-op and rejection paths, without
        // downloading vendor software or executing a vendor installer.
        const realSetup = path.join(root, "scripts/setup-webos-simulator.sh");
        const setupEnv = {
            ...env,
            WEBOS_SDK_PATH: managedSdk,
            WEBOS_VERSION: "26",
        };
        const existingSetup = await exec("bash", [realSetup], {
            env: setupEnv,
        });
        assert.match(existingSetup.stdout, /already installed/);
        const registeredSetup = await exec("bash", [realSetup], {
            env: { ...setupEnv, WEBOS_SDK_PATH: "" },
        });
        assert(
            registeredSetup.stdout.includes(alternateSdk),
            "Standalone setup must reuse the registered SDK"
        );
        const olderRelease = path.join(fixture, "older working release");
        createSimulator(olderRelease, "26", "1.4.9");
        const reusedRelease = await exec(
            "bash",
            [realSetup, "--destination", olderRelease],
            { env: setupEnv }
        );
        assert.match(reusedRelease.stdout, /already installed/);
        const reusedVersion = await exec(
            "bash",
            [realSetup, "--version", "25", "--destination", sdk],
            { env: setupEnv }
        );
        assert.match(reusedVersion.stdout, /already installed/);
        const absent = path.join(fixture, "never installed");
        await exec("bash", [realSetup, "--destination", absent, "--dry-run"], {
            env: setupEnv,
        });
        assert(
            !fs.existsSync(absent),
            "Setup dry run must not create SDK files"
        );
        await assert.rejects(
            exec("bash", [realSetup, "--version", "25"], { env: setupEnv }),
            (error) => /supports webOS 26/.test(error.stderr)
        );
        const incomplete = path.join(fixture, "incomplete SDK");
        fs.mkdirSync(incomplete);
        await assert.rejects(
            exec("bash", [realSetup, "--destination", incomplete], {
                env: setupEnv,
            }),
            (error) => /refusing to overwrite/.test(error.stderr)
        );
        const binaries = path.join(fixture, "bin");
        fs.mkdirSync(binaries);
        fs.writeFileSync(
            path.join(binaries, "uname"),
            '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo arm64; fi\n',
            { mode: 0o755 }
        );
        fs.writeFileSync(
            path.join(binaries, "ditto"),
            '#!/bin/sh\necho "Unexpected extraction" >&2\nexit 91\n',
            { mode: 0o755 }
        );
        const badArchive = path.join(fixture, "bad.zip");
        fs.writeFileSync(badArchive, "not the official archive");
        await assert.rejects(
            exec(
                "bash",
                [realSetup, "--destination", absent, "--archive", badArchive],
                {
                    env: {
                        ...setupEnv,
                        PATH: binaries + path.delimiter + setupEnv.PATH,
                    },
                }
            ),
            (error) => /Archive size differs/.test(error.stderr)
        );
        assert(
            !fs.existsSync(absent),
            "Invalid archive must not create the SDK"
        );
        fs.truncateSync(badArchive, 111268559);
        await assert.rejects(
            exec(
                "bash",
                [realSetup, "--destination", absent, "--archive", badArchive],
                {
                    env: {
                        ...setupEnv,
                        PATH: binaries + path.delimiter + setupEnv.PATH,
                    },
                }
            ),
            (error) => /Archive checksum differs/.test(error.stderr)
        );
        assert(
            !fs.existsSync(absent),
            "Invalid checksum must not create the SDK"
        );
        assert(
            !fs
                .readdirSync(fixture)
                .some((name) => name.startsWith(".webos-simulator-install.")),
            "Failed setup must remove its temporary downloads"
        );
        const cliHome = path.join(fixture, "CLI-only home");
        const noCli = await exec("bash", [realSetup, "--cli-only"], {
            env: { ...setupEnv, HOME: cliHome, WEBOS_CLI: "" },
        });
        assert.match(noCli.stdout, /No CLI installation is needed/);
        assert(
            !fs.existsSync(cliHome),
            "Compatibility option must not install npm packages"
        );

        // Real native launcher: exact argv, numerical release ordering and no shell.
        const nativeSdk = path.join(
            fixture,
            "native SDK 'quotes' $(touch NEVER_CREATED)"
        );
        const nativeApp = path.join(
            fixture,
            'native app "quotes"; touch NEVER_CREATED'
        );
        fs.mkdirSync(nativeSdk);
        fs.mkdirSync(nativeApp);
        fs.writeFileSync(path.join(nativeApp, "appinfo.json"), "{}");
        createSimulator(nativeSdk, "26", "1.9.0");
        createSimulator(nativeSdk, "26", "1.10.0");
        createSimulator(nativeSdk, "25", "99.99.99");
        const nativeOptions = { app: nativeApp, sdk: nativeSdk, version: "26" };
        const macCommand = nativeLauncher.launchCommand(
            nativeOptions,
            "darwin"
        );
        assert.equal(macCommand.file, "/usr/bin/open");
        assert.deepEqual(macCommand.args, [
            path.join(nativeSdk, "webOS_TV_26_Simulator_1.10.0.app"),
            "--args",
            nativeApp,
            "{}",
        ]);
        assert.throws(
            () =>
                nativeLauncher.launchCommand(
                    { ...nativeOptions, version: "24" },
                    "darwin"
                ),
            /No executable/
        );
        assert.throws(
            () =>
                nativeLauncher.launchCommand(
                    { ...nativeOptions, version: "26;echo injected" },
                    "darwin"
                ),
            /positive integer/
        );
        assert.throws(
            () =>
                nativeLauncher.launchCommand(
                    { ...nativeOptions, sdk: path.join(fixture, "absent") },
                    "darwin"
                ),
            /ENOENT/
        );
        const linuxPath = path.join(
            nativeSdk,
            "webOS_TV_26_Simulator_1.10.0.AppImage"
        );
        const nativeCapture = path.join(fixture, "native argv.json");
        fs.writeFileSync(
            linuxPath,
            "#!" +
                process.execPath +
                '\nrequire("node:fs").writeFileSync(' +
                JSON.stringify(nativeCapture) +
                ", JSON.stringify(process.argv.slice(2)));\n",
            { mode: 0o755 }
        );
        assert.equal(nativeLauncher.launch(nativeOptions, "linux"), 0);
        assert.deepEqual(JSON.parse(fs.readFileSync(nativeCapture, "utf8")), [
            nativeApp,
            "{}",
        ]);
        assert(!fs.existsSync(path.join(process.cwd(), "NEVER_CREATED")));
        fs.writeFileSync(
            linuxPath,
            "#!" + process.execPath + "\nprocess.exit(17);\n"
        );
        assert.equal(nativeLauncher.launch(nativeOptions, "linux"), 17);
        const windowsPath = path.join(
            nativeSdk,
            "webOS_TV_26_Simulator_1.10.0.exe"
        );
        fs.writeFileSync(windowsPath, "fixture", { mode: 0o755 });
        assert.deepEqual(nativeLauncher.launchCommand(nativeOptions, "win32"), {
            args: [nativeApp, "{}"],
            file: windowsPath,
        });
        fs.unlinkSync(path.join(nativeApp, "appinfo.json"));
        assert.throws(
            () => nativeLauncher.launchCommand(nativeOptions, "linux"),
            /ENOENT/
        );
        console.log(
            "PASS webOS shell launcher: missing-tool bootstrap, reuse, stale registration, setup failure, dry run, archive rejection, native argv without CLI dependencies, exact explicit CLI arguments and preflight"
        );
    } finally {
        server.close();
        fs.rmSync(fixture, { force: true, recursive: true });
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
