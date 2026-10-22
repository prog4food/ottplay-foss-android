// Reproducible ES5 media assets shared by browser, native shell and Web Worker.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("acorn");
const root = path.resolve(__dirname, "..");
const assets = [
    "runtime-polyfills.js",
    "hls.min.js",
    "hls.worker.js",
    "video.min.js",
];
const mediaLicenses = [
    "core-js",
    "hls.js",
    "video.js",
    "@videojs/http-streaming",
];
const licenseName = (name) => name.replace("/", "-") + "-LICENSE.txt";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const read = (file) => fs.readFileSync(path.join(root, file));
const manifestPath = "js/media-runtime.json";
const bootstrapTag =
    /(<script src="(?:\.\/|\/)js\/runtime-polyfills\.js)(?:\?v=[a-f0-9]+)?("[^>]*><\/script>)/;

function workerBootstrap(version) {
    // Classic importScripts is synchronous and resolves against the worker's
    // own URL. Do not require URL, Promise or any other not-yet-patched API.
    // A stale/blocked runtime must fail before upstream registers its handler.
    return (
        "/*! OTT-play ES5 worker bootstrap; shared runtime and licenses in js/. */\n" +
        "importScripts(" +
        JSON.stringify("./runtime-polyfills.js?v=" + version) +
        ");\n" +
        "if (self.__ottRuntimePolyfillsReady !== true || self.__ottMediaRuntimeVersion !== " +
        JSON.stringify(version) +
        ') { throw new Error("OTT-play worker runtime mismatch"); }\n' +
        "/* Upstream hls.js worker follows unchanged. */\n"
    );
}

function stampBootstrap(file, version) {
    const html = fs.readFileSync(file, "utf8");
    assert(
        bootstrapTag.test(html),
        "Missing blocking runtime bootstrap: " + file
    );
    fs.writeFileSync(
        file,
        html.replace(bootstrapTag, "$1?v=" + version + "$2")
    );
}

function lockInputsDigest(lock) {
    const value = JSON.parse(JSON.stringify(lock));
    // Release sync changes the application identity, not the media inputs.
    // Preserve field presence and all dependency/root metadata in the key.
    if (Object.prototype.hasOwnProperty.call(value, "version"))
        value.version = "";
    if (
        value.packages &&
        value.packages[""] &&
        Object.prototype.hasOwnProperty.call(value.packages[""], "version")
    )
        value.packages[""].version = "";
    function canonical(item) {
        if (Array.isArray(item))
            return "[" + item.map(canonical).join(",") + "]";
        if (item && typeof item === "object")
            return (
                "{" +
                Object.keys(item)
                    .sort()
                    .map(
                        (key) =>
                            JSON.stringify(key) + ":" + canonical(item[key])
                    )
                    .join(",") +
                "}"
            );
        return JSON.stringify(item);
    }
    return sha(canonical(value));
}

function inputs() {
    const lock = JSON.parse(read("package-lock.json"));
    const packages = {};
    for (const name of [
        "core-js",
        "hls.js",
        "video.js",
        "@videojs/http-streaming",
        "typescript",
        "rollup",
        "terser",
        "@rollup/plugin-commonjs",
        "@rollup/plugin-node-resolve",
    ]) {
        const installed = JSON.parse(
            read("node_modules/" + name + "/package.json")
        );
        const pinned = lock.packages["node_modules/" + name];
        assert.equal(installed.version, pinned.version, "Run npm ci: " + name);
        packages[name] = {
            integrity: pinned.integrity,
            version: installed.version,
        };
    }
    return {
        builderSha256: sha(read("scripts/media-runtime.cjs")),
        lockInputsSha256: lockInputsDigest(lock),
        packages,
        webPolyfillsSha256: sha(read("src/polyfills/runtime.ts")),
    };
}

async function buildMediaRuntime() {
    const { rollup } = require("rollup");
    const commonjs = require("@rollup/plugin-commonjs");
    const { nodeResolve } = require("@rollup/plugin-node-resolve");
    const { minify } = require("terser");
    const ts = require("typescript");
    const source = inputs();
    const runtimeVersion = sha(JSON.stringify(source)).slice(0, 16);
    const bundle = await rollup({
        input: path.join(root, "node_modules/core-js/stable/index.js"),
        onwarn(warning, warn) {
            if (warning.code !== "CIRCULAR_DEPENDENCY") warn(warning);
        },
        plugins: [nodeResolve(), commonjs()],
    });
    let language;
    try {
        const result = await bundle.generate({
            format: "iife",
            generatedCode: "es5",
            name: "OttLanguageRuntime",
        });
        language = result.output[0].code;
    } finally {
        await bundle.close();
    }
    // Keep the installer globally available to the classic application bundle.
    // It also runs without window/document inside the standalone worker.
    const web = ts.transpileModule(
        read("src/polyfills/runtime.ts")
            .toString()
            .replace(/^export\s+/gm, ""),
        {
            compilerOptions: {
                module: ts.ModuleKind.None,
                target: ts.ScriptTarget.ES5,
            },
        }
    ).outputText;
    // Some old WebKit builds expose only a blob URL namespace. A standards URL
    // constructor may replace it, but the native blob methods must survive.
    const realm =
        '(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : globalThis)';
    const preserveBlob =
        "(function (g) { var original = g.URL, prefixed = g.webkitURL;\n" +
        language +
        '\n["createObjectURL", "revokeObjectURL"].forEach(function (key) {\n' +
        'var owner = original && typeof original[key] === "function" ? original : prefixed;\n' +
        'if (g.URL && typeof g.URL[key] !== "function" && owner && typeof owner[key] === "function") {\n' +
        "g.URL[key] = function () { return owner[key].apply(owner, arguments); }; } });\n})(" +
        realm +
        ");\n";
    const ready =
        "\n" +
        realm +
        ".__ottMediaRuntimeVersion = " +
        JSON.stringify(runtimeVersion) +
        ";\n" +
        realm +
        ".__ottRuntimePolyfillsReady = true;\n";
    const minified = await minify(preserveBlob + "\n" + web + ready, {
        compress: { passes: 2 },
        ecma: 5,
        format: { comments: false },
        mangle: { reserved: ["applyWebRuntimePolyfills"] },
    });
    const header =
        "/*! OTT-play ES5 runtime: core-js " +
        source.packages["core-js"].version +
        " (MIT) and project web API shims. See js/licenses/. Generated by scripts/media-runtime.cjs. */\n";
    const runtime = header + minified.code + "\n";
    const hls = read("node_modules/hls.js/dist/hls.min.js");
    const worker =
        workerBootstrap(runtimeVersion) +
        read("node_modules/hls.js/dist/hls.worker.js").toString();
    const outputs = {
        "hls.min.js": hls,
        "hls.worker.js": worker,
        "runtime-polyfills.js": runtime,
        // The official v7 UMD includes the pinned VHS 2.x build, exactly once.
        "video.min.js": read("node_modules/video.js/dist/video.min.js"),
    };
    const hashes = {};
    for (const [file, bytes] of Object.entries(outputs)) {
        parse(bytes.toString(), { ecmaVersion: 5, sourceType: "script" });
        fs.writeFileSync(path.join(root, "js", file), bytes);
        hashes[file] = sha(bytes);
    }
    const licenses = path.join(root, "js/licenses");
    fs.mkdirSync(licenses, { recursive: true });
    for (const name of mediaLicenses)
        fs.copyFileSync(
            path.join(root, "node_modules", name, "LICENSE"),
            path.join(licenses, licenseName(name))
        );
    fs.copyFileSync(
        path.join(root, "LICENSE"),
        path.join(licenses, "project-LICENSE.txt")
    );
    fs.copyFileSync(
        path.join(root, "licenses/android/Apache-2.0.txt"),
        path.join(licenses, "Apache-2.0.txt")
    );
    fs.writeFileSync(
        path.join(root, manifestPath),
        JSON.stringify(
            { schema: 2, ...source, assets: hashes, runtimeVersion },
            null,
            2
        ) + "\n"
    );
    stampBootstrap(path.join(root, "index.html"), runtimeVersion);
    stampBootstrap(path.join(root, "src-tauri/pip/pip.html"), runtimeVersion);
    auditMediaRuntime(root);
    console.log(
        "Built shared ES5 runtime and hls.js " +
            source.packages["hls.js"].version +
            " (page and worker)"
    );
}

function auditMediaRuntime(directory = root) {
    const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, manifestPath))
    );
    assert.equal(manifest.schema, 2);
    const expected = inputs();
    assert.equal(
        manifest.runtimeVersion,
        sha(JSON.stringify(expected)).slice(0, 16),
        "Stale media URL version"
    );
    for (const key of Object.keys(expected))
        assert.deepEqual(
            manifest[key],
            expected[key],
            "Stale media runtime inputs: " + key + "; run npm run build:media"
        );
    for (const file of assets) {
        const bytes = fs.readFileSync(path.join(directory, "js", file));
        assert.equal(
            sha(bytes),
            manifest.assets[file],
            "Stale media runtime asset: " + file
        );
        parse(bytes.toString(), { ecmaVersion: 5, sourceType: "script" });
    }
    assert.equal(
        manifest.assets["hls.min.js"],
        sha(read("node_modules/hls.js/dist/hls.min.js")),
        "Modified upstream hls.js"
    );
    assert.equal(
        manifest.assets["video.min.js"],
        sha(read("node_modules/video.js/dist/video.min.js")),
        "Modified upstream Video.js/VHS"
    );
    assert.equal(
        JSON.parse(read("node_modules/video.js/package.json")).dependencies[
            "@videojs/http-streaming"
        ],
        expected.packages["@videojs/http-streaming"].version,
        "Video.js must bundle the pinned VHS version"
    );
    const worker = Buffer.concat([
        Buffer.from(workerBootstrap(manifest.runtimeVersion)),
        read("node_modules/hls.js/dist/hls.worker.js"),
    ]);
    assert.equal(
        manifest.assets["hls.worker.js"],
        sha(worker),
        "Worker must synchronously import and verify the exact runtime before unchanged upstream code"
    );
    for (const name of mediaLicenses)
        assert(
            fs
                .readFileSync(
                    path.join(directory, "js/licenses", licenseName(name))
                )
                .equals(read("node_modules/" + name + "/LICENSE")),
            "Missing media license: " + name
        );
    assert(
        fs
            .readFileSync(
                path.join(directory, "js/licenses/project-LICENSE.txt")
            )
            .equals(read("LICENSE")),
        "Missing web shim license"
    );
    assert(
        fs
            .readFileSync(path.join(directory, "js/licenses/Apache-2.0.txt"))
            .equals(read("licenses/android/Apache-2.0.txt")),
        "Missing Apache license text"
    );
    for (const file of ["index.html", "pip.html", "src-tauri/pip/pip.html"]) {
        const htmlPath = path.join(directory, file);
        if (!fs.existsSync(htmlPath)) continue;
        const html = fs.readFileSync(htmlPath, "utf8");
        assert(
            html.includes(
                "js/runtime-polyfills.js?v=" + manifest.runtimeVersion + '"'
            ),
            "Stale bootstrap URL: " + file
        );
    }
    return manifest;
}

function stageMediaRuntime(directory) {
    auditMediaRuntime(root);
    fs.mkdirSync(path.join(directory, "js"), { recursive: true });
    for (const file of [...assets, "media-runtime.json"])
        fs.copyFileSync(
            path.join(root, "js", file),
            path.join(directory, "js", file)
        );
    fs.cpSync(
        path.join(root, "js/licenses"),
        path.join(directory, "js/licenses"),
        { recursive: true }
    );
    const manifest = JSON.parse(read(manifestPath));
    for (const file of ["index.html", "pip.html"]) {
        const html = path.join(directory, file);
        if (fs.existsSync(html)) stampBootstrap(html, manifest.runtimeVersion);
    }
    auditMediaRuntime(directory);
}

module.exports = {
    auditMediaRuntime,
    buildMediaRuntime,
    lockInputsDigest,
    stageMediaRuntime,
};
if (require.main === module) {
    if (process.argv[2] === "build")
        buildMediaRuntime().catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
    else if (process.argv[2] === "check") {
        auditMediaRuntime();
        console.log("Media runtime inputs, ES5, worker and licenses verified");
    } else throw new Error("Usage: node scripts/media-runtime.cjs build|check");
}
