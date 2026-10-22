#!/usr/bin/env node
// Official SDK bootstrap only: no server, firmware mirror or license acceptance.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

// Published checksums: https://developer.android.com/studio#command-tools
const commandLineTools = {
    "darwin-arm64": [
        "mac_arm64",
        "835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e",
    ],
    "darwin-x64": [
        "mac_x86_64",
        "c5a6378ab5cf7e0d5701921405115befff13e9ff7417fb588389338f8bd050f3",
    ],
    "linux-x64": [
        "linux",
        "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583",
    ],
};
const commandLineToolsVersion = "15859902";

function fail(message) {
    throw new Error(message);
}
function quote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}
function print(command, args) {
    console.log([command, ...args].map(quote).join(" "));
}
function invoke(command, args, options = {}) {
    const { includeStderr = false, ...spawnOptions } = options;
    const result = spawnSync(command, args, {
        encoding: "utf8",
        timeout: 15000,
        ...spawnOptions,
    });
    if (result.error || result.status !== 0) {
        fail(
            result.error?.message ||
                `${path.basename(command)} failed: ${(result.stderr || result.stdout || "").trim()}`
        );
    }
    return (
        (result.stdout || "") + (includeStderr ? result.stderr || "" : "")
    ).trim();
}
function executable(file) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
    } catch (_) {
        return false;
    }
}
function sdkTool(sdk, name) {
    const root = path.join(sdk, "cmdline-tools");
    const versions = fs.existsSync(root)
        ? fs.readdirSync(root).sort().reverse()
        : [];
    return [
        path.join(root, "latest/bin", name),
        ...versions.map((version) => path.join(root, version, "bin", name)),
        ...(process.env.PATH || "")
            .split(path.delimiter)
            .map((dir) => path.join(dir, name)),
    ].find(executable);
}
async function bootstrapCommandLineTools(sdk, dry) {
    const release = commandLineTools[`${process.platform}-${process.arch}`];
    if (!release)
        fail(
            "Automatic Android SDK setup supports macOS ARM64/Intel and Linux x86_64; install command-line tools manually on this host"
        );
    const [platform, sha256] = release;
    const url = `https://dl.google.com/android/repository/commandlinetools-${platform}-${commandLineToolsVersion}_latest.zip`;
    const target = path.join(
        sdk,
        "cmdline-tools",
        `ottplay-${commandLineToolsVersion}`
    );
    if (fs.existsSync(target))
        fail(
            `Incomplete command-line tools at ${target}; repair that installation before retrying`
        );
    if (dry) {
        print("curl", [
            "--fail",
            "--location",
            "--output",
            "<temporary SDK archive>",
            url,
        ]);
        console.log(
            `Verify SHA-256 ${sha256}, extract command-line tools to ${target}, remove temporary archive`
        );
        return target;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const work = fs.mkdtempSync(
        path.join(path.dirname(target), ".ottplay-tools-")
    );
    try {
        const archive = path.join(work, "tools.zip");
        invoke(
            "curl",
            [
                "--fail",
                "--location",
                "--show-error",
                "--retry",
                "2",
                "--output",
                archive,
                url,
            ],
            { stdio: "inherit", timeout: 0 }
        );
        const hash = createHash("sha256");
        for await (const chunk of fs.createReadStream(archive))
            hash.update(chunk);
        if (hash.digest("hex") !== sha256)
            fail(
                "Android command-line tools checksum mismatch; archive was not extracted"
            );
        invoke("unzip", ["-q", archive, "-d", work], { timeout: 120000 });
        const extracted = path.join(work, "cmdline-tools");
        for (const name of ["sdkmanager", "avdmanager"])
            if (!executable(path.join(extracted, "bin", name)))
                fail(`Downloaded command-line tools are missing ${name}`);
        fs.renameSync(extracted, target);
        return target;
    } finally {
        fs.rmSync(work, { force: true, recursive: true });
    }
}
function readIni(file) {
    return Object.fromEntries(
        fs
            .readFileSync(file, "utf8")
            .split(/\r?\n/)
            .filter((line) => line.includes("="))
            .map((line) => {
                const split = line.indexOf("=");
                return [
                    line.slice(0, split).trim(),
                    line.slice(split + 1).trim(),
                ];
            })
    );
}
function setIniValues(text, values) {
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    for (const [key, value] of Object.entries(values)) {
        const line = new RegExp(
            "^[ \\t]*" +
                key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
                "[ \\t]*=[^\\r\\n]*",
            "gm"
        );
        const setting = `${key}=${value}`;
        text = line.test(text)
            ? text.replace(line, setting)
            : text + (text.endsWith("\n") ? "" : newline) + setting + newline;
    }
    return text;
}
function processIsRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code !== "ESRCH";
    }
}
function inputEnabled(value) {
    return /^(yes|true|1)$/i.test(String(value || "").trim());
}
function help(mode) {
    console.log(`Usage: scripts/${mode === "setup" ? "setup" : "run"}-android-tv-emulator.sh [options]

  --sdk DIRECTORY   Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT)
  --google-tv       Use Google TV instead of Android TV
  --avd NAME        AVD name (OttplayAndroidTV or OttplayGoogleTV)
  --dry-run         Print commands; do not install, create, boot or connect
  --help            Show this help

Setup options:
  --image PACKAGE   Default: system-images;android-36;android-tv;arm64-v8a
                    (x86_64 on Intel; google-tv with --google-tv)
  --device ID       Default: tv_1080p
  --data-size MB    New AVD data partition (default: 2048; existing AVD unchanged)

Run options:
  --port NUMBER     Console port for a new instance (default: 5570)
  --timeout SECONDS Boot timeout (default: 180)
  --headless        Start without a window
  --url URL         Open the hosted player (default: http://127.0.0.1:8443/;
                    OTTP_PLAYER_URL)
  --home            Boot/connect without launching the player
  --apk FILE        Install an APK on this TV AVD; requires --component
  --component NAME  Launch an installed activity, e.g. package/.MainActivity
  --stop            Stop only this named TV AVD
  --no-install      Fail if the TV AVD or required SDK packages are missing

Setup and run install missing SDK tools, TV image and AVD automatically.
Command-line tools are downloaded from Google with a pinned SHA-256 on macOS
ARM64/Intel and Linux x86_64. Requires Java and curl/unzip for first setup.
SDK license prompts stay interactive; existing AVDs are never overwritten.
Run opens the hosted player in a locally built test WebView app by default.
This requires installed Android platform 36, build-tools 36 and Java 17+.
--home skips the app; --apk/--component select another app. These modes cannot
be combined with --url. It reverses ports
8443 (existing player/companion) and 8090 (playlist proxy) through ADB so guest
127.0.0.1 reaches the host stack. No browser or player app is assumed installed.
No server is started. --stop never installs anything.`);
}

async function main() {
    const [mode, ...argv] = process.argv.slice(2);
    if (!["setup", "run"].includes(mode)) fail("Expected setup or run");
    const options = {};
    const valueOptions = [
        "sdk",
        "avd",
        "image",
        "device",
        "data-size",
        "port",
        "timeout",
        "apk",
        "component",
        "url",
    ];
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].replace(/^--/, "");
        if (argv[i] === "--help" || argv[i] === "-h") {
            help(mode);
            return;
        }
        if (argv[i] === `--${key}` && valueOptions.includes(key)) {
            if (!argv[i + 1] || argv[i + 1].startsWith("--"))
                fail(`${argv[i]} requires a value`);
            options[key] = argv[++i];
        } else if (
            [
                "--dry-run",
                "--google-tv",
                "--headless",
                "--stop",
                "--home",
                "--no-install",
            ].includes(argv[i])
        )
            options[key] = true;
        else fail(`Unknown option: ${argv[i]}`);
    }
    for (const key of mode === "setup"
        ? [
              "port",
              "timeout",
              "apk",
              "component",
              "headless",
              "stop",
              "url",
              "home",
              "no-install",
          ]
        : ["image", "device", "data-size"]) {
        if (options[key] !== undefined)
            fail(`--${key} is not a ${mode} option`);
    }
    const tag = options["google-tv"] ? "google-tv" : "android-tv";
    const avd =
        options.avd ||
        (options["google-tv"] ? "OttplayGoogleTV" : "OttplayAndroidTV");
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(avd)) fail("Invalid AVD name");
    const defaultSdk =
        process.platform === "darwin"
            ? path.join(os.homedir(), "Library/Android/sdk")
            : path.join(os.homedir(), "Android/Sdk");
    const brewSdk = "/opt/homebrew/share/android-commandlinetools";
    const sdk = path.resolve(
        options.sdk ||
            process.env.ANDROID_HOME ||
            process.env.ANDROID_SDK_ROOT ||
            (fs.existsSync(defaultSdk)
                ? defaultSdk
                : fs.existsSync(brewSdk)
                  ? brewSdk
                  : defaultSdk)
    );
    const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
    const avdHome =
        process.env.ANDROID_AVD_HOME ||
        path.join(
            process.env.ANDROID_USER_HOME ||
                path.join(os.homedir(), ".android"),
            "avd"
        );
    const avdIni = path.join(avdHome, `${avd}.ini`);
    const emulator = path.join(sdk, "emulator/emulator");
    const adb = path.join(sdk, "platform-tools/adb");
    const dry = options["dry-run"];
    async function ensureSetup(forRun = false) {
        const dataSize = Number(options["data-size"] || 2048);
        if (!Number.isInteger(dataSize) || dataSize < 512 || dataSize > 65536)
            fail("--data-size must be an integer between 512 and 65536 MB");
        let image =
            options.image ||
            `system-images;android-36;${tag};${process.arch === "arm64" ? "arm64-v8a" : "x86_64"}`;
        const existingAvd = fs.existsSync(avdIni);
        let config;
        if (existingAvd) {
            config = readIni(
                path.join(
                    readIni(avdIni).path || path.join(avdHome, `${avd}.avd`),
                    "config.ini"
                )
            );
            if (!["android-tv", "google-tv"].includes(config["tag.id"]))
                fail(`AVD ${avd} is not an Android TV / Google TV profile`);
            // Launch preserves a previously selected API/image, including custom AVDs.
            if (forRun)
                image = path
                    .relative(
                        sdk,
                        path.resolve(sdk, config["image.sysdir.1"] || "")
                    )
                    .split(path.sep)
                    .join(";");
            image = image.replace(/;+$/, "");
        }
        if (
            !/^system-images;android-\d+;(android-tv|google-tv);(arm64-v8a|x86_64)$/.test(
                image
            )
        )
            fail("Expected an Android TV or Google TV system image package");
        if (
            process.platform === "darwin" &&
            process.arch === "arm64" &&
            !image.endsWith(";arm64-v8a")
        )
            fail(
                "The Android Emulator on Apple Silicon requires an ARM64 image; Rosetta does not provide x86 VM acceleration"
            );
        const imagePath = path.join(sdk, ...image.split(";"));
        if (existingAvd) {
            if (
                path.resolve(sdk, config["image.sysdir.1"] || "") !==
                path.resolve(imagePath)
            )
                fail(
                    `Existing ${avd} uses a different image; choose another --avd name`
                );
        }
        const installed = {
            [image]: () =>
                ["package.xml", "system.img"].every((file) =>
                    fs.existsSync(path.join(imagePath, file))
                ),
            emulator: () => executable(emulator),
            "platform-tools": () => executable(adb),
        };
        if (!forRun || (!options.home && !options.component)) {
            installed["platforms;android-36"] = () =>
                fs.existsSync(
                    path.join(sdk, "platforms/android-36/android.jar")
                );
            installed["build-tools;36.0.0"] = () =>
                ["aapt", "d8", "zipalign", "apksigner"].every((name) =>
                    executable(path.join(sdk, "build-tools/36.0.0", name))
                );
        }
        const missingPackages = () =>
            Object.keys(installed).filter((name) => !installed[name]());
        const packages = missingPackages();
        if (options["no-install"] && (packages.length || !existingAvd))
            fail(
                `AVD ${avd} or required SDK packages are not installed; remove --no-install or run setup-android-tv-emulator.sh`
            );
        let sdkmanager = sdkTool(sdk, "sdkmanager");
        let avdmanager = sdkTool(sdk, "avdmanager");
        if ((packages.length && !sdkmanager) || (!existingAvd && !avdmanager)) {
            const toolsDirectory = await bootstrapCommandLineTools(sdk, dry);
            sdkmanager = path.join(toolsDirectory, "bin/sdkmanager");
            avdmanager = path.join(toolsDirectory, "bin/avdmanager");
        }
        const installArgs = [`--sdk_root=${sdk}`, "--install", ...packages];
        const createArgs = [
            "create",
            "avd",
            "--name",
            avd,
            "--package",
            image,
            "--device",
            options.device || "tv_1080p",
        ];
        if (packages.length) print(sdkmanager, installArgs);
        if (!dry && packages.length) {
            invoke(sdkmanager, installArgs, {
                env,
                stdio: "inherit",
                timeout: 0,
            });
            const missing = missingPackages();
            if (missing.length)
                fail(
                    `Required SDK packages were not installed: ${missing.join(", ")}; review any SDK license prompt manually`
                );
        }
        if (existingAvd) {
            console.log(`Keeping existing AVD: ${avd}`);
            return;
        }
        print(avdmanager, createArgs);
        console.log(`New AVD data partition: ${dataSize} MB`);
        if (!dry) {
            // 'no' answers the custom hardware-profile question, not a license.
            invoke(avdmanager, createArgs, {
                env,
                input: "no\n",
                timeout: 60000,
            });
            if (!fs.existsSync(avdIni))
                fail("AVD creation did not produce its configuration");
            const configFile = path.join(
                readIni(avdIni).path || path.join(avdHome, `${avd}.avd`),
                "config.ini"
            );
            fs.writeFileSync(
                configFile,
                setIniValues(fs.readFileSync(configFile, "utf8"), {
                    "disk.dataPartition.size": `${dataSize}M`,
                    "hw.dPad": "yes",
                    "hw.keyboard": "yes",
                })
            );
            console.log(
                `Ready: ${avd}. Run ./scripts/run-android-tv-emulator.sh --avd ${avd}`
            );
        }
        return;
    }
    if (mode === "setup") {
        await ensureSetup();
        return;
    }
    const port = Number(options.port || 5570);
    const timeout = Number(options.timeout || 180);
    if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2)
        fail("--port must be an even number from 5554 to 5682");
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 1800)
        fail("--timeout must be between 1 and 1800 seconds");
    if (options.apk && !options.component)
        fail("--apk requires --component (the activity to launch)");
    if (
        options.component &&
        !/^[A-Za-z][\w.]*\/[A-Za-z.][\w.$]*$/.test(options.component)
    )
        fail("Invalid Android activity component");
    if (
        options.stop &&
        (options.apk || options.component || options.url || options.home)
    )
        fail(
            "--stop cannot be combined with --url, --home, --apk or --component"
        );
    if (options.home && (options.url || options.apk || options.component))
        fail("--home cannot be combined with --url, --apk or --component");
    if (options.url && (options.apk || options.component))
        fail("--url cannot be combined with --apk or --component");
    if (
        options.apk &&
        (!/\.apk$/i.test(options.apk) ||
            !fs.existsSync(options.apk) ||
            !fs.statSync(options.apk).isFile())
    )
        fail(`Expected a local APK file: ${options.apk}`);
    const openPlayer = !options.stop && !options.home && !options.component;
    let playerUrl;
    if (openPlayer) {
        try {
            playerUrl = new URL(
                options.url ||
                    process.env.OTTP_PLAYER_URL ||
                    "http://127.0.0.1:8443/"
            );
            if (
                !["http:", "https:"].includes(playerUrl.protocol) ||
                playerUrl.username ||
                playerUrl.password
            )
                fail("Invalid player URL");
        } catch (_) {
            fail("Player URL must be an HTTP(S) URL without credentials");
        }
    }
    if (!options.stop) await ensureSetup(true);
    else if (!fs.existsSync(avdIni) || !executable(adb)) {
        console.log(`${avd} is not installed/running; nothing to stop`);
        return;
    }
    const reversePorts = new Set([8443, 8090]);
    if (
        playerUrl &&
        ["127.0.0.1", "localhost", "[::1]"].includes(playerUrl.hostname)
    )
        reversePorts.add(
            Number(
                playerUrl.port || (playerUrl.protocol === "https:" ? 443 : 80)
            )
        );
    let launchApk = options.apk ? path.resolve(options.apk) : undefined;
    let launchComponent = options.component;
    function preparePlayer() {
        console.log(
            "Preparing Android TV WebView test app with the installed SDK"
        );
        const prepared =
            require("./prepare-android-tv-player.cjs").prepareAndroidTvPlayer({
                dryRun: Boolean(dry),
                sdk,
            });
        launchApk = prepared.apk;
        launchComponent = prepared.component;
    }
    function activityArgs() {
        const args = [
            "-s",
            serial,
            "shell",
            "am",
            "start",
            "-W",
            "-n",
            quote(launchComponent),
        ];
        if (playerUrl) args.push("-d", quote(playerUrl.href));
        return args;
    }
    const bootArgs = [
        "-avd",
        avd,
        "-port",
        String(port),
        "-no-boot-anim",
        "-no-snapshot-save",
        "-gpu",
        "auto",
    ];
    if (options.headless) bootArgs.push("-no-window");
    let serial = `emulator-${port}`;
    if (dry) {
        if (options.stop) print(adb, ["-s", serial, "emu", "kill"]);
        else {
            if (openPlayer) preparePlayer();
            print(emulator, bootArgs);
            for (const reverse of reversePorts)
                print(adb, [
                    "-s",
                    serial,
                    "reverse",
                    `tcp:${reverse}`,
                    `tcp:${reverse}`,
                ]);
            if (launchApk)
                print(adb, ["-s", serial, "install", "-r", launchApk]);
            if (launchComponent) print(adb, activityArgs());
        }
        return;
    }
    if (!fs.existsSync(avdIni))
        fail(
            `AVD ${avd} is not installed; run setup-android-tv-emulator.sh first`
        );
    const avdDirectory =
        readIni(avdIni).path || path.join(avdHome, `${avd}.avd`);
    const avdConfigFile = path.join(avdDirectory, "config.ini");
    const avdConfig = readIni(avdConfigFile);
    if (!["android-tv", "google-tv"].includes(avdConfig["tag.id"]))
        fail(`AVD ${avd} is not an Android TV / Google TV profile`);
    if (openPlayer) {
        for (const url of [playerUrl.origin + "/health", playerUrl.href]) {
            try {
                invoke("curl", [
                    "--globoff",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--connect-timeout",
                    "3",
                    "--max-time",
                    "10",
                    url,
                ]);
            } catch (_) {
                fail(
                    `Player companion/page is unavailable at ${url}. Start the existing local stack first; 8090 is the playlist proxy, not the player.`
                );
            }
        }
        preparePlayer();
    }
    const devices = invoke(adb, ["devices"], { env })
        .split(/\r?\n/)
        .map((line) => line.split(/\s+/))
        .filter((fields) => /^emulator-\d+$/.test(fields[0]));
    const matching = devices.filter(
        ([id, state]) =>
            state === "device" &&
            invoke(adb, ["-s", id, "emu", "avd", "name"], { env }).split(
                /\r?\n/
            )[0] === avd
    );
    if (matching.length > 1)
        fail(
            `Multiple running instances of ${avd}; close the extra instance first`
        );
    if (matching.length) serial = matching[0][0];
    if (options.stop) {
        if (matching.length) {
            invoke(adb, ["-s", serial, "emu", "kill"], { env });
            console.log(`Stopped ${avd} (${serial})`);
        } else console.log(`${avd} is not running`);
        return;
    }
    let needsBoot = !matching.length;
    if (matching.length) await waitForBoot();
    else {
        if (devices.some(([id]) => id === serial))
            fail(`${serial} is occupied by another AVD; select another --port`);
        invoke(emulator, ["-accel-check"], { env });
    }
    const inputSettings = { "hw.dPad": "yes", "hw.keyboard": "yes" };
    const configuredInput = readIni(avdConfigFile);
    const needsInputRepair = Object.keys(inputSettings).some(
        (key) => !inputEnabled(configuredInput[key])
    );
    const hardwareFile = path.join(avdDirectory, "hardware-qemu.ini");
    const hardware = fs.existsSync(hardwareFile) ? readIni(hardwareFile) : {};
    const staleHardware = Object.keys(inputSettings).some(
        (key) => hardware[key] !== undefined && !inputEnabled(hardware[key])
    );
    if (needsInputRepair || staleHardware) {
        if (matching.length) {
            // Check that a replacement can boot before stopping the current TV.
            invoke(emulator, ["-accel-check"], { env });
            const identity = invoke(adb, ["-s", serial, "emu", "avd", "name"], {
                env,
            });
            if (identity.split(/\r?\n/)[0] !== avd)
                fail("Emulator identity changed before keyboard repair");
            let oldPid;
            try {
                // The SDK stores an ASCII PID with an optional trailing NUL.
                const lock = fs.readFileSync(
                    path.join(avdDirectory, "hardware-qemu.ini.lock"),
                    "utf8"
                );
                if (/^[0-9]+\0?$/.test(lock)) {
                    const parsed = Number.parseInt(lock, 10);
                    if (Number.isSafeInteger(parsed) && parsed > 1)
                        oldPid = parsed;
                }
            } catch (_) {
                // ADB disappearance remains the fallback when no PID is recorded.
            }
            console.log(
                `Restarting ${avd} (${serial}) to enable keyboard and D-pad`
            );
            invoke(adb, ["-s", serial, "emu", "kill"], { env });
            const stopDeadline = Date.now() + timeout * 1000;
            let stopped = false;
            while (Date.now() < stopDeadline) {
                const attached = invoke(adb, ["devices"], { env })
                    .split(/\r?\n/)
                    .some((line) => line.split(/\s+/)[0] === serial);
                if (!attached && (!oldPid || !processIsRunning(oldPid))) {
                    stopped = true;
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            if (!stopped)
                fail(
                    `Stop timed out for ${serial}; no replacement was started`
                );
            // Reuse this TV's console port, not a possibly occupied default port.
            bootArgs[bootArgs.indexOf("-port") + 1] = serial.slice(
                "emulator-".length
            );
            needsBoot = true;
        }
        // Re-read after shutdown so any unrelated last-minute AVD settings survive.
        const latestInput = readIni(avdConfigFile);
        if (
            Object.keys(inputSettings).some(
                (key) => !inputEnabled(latestInput[key])
            )
        ) {
            fs.writeFileSync(
                avdConfigFile,
                setIniValues(
                    fs.readFileSync(avdConfigFile, "utf8"),
                    inputSettings
                )
            );
        }
        bootArgs.push("-no-snapshot-load");
    }
    if (needsBoot) {
        const logDir = path.resolve(__dirname, "../build/emulator-logs");
        fs.mkdirSync(logDir, { recursive: true });
        const logFile = path.join(logDir, `${avd}.log`);
        const fd = fs.openSync(logFile, "a");
        const child = spawn(emulator, bootArgs, {
            detached: true,
            env,
            stdio: ["ignore", fd, fd],
        });
        fs.closeSync(fd);
        child.on("error", (error) => {
            console.error(error.message);
        });
        child.unref();
        console.log(`Starting ${avd} (${serial}); log: ${logFile}`);
        await waitForBoot(child);
    } else console.log(`Reusing ${avd} (${serial})`);
    async function waitForBoot(child) {
        const deadline = Date.now() + timeout * 1000;
        let booted = false;
        while (Date.now() < deadline) {
            const result = spawnSync(
                adb,
                ["-s", serial, "shell", "getprop", "sys.boot_completed"],
                { encoding: "utf8", env, timeout: 5000 }
            );
            if (result.status === 0 && result.stdout.trim() === "1") {
                // ADB may reconnect after Android reports boot completion. Require
                // the expected identity in this poll before touching ports or apps.
                const identity = spawnSync(
                    adb,
                    ["-s", serial, "emu", "avd", "name"],
                    { encoding: "utf8", env, timeout: 5000 }
                );
                if (identity.status === 0) {
                    if (identity.stdout.trim().split(/\r?\n/)[0] !== avd)
                        fail("Emulator identity changed during boot");
                    booted = true;
                    break;
                }
                const transportError = (
                    identity.stderr ||
                    identity.stdout ||
                    ""
                ).trim();
                if (
                    identity.error?.code !== "ETIMEDOUT" &&
                    !/device.*not found|device offline|no devices\/emulators found|transport.*(?:not found|closed)/i.test(
                        transportError
                    )
                )
                    fail(
                        identity.error?.message ||
                            `ADB identity query failed: ${transportError}`
                    );
            }
            if (child && (child.exitCode !== null || child.signalCode !== null))
                fail("Emulator exited during boot; inspect its log");
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        if (!booted)
            fail(
                `Boot timed out for ${serial}; inspect build/emulator-logs before retrying. No other emulator was stopped`
            );
    }
    for (const reverse of reversePorts)
        invoke(
            adb,
            ["-s", serial, "reverse", `tcp:${reverse}`, `tcp:${reverse}`],
            { env }
        );
    if (launchApk)
        console.log(
            invoke(adb, ["-s", serial, "install", "-r", launchApk], {
                env,
                timeout: 120000,
            })
        );
    if (launchComponent) {
        const output = invoke(adb, activityArgs(), {
            env,
            includeStderr: true,
            timeout: 60000,
        });
        if (/Error:|Exception|Status:\s*(?!ok\b)\w+/i.test(output))
            fail(output);
        console.log(output);
    }
    console.log(
        `Ready: ${avd} (${serial}). Host player: ${playerUrl ? playerUrl.href : "http://127.0.0.1:8443/"}; playlist proxy: http://127.0.0.1:8090/`
    );
}
main().catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
});
