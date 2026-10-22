/* Exercise the actual Vite staging functions without rebuilding the player. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { CLASSIC_PROVIDER_BUNDLES } = require("../scripts/classic-bundle.cjs");

const configPath = path.resolve(__dirname, "../vite.config.ts");
const text = fs.readFileSync(configPath, "utf8");
const config = ts.createSourceFile(
    configPath,
    text,
    ts.ScriptTarget.Latest,
    true
);
const names = new Set([
    "privateAssetDirectories",
    "copyRuntimeAssets",
    "stagePlayerAssets",
    "autoPlaybackScript",
    "stageTauriFrontend",
    "removeDuplicatePlayerAssets",
]);
const selected = config.statements.filter((node) => {
    if (ts.isFunctionDeclaration(node)) return names.has(node.name?.text);
    return (
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((item) =>
            names.has(item.name.text)
        )
    );
});
assert.equal(selected.length, names.size, "Vite staging implementation moved");
const code = ts.transpileModule(
    selected.map((node) => node.getText(config)).join("\n"),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;
// This suite isolates copying/privacy filters; actual native modernization and
// byte/typography gates are exercised in test_native_runtime.cjs.
const context = vm.createContext({
    ...fs,
    ...path,
    CLASSIC_PROVIDER_BUNDLES,
    console: { log() {} },
    isRetiredRuntimeScript: require("../scripts/runtime-assets.cjs")
        .isRetiredRuntimeScript,
    stageNativeRuntime() {},
});
vm.runInContext(code, context);
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-staging-test-"));
function write(name, data = name) {
    const file = path.join(fixture, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
}
function exists(name) {
    return fs.existsSync(path.join(fixture, name));
}
try {
    const demoFiles = [
        "pattern.mp4",
        "pattern.m3u8",
        ...Array.from({ length: 12 }, (_, i) => `pattern${i}.ts`),
    ];
    for (const name of demoFiles) write("src/demo/" + name);
    write("src/demo/private-recording.mp4");
    write("src/demo/debug.ts");
    write("src/demo/logs/private.json");
    for (const name of [
        "src/devices/lg/webos/device.js",
        "src/devices/legacy-core.js",
        "src/devices/tizen/config.json",
        "src/devices/logs/pre_tool_use.json",
        "src/devices/lg/.private/file.json",
        "src/devices/lg/node_modules/dependency.js",
        "src/devices/lg/build/source.js",
        "src/devices/lg/.env",
        "src/devices/lg/private.key",
        "src/fonts/player.woff2",
        "src/fonts/logs/debug.json",
        "src/providers/provider.js",
        "src/providers/about.html",
        "src/providers/fetch-provider-descriptions.sh",
        "src/providers/.hidden.json",
        "src/styles/player.css",
        "src/locales/english.js",
        "src/locales/russian.js",
        "src/images/player-logo.png",
        "src/images/mute.png",
        "src/images/beta.png",
        "src/images/blue_short.png",
        "src/images/no_image.png",
        "src/images/future-unused-art.png",
        "src/images/logo.png",
        "src/images/debug.js",
        "src/images/logs/private.json",
        "src/images/.hidden.png",
        "src/js/hls.min.js",
        "src/js/jquery-1.11.1.min.js",
        "src/js/shaka-player.compiled.js",
        "src/js/browser-app/manifest.webmanifest",
        "src/js/browser-app/index.webmanifest",
        "src/js/browser-app/pc.webmanifest",
        "src/js/browser-app/pc-plain.webmanifest",
        "src/js/browser-app/icon-512.png",
        "src/favicon.ico",
        "src/src-tauri/pip/pip.html",
        "src/src-tauri/pip/pip-player.js",
        "dist/index.html",
        "dist/player.js",
        "dist/hosted/epg-worker.js",
        "dist/hosted/pako-LICENSE",
        "dist/hosted/sax-LICENSE",
        "dist/swop-input/index.html",
        "dist/swop-input/app.js",
        "dist/swop-input/locales/rus-fixture.json",
        "dist/diagnostics/av-v1.mp4",
        "dist/diagnostics/private-recording.mp4",
        "stage/diagnostics/av-v1.mp4",
        "stage/devices/logs/previous-build.json",
    ])
        write(name);
    for (const kind of Object.keys(CLASSIC_PROVIDER_BUNDLES)) {
        write("dist/provider-" + kind + ".js", "provider " + kind);
    }
    write(
        "src/build/core/auto-playback.js",
        "export function watchAutoNativePlayback() { return 'same shared helper'; }\n"
    );
    context.stageTauriFrontend(
        path.join(fixture, "src"),
        path.join(fixture, "dist"),
        path.join(fixture, "stage")
    );
    for (const name of [
        "devices/lg/webos/device.js",
        "devices/tizen/config.json",
        "fonts/player.woff2",
        "providers/provider.js",
        "providers/about.html",
        "styles/player.css",
        "locales/english.js",
        "locales/russian.js",
        "images/player-logo.png",
        "js/hls.min.js",
        "js/jquery-1.11.1.min.js",
        "js/shaka-player.compiled.js",
        "favicon.ico",
    ]) {
        assert.equal(
            fs.readFileSync(path.join(fixture, "stage", name), "utf8"),
            fs.readFileSync(path.join(fixture, "src", name), "utf8"),
            name
        );
    }
    for (const name of [
        "hosted/epg-worker.js",
        "hosted/pako-LICENSE",
        "hosted/sax-LICENSE",
        "swop-input/index.html",
        "swop-input/app.js",
        "swop-input/locales/rus-fixture.json",
    ]) {
        assert.equal(
            fs.readFileSync(path.join(fixture, "stage", name), "utf8"),
            fs.readFileSync(path.join(fixture, "dist", name), "utf8"),
            "Hosted assets come from the checked build: " + name
        );
    }
    for (const name of ["pip.html", "pip-player.js"]) {
        assert.equal(
            fs.readFileSync(path.join(fixture, "stage", name), "utf8"),
            fs.readFileSync(
                path.join(fixture, "src/src-tauri/pip", name),
                "utf8"
            ),
            "PiP runtime asset must be embedded: " + name
        );
    }
    assert.equal(
        fs.readFileSync(path.join(fixture, "stage/auto-playback.js"), "utf8"),
        "function watchAutoNativePlayback() { return 'same shared helper'; }\n",
        "PiP loads the compiled shared watchdog as a classic script"
    );
    assert.equal(
        exists("stage/demo"),
        false,
        "Remote demo media must not enter native bundles"
    );
    for (const name of [
        "devices/legacy-core.js",
        "diagnostics",
        "diagnostics/private-recording.mp4",
        "devices/logs",
        "devices/lg/.private",
        "devices/lg/node_modules",
        "devices/lg/build",
        "devices/lg/.env",
        "devices/lg/private.key",
        "fonts/logs",
        "providers/fetch-provider-descriptions.sh",
        "providers/.hidden.json",
        "images/.hidden.png",
        "images/mute.png",
        "images/beta.png",
        "images/blue_short.png",
        "images/no_image.png",
        "images/future-unused-art.png",
        "images/logo.png",
        "images/debug.js",
        "images/logs",
        "js/browser-app",
    ])
        assert.equal(exists(`stage/${name}`), false, name);
    assert.equal(exists("src/devices/logs/pre_tool_use.json"), true);
    assert.equal(
        fs.readFileSync(path.join(fixture, "stage/index.html"), "utf8"),
        "dist/index.html"
    );
    assert.equal(
        fs.readFileSync(path.join(fixture, "stage/dist/player.js"), "utf8"),
        "dist/player.js"
    );
    for (const kind of Object.keys(CLASSIC_PROVIDER_BUNDLES)) {
        const file = "provider-" + kind + ".js";
        assert.equal(
            fs.readFileSync(path.join(fixture, "stage/dist", file), "utf8"),
            "provider " + kind
        );
        assert.equal(
            exists("stage/" + file),
            false,
            "Native root must not duplicate provider chunks"
        );
    }

    const scripts = [
        "player.js",
        ...Object.keys(CLASSIC_PROVIDER_BUNDLES).map(
            (kind) => "provider-" + kind + ".js"
        ),
    ];
    for (const file of scripts) {
        write("mobile/" + file, "same " + file);
        write("mobile/dist/" + file, "same " + file);
    }
    write("mobile/index.html", "boot");
    context.removeDuplicatePlayerAssets(path.join(fixture, "mobile"));
    for (const file of scripts) {
        assert.equal(
            exists("mobile/" + file),
            false,
            "Unused flat native script: " + file
        );
        assert.equal(
            fs.readFileSync(path.join(fixture, "mobile/dist", file), "utf8"),
            "same " + file
        );
    }
    assert.equal(exists("mobile/index.html"), true);
    write("broken/player.js", "first");
    write("broken/dist/player.js", "second");
    assert.throws(
        () => context.removeDuplicatePlayerAssets(path.join(fixture, "broken")),
        /Mismatched native player copies/
    );
    assert.equal(exists("broken/player.js"), true);

    // Capacitor retains its dist root between builds; copying a tree must
    // remove already staged private/stale files, not merely filter new copies.
    write("cap/devices/logs/old.json");
    write("cap/devices/removed-adapter.js");
    context.copyRuntimeAssets(
        path.join(fixture, "src/devices"),
        path.join(fixture, "cap/devices")
    );
    assert.equal(exists("cap/devices/logs"), false);
    assert.equal(exists("cap/devices/removed-adapter.js"), false);
    assert.equal(exists("cap/devices/lg/webos/device.js"), true);

    // Browser installations need the complete manifest tree in production;
    // native distributions must also retire browser artwork from old output.
    context.copyRuntimeAssets(
        path.join(fixture, "src/js"),
        path.join(fixture, "browser/js")
    );
    for (const name of [
        "manifest.webmanifest",
        "index.webmanifest",
        "pc.webmanifest",
        "pc-plain.webmanifest",
        "icon-512.png",
    ])
        assert.equal(
            fs.readFileSync(
                path.join(fixture, "browser/js/browser-app", name),
                "utf8"
            ),
            fs.readFileSync(
                path.join(fixture, "src/js/browser-app", name),
                "utf8"
            ),
            "Browser installation asset: " + name
        );
    context.copyRuntimeAssets(
        path.join(fixture, "src/js"),
        path.join(fixture, "browser/js"),
        false
    );
    assert.equal(
        exists("browser/js/browser-app"),
        false,
        "Native staging removes browser manifests and inherited icon artwork"
    );
    assert.equal(exists("browser/js/hls.min.js"), true);
    assert.equal(exists("src/js/browser-app/icon-512.png"), true);

    // A persistent Capacitor output can contain old permitted-looking files as
    // well as old artwork. Restage real files; do not merely skip future copies.
    write("cap/images/player-logo.png", "stale icon");
    write("cap/styles/player.css", "stale CSS");
    write("cap/locales/removed.js", "stale locale");
    write("cap/images/mute.png", "old unused art");
    write("cap/images/future-unused-art.png", "old unknown art");
    write("cap/images/logs/previous.json");
    write("cap/images/.private/previous.json");
    write("cap/styles/private.css", "stale stylesheet");
    write("cap/locales/logs/previous.json");
    write("cap/keep-unrelated.txt", "unrelated output");
    context.stagePlayerAssets(
        path.join(fixture, "src"),
        path.join(fixture, "cap")
    );
    for (const directory of ["styles", "images", "locales"])
        assert.deepEqual(
            fs.readdirSync(path.join(fixture, "cap", directory)).sort(),
            fs.readdirSync(path.join(fixture, "stage", directory)).sort(),
            "Capacitor and full Tauri staging produce the same " + directory
        );
    for (const name of [
        "images/player-logo.png",
        "styles/player.css",
        "locales/english.js",
        "locales/russian.js",
    ])
        assert.equal(
            fs.readFileSync(path.join(fixture, "cap", name), "utf8"),
            fs.readFileSync(path.join(fixture, "src", name), "utf8"),
            "fresh player runtime bytes: " + name
        );
    for (const name of [
        "locales/removed.js",
        "locales/logs",
        "styles/private.css",
        "images/mute.png",
        "images/future-unused-art.png",
        "images/logs",
        "images/.private",
    ])
        assert.equal(exists("cap/" + name), false, "retired output: " + name);
    assert.equal(exists("cap/keep-unrelated.txt"), true);

    // Switching a previously staged Full directory to Play must retire the
    // startup image even while it remains available in the source tree.
    context.stagePlayerAssets(
        path.join(fixture, "src"),
        path.join(fixture, "cap"),
        "play"
    );
    assert.equal(
        exists("cap/images/player-logo.png"),
        false,
        "Play removes the stale Full startup image"
    );
    assert.equal(
        exists("src/images/player-logo.png"),
        true,
        "Play staging preserves the Full source image"
    );
    assert.deepEqual(
        exists("cap/images")
            ? fs.readdirSync(path.join(fixture, "cap/images"))
            : [],
        [],
        "Play stages no startup artwork"
    );
    for (const name of [
        "styles/player.css",
        "locales/english.js",
        "locales/russian.js",
    ])
        assert.equal(
            fs.readFileSync(path.join(fixture, "cap", name), "utf8"),
            fs.readFileSync(path.join(fixture, "stage", name), "utf8"),
            "Play keeps required CSS and locale bytes: " + name
        );

    // Locales are discovered from current inputs, not a hard-coded language
    // list. Removing a previously staged locale must remove it from the output.
    fs.unlinkSync(path.join(fixture, "src/locales/russian.js"));
    write("src/locales/testlanguage.js", "new locale bytes");
    write("src/locales/Uppercase.js", "invalid locale name");
    write("src/locales/_legacy.js", "old locale name");
    context.stagePlayerAssets(
        path.join(fixture, "src"),
        path.join(fixture, "cap")
    );
    assert.equal(exists("cap/locales/russian.js"), false);
    assert.equal(exists("cap/locales/Uppercase.js"), false);
    assert.equal(exists("cap/locales/_legacy.js"), false);
    assert.equal(
        fs.readFileSync(
            path.join(fixture, "cap/locales/testlanguage.js"),
            "utf8"
        ),
        "new locale bytes"
    );
    assert.equal(
        exists("src/images/future-unused-art.png"),
        true,
        "staging leaves source artwork intact"
    );

    // A similarly named image and a previous output logo cannot substitute for
    // the actual startup logo. Missing required input must stop packaging.
    write("missing-icon/styles/player.css");
    write("missing-icon/locales/english.js");
    write("missing-icon/images/logo.png");
    write(
        "missing-icon-output/images/player-logo.png",
        "previous successful build"
    );
    assert.throws(
        () =>
            context.stagePlayerAssets(
                path.join(fixture, "missing-icon"),
                path.join(fixture, "missing-icon-output")
            ),
        /Missing player runtime asset: images\/player-logo\.png/
    );
    assert.equal(exists("missing-icon-output/images/player-logo.png"), false);
    assert.equal(exists("missing-icon-output/images/logo.png"), false);

    // The same source that is invalid for Full is sufficient for Play: its
    // startup does not request an icon. Old output must not supply a hidden one.
    write("missing-icon-play/images/player-logo.png", "stale Full image");
    context.stagePlayerAssets(
        path.join(fixture, "missing-icon"),
        path.join(fixture, "missing-icon-play"),
        "play"
    );
    assert.equal(exists("missing-icon-play/images/player-logo.png"), false);
    assert.equal(exists("missing-icon-play/images/logo.png"), false);
    assert.equal(
        fs.readFileSync(
            path.join(fixture, "missing-icon-play/styles/player.css"),
            "utf8"
        ),
        "missing-icon/styles/player.css"
    );
    assert.equal(
        fs.readFileSync(
            path.join(fixture, "missing-icon-play/locales/english.js"),
            "utf8"
        ),
        "missing-icon/locales/english.js"
    );
    write("missing-css/locales/english.js");
    assert.throws(
        () =>
            context.stagePlayerAssets(
                path.join(fixture, "missing-css"),
                path.join(fixture, "missing-css-play"),
                "play"
            ),
        /Missing player runtime asset: styles\/player\.css/
    );

    // Both required assets and discovered locales must still pass through the
    // shared symlink guard instead of exposing a file outside the asset tree.
    write("outside-player.js", "private fixture");
    for (const linkedAsset of [
        "images/player-logo.png",
        "locales/external.js",
    ]) {
        const source = "player-link-" + path.basename(linkedAsset);
        write(source + "/styles/player.css");
        write(source + "/locales/english.js");
        if (linkedAsset !== "images/player-logo.png")
            write(source + "/images/player-logo.png");
        fs.mkdirSync(path.dirname(path.join(fixture, source, linkedAsset)), {
            recursive: true,
        });
        fs.symlinkSync(
            path.join(fixture, "outside-player.js"),
            path.join(fixture, source, linkedAsset)
        );
        assert.throws(
            () =>
                context.stagePlayerAssets(
                    path.join(fixture, source),
                    path.join(fixture, source + "-output")
                ),
            /must not be a symlink/
        );
        assert.equal(exists(source + "-output/" + linkedAsset), false);
    }

    write("outside.json", "private fixture");
    fs.symlinkSync(
        path.join(fixture, "outside.json"),
        path.join(fixture, "src/devices/public.json")
    );
    assert.throws(
        () =>
            context.copyRuntimeAssets(
                path.join(fixture, "src/devices"),
                path.join(fixture, "rejected")
            ),
        /must not be a symlink/
    );
    assert.equal(exists("rejected/public.json"), false);
    console.log(
        "Frontend staging: Full icon required, Play icon retired; browser manifests preserved and native browser artwork excluded; CSS/locales preserved; unused/private/stale assets excluded; required assets and symlinks guarded"
    );
} finally {
    fs.rmSync(fixture, { force: true, recursive: true });
}
