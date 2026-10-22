#!/usr/bin/env node
// Package the current classic web build for deployment on non-development PCs/STBs.
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stageOfflineShell } = require("./offline-shell.cjs");
const { CLASSIC_PROVIDER_BUNDLES } = require("./classic-bundle.cjs");

const root = path.resolve(__dirname, "..");
// Keep deployable archives outside Capacitor's dist/ web root.
const packages = path.join(root, "build", "packages");
const archiveName = "ottplay-foss-modea.tar.gz";
const archivePath = path.join(packages, archiveName);
const checksumPath = path.join(packages, "ottplay-foss-modea.sha256");

function requirePath(relativePath, directory) {
    const source = path.join(root, relativePath);
    if (!fs.existsSync(source)) {
        throw new Error(
            "Missing " +
                relativePath +
                "; run the production build before packaging."
        );
    }
    const stat = fs.statSync(source);
    if (directory ? !stat.isDirectory() : !stat.isFile()) {
        throw new Error("Unexpected file type: " + relativePath);
    }
    return source;
}

function sha256(file) {
    return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function revision() {
    // Workflow events can refer to a different ref than the actual checkout.
    // Describe the packaged source; an event SHA is not a source fallback.
    try {
        return (
            execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: root,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
            }).trim() || "unknown"
        );
    } catch (_) {
        return "unknown";
    }
}

let staging;
try {
    const index = requirePath("dist/index.html", false);
    const bundle = requirePath("dist/player.js", false);
    const providerBundles = Object.keys(CLASSIC_PROVIDER_BUNDLES).map(
        (kind) => {
            const file = "provider-" + kind + ".js";
            return { file, kind, source: requirePath("dist/" + file, false) };
        }
    );
    const assets = [
        "favicon.ico",
        "fonts",
        "js",
        "devices",
        "styles",
        "images",
        "locales",
        "providers",
        "hosted",
        "swop-input",
    ];
    const sources = assets.map((name) =>
        requirePath("dist/" + name, name !== "favicon.ico")
    );
    for (const file of [
        "hosted/epg-worker.js",
        "hosted/pako-inflate.js",
        "hosted/sax.js",
        "swop-input/index.html",
        "swop-input/app.js",
    ])
        requirePath("dist/" + file, false);
    // Require built installation assets; a stale dist must not silently package
    // an installable entry point without its metadata, icon or window layout.
    for (const file of [
        "manifest.webmanifest",
        "index.webmanifest",
        "pc.webmanifest",
        "pc-plain.webmanifest",
        "icon-512.png",
        "window-controls.js",
        "window-controls.css",
    ])
        requirePath("dist/js/browser-app/" + file, false);
    const pkg = JSON.parse(
        fs.readFileSync(path.join(root, "package.json"), "utf8")
    );
    staging = fs.mkdtempSync(path.join(os.tmpdir(), "ottplay-modea-"));
    const webRoot = path.join(staging, "web");
    fs.mkdirSync(path.join(webRoot, "dist"), { recursive: true });
    fs.copyFileSync(index, path.join(webRoot, "index.html"));
    fs.copyFileSync(bundle, path.join(webRoot, "dist", "player.js"));
    const providerMetadata = {};
    providerBundles.forEach(({ file, kind, source }) => {
        const relative = "dist/" + file;
        const staged = path.join(webRoot, relative);
        fs.copyFileSync(source, staged);
        providerMetadata[kind] = {
            bytes: fs.statSync(staged).size,
            file: relative,
            sha256: sha256(staged),
        };
    });
    assets.forEach((name, i) => {
        fs.cpSync(sources[i], path.join(webRoot, name), {
            preserveTimestamps: true,
            recursive: true,
        });
    });
    stageOfflineShell(webRoot);
    const metadata = {
        bundleSha256: sha256(path.join(webRoot, "dist", "player.js")),
        providerBundles: providerMetadata,
        revision: revision(),
        version: pkg.version,
    };
    fs.writeFileSync(
        path.join(webRoot, "build-info.json"),
        JSON.stringify(metadata, null, 2) + "\n"
    );

    // Tar only the fresh web root: no Capacitor nested output, server, or native binaries.
    const stagedArchive = path.join(staging, archiveName);
    execFileSync("tar", ["-czf", stagedArchive, "-C", webRoot, "."], {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stdio: "inherit",
    });
    fs.mkdirSync(packages, { recursive: true });
    fs.copyFileSync(stagedArchive, archivePath);
    fs.writeFileSync(
        checksumPath,
        sha256(stagedArchive) + "  " + archiveName + "\n"
    );
    console.log("Packaged " + archivePath);
    console.log("SHA256 " + checksumPath);
} catch (error) {
    console.error("Mode A packaging failed: " + error.message);
    process.exitCode = 1;
} finally {
    if (staging) fs.rmSync(staging, { force: true, recursive: true });
}
