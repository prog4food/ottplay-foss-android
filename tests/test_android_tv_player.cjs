const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const temp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "ottplay Android host [test] "))
);
const root = path.join(temp, "project with spaces");
const sdk = path.join(temp, "SDK [36]");
const java = path.join(temp, "Java 17");
const calls = path.join(temp, "calls.jsonl");
const androidUser = path.join(temp, "Android user [config]");
const stableKey = path.join(androidUser, "ottplay-simulator/debug.keystore");
const output = path.join(root, "build/device-android-tv-player");
const builder = path.join(root, "scripts/prepare-android-tv-player.cjs");
const component = "play.ott.simulator.web/.MainActivity";

function write(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
}

const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const name = path.basename(process.argv[1]);
const at = key => args[args.indexOf(key) + 1];
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({name, args, cwd:process.cwd()})+'\\n');
if (process.env.FAIL_TOOL === name) process.exit(1);
if (name === 'javac' && args[0] === '-version') console.log('javac 17.0.19');
else if (name === 'javac') {
  const dir = path.join(at('-d'), 'play/ott/simulator/web');
  fs.mkdirSync(dir, {recursive:true}); fs.writeFileSync(path.join(dir,'MainActivity.class'), 'bytecode');
} else if (name === 'd8') fs.writeFileSync(path.join(at('--output'),'classes.dex'), 'dex');
else if (name === 'aapt' && args[0] === 'package') fs.writeFileSync(at('-F'), 'manifest');
else if (name === 'aapt' && args[0] === 'add') fs.appendFileSync(args[1], fs.readFileSync(args[2]));
else if (name === 'zipalign' && args[0] === '-f') fs.copyFileSync(args[2],args[3]);
else if (name === 'keytool') {
  if (process.env.KEYTOOL_BARRIER_DIR) {
    const barrier = process.env.KEYTOOL_BARRIER_DIR;
    fs.writeFileSync(path.join(barrier, process.pid+'.ready'), 'ready');
    const deadline = Date.now()+5000;
    while (fs.readdirSync(barrier).length < 2 && Date.now() < deadline)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    if (fs.readdirSync(barrier).length < 2) throw Error('Concurrent builder did not reach keytool');
  }
  fs.writeFileSync(at('-keystore'), 'anonymous-debug-key-'+process.pid);
}
else if (name === 'apksigner' && args[0] === 'sign') {
  fs.copyFileSync(args.at(-1),at('--out'));
  fs.appendFileSync(at('--out'),'signed:'+fs.readFileSync(at('--ks'),'utf8'));
}
`;

try {
    write(
        builder,
        fs.readFileSync(
            path.join(__dirname, "../scripts/prepare-android-tv-player.cjs")
        )
    );
    fs.cpSync(
        path.join(__dirname, "../scripts/fixtures/android-tv-webview"),
        path.join(root, "scripts/fixtures/android-tv-webview"),
        { recursive: true }
    );
    for (const name of ["aapt", "d8", "zipalign", "apksigner"])
        write(path.join(sdk, "build-tools/36.0.0", name), fake);
    for (const name of ["javac", "keytool"])
        write(path.join(java, "bin", name), fake);
    for (const file of [
        "platforms/android-36/android.jar",
        "platforms/android-36/source.properties",
        "build-tools/36.0.0/source.properties",
        "build-tools/36.0.0/lib/d8.jar",
        "build-tools/36.0.0/lib/apksigner.jar",
    ])
        write(path.join(sdk, file), `fixture ${file}`);
    write(path.join(java, "release"), "JAVA_VERSION=17");
    for (const file of [
        ...["aapt", "d8", "zipalign", "apksigner"].map((name) =>
            path.join(sdk, "build-tools/36.0.0", name)
        ),
        ...["javac", "keytool"].map((name) => path.join(java, "bin", name)),
    ])
        fs.chmodSync(file, 0o755);

    const env = {
        ...process.env,
        ANDROID_USER_HOME: androidUser,
        CALL_LOG: calls,
        JAVA_HOME: java,
    };
    const invoke = (args, extra = {}, entry = builder) =>
        spawnSync(process.execPath, [entry, ...args], {
            cwd: temp,
            encoding: "utf8",
            env: { ...env, ...extra },
            timeout: 15000,
        });
    const history = () =>
        fs.existsSync(calls)
            ? fs
                  .readFileSync(calls, "utf8")
                  .trim()
                  .split("\n")
                  .filter(Boolean)
                  .map(JSON.parse)
            : [];
    const clear = () => fs.writeFileSync(calls, "");
    const successful = (result, destination = output) => {
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), {
            apk: path.join(destination, "player.apk"),
            component,
        });
    };

    successful(invoke(["--dry-run", "--sdk", "does not exist"]));
    assert.equal(fs.existsSync(output), false, "dry run creates no files");
    assert.equal(
        fs.existsSync(androidUser),
        false,
        "dry run creates no signing directory"
    );
    assert.deepEqual(history(), [], "dry run invokes no tools");

    // A relative SDK and a foreign cwd must still supply absolute SDK inputs.
    successful(invoke(["--sdk", path.relative(temp, sdk)]));
    const first = history();
    assert.deepEqual(
        first.map((call) => call.name),
        [
            "javac",
            "javac",
            "d8",
            "aapt",
            "aapt",
            "zipalign",
            "keytool",
            "apksigner",
            "apksigner",
            "zipalign",
        ]
    );
    const compile = first.find(
        (call) => call.name === "javac" && call.args[0] !== "-version"
    );
    assert.ok(
        compile.args.includes("-g:none"),
        "omit local source debug metadata"
    );
    assert.equal(
        compile.args[compile.args.indexOf("-bootclasspath") + 1],
        path.join(sdk, "platforms/android-36/android.jar")
    );
    assert.equal(
        compile.args.at(-1),
        "MainActivity.java",
        "source argument is relative"
    );
    const signing = first.find(
        (call) => call.name === "apksigner" && call.args[0] === "sign"
    );
    assert.ok(
        first.indexOf(first.find((call) => call.name === "zipalign")) <
            first.indexOf(signing)
    );
    const certificate = first.find((call) => call.name === "keytool");
    assert.equal(
        certificate.args[certificate.args.indexOf("-dname") + 1],
        "CN=Android Debug"
    );
    const metadata = fs.readFileSync(path.join(output, "cache.json"), "utf8");
    assert.ok(
        !metadata.includes(temp),
        "cache contains only hashes, no local paths"
    );
    assert.deepEqual(fs.readdirSync(output).sort(), [
        "cache.json",
        "player.apk",
    ]);
    assert.equal(signing.args[signing.args.indexOf("--ks") + 1], stableKey);
    assert.equal(fs.statSync(stableKey).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(stableKey)).mode & 0o777, 0o700);
    const firstKey = fs.readFileSync(stableKey);

    clear();
    successful(invoke(["--sdk", sdk]));
    assert.deepEqual(
        history().map((call) => call.name),
        ["javac"],
        "unchanged inputs only read javac version, no rebuild"
    );

    // Byte changes invalidate the cache even with unchanged source/tool names.
    for (const file of [
        path.join(
            root,
            "scripts/fixtures/android-tv-webview/MainActivity.java"
        ),
        path.join(sdk, "build-tools/36.0.0/lib/d8.jar"),
        path.join(output, "player.apk"),
    ]) {
        fs.appendFileSync(file, "\nchanged bytes");
        clear();
        successful(invoke(["--sdk", sdk]));
        assert.ok(
            history().some((call) => call.name === "d8"),
            `${path.basename(file)} invalidates cache`
        );
        assert.ok(
            !history().some((call) => call.name === "keytool"),
            "existing signing identity is preserved"
        );
    }

    fs.writeFileSync(path.join(output, "cache.json"), "malformed");
    clear();
    const beforeFailure = fs.readFileSync(path.join(output, "player.apk"));
    const failed = invoke(["--sdk", sdk], { FAIL_TOOL: "d8" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /d8 failed/);
    assert.deepEqual(
        fs.readFileSync(path.join(output, "player.apk")),
        beforeFailure,
        "failed rebuild preserves previous APK"
    );
    assert.ok(
        !fs.readdirSync(output).some((name) => name.startsWith("work-")),
        "failed build cleans temporary output"
    );
    assert.ok(!history().some((call) => call.name === "apksigner"));
    assert.deepEqual(
        fs.readFileSync(stableKey),
        firstKey,
        "failed build preserves stable signing identity"
    );
    successful(invoke(["--sdk", sdk]));

    // Deleting build outputs and switching checkout must keep install -r compatible.
    const secondRoot = path.join(temp, "another checkout [space]");
    const secondBuilder = path.join(
        secondRoot,
        "scripts/prepare-android-tv-player.cjs"
    );
    const secondOutput = path.join(
        secondRoot,
        "build/device-android-tv-player"
    );
    fs.cpSync(path.join(root, "scripts"), path.join(secondRoot, "scripts"), {
        recursive: true,
    });
    fs.rmSync(output, { force: true, recursive: true });
    clear();
    successful(invoke(["--sdk", sdk]));
    successful(invoke(["--sdk", sdk], {}, secondBuilder), secondOutput);
    assert.deepEqual(fs.readFileSync(stableKey), firstKey);
    assert.ok(
        !history().some((call) => call.name === "keytool"),
        "build deletion/new checkout reuses key"
    );
    for (const destination of [output, secondOutput])
        assert.ok(
            fs
                .readFileSync(path.join(destination, "player.apk"), "utf8")
                .endsWith(`signed:${firstKey}`)
        );

    // Adopt an old build-local key once, without consuming or changing it.
    const migrationUser = path.join(temp, "legacy user");
    const migratedKey = path.join(
        migrationUser,
        "ottplay-simulator/debug.keystore"
    );
    const legacyKey = path.join(output, "debug.keystore");
    write(legacyKey, "old-anonymous-signing-identity");
    fs.chmodSync(legacyKey, 0o644);
    write(
        path.join(migrationUser, "debug.keystore"),
        "unrelated-Android-debug-key"
    );
    clear();
    successful(
        invoke(["--sdk", sdk, "--dry-run"], {
            ANDROID_USER_HOME: migrationUser,
        })
    );
    assert.equal(
        fs.existsSync(migratedKey),
        false,
        "dry run does not migrate old key"
    );
    successful(invoke(["--sdk", sdk], { ANDROID_USER_HOME: migrationUser }));
    assert.equal(
        fs.readFileSync(migratedKey, "utf8"),
        "old-anonymous-signing-identity"
    );
    assert.equal(fs.statSync(migratedKey).mode & 0o777, 0o600);
    assert.equal(
        fs.readFileSync(legacyKey, "utf8"),
        "old-anonymous-signing-identity"
    );
    assert.equal(
        fs.statSync(legacyKey).mode & 0o777,
        0o644,
        "migration leaves legacy key untouched"
    );
    assert.equal(
        fs.readFileSync(path.join(migrationUser, "debug.keystore"), "utf8"),
        "unrelated-Android-debug-key"
    );
    assert.ok(
        !history().some((call) => call.name === "keytool"),
        "migration preserves certificate"
    );
    write(legacyKey, "different-checkout-legacy-key");
    clear();
    successful(invoke(["--sdk", sdk], { ANDROID_USER_HOME: migrationUser }));
    assert.equal(
        fs.readFileSync(migratedKey, "utf8"),
        "old-anonymous-signing-identity",
        "existing stable key wins over legacy"
    );
    assert.deepEqual(
        history().map((call) => call.name),
        ["javac"],
        "legacy replacement does not invalidate stable-key cache"
    );

    // Two fresh checkouts can create keys together; both must sign with the winner.
    fs.unlinkSync(legacyKey);
    const raceUser = path.join(temp, "concurrent user");
    const barrier = path.join(temp, "key creation barrier");
    fs.mkdirSync(barrier);
    const race = spawnSync(
        process.execPath,
        [
            "-e",
            `
      const {spawn}=require('node:child_process');
      Promise.all(process.argv.slice(1).map(entry=>new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[entry,'--sdk',process.env.TEST_SDK],{stdio:['ignore','ignore','pipe']});
        let error=''; child.stderr.on('data',value=>error+=value);
        child.on('error',reject); child.on('close',code=>code===0?resolve():reject(Error(error||'Builder failed')));
      }))).catch(error=>{console.error(error);process.exitCode=1;});
    `,
            builder,
            secondBuilder,
        ],
        {
            cwd: temp,
            encoding: "utf8",
            env: {
                ...env,
                ANDROID_USER_HOME: raceUser,
                KEYTOOL_BARRIER_DIR: barrier,
                TEST_SDK: sdk,
            },
            timeout: 25000,
        }
    );
    assert.equal(race.error, undefined);
    assert.equal(race.status, 0, race.stderr);
    const winner = fs.readFileSync(
        path.join(raceUser, "ottplay-simulator/debug.keystore"),
        "utf8"
    );
    assert.equal(
        fs.readdirSync(barrier).length,
        2,
        "both processes reached key generation"
    );
    for (const destination of [output, secondOutput])
        assert.ok(
            fs
                .readFileSync(path.join(destination, "player.apk"), "utf8")
                .endsWith(`signed:${winner}`),
            "both APKs use the same winning certificate"
        );
    assert.deepEqual(fs.readdirSync(path.join(raceUser, "ottplay-simulator")), [
        "debug.keystore",
    ]);

    // Exercise the home fallback without changing this process's real home.
    const defaultHome = path.join(temp, "default home");
    const sharedDebugKey = path.join(defaultHome, ".android/debug.keystore");
    write(sharedDebugKey, "unrelated-standard-debug-key");
    successful(
        spawnSync(
            process.execPath,
            [
                "-e",
                `
        require('node:os').homedir=()=>process.env.TEST_HOME;
        const api=require(process.argv[1]);
        console.log(JSON.stringify(api.prepareAndroidTvPlayer({sdk:process.env.TEST_SDK})));
    `,
                builder,
            ],
            {
                cwd: temp,
                encoding: "utf8",
                env: {
                    ...env,
                    ANDROID_USER_HOME: "",
                    TEST_HOME: defaultHome,
                    TEST_SDK: sdk,
                },
                timeout: 15000,
            }
        )
    );
    assert.ok(
        fs.existsSync(
            path.join(defaultHome, ".android/ottplay-simulator/debug.keystore")
        )
    );
    assert.equal(
        fs.readFileSync(sharedDebugKey, "utf8"),
        "unrelated-standard-debug-key"
    );

    for (const args of [["--sdk"], ["--unknown"], ["--sdk", "missing"]]) {
        const result = invoke(args);
        assert.notEqual(result.status, 0, args.join(" "));
    }
    console.log("Android TV player builder regression passed");
} finally {
    fs.rmSync(temp, { force: true, recursive: true });
}
