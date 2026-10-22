// Offline, dependency-free Android TV WebView host for local simulator checks.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const component = "play.ott.simulator.web/.MainActivity";
const output = path.resolve(__dirname, "../build/device-android-tv-player");
const apk = path.join(output, "player.apk");
const fixtures = path.join(__dirname, "fixtures/android-tv-webview");

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        timeout: 120000,
        ...options,
    });
    if (result.error || result.status !== 0) {
        throw new Error(
            `${path.basename(command)} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`
        );
    }
    return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function fileHash(file) {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function requireFile(file) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile())
        throw new Error(
            `Required Android build tool or input is missing: ${file}`
        );
    return file;
}

function javaHome() {
    if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
    if (process.platform === "darwin") return run("/usr/libexec/java_home", []);
    const javac = (process.env.PATH || "")
        .split(path.delimiter)
        .map((directory) => path.join(directory, "javac"))
        .find((file) => fs.existsSync(file));
    if (!javac) throw new Error("Java 17 or newer is required (set JAVA_HOME)");
    return path.dirname(path.dirname(fs.realpathSync(javac)));
}

function publishSigningKey(source, key) {
    const directory = path.dirname(key);
    fs.mkdirSync(directory, { mode: 0o700, recursive: true });
    const work = fs.mkdtempSync(path.join(directory, ".key-"));
    try {
        const prepared = path.join(work, "debug.keystore");
        fs.copyFileSync(source, prepared);
        fs.chmodSync(prepared, 0o600);
        try {
            // Publish complete bytes atomically. A concurrent first launch must
            // use the winning key, never replace it with its own certificate.
            fs.linkSync(prepared, key);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
    } finally {
        fs.rmSync(work, { force: true, recursive: true });
    }
}

function prepareAndroidTvPlayer({ sdk, dryRun = false } = {}) {
    // Dry runs also work before SDK installation and never invoke build tools.
    if (dryRun) return { apk, component };
    if (!sdk) throw new Error("Android SDK path is required (--sdk)");
    sdk = path.resolve(sdk);
    const tools = path.join(sdk, "build-tools/36.0.0");
    const androidJar = requireFile(
        path.join(sdk, "platforms/android-36/android.jar")
    );
    const java = javaHome();
    const javac = requireFile(path.join(java, "bin/javac"));
    const keytool = requireFile(path.join(java, "bin/keytool"));
    const javaVersion = run(javac, ["-version"]);
    if (Number(javaVersion.match(/javac (\d+)/)?.[1] || 0) < 17)
        throw new Error("Java 17 or newer is required");
    const names = ["aapt", "d8", "zipalign", "apksigner"];
    for (const name of names) requireFile(path.join(tools, name));
    const environment = { ...process.env, JAVA_HOME: java };
    const execute = (name, args, options) =>
        run(path.join(tools, name), args, { env: environment, ...options });
    const sources = ["AndroidManifest.xml", "MainActivity.java"];
    const inputFiles = [
        __filename,
        ...sources.map((name) => path.join(fixtures, name)),
        androidJar,
        path.join(sdk, "platforms/android-36/source.properties"),
        ...names.map((name) => path.join(tools, name)),
        path.join(tools, "lib/d8.jar"),
        path.join(tools, "lib/apksigner.jar"),
        path.join(tools, "source.properties"),
        javac,
        keytool,
        path.join(java, "release"),
    ];
    const inputsHash = createHash("sha256")
        .update(javaVersion)
        .update(inputFiles.map(fileHash).join("\n"))
        .digest("hex");
    const key = path.resolve(
        process.env.ANDROID_USER_HOME || path.join(os.homedir(), ".android"),
        "ottplay-simulator/debug.keystore"
    );
    const legacyKey = path.join(output, "debug.keystore");
    if (!fs.existsSync(key) && fs.existsSync(legacyKey))
        publishSigningKey(legacyKey, key);
    const cacheFile = path.join(output, "cache.json");
    try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (
            cache.inputs === inputsHash &&
            cache.key === fileHash(key) &&
            cache.apk === fileHash(apk)
        )
            return { apk, component };
    } catch (_) {
        // Missing or corrupted outputs are rebuilt; preserve an existing key.
    }
    fs.mkdirSync(output, { recursive: true });
    const work = fs.mkdtempSync(path.join(output, "work-"));
    try {
        for (const name of sources)
            fs.copyFileSync(path.join(fixtures, name), path.join(work, name));
        fs.mkdirSync(path.join(work, "classes"));
        fs.mkdirSync(path.join(work, "dex"));
        run(
            javac,
            [
                "-g:none",
                "-encoding",
                "UTF-8",
                "-source",
                "8",
                "-target",
                "8",
                "-bootclasspath",
                androidJar,
                "-d",
                "classes",
                "MainActivity.java",
            ],
            { cwd: work }
        );
        const classes = fs
            .readdirSync(path.join(work, "classes/play/ott/simulator/web"))
            .filter((name) => name.endsWith(".class"))
            .map((name) => path.join("classes/play/ott/simulator/web", name));
        execute(
            "d8",
            [
                "--release",
                "--min-api",
                "26",
                "--lib",
                androidJar,
                "--output",
                "dex",
                ...classes,
            ],
            { cwd: work }
        );
        execute(
            "aapt",
            [
                "package",
                "-f",
                "-M",
                "AndroidManifest.xml",
                "-I",
                androidJar,
                "-F",
                "unsigned.apk",
            ],
            { cwd: work }
        );
        execute("aapt", ["add", "../unsigned.apk", "classes.dex"], {
            cwd: path.join(work, "dex"),
        });
        execute("zipalign", ["-f", "4", "unsigned.apk", "aligned.apk"], {
            cwd: work,
        });
        if (!fs.existsSync(key)) {
            run(
                keytool,
                [
                    "-genkeypair",
                    "-noprompt",
                    "-keystore",
                    "debug.keystore",
                    "-storetype",
                    "JKS",
                    "-storepass",
                    "android",
                    "-keypass",
                    "android",
                    "-alias",
                    "androiddebugkey",
                    "-keyalg",
                    "RSA",
                    "-keysize",
                    "2048",
                    "-validity",
                    "10000",
                    "-dname",
                    "CN=Android Debug",
                ],
                { cwd: work }
            );
            publishSigningKey(path.join(work, "debug.keystore"), key);
        }
        execute(
            "apksigner",
            [
                "sign",
                "--ks",
                key,
                "--ks-key-alias",
                "androiddebugkey",
                "--ks-pass",
                "pass:android",
                "--key-pass",
                "pass:android",
                "--v4-signing-enabled",
                "false",
                "--out",
                "player.apk",
                "aligned.apk",
            ],
            { cwd: work }
        );
        execute("apksigner", ["verify", "player.apk"], { cwd: work });
        execute("zipalign", ["-c", "4", "player.apk"], { cwd: work });
        const cache = {
            apk: fileHash(path.join(work, "player.apk")),
            inputs: inputsHash,
            key: fileHash(key),
        };
        fs.writeFileSync(
            path.join(work, "cache.json"),
            `${JSON.stringify(cache)}\n`
        );
        fs.renameSync(path.join(work, "player.apk"), apk);
        fs.renameSync(path.join(work, "cache.json"), cacheFile);
    } finally {
        fs.rmSync(work, { force: true, recursive: true });
    }
    return { apk, component };
}

module.exports = { component, prepareAndroidTvPlayer };
if (require.main === module) {
    try {
        const args = process.argv.slice(2);
        const defaultSdk =
            process.platform === "darwin"
                ? path.join(os.homedir(), "Library/Android/sdk")
                : path.join(os.homedir(), "Android/Sdk");
        const brewSdk = "/opt/homebrew/share/android-commandlinetools";
        const options = {
            sdk:
                process.env.ANDROID_HOME ||
                process.env.ANDROID_SDK_ROOT ||
                (fs.existsSync(defaultSdk)
                    ? defaultSdk
                    : fs.existsSync(brewSdk)
                      ? brewSdk
                      : defaultSdk),
        };
        while (args.length) {
            const arg = args.shift();
            if (arg === "--dry-run") options.dryRun = true;
            else if (arg === "--sdk" && args[0] && !args[0].startsWith("--"))
                options.sdk = args.shift();
            else if (arg === "--help" || arg === "-h") {
                console.log(
                    "Usage: node scripts/prepare-android-tv-player.cjs [--sdk PATH] [--dry-run]\nOffline build: Android SDK platform 36, build-tools 36.0.0, Java 17+.\nOutput: ignored build/device-android-tv-player/.\nAnonymous key: ANDROID_USER_HOME/ottplay-simulator/debug.keystore (default ~/.android/ottplay-simulator/)."
                );
                process.exit(0);
            } else throw new Error(`Unknown or incomplete option: ${arg}`);
        }
        console.log(JSON.stringify(prepareAndroidTvPlayer(options)));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
