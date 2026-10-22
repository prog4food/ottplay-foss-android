// Modern native-shell runtime. The legacy server assets in js/ and fonts/
// remain untouched; every native stage is independently rebuilt from npm.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { transformPlaySystemIcons } = require("./play-system-icons.cjs");
const { stageMediaRuntime, auditMediaRuntime } = require("./media-runtime.cjs");
const sharedCore = require("./shared-core.cjs");
const root = path.resolve(__dirname, "..");

const LIBRARIES = [
    {
        file: "jquery.min.js",
        license: "LICENSE.txt",
        name: "jquery",
        source: "dist/jquery.min.js",
    },
    { file: "hls.min.js", name: "hls.js", source: "dist/hls.min.js" },
    {
        file: "shaka-player.compiled.js",
        name: "shaka-player",
        source: "dist/shaka-player.compiled.js",
    },
];
const SYSTEM_FONTS = [
    {
        name: "System",
        stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Ubuntu, Cantarell, Arial, sans-serif',
    },
    {
        name: "Sans serif",
        stack: 'Roboto, "Segoe UI", "Helvetica Neue", "Noto Sans", Ubuntu, Cantarell, Arial, sans-serif',
    },
    {
        name: "Condensed",
        stack: '"Roboto Condensed", "Arial Narrow", "Liberation Sans Narrow", "Noto Sans Condensed", sans-serif-condensed, sans-serif',
    },
    {
        name: "Handwritten",
        stack: '"Segoe Print", "Bradley Hand", "Comic Sans MS", Chilanka, cursive',
    },
    {
        name: "Classic sans",
        stack: 'Arial, "Helvetica Neue", "Liberation Sans", "Noto Sans", sans-serif',
    },
    {
        name: "Serif",
        stack: 'Georgia, "Noto Serif", "Times New Roman", "Liberation Serif", serif',
    },
    {
        name: "Narrow",
        stack: '"Arial Narrow", "Roboto Condensed", "Liberation Sans Narrow", sans-serif-condensed, sans-serif',
    },
];
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function visit(directory, fn) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        assert(!entry.isSymbolicLink(), "Native asset symlink: " + file);
        if (entry.isDirectory()) visit(file, fn);
        else fn(file);
    }
}

function stageNativeFonts(directory) {
    // Transform app code before installing vendor code: upstream libraries are
    // never rewritten, even when their parsers contain Unicode-range literals.
    visit(directory, (file) => {
        if (!/\.(js|css|html)$/i.test(file)) return;
        if (path.relative(directory, file).startsWith("js" + path.sep)) return;
        const css = file.endsWith(".css");
        let text = fs.readFileSync(file, "utf8");
        if (css) text = text.replace(/@font-face\s*\{[^}]*\}/gi, "");
        text = transformPlaySystemIcons(text, css);
        // Remove historical commented external-font imports as well.
        if (css) text = text.replace(/\/\*\s*@import[\s\S]*?\*\//g, "");
        fs.writeFileSync(file, text);
    });
    fs.rmSync(path.join(directory, "fonts"), { force: true, recursive: true });
    fs.appendFileSync(
        path.join(directory, "styles/player.css"),
        "\n/* Native shells use only fonts installed by the operating system. */\n" +
            "body { font-family: " +
            SYSTEM_FONTS[0].stack +
            "; }\n" +
            '.system-icons { font-family: "Segoe UI Symbol", "Apple Symbols", "Noto Sans Symbols 2", "Noto Sans Symbols", sans-serif; display: inline-block; min-width: 1em; text-align: center; white-space: nowrap; letter-spacing: normal; }\n'
    );
}

function stageNativeRuntime(directory, platform) {
    // Native shells bundle their UI and must not ship the web-only cache manifest.
    fs.rmSync(path.join(directory, "offline-worker.js"), { force: true });
    assert(
        ["tauri", "capacitor"].includes(platform),
        "Unknown native platform"
    );
    stageNativeFonts(directory);
    const js = path.join(directory, "js");
    fs.rmSync(js, { force: true, recursive: true });
    fs.mkdirSync(js, { recursive: true });
    const licenses = path.join(directory, "licenses/native");
    fs.rmSync(licenses, { force: true, recursive: true });
    fs.mkdirSync(licenses, { recursive: true });
    const lock = JSON.parse(
        fs.readFileSync(path.join(root, "package-lock.json"))
    );
    const components = [];
    for (const lib of LIBRARIES) {
        const base = path.join(root, "node_modules", lib.name);
        const pkg = JSON.parse(
            fs.readFileSync(path.join(base, "package.json"))
        );
        const locked = lock.packages["node_modules/" + lib.name];
        assert.equal(
            pkg.version,
            locked.version,
            "npm install differs from lockfile"
        );
        const bytes = fs.readFileSync(path.join(base, lib.source));
        fs.writeFileSync(path.join(js, lib.file), bytes);
        fs.copyFileSync(
            path.join(base, lib.license || "LICENSE"),
            path.join(licenses, lib.name + "-LICENSE.txt")
        );
        components.push({
            file: "js/" + lib.file,
            integrity: locked.integrity,
            license: pkg.license,
            name: lib.name,
            sha256: sha(bytes),
            version: pkg.version,
        });
    }
    // Preserve all upstream bundled third-party notices, including their paths.
    const thirdParty = path.join(root, "node_modules/shaka-player/third_party");
    visit(thirdParty, (file) => {
        if (
            !/^(?:LICENSE|COPYING|NOTICE|SUMMARY)(?:[._-].*)?$/i.test(
                path.basename(file)
            )
        )
            return;
        const destination = path.join(
            licenses,
            "shaka-third-party",
            path.relative(thirdParty, file)
        );
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(file, destination);
    });
    if (platform === "capacitor") {
        for (const name of ["core", "app"]) {
            fs.copyFileSync(
                path.join(root, "node_modules/@capacitor", name, "LICENSE"),
                path.join(licenses, "capacitor-" + name + "-LICENSE.txt")
            );
        }
    }
    for (const [source, destination] of [
        ["LICENSE", "licenses/project-MIT.txt"],
        ["js/licenses/SJCL-1.0.9.txt", "licenses/SJCL-1.0.9.txt"],
        ["docs/privacy-policy.md", "privacy-policy.txt"],
        ["THIRD-PARTY-NOTICES.md", "third-party-notices.txt"],
    ])
        fs.copyFileSync(
            path.join(root, source),
            path.join(directory, destination)
        );
    if (platform === "tauri")
        fs.copyFileSync(
            path.join(root, "vendor/block-0.1.6-LICENSE.txt"),
            path.join(licenses, "block-0.1.6-LICENSE.txt")
        );
    stageMediaRuntime(directory);
    sharedCore.stage(directory);
    const environment =
        "window.__ottNativeRuntime = true;\n" +
        "window.__ottNativeFontFamilies = " +
        JSON.stringify(SYSTEM_FONTS.map((font) => font.stack)) +
        ";\n" +
        "window.__ottNativeFontOptions = " +
        JSON.stringify(
            SYSTEM_FONTS.map(
                (font) =>
                    '<span style="font-family:' +
                    font.stack.replace(/"/g, "&quot;") +
                    '">' +
                    font.name +
                    "</span>"
            )
        ) +
        ";\n";
    fs.writeFileSync(path.join(js, "native-environment.js"), environment);
    const index = path.join(directory, "index.html");
    const html = fs.readFileSync(index, "utf8");
    const bootstrap =
        /<script src="\/js\/runtime-polyfills\.js(\?v=[a-f0-9]+)"><\/script>/;
    assert(
        bootstrap.test(html),
        "Native entry point has no compatibility bootstrap"
    );
    fs.writeFileSync(
        index,
        html.replace(
            bootstrap,
            '<script src="./js/runtime-polyfills.js$1"></script>\n<script src="./js/native-environment.js"></script>'
        )
    );
    fs.writeFileSync(
        path.join(directory, "native-runtime.json"),
        JSON.stringify(
            {
                components,
                environmentSha256: sha(environment),
                fonts: "system",
                platform,
                schema: 1,
            },
            null,
            2
        )
    );
    auditNativeRuntime(directory);
}

function auditNativeRuntime(directory) {
    auditMediaRuntime(directory);
    sharedCore.checkStaged(directory);
    const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, "native-runtime.json"))
    );
    assert.equal(manifest.fonts, "system");
    assert.equal(manifest.components.length, LIBRARIES.length);
    if (manifest.platform === "tauri")
        assert.equal(
            sha(
                fs.readFileSync(
                    path.join(
                        directory,
                        "licenses/native/block-0.1.6-LICENSE.txt"
                    )
                )
            ),
            sha(
                fs.readFileSync(
                    path.join(root, "vendor/block-0.1.6-LICENSE.txt")
                )
            ),
            "The native Blocks runtime copyright and permission notice must remain intact"
        );
    for (const lib of LIBRARIES) {
        const item = manifest.components.find((item) => item.name === lib.name);
        assert(
            item && item.file === "js/" + lib.file,
            "Missing native library"
        );
        const pkg = JSON.parse(
            fs.readFileSync(
                path.join(root, "node_modules", lib.name, "package.json")
            )
        );
        assert.equal(
            item.version,
            pkg.version,
            "Stale native library: " + lib.name
        );
        assert.equal(
            sha(fs.readFileSync(path.join(directory, item.file))),
            item.sha256
        );
        assert.equal(
            item.sha256,
            sha(
                fs.readFileSync(
                    path.join(root, "node_modules", lib.name, lib.source)
                )
            ),
            "Native vendor bytes changed"
        );
        assert(
            fs.readFileSync(
                path.join(
                    directory,
                    "licenses/native",
                    lib.name + "-LICENSE.txt"
                ),
                "utf8"
            ).length > 500
        );
    }
    assert.equal(
        sha(fs.readFileSync(path.join(directory, "js/native-environment.js"))),
        manifest.environmentSha256
    );
    assert(
        !fs.existsSync(path.join(directory, "fonts")),
        "Bundled fonts in native shell"
    );
    assert(
        !fs.existsSync(path.join(directory, "js/jquery-1.11.1.min.js")),
        "Legacy jQuery in native shell"
    );
    visit(directory, (file) => {
        assert(!/\.(ttf|otf|eot|woff2?)$/i.test(file), "Bundled font: " + file);
        if (file.endsWith(".css")) {
            const text = fs.readFileSync(file, "utf8");
            assert(
                !/@font-face|url\([^)]*\/fonts\//i.test(text),
                "Webfont request in native shell"
            );
        }
    });
    return manifest;
}

// Capacitor adds its bridge files, but every player file must be the exact stage
// that passed audit. Runtime manifests alone do not cover application JS/CSS.
function auditNativeRuntimeCopy(source, destination) {
    source = path.resolve(source);
    destination = path.resolve(destination);
    assert.notEqual(
        fs.realpathSync(source),
        fs.realpathSync(destination),
        "Source and copied runtime are the same directory"
    );
    const expected = auditNativeRuntime(source);
    const actual = auditNativeRuntime(destination);
    assert.equal(
        actual.platform,
        expected.platform,
        "Copied native platform differs"
    );
    let files = 0;
    const expectedFiles = new Set();
    visit(source, (file) => {
        const relative = path.relative(source, file);
        expectedFiles.add(relative);
        const copied = path.join(destination, relative);
        assert(
            fs.existsSync(copied) && fs.lstatSync(copied).isFile(),
            "Missing copied native asset: " + relative
        );
        assert.equal(
            sha(fs.readFileSync(copied)),
            sha(fs.readFileSync(file)),
            "Stale copied native asset: " + relative
        );
        files++;
    });
    visit(destination, (file) => {
        const relative = path.relative(destination, file);
        const generated =
            actual.platform === "capacitor" &&
            ["cordova.js", "cordova_plugins.js"].includes(relative);
        assert(
            expectedFiles.has(relative) || generated,
            "Unexpected copied native asset: " + relative
        );
    });
    return { files, manifest: actual };
}

function auditCli(args) {
    if (args.shift() !== "audit" || !args[0] || args[0].startsWith("--")) {
        throw new Error(
            "Usage: node scripts/native-runtime.cjs audit <directory> [--platform tauri|capacitor] [--source <directory>]"
        );
    }
    const directory = path.resolve(args.shift());
    let platform;
    let source;
    while (args.length) {
        const option = args.shift();
        const value = args.shift();
        if (!value || value.startsWith("--"))
            throw new Error("Missing audit option value");
        if (
            option === "--platform" &&
            !platform &&
            ["tauri", "capacitor"].includes(value)
        )
            platform = value;
        else if (option === "--source" && !source) source = path.resolve(value);
        else throw new Error("Invalid audit option: " + option);
    }
    const result = source
        ? auditNativeRuntimeCopy(source, directory)
        : { manifest: auditNativeRuntime(directory) };
    const manifest = result.manifest;
    if (platform)
        assert.equal(manifest.platform, platform, "Unexpected native platform");
    return {
        components: manifest.components.map(({ name, version, sha256 }) => ({
            name,
            sha256,
            version,
        })),
        directory,
        filesCompared: result.files || null,
        manifestSha256: sha(
            fs.readFileSync(path.join(directory, "native-runtime.json"))
        ),
        platform: manifest.platform,
    };
}

if (require.main === module) {
    try {
        console.log(JSON.stringify(auditCli(process.argv.slice(2)), null, 2));
    } catch (error) {
        console.error("Native runtime audit failed: " + error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    auditCli,
    auditNativeRuntime,
    auditNativeRuntimeCopy,
    LIBRARIES,
    SYSTEM_FONTS,
    stageNativeFonts,
    stageNativeRuntime,
};
