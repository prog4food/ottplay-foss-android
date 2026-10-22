#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parse } = require("acorn");
const { inlineScripts } = require("./html-scripts.cjs");
const {
    auditNativeRuntime,
    auditNativeRuntimeCopy,
} = require("./native-runtime.cjs");
const root = path.resolve(__dirname, "..");

function auditAssets(directory, flavor) {
    assert.equal(flavor, "full", "Only the Full Capacitor APK is supported");
    const read = (file) => fs.readFileSync(path.join(directory, file), "utf8");
    const config = JSON.parse(read("capacitor.config.json"));
    const manifest = JSON.parse(read("public/android-distribution.json"));
    const version = JSON.parse(
        fs.readFileSync(path.join(root, "android/version.json"))
    );
    assert.equal(
        auditNativeRuntime(path.join(directory, "public")).platform,
        "capacitor"
    );
    assert.equal(config.appId, "play.ott.foss");
    assert.equal(manifest.applicationId, config.appId);
    assert.equal(manifest.distribution, flavor);
    assert.equal(manifest.version, version.versionName);
    assert.equal(manifest.versionCode, version.versionCode);
    assert.equal(manifest.version, require("../package.json").version);
    assert(
        !config.server?.url && !config.server?.allowNavigation?.length,
        "Remote app code is forbidden"
    );
    assert.equal(
        config.server.hostname,
        "localhost",
        "Keep the installed settings origin"
    );
    assert.equal(
        config.loggingBehavior,
        "none",
        "Native calls may contain credentials"
    );
    assert(
        JSON.parse(read("capacitor.plugins.json")).some(
            (plugin) =>
                plugin.classpath === "com.capacitorjs.plugins.app.AppPlugin"
        )
    );
    assert(read("public/third-party-notices.txt").includes("jQuery"));
    assert(read("public/licenses/project-MIT.txt").length > 100);
    const bundle = read("public/player.js");
    assert.equal(
        bundle,
        read("public/dist/player.js"),
        "Nested boot bundle must match"
    );
    assert(
        bundle.includes('providerDistribution="full"'),
        "Full provider catalog is missing"
    );
    assert(
        fs.statSync(path.join(directory, "public/images/player-logo.png"))
            .size > 0
    );
    assert(read("public/styles/player.css").length > 100);
    for (const provider of [
        "m3u",
        "stalker",
        "plex",
        "vportal",
        "edem",
        "ottclub",
    ])
        assert(
            fs
                .statSync(path.join(directory, "public/providers", provider))
                .isDirectory()
        );
    let checked = 0;
    function scan(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            assert(!entry.isSymbolicLink(), "Symlink in packaged assets");
            assert(
                !entry.name.startsWith("."),
                "Private file in packaged assets"
            );
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) scan(file);
            else if (entry.name.endsWith(".js")) {
                parse(fs.readFileSync(file, "utf8"), {
                    ecmaVersion: "latest",
                    sourceType: "script",
                });
                checked++;
            } else if (entry.name.endsWith(".html")) {
                for (const script of inlineScripts(
                    fs.readFileSync(file, "utf8")
                ))
                    parse(script, {
                        ecmaVersion: "latest",
                        sourceType: "script",
                    });
            }
        }
    }
    scan(path.join(directory, "public"));
    console.log(
        "PASS Full Capacitor identity, version, providers and native runtime (" +
            checked +
            " scripts)"
    );
}

function auditTarget(target, flavor, minSdk = 24) {
    if (fs.statSync(target).isDirectory()) return auditAssets(target, flavor);
    assert.equal(path.extname(target), ".apk");
    execFileSync(
        "python3",
        [
            path.join(__dirname, "verify-android-apk.py"),
            path.resolve(target),
            String(minSdk),
        ],
        { stdio: "inherit" }
    );
    const temporary = fs.mkdtempSync(
        path.join(os.tmpdir(), "ottplay-apk-audit-")
    );
    try {
        execFileSync(
            "python3",
            [
                "-c",
                [
                    "import pathlib, sys, zipfile",
                    "root = pathlib.Path(sys.argv[2])",
                    "seen = set()",
                    "with zipfile.ZipFile(sys.argv[1]) as archive:",
                    " for info in archive.infolist():",
                    "  name = info.filename",
                    "  if not name.startswith('assets/') or info.is_dir(): continue",
                    "  relative = pathlib.PurePosixPath(name[len('assets/'):])",
                    "  assert not relative.is_absolute() and '..' not in relative.parts and '\\\\' not in name",
                    "  assert str(relative) not in seen, 'Duplicate asset'",
                    "  seen.add(str(relative))",
                    "  output = root.joinpath(*relative.parts)",
                    "  output.parent.mkdir(parents=True, exist_ok=True)",
                    "  output.write_bytes(archive.read(info))",
                ].join("\n"),
                path.resolve(target),
                temporary,
            ],
            { stdio: "inherit" }
        );
        auditAssets(temporary, flavor);
        const distribution = JSON.parse(
            fs.readFileSync(
                path.join(temporary, "public/android-distribution.json")
            )
        );
        assert.equal(
            distribution.minSdk,
            minSdk,
            "Packaged runtime target differs from APK manifest"
        );
        assert.equal(distribution.capacitorMajor, minSdk === 22 ? 6 : 8);
        auditNativeRuntimeCopy(
            path.join(
                root,
                minSdk === 22
                    ? "android/app/build-api22/generated/ottplay/full/assets/public"
                    : "android/app/build/generated/ottplay/full/assets/public"
            ),
            path.join(temporary, "public")
        );
    } finally {
        fs.rmSync(temporary, { force: true, recursive: true });
    }
}
if (require.main === module) {
    try {
        auditTarget(
            process.argv[2],
            process.argv[3] || "full",
            Number(process.argv[4] || 24)
        );
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
module.exports = { auditAssets, auditTarget };
