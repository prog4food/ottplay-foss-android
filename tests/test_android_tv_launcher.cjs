const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ottplay TV launch "))
);
const root = path.join(tmp, "project with spaces");
const sdk = path.join(tmp, "SDK with spaces");
const bin = path.join(tmp, "fake commands");
const avdHome = path.join(tmp, "AVD with spaces");
const log = path.join(tmp, "calls.jsonl");
const state = path.join(tmp, "devices.json");
const bootState = path.join(tmp, "boot-state.json");
const image = `system-images;android-36;android-tv;${process.arch === "arm64" ? "arm64-v8a" : "x86_64"}`;
const imagePath = path.join(sdk, ...image.split(";"));
const generatedApk = path.join(root, "build/android-tv-player/player.apk");
const hostedComponent = "play.ott.simulator.web/.MainActivity";
fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
fs.mkdirSync(bin, { recursive: true });
fs.mkdirSync(avdHome, { recursive: true });
for (const name of [
    "android-tv-emulator.cjs",
    "setup-android-tv-emulator.sh",
    "run-android-tv-emulator.sh",
]) {
    let source = fs.readFileSync(
        path.join(__dirname, "../scripts", name),
        "utf8"
    );
    // Use a tiny local fixture in place of Google's large download; checksum
    // verification and the full bootstrap control flow still execute normally.
    if (name === "android-tv-emulator.cjs")
        source = source.replace(
            /"[0-9a-f]{64}"/g,
            JSON.stringify(
                createHash("sha256").update("fixture SDK archive").digest("hex")
            )
        );
    fs.writeFileSync(path.join(root, "scripts", name), source);
}
fs.writeFileSync(
    path.join(root, "scripts/prepare-android-tv-player.cjs"),
    `const fs = require('node:fs');
const path = require('node:path');
const component = 'play.ott.simulator.web/.MainActivity';
exports.component = component;
exports.prepareAndroidTvPlayer = ({sdk, dryRun}) => {
  const apk = path.join(__dirname, '../build/android-tv-player/player.apk');
  if (!dryRun) {
    fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({name:'prepare-player', args:[sdk]})+'\\n');
    if (process.env.FAIL_PREPARE) throw new Error('Player preparation failed');
    fs.mkdirSync(path.dirname(apk), {recursive:true});
    fs.writeFileSync(apk, 'fake built APK');
  }
  return {apk, component};
};
`
);
const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const name = path.basename(process.argv[1]);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({name, args})+'\\n');
let devices = JSON.parse(fs.readFileSync(process.env.STATE_FILE));
if (name === 'curl') {
  const url = args.find(arg => /^https?:/.test(arg));
  if (process.env.FAIL_CURL || (process.env.FAIL_PLAYER_PREFLIGHT && !url.endsWith('/health'))) {
    console.error('curl: server unavailable'); process.exit(22);
  }
  if (args.includes('--output')) {
    if (process.env.FAIL_DOWNLOAD) process.exit(22);
    fs.writeFileSync(args[args.indexOf('--output')+1], process.env.BAD_CHECKSUM ? 'wrong archive' : 'fixture SDK archive');
  }
  console.log('ok');
} else if (name === 'unzip') {
  const dir = path.join(args[args.indexOf('-d')+1], 'cmdline-tools/bin');
  fs.mkdirSync(dir, {recursive:true});
  for (const command of ['sdkmanager', 'avdmanager']) {
    fs.writeFileSync(path.join(dir, command), fs.readFileSync(process.argv[1]), {mode:0o755});
  }
} else if (name === 'sdkmanager') {
  if (process.env.FAIL_INSTALL) process.exit(1);
  for (const name of args.filter(arg => /^(system-images|platforms|build-tools);/.test(arg) || ['emulator','platform-tools'].includes(arg))) {
    if (process.env.SKIP_BUILD_PACKAGES && /^(platforms|build-tools);/.test(name)) continue;
    const dir = path.join(process.env.ANDROID_HOME, ...name.split(';'));
    const markers = name.startsWith('platforms;') ? ['android.jar'] : name.startsWith('build-tools;') ? ['aapt','d8','zipalign','apksigner'] : name === 'emulator' ? ['emulator'] : name === 'platform-tools' ? ['adb'] : ['package.xml','system.img'];
    fs.mkdirSync(dir, {recursive:true});
    for (const marker of markers) fs.writeFileSync(path.join(dir,marker), ['emulator','adb'].includes(marker) ? fs.readFileSync(process.argv[1]) : 'fake SDK component', {mode:0o755});
  }
} else if (name === 'avdmanager') {
  if (fs.readFileSync(0,'utf8') !== 'no\\n') throw new Error('Wrong custom-hardware answer');
  const avd = args[args.indexOf('--name')+1];
  const image = args[args.indexOf('--package')+1];
  const dir = path.join(process.env.ANDROID_AVD_HOME, avd+'.avd');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(process.env.ANDROID_AVD_HOME,avd+'.ini'),'path='+dir+'\\n');
  fs.writeFileSync(path.join(dir,'config.ini'),'image.sysdir.1='+image.replaceAll(';','/')+'\\ntag.id='+image.split(';')[2]+'\\ndisk.dataPartition.size=6G\\nhw.keyboard=no\\nhw.dPad=no\\n');
} else if (name === 'emulator') {
  if (args[0] === '-accel-check' && process.env.FAIL_ACCEL) process.exit(1);
  if (args[0] !== '-accel-check') {
    const serial = 'emulator-'+args[args.indexOf('-port')+1];
    const avd = args[args.indexOf('-avd')+1];
    devices[serial] = avd;
    fs.writeFileSync(process.env.STATE_FILE,JSON.stringify(devices));
    const dir = path.join(process.env.ANDROID_AVD_HOME,avd+'.avd');
    fs.copyFileSync(path.join(dir,'config.ini'),path.join(dir,'hardware-qemu.ini'));
  }
} else if (name === 'adb') {
  // A newly spawned emulator may not have registered its serial yet.
  if (args[0] === '-s' && !Object.prototype.hasOwnProperty.call(devices, args[1])) {
    console.error("error: device '"+args[1]+"' not found"); process.exit(1);
  }
  if (args[0] === 'devices') {
    const boot = JSON.parse(fs.readFileSync(process.env.BOOT_STATE));
    if (boot.stopping && !process.env.STOP_STUCK) {
      boot.stopPolls = (boot.stopPolls || 0) + 1;
      if (boot.stopPolls > Number(process.env.STOP_DELAY_POLLS || 0)) {
        delete devices[boot.stopping]; delete boot.stopping;
        fs.writeFileSync(process.env.STATE_FILE,JSON.stringify(devices));
      }
      fs.writeFileSync(process.env.BOOT_STATE,JSON.stringify(boot));
    }
    console.log('List of devices attached\\n'+Object.keys(devices).map(id=>id+'\\tdevice').join('\\n'));
  }
  else if(args[2] === 'emu' && args[3] === 'avd') {
    const boot = JSON.parse(fs.readFileSync(process.env.BOOT_STATE));
    if (boot.queried && process.env.IDENTITY_TRANSIENT && !boot.failedIdentity) {
      fs.writeFileSync(process.env.BOOT_STATE, JSON.stringify({...boot, failedIdentity:true}));
      console.error("error: device '"+args[1]+"' not found"); process.exit(1);
    }
    console.log((boot.queried && process.env.IDENTITY_MISMATCH ? 'OtherTV' : devices[args[1]])+'\\nOK');
  }
  else if(args[2] === 'shell' && args[3] === 'getprop') {
    const boot = JSON.parse(fs.readFileSync(process.env.BOOT_STATE));
    fs.writeFileSync(process.env.BOOT_STATE, JSON.stringify({...boot, queried:true}));
    console.log(process.env.NOT_BOOTED ? '0' : '1');
  }
  else if(args[2] === 'emu' && args[3] === 'kill') {
    const boot = JSON.parse(fs.readFileSync(process.env.BOOT_STATE));
    fs.writeFileSync(process.env.BOOT_STATE,JSON.stringify({...boot,stopping:args[1],stopPolls:0}));
    console.log('OK: killing emulator, bye bye');
  }
  else if(args[2] === 'shell' && args[3] === 'am') {
    if (process.env.BAD_ACTIVITY_STDERR) console.error('Error: Activity class does not exist.');
    else console.log(process.env.BAD_ACTIVITY ? 'Error: Activity class does not exist.' : 'Status: ok');
  }
  else console.log('Success');
}
`;
for (const relative of [
    "cmdline-tools/latest/bin/sdkmanager",
    "cmdline-tools/latest/bin/avdmanager",
    "platform-tools/adb",
    "emulator/emulator",
]) {
    const file = path.join(sdk, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fake, { mode: 0o755 });
}
fs.writeFileSync(path.join(bin, "curl"), fake, { mode: 0o755 });
fs.writeFileSync(path.join(bin, "unzip"), fake, { mode: 0o755 });
fs.symlinkSync(process.execPath, path.join(bin, "node"));
function devices(value) {
    fs.writeFileSync(state, JSON.stringify(value));
}
function calls() {
    return fs.existsSync(log)
        ? fs
              .readFileSync(log, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map(JSON.parse)
        : [];
}
function run(mode, args = [], extraEnv = {}, success = true) {
    fs.writeFileSync(log, "");
    fs.writeFileSync(bootState, "{}");
    const result = spawnSync(
        "bash",
        [
            path.join(root, "scripts", `${mode}-android-tv-emulator.sh`),
            "--sdk",
            sdk,
            ...args,
        ],
        {
            cwd: tmp,
            encoding: "utf8",
            env: {
                ...process.env,
                ANDROID_AVD_HOME: avdHome,
                BAD_ACTIVITY: "",
                BAD_ACTIVITY_STDERR: "",
                BAD_CHECKSUM: "",
                BOOT_STATE: bootState,
                CALL_LOG: log,
                FAIL_ACCEL: "",
                FAIL_CURL: "",
                FAIL_DOWNLOAD: "",
                FAIL_INSTALL: "",
                FAIL_PLAYER_PREFLIGHT: "",
                FAIL_PREPARE: "",
                IDENTITY_MISMATCH: "",
                IDENTITY_TRANSIENT: "",
                NOT_BOOTED: "",
                OTTP_PLAYER_URL: "",
                PATH: bin + path.delimiter + process.env.PATH,
                SKIP_BUILD_PACKAGES: "",
                STATE_FILE: state,
                STOP_DELAY_POLLS: "",
                STOP_STUCK: "",
                ...extraEnv,
            },
            timeout: 20000,
        }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, success ? 0 : 1, result.stdout + result.stderr);
    return result.stdout + result.stderr;
}
try {
    devices({});
    assert.match(run("setup", ["--dry-run"]), /tv_1080p/);
    assert.equal(calls().length, 0, "dry run must not invoke SDK");
    assert.equal(
        fs.existsSync(path.join(avdHome, "OttplayAndroidTV.ini")),
        false
    );
    assert.match(run("setup", ["--google-tv", "--dry-run"]), /OttplayGoogleTV/);
    assert.match(run("setup", ["--avd", ".."], {}, false), /Invalid AVD/);
    assert.match(run("setup", ["--sdk"], {}, false), /requires a value/);
    assert.match(run("setup", ["--headless"], {}, false), /not a setup option/);
    assert.match(run("setup", ["--home"], {}, false), /not a setup option/);
    assert.match(
        run("setup", ["--url", "http://localhost:8095/"], {}, false),
        /not a setup option/
    );
    assert.match(run("setup", ["--data-size", "0"], {}, false), /--data-size/);
    assert.equal(
        calls().length,
        0,
        "invalid data size must not invoke the SDK"
    );
    assert.match(run("setup", [], { FAIL_INSTALL: "1" }, false), /failed/);
    assert.equal(
        calls().some((call) => call.name === "avdmanager"),
        false,
        "failed download must not create an AVD"
    );
    assert.match(
        run("setup", [], { SKIP_BUILD_PACKAGES: "1" }, false),
        /Required SDK packages were not installed: platforms;android-36, build-tools;36.0.0/
    );
    assert.equal(
        calls().some((call) => call.name === "avdmanager"),
        false,
        "sdkmanager exit zero with missing packages must not create an AVD"
    );
    assert.match(run("setup"), /Ready: OttplayAndroidTV/);
    assert.ok(fs.existsSync(path.join(imagePath, "package.xml")));
    const installedPackages = calls().find(
        (call) => call.name === "sdkmanager"
    ).args;
    assert.ok(installedPackages.includes("platforms;android-36"));
    assert.ok(installedPackages.includes("build-tools;36.0.0"));
    assert.ok(
        fs.existsSync(path.join(sdk, "platforms/android-36/android.jar"))
    );
    assert.ok(fs.existsSync(path.join(sdk, "build-tools/36.0.0/apksigner")));
    const configFile = path.join(avdHome, "OttplayAndroidTV.avd/config.ini");
    assert.match(
        fs.readFileSync(configFile, "utf8"),
        /^disk\.dataPartition\.size=2048M$/m
    );
    assert.match(fs.readFileSync(configFile, "utf8"), /^hw\.keyboard=yes$/m);
    assert.match(fs.readFileSync(configFile, "utf8"), /^hw\.dPad=yes$/m);
    assert.deepEqual(calls().find((call) => call.name === "avdmanager").args, [
        "create",
        "avd",
        "--name",
        "OttplayAndroidTV",
        "--package",
        image,
        "--device",
        "tv_1080p",
    ]);
    const originalConfig = fs.readFileSync(configFile, "utf8");
    assert.match(run("setup", ["--data-size", "4096"]), /Keeping existing AVD/);
    assert.equal(
        fs.readFileSync(configFile, "utf8"),
        originalConfig,
        "existing data partition must remain unchanged"
    );
    assert.equal(calls().length, 0, "existing AVD must remain unchanged");
    assert.match(
        run("setup", ["--avd", "CustomTV", "--data-size", "3072"]),
        /Ready: CustomTV/
    );
    assert.match(
        fs.readFileSync(path.join(avdHome, "CustomTV.avd/config.ini"), "utf8"),
        /^disk\.dataPartition\.size=3072M$/m
    );
    assert.match(
        run(
            "setup",
            ["--image", image.replace("android-36", "android-35")],
            {},
            false
        ),
        /different image/
    );
    assert.match(
        run("run", ["--home", "--dry-run", "--headless"]),
        /-no-window/
    );
    assert.equal(calls().length, 0);
    assert.match(run("run", ["--port", "5555"], {}, false), /even number/);
    assert.match(run("run", ["--timeout", "0"], {}, false), /--timeout/);
    assert.match(
        run("run", ["--data-size", "2048"], {}, false),
        /not a run option/
    );
    assert.match(
        run("run", ["--component", "bad;command"], {}, false),
        /Invalid Android activity/
    );
    assert.match(
        run("run", ["--home", "--avd", "Absent", "--no-install"], {}, false),
        /not installed/
    );
    assert.equal(
        calls().length,
        0,
        "--no-install must fail without SDK mutations"
    );
    assert.match(run("run", ["--stop", "--avd", "Absent"]), /nothing to stop/);
    assert.equal(
        calls().length,
        0,
        "stopping a removed TV must not reinstall it"
    );
    assert.match(run("run", ["--home", "--avd", "Absent"]), /Starting Absent/);
    assert.ok(calls().some((call) => call.name === "avdmanager"));
    assert.match(run("run", ["--home", "--avd", "Absent"]), /Reusing Absent/);
    assert.equal(
        calls().some((call) =>
            ["sdkmanager", "avdmanager"].includes(call.name)
        ),
        false
    );
    devices({});
    assert.match(
        run("run", ["--google-tv", "--home"]),
        /Starting OttplayGoogleTV/
    );
    assert.ok(
        calls()
            .find((call) => call.name === "sdkmanager")
            .args.includes(image.replace("android-tv", "google-tv"))
    );
    assert.match(
        fs.readFileSync(
            path.join(avdHome, "OttplayGoogleTV.avd/config.ini"),
            "utf8"
        ),
        /tag.id=google-tv/
    );
    devices({});
    fs.rmSync(path.join(imagePath, "system.img"));
    fs.rmSync(path.join(sdk, "emulator/emulator"));
    fs.rmSync(path.join(sdk, "platform-tools/adb"));
    assert.match(run("run", ["--home"]), /Starting OttplayAndroidTV/);
    assert.deepEqual(
        calls()
            .find((call) => call.name === "sdkmanager")
            .args.slice(2),
        [image, "emulator", "platform-tools"]
    );
    assert.equal(
        fs.readFileSync(configFile, "utf8"),
        originalConfig,
        "repair of removed packages preserves AVD config"
    );
    assert.equal(
        calls().some((call) => call.name === "avdmanager"),
        false
    );
    devices({ "emulator-5554": "ExistingPhone", "emulator-5570": "OtherTV" });
    assert.match(run("run", ["--home"], {}, false), /occupied/);
    assert.equal(
        calls().some(
            (call) =>
                call.args.includes("reverse") || call.args.includes("kill")
        ),
        false
    );
    const apk = path.join(tmp, "app with spaces.apk");
    fs.writeFileSync(apk, "fake");
    const apkDirectory = path.join(tmp, "directory.apk");
    fs.mkdirSync(apkDirectory);
    const nonApk = path.join(tmp, "page.html");
    fs.writeFileSync(nonApk, "<title>not an APK</title>");
    for (const invalidApk of [
        apkDirectory,
        nonApk,
        "http://127.0.0.1:8095/app.apk",
    ]) {
        assert.match(
            run(
                "run",
                ["--apk", invalidApk, "--component", "test.ott/.MainActivity"],
                {},
                false
            ),
            /Expected a local APK file/
        );
        assert.equal(
            calls().length,
            0,
            "bad APK input must fail before connecting or booting"
        );
    }
    devices({
        "emulator-5554": "ExistingPhone",
        "emulator-5572": "OttplayAndroidTV",
    });
    assert.match(
        run("run", ["--apk", apk, "--component", "test.ott/.MainActivity"]),
        /Reusing OttplayAndroidTV \(emulator-5572\)/
    );
    assert.equal(
        calls().some((call) => call.name === "emulator"),
        false
    );
    const changes = calls().filter(
        (call) =>
            call.args.includes("reverse") ||
            call.args.includes("install") ||
            call.args.includes("start")
    );
    assert.equal(changes.length, 4);
    assert.ok(changes.every((call) => call.args[1] === "emulator-5572"));
    assert.deepEqual(
        changes.find((call) => call.args.includes("install")).args,
        ["-s", "emulator-5572", "install", "-r", apk]
    );
    assert.match(
        run("run", ["--home"], { IDENTITY_TRANSIENT: "1" }),
        /Ready: OttplayAndroidTV/
    );
    const reconnectCalls = calls();
    const firstReverse = reconnectCalls.findIndex((call) =>
        call.args.includes("reverse")
    );
    assert.equal(
        reconnectCalls
            .slice(0, firstReverse)
            .filter((call) => call.args.includes("getprop")).length,
        2,
        "retry a missing ADB transport after boot completion before modifying ports"
    );
    assert.equal(
        reconnectCalls.some((call) => call.name === "emulator"),
        false,
        "ADB reconnect must not restart the emulator"
    );
    assert.match(
        run("run", ["--home"], { IDENTITY_MISMATCH: "1" }, false),
        /identity changed/
    );
    assert.equal(
        calls().some(
            (call) =>
                call.args.includes("reverse") ||
                call.args.includes("install") ||
                call.args.includes("kill")
        ),
        false,
        "a different AVD must never receive mutations"
    );
    assert.match(
        run(
            "run",
            ["--component", "test.ott/.Missing"],
            { BAD_ACTIVITY: "1" },
            false
        ),
        /Activity class does not exist/
    );
    assert.match(
        run(
            "run",
            ["--component", "test.ott/.Missing"],
            { BAD_ACTIVITY_STDERR: "1" },
            false
        ),
        /Activity class does not exist/
    );
    run("run", ["--component", "test.ott/.Main$Nested"]);
    assert.equal(
        calls()
            .find((call) => call.args.includes("start"))
            .args.at(-1),
        "'test.ott/.Main$Nested'",
        "protect component dollar signs from the Android shell"
    );
    assert.match(
        run("run", ["--home", "--timeout", "1"], { NOT_BOOTED: "1" }, false),
        /Boot timed out/
    );
    assert.match(run("run", ["--stop"]), /Stopped OttplayAndroidTV/);
    assert.deepEqual(calls().find((call) => call.args.includes("kill")).args, [
        "-s",
        "emulator-5572",
        "emu",
        "kill",
    ]);
    devices({ "emulator-5554": "ExistingPhone" });
    assert.match(run("run", ["--stop"]), /not running/);
    assert.equal(
        calls().some((call) => call.args.includes("kill")),
        false
    );
    assert.match(run("run", ["--home"]), /Starting OttplayAndroidTV/);
    assert.ok(
        calls().some(
            (call) =>
                call.name === "emulator" && call.args.includes("-accel-check")
        )
    );
    assert.deepEqual(
        calls()
            .filter((call) => call.args.includes("reverse"))
            .map((call) => call.args.at(-1)),
        ["tcp:8443", "tcp:8090"]
    );

    const defaultUrl = "http://127.0.0.1:8443/";
    const shellQuote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
    const hostedCalls = () =>
        calls().filter((call) =>
            ["curl", "prepare-player"].includes(call.name)
        );
    for (const args of [
        ["--home", "--url", defaultUrl],
        ["--home", "--component", hostedComponent],
        ["--home", "--apk", apk, "--component", hostedComponent],
        ["--url", defaultUrl, "--component", hostedComponent],
        ["--url", defaultUrl, "--apk", apk, "--component", hostedComponent],
        ["--stop", "--home"],
        ["--stop", "--url", defaultUrl],
        ["--stop", "--component", hostedComponent],
        ["--stop", "--apk", apk, "--component", hostedComponent],
    ]) {
        run("run", args, {}, false);
        assert.equal(
            calls().length,
            0,
            `conflicting options must fail before preflight or SDK: ${args.join(" ")}`
        );
    }
    for (const invalidUrl of [
        "not-a-url",
        "file:///tmp/player.html",
        "javascript:alert(1)",
        "http://user:password@localhost:8095/",
    ]) {
        run("run", ["--url", invalidUrl], {}, false);
        assert.equal(calls().length, 0, "invalid URL must not invoke commands");
        run("run", [], { OTTP_PLAYER_URL: invalidUrl }, false);
        assert.equal(
            calls().length,
            0,
            "invalid environment URL must fail before preflight or SDK"
        );
    }
    const beforeDryFiles = fs.readdirSync(root, { recursive: true }).sort();
    const dryOutput = run("run", ["--dry-run"]);
    assert.match(dryOutput, /install.*-r/);
    assert.ok(dryOutput.includes(hostedComponent));
    assert.ok(dryOutput.includes(defaultUrl));
    assert.equal(
        calls().length,
        0,
        "dry run must not execute external commands"
    );
    assert.deepEqual(
        fs.readdirSync(root, { recursive: true }).sort(),
        beforeDryFiles,
        "dry run must not generate files or directories"
    );
    assert.equal(fs.existsSync(generatedApk), false);

    devices({ "emulator-5554": "ExistingPhone" });
    run("run", [], { FAIL_CURL: "1" }, false);
    assert.deepEqual(
        calls().map((call) => call.name),
        ["curl"],
        "failed health check must not build, boot, or contact ADB"
    );
    run("run", [], { FAIL_PLAYER_PREFLIGHT: "1" }, false);
    assert.deepEqual(
        calls().map((call) => call.name),
        ["curl", "curl"],
        "failed player check must not build, boot, or contact ADB"
    );
    run("run", [], { FAIL_PREPARE: "1" }, false);
    assert.deepEqual(
        calls().map((call) => call.name),
        ["curl", "curl", "prepare-player"],
        "failed APK preparation must not boot or contact ADB"
    );
    assert.equal(fs.existsSync(generatedApk), false);

    devices({
        "emulator-5554": "ExistingPhone",
        "emulator-5572": "OttplayAndroidTV",
    });
    const output = run("run");
    assert.match(output, /Reusing OttplayAndroidTV \(emulator-5572\)/);
    const defaultCalls = calls();
    assert.deepEqual(
        defaultCalls.slice(0, 3).map((call) => call.name),
        ["curl", "curl", "prepare-player"],
        "preflight and build must precede any emulator connection"
    );
    assert.deepEqual(
        defaultCalls
            .filter((call) => call.name === "curl")
            .map((call) => call.args.find((arg) => /^https?:/.test(arg))),
        ["http://127.0.0.1:8443/health", defaultUrl]
    );
    assert.ok(
        defaultCalls
            .filter((call) => call.name === "curl")
            .every(
                (call) =>
                    call.args.includes("--globoff") &&
                    call.args.includes("--fail")
            )
    );
    assert.deepEqual(
        defaultCalls.find((call) => call.name === "prepare-player").args,
        [sdk]
    );
    assert.ok(fs.existsSync(generatedApk));
    assert.equal(
        defaultCalls.some((call) => call.name === "emulator"),
        false
    );
    const hostedMutations = defaultCalls.filter(
        (call) =>
            call.args.includes("reverse") ||
            call.args.includes("install") ||
            call.args.includes("start")
    );
    assert.equal(hostedMutations.length, 4);
    assert.ok(
        hostedMutations.every((call) => call.args[1] === "emulator-5572"),
        "default hosted player must never target an unrelated running device"
    );
    assert.deepEqual(
        hostedMutations.find((call) => call.args.includes("install")).args,
        ["-s", "emulator-5572", "install", "-r", generatedApk],
        "built APK path must resolve from the checkout even outside its cwd"
    );
    assert.deepEqual(
        hostedMutations.find((call) => call.args.includes("start")).args,
        [
            "-s",
            "emulator-5572",
            "shell",
            "am",
            "start",
            "-W",
            "-n",
            shellQuote(hostedComponent),
            "-d",
            shellQuote(defaultUrl),
        ]
    );

    const customUrl =
        "http://localhost:9012/play'er?value=abc&set=[1,2]#sec'tion";
    run("run", ["--url", customUrl], { OTTP_PLAYER_URL: "invalid-ignored" });
    const customCalls = calls();
    assert.deepEqual(
        customCalls
            .filter((call) => call.name === "curl")
            .map((call) => call.args.find((arg) => /^https?:/.test(arg))),
        ["http://localhost:9012/health", customUrl],
        "URL path, query and fragment must remain one curl argument"
    );
    assert.deepEqual(
        customCalls
            .filter((call) => call.args.includes("reverse"))
            .map((call) => call.args.at(-1)),
        ["tcp:8443", "tcp:8090", "tcp:9012"]
    );
    assert.equal(
        customCalls.find((call) => call.args.includes("start")).args.at(-1),
        shellQuote(customUrl),
        "URL quotes and shell metacharacters must reach Android as data"
    );
    const environmentUrl = "https://player.example.invalid/player?test=1";
    run("run", [], { OTTP_PLAYER_URL: environmentUrl });
    assert.equal(
        calls()
            .find((call) => call.args.includes("start"))
            .args.at(-1),
        shellQuote(environmentUrl)
    );
    assert.deepEqual(
        calls()
            .filter((call) => call.args.includes("reverse"))
            .map((call) => call.args.at(-1)),
        ["tcp:8443", "tcp:8090"],
        "remote URLs must not add an unrelated reverse port"
    );
    for (const args of [
        ["--home"],
        ["--component", "test.ott/.MainActivity"],
        ["--apk", apk, "--component", "test.ott/.MainActivity"],
        ["--stop"],
    ]) {
        run("run", args, { OTTP_PLAYER_URL: "invalid-ignored" });
        assert.equal(
            hostedCalls().length,
            0,
            "explicit modes must not validate an unused URL or prepare the hosted player"
        );
    }

    devices({ "emulator-5554": "ExistingPhone" });
    assert.match(run("run"), /Starting OttplayAndroidTV/);
    assert.ok(
        calls().some(
            (call) => call.name === "emulator" && call.args.includes("-avd")
        )
    );
    assert.deepEqual(
        calls().find((call) => call.args.includes("install")).args,
        ["-s", "emulator-5570", "install", "-r", generatedApk]
    );
    assert.ok(
        calls()
            .filter((call) => call.args.includes("start"))
            .every((call) => call.args[1] === "emulator-5570")
    );

    const hardwareFile = path.join(
        path.dirname(configFile),
        "hardware-qemu.ini"
    );
    const pidFile = path.join(
        path.dirname(configFile),
        "hardware-qemu.ini.lock"
    );
    const dataFile = path.join(path.dirname(configFile), "userdata-qemu.img");
    const preservedData = Buffer.from("existing TV app data and settings");
    fs.writeFileSync(dataFile, preservedData);
    const goodConfig =
        originalConfig + "hw.ramSize=4096\nskin.name=custom-tv\n";
    const brokenConfig = goodConfig
        .replace("hw.keyboard=yes", "hw.keyboard=no")
        .replace("hw.dPad=yes", "hw.dPad=0");
    const oldHardware = "hw.keyboard=false\nhw.dPad=false\n";
    function brokenTv() {
        fs.writeFileSync(configFile, brokenConfig);
        fs.writeFileSync(hardwareFile, oldHardware);
        devices({
            "emulator-5554": "ExistingPhone",
            "emulator-5570": "OtherTV",
            "emulator-5572": "OttplayAndroidTV",
        });
    }
    function assertInputUnchanged(reason) {
        assert.equal(fs.readFileSync(configFile, "utf8"), brokenConfig, reason);
        assert.equal(
            fs.readFileSync(hardwareFile, "utf8"),
            oldHardware,
            reason
        );
        assert.deepEqual(fs.readFileSync(dataFile), preservedData, reason);
    }
    function assertNoAvdMutation(reason) {
        assertInputUnchanged(reason);
        assert.equal(
            calls().some(
                (call) =>
                    call.args.includes("kill") ||
                    call.args.includes("-avd") ||
                    call.args.includes("reverse") ||
                    call.args.includes("install")
            ),
            false,
            reason
        );
    }
    brokenTv();
    run("run", ["--dry-run"]);
    assert.equal(calls().length, 0);
    assertInputUnchanged("dry run must not repair input hardware");
    run("run", ["--stop"]);
    assertInputUnchanged("stop must not repair input hardware");
    assert.deepEqual(calls().find((call) => call.args.includes("kill")).args, [
        "-s",
        "emulator-5572",
        "emu",
        "kill",
    ]);

    for (const extra of [
        { FAIL_CURL: "1" },
        { FAIL_PREPARE: "1" },
        { IDENTITY_MISMATCH: "1" },
        { FAIL_ACCEL: "1" },
    ]) {
        brokenTv();
        run("run", [], extra, false);
        assertNoAvdMutation(
            "preflight, build, identity or acceleration failure must precede input repair"
        );
    }
    brokenTv();
    devices({ "emulator-5554": "ExistingPhone", "emulator-5570": "OtherTV" });
    assert.match(run("run", ["--home"], {}, false), /occupied/);
    assertNoAvdMutation("occupied port must not repair an unrelated AVD");
    brokenTv();
    devices({
        "emulator-5572": "OttplayAndroidTV",
        "emulator-5574": "OttplayAndroidTV",
    });
    assert.match(
        run("run", ["--home"], {}, false),
        /Multiple running instances/
    );
    assertNoAvdMutation("ambiguous AVD identity must not change configuration");
    brokenTv();
    const phoneProfile = brokenConfig.replace(
        "tag.id=android-tv",
        "tag.id=google_apis"
    );
    fs.writeFileSync(configFile, phoneProfile);
    assert.match(run("run", ["--home"], {}, false), /not an Android TV/);
    assert.equal(fs.readFileSync(configFile, "utf8"), phoneProfile);
    assert.equal(calls().length, 0);

    brokenTv();
    assert.match(
        run("run", ["--home", "--timeout", "1"], { STOP_STUCK: "1" }, false),
        /Stop timed out/
    );
    assertInputUnchanged(
        "failed shutdown must not write config or touch app data"
    );
    assert.equal(
        calls().some((call) => call.args.includes("-avd")),
        false,
        "replacement waits for old serial to disappear"
    );
    brokenTv();
    fs.writeFileSync(pidFile, String(process.pid) + "\0");
    assert.match(
        run("run", ["--home", "--timeout", "1"], {}, false),
        /Stop timed out/
    );
    assertInputUnchanged(
        "disconnected serial with live SDK PID must not launch a second process"
    );
    assert.equal(
        calls().some((call) => call.args.includes("-avd")),
        false
    );
    fs.unlinkSync(pidFile);

    brokenTv();
    assert.match(
        run("run", [], { STOP_DELAY_POLLS: "2" }),
        /Restarting OttplayAndroidTV \(emulator-5572\)/
    );
    const repairCalls = calls();
    const killIndex = repairCalls.findIndex((call) =>
        call.args.includes("kill")
    );
    const bootIndex = repairCalls.findIndex(
        (call) => call.name === "emulator" && call.args.includes("-avd")
    );
    assert.ok(killIndex > -1 && bootIndex > killIndex);
    assert.ok(
        repairCalls
            .slice(killIndex + 1, bootIndex)
            .filter((call) => call.name === "adb" && call.args[0] === "devices")
            .length >= 3,
        "wait for asynchronous ADB disconnection before restarting"
    );
    assert.deepEqual(repairCalls[killIndex].args, [
        "-s",
        "emulator-5572",
        "emu",
        "kill",
    ]);
    assert.ok(repairCalls[bootIndex].args.includes("-no-snapshot-load"));
    assert.equal(
        repairCalls[bootIndex].args[
            repairCalls[bootIndex].args.indexOf("-port") + 1
        ],
        "5572",
        "restart on the matched port while default port belongs to another TV"
    );
    assert.ok(
        repairCalls
            .filter(
                (call) =>
                    call.args.includes("kill") ||
                    call.args.includes("reverse") ||
                    call.args.includes("install") ||
                    call.args.includes("start")
            )
            .every((call) => call.args[1] === "emulator-5572")
    );
    assert.equal(
        repairCalls.some((call) => call.args.includes("-wipe-data")),
        false
    );
    assert.equal(
        fs.readFileSync(configFile, "utf8"),
        goodConfig,
        "repair changes only the two input fields"
    );
    assert.deepEqual(fs.readFileSync(dataFile), preservedData);
    assert.deepEqual(JSON.parse(fs.readFileSync(state)), {
        "emulator-5554": "ExistingPhone",
        "emulator-5570": "OtherTV",
        "emulator-5572": "OttplayAndroidTV",
    });

    // Actual SDK runtime INI booleans differ from config.ini's yes/no spelling.
    const spacedConfig = goodConfig
        .replace("hw.keyboard=yes", "hw.keyboard = yes")
        .replace("hw.dPad=yes", "hw.dPad = 1");
    fs.writeFileSync(configFile, spacedConfig);
    fs.writeFileSync(hardwareFile, "hw.keyboard = true\nhw.dPad=true\n");
    assert.match(run("run", ["--home"]), /Reusing OttplayAndroidTV/);
    assert.equal(
        calls().some(
            (call) => call.name === "emulator" || call.args.includes("kill")
        ),
        false,
        "already enabled runtime keyboard must be reused without restart"
    );
    assert.equal(
        fs.readFileSync(configFile, "utf8"),
        spacedConfig,
        "semantic no-op preserves formatting"
    );

    // Editing config.ini alone does not retrofit a running emulator's devices.
    fs.writeFileSync(hardwareFile, oldHardware);
    assert.match(run("run", ["--home"]), /Restarting OttplayAndroidTV/);
    assert.ok(
        calls()
            .find((call) => call.args.includes("-avd"))
            .args.includes("-no-snapshot-load")
    );
    assert.equal(fs.readFileSync(configFile, "utf8"), spacedConfig);

    brokenTv();
    devices({ "emulator-5554": "ExistingPhone" });
    assert.match(run("run", ["--home"]), /Starting OttplayAndroidTV/);
    assert.equal(
        calls().some((call) => call.args.includes("kill")),
        false,
        "stopped AVD repair does not kill any running phone"
    );
    assert.ok(
        calls()
            .find((call) => call.args.includes("-avd"))
            .args.includes("-no-snapshot-load")
    );
    assert.equal(fs.readFileSync(configFile, "utf8"), goodConfig);
    assert.deepEqual(fs.readFileSync(dataFile), preservedData);

    // Reinstall from an absent SDK without using the host SDK, network or VM.
    const cleanSdk = path.join(tmp, "fresh SDK");
    const isolatedEnv = {
        PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
    };
    const freshArgs = ["--home", "--avd", "FreshTV", "--sdk", cleanSdk];
    devices({});
    const freshDry = run("run", [...freshArgs, "--dry-run"], isolatedEnv);
    assert.match(
        freshDry,
        /dl\.google\.com\/android\/repository\/commandlinetools-/
    );
    assert.match(freshDry, /Verify SHA-256/);
    assert.match(freshDry, /sdkmanager.*--install/);
    assert.equal(calls().length, 0);
    assert.equal(
        fs.existsSync(cleanSdk),
        false,
        "dry bootstrap leaves no files"
    );
    assert.match(
        run("run", freshArgs, { ...isolatedEnv, FAIL_DOWNLOAD: "1" }, false),
        /failed/
    );
    assert.equal(
        calls().some((call) => call.name === "unzip"),
        false
    );
    assert.deepEqual(
        fs.readdirSync(path.join(cleanSdk, "cmdline-tools")),
        [],
        "failed download is cleaned up"
    );
    assert.match(
        run("run", freshArgs, { ...isolatedEnv, BAD_CHECKSUM: "1" }, false),
        /checksum mismatch/
    );
    assert.equal(
        calls().some((call) => call.name === "unzip"),
        false,
        "unverified archive must never be extracted"
    );
    assert.deepEqual(fs.readdirSync(path.join(cleanSdk, "cmdline-tools")), []);
    assert.match(
        run("run", freshArgs, { ...isolatedEnv, FAIL_INSTALL: "1" }, false),
        /failed/
    );
    assert.ok(calls().some((call) => call.name === "unzip"));
    assert.equal(
        fs.existsSync(path.join(avdHome, "FreshTV.ini")),
        false,
        "failed SDK installation must not create an AVD"
    );
    assert.deepEqual(
        fs.readdirSync(path.join(cleanSdk, "cmdline-tools")),
        ["ottplay-15859902"],
        "successful bootstrap retains tools only, no downloaded archive"
    );
    assert.match(run("run", freshArgs, isolatedEnv), /Starting FreshTV/);
    assert.equal(
        calls().some((call) => ["curl", "unzip"].includes(call.name)),
        false,
        "retry reuses verified command-line tools"
    );
    assert.ok(
        fs.existsSync(path.join(cleanSdk, ...image.split(";"), "system.img"))
    );
    assert.match(run("run", freshArgs, isolatedEnv), /Reusing FreshTV/);
    assert.equal(
        calls().some((call) =>
            ["sdkmanager", "avdmanager", "curl", "unzip"].includes(call.name)
        ),
        false,
        "complete installation is reused"
    );
    console.log("Android TV setup/launcher integration tests passed");
} finally {
    fs.rmSync(tmp, { force: true, recursive: true });
}
