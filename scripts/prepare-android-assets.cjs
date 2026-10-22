#!/usr/bin/env node
// Gradle owns one output directory per distribution. Never read dist/ or the
// shared Capacitor assets tree: both can contain a previous Full build.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { loadConfig } = require("@capacitor/cli/dist/config");
const { getPlugins } = require("@capacitor/cli/dist/plugin");
const { auditAssets } = require("./verify-android-distribution.cjs");
const root = path.resolve(__dirname, "..");

async function pluginMetadata(config) {
    // Use Capacitor's dependency discovery, then the same annotation/package
    // convention as its Android CLI. Never copy stale capacitor.plugins.json.
    const plugins = await getPlugins(config, "android");
    const entries = [];
    function scan(directory, pkg) {
        for (const entry of fs.readdirSync(directory, {
            withFileTypes: true,
        })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) scan(file, pkg);
            else if (/\.(java|kt)$/.test(entry.name)) {
                const source = fs.readFileSync(file, "utf8");
                const annotated =
                    /^@(?:CapacitorPlugin|NativePlugin)[\s\S]+?class ([\w]+)/m.exec(
                        source
                    );
                if (!annotated) continue;
                const namespace = /^package ([\w.]+);?\s*$/m.exec(
                    source.slice(0, annotated.index)
                );
                if (!namespace)
                    throw new Error("Plugin package missing: " + file);
                entries.push({
                    classpath: namespace[1] + "." + annotated[1],
                    pkg,
                });
            }
        }
    }
    for (const plugin of plugins) {
        if (plugin.xml)
            throw new Error(
                "Cordova plugins require an explicit Android distribution review"
            );
        const src = plugin.manifest?.android?.src;
        if (src) scan(path.join(plugin.rootPath, src, "src/main"), plugin.id);
    }
    if (!entries.some((entry) => entry.pkg === "@capacitor/app")) {
        throw new Error("Required Capacitor App plugin was not discovered");
    }
    return entries.sort((a, b) => a.classpath.localeCompare(b.classpath));
}

async function prepare(flavor, output) {
    const api22 = flavor === "full-api22";
    if (api22) flavor = "full";
    if (flavor !== "full" || !output) {
        throw new Error(
            "Usage: node scripts/prepare-android-assets.cjs <full|full-api22> <assets-directory>"
        );
    }
    process.chdir(root);
    output = path.resolve(output);
    // Restrict destructive cleanup to the documented generated root.
    const allowed = path.join(
        root,
        api22
            ? "android/app/build-api22/generated/ottplay"
            : "android/app/build/generated/ottplay",
        flavor,
        "assets"
    );
    if (output !== allowed) throw new Error("Output must be " + allowed);
    fs.rmSync(output, { force: true, recursive: true });
    fs.mkdirSync(output, { recursive: true });
    const temporary = fs.mkdtempSync(
        path.join(os.tmpdir(), "ottplay-android-" + flavor + "-")
    );
    try {
        execFileSync(
            process.execPath,
            [path.join(root, "node_modules/vite/bin/vite.js"), "build"],
            {
                cwd: root,
                env: {
                    ...process.env,
                    OTTPLAY_ANDROID_COMPILE_ROOT: temporary,
                    OTTPLAY_ANDROID_FLAVOR: flavor,
                    OTTPLAY_ANDROID_OUTPUT: path.join(output, "public"),
                },
                stdio: "inherit",
            }
        );
        const config = await loadConfig();
        fs.copyFileSync(
            path.join(root, "docs/privacy-policy.md"),
            path.join(output, "public/privacy-policy.txt")
        );
        fs.copyFileSync(
            path.join(root, "THIRD-PARTY-NOTICES.md"),
            path.join(output, "public/third-party-notices.txt")
        );
        const licenses = path.join(output, "public/licenses");
        fs.mkdirSync(licenses, { recursive: true });
        fs.copyFileSync(
            path.join(root, "LICENSE"),
            path.join(licenses, "project-MIT.txt")
        );
        for (const name of fs.readdirSync(
            path.join(root, "licenses/android")
        )) {
            const source = path.join(root, "licenses/android", name);
            if (!name.endsWith(".txt") || !fs.lstatSync(source).isFile()) {
                throw new Error("Unexpected license asset: " + name);
            }
            fs.copyFileSync(source, path.join(licenses, name));
        }
        const packaged = {
            ...config.app.extConfig,
            appId: "play.ott.foss",
            appName: "OTT-play FOSS",
            webDir: "public",
        };
        // All app code must come from this package, including release builds.
        if (packaged.server?.url || packaged.server?.allowNavigation?.length) {
            throw new Error(
                "Android distributions cannot use a remote app server or allowNavigation"
            );
        }
        fs.writeFileSync(
            path.join(output, "capacitor.config.json"),
            JSON.stringify(packaged, null, 2)
        );
        fs.writeFileSync(
            path.join(output, "capacitor.plugins.json"),
            JSON.stringify(await pluginMetadata(config), null, 2)
        );
        const version = require("../android/version.json");
        if (version.versionName !== require("../package.json").version)
            throw new Error(
                "Android versionName must match the frontend version"
            );
        fs.writeFileSync(
            path.join(output, "public/android-distribution.json"),
            JSON.stringify(
                {
                    applicationId: packaged.appId,
                    capacitorMajor: api22 ? 6 : 8,
                    distribution: flavor,
                    minSdk: api22 ? 22 : 24,
                    version: version.versionName,
                    versionCode: version.versionCode,
                },
                null,
                2
            )
        );
        if (api22) {
            fs.mkdirSync(path.join(output, "public/licenses/native"), {
                recursive: true,
            });
            for (const name of ["core", "app"]) {
                fs.copyFileSync(
                    path.join(
                        root,
                        "android/compat/node_modules/@capacitor",
                        name,
                        "LICENSE"
                    ),
                    path.join(
                        output,
                        "public/licenses/native",
                        "capacitor-" + name + "-LICENSE.txt"
                    )
                );
            }
        }
        auditAssets(output, flavor);
        console.log(
            "Prepared and audited Android " + flavor + " assets: " + output
        );
    } catch (error) {
        fs.rmSync(output, { force: true, recursive: true });
        throw error;
    } finally {
        fs.rmSync(temporary, { force: true, recursive: true });
    }
}

if (require.main === module)
    prepare(process.argv[2], process.argv[3]).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
module.exports = { pluginMetadata, prepare };
