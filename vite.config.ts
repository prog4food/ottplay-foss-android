import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, execSync } from "child_process";
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Load the helper from its own CommonJS module so Vite's config bundler does
// not rewrite its TypeScript dependency into a file-URL require.
const classicRequire = createRequire(import.meta.url);
const { ensureMediaRuntime } = classicRequire(
    resolve(__dirname, "scripts/media-runtime-cache.cjs")
);
const { optimizeClassic } = classicRequire(
    resolve(__dirname, "scripts/classic-optimizer.cjs")
);
const { CLASSIC_PLAYER_NAME_POLICY } = classicRequire(
    resolve(__dirname, "scripts/classic-function-names.cjs")
);
const { inspectBundleSets, measureBundle, writeBundleReport } = classicRequire(
    resolve(__dirname, "scripts/classic-size.cjs")
);
const { stageNativeRuntime } = classicRequire(
    resolve(__dirname, "scripts/native-runtime.cjs")
);
const { stage: stageHostedEpg } = classicRequire(
    resolve(__dirname, "scripts/hosted-epg.cjs")
);
const { stageOfflineShell } = classicRequire(
    resolve(__dirname, "scripts/offline-shell.cjs")
);
const { stageHostedSwop } = classicRequire(
    resolve(__dirname, "scripts/hosted-swop.cjs")
);
const { configureNativeDev } = classicRequire(
    resolve(__dirname, "scripts/native-dev.cjs")
);
const { embedPlayerBuildIdentity } = classicRequire(
    resolve(__dirname, "scripts/player-build-identity.cjs")
);
const { assembleClassic, CLASSIC_MAIN_MODULES, CLASSIC_PROVIDER_BUNDLES } =
    classicRequire(resolve(__dirname, "scripts/classic-bundle.cjs"));
const { isRetiredRuntimeScript } = classicRequire(
    resolve(__dirname, "scripts/runtime-assets.cjs")
);
// Verify and stage the pinned compiler output before any build/dev staging.
classicRequire(resolve(__dirname, "scripts/shared-core.cjs")).stage();
const androidFlavor = process.env.OTTPLAY_ANDROID_FLAVOR;
if (androidFlavor && androidFlavor !== "full" && androidFlavor !== "play") {
    throw new Error("Unknown Android distribution: " + androidFlavor);
}
const androidOutput = process.env.OTTPLAY_ANDROID_OUTPUT;
const androidCompileRoot = process.env.OTTPLAY_ANDROID_COMPILE_ROOT;
if (androidFlavor && (!androidOutput || !androidCompileRoot)) {
    throw new Error(
        "Legacy Android frontend staging requires explicit output and compile roots; APK/AAB builds moved to open-ott-play/ottplay-android"
    );
}
const { prepareDistributionModules, stagePlayProviders } = classicRequire(
    resolve(__dirname, "scripts/android-distribution.cjs")
);

const privateAssetDirectories = new Set([
    "logs",
    "node_modules",
    "__pycache__",
    "target",
    "build",
]);

function copyRuntimeAssets(
    source: string,
    destination: string,
    includeBrowserApp = true
): void {
    // Replace copied trees so previously staged local logs also disappear.
    // Only public runtime assets belong in native bundles; never follow links.
    rmSync(destination, { force: true, recursive: true });
    cpSync(source, destination, {
        filter(path) {
            if (isRetiredRuntimeScript(path)) return false;
            const name = basename(path);
            if (name.startsWith(".") || privateAssetDirectories.has(name)) {
                return false;
            }
            // Installation metadata and artwork belong only to browser builds.
            if (!includeBrowserApp && name === "browser-app") return false;
            const info = lstatSync(path);
            if (info.isSymbolicLink()) {
                throw new Error("Runtime asset must not be a symlink: " + path);
            }
            return (
                info.isDirectory() ||
                (info.isFile() &&
                    (/\.(html|js|css|json|webmanifest|txt|png|gif|ico|jpe?g|svg|ttf|otf|eot|woff2?)$/i.test(
                        name
                    ) ||
                        /^(?:pako|sax)-LICENSE$/.test(name)))
            );
        },
        recursive: true,
    });
}

// Full displays the player logo at startup; Play excludes that artwork.
// Keep packaged assets explicit instead of copying every source image.
function stagePlayerAssets(
    source: string,
    destination: string,
    flavor = "full"
): void {
    for (const directory of ["styles", "images", "locales"]) {
        rmSync(join(destination, directory), { force: true, recursive: true });
        mkdirSync(join(destination, directory), { recursive: true });
    }
    if (flavor !== "full" && flavor !== "play") {
        throw new Error("Unknown player asset distribution: " + flavor);
    }
    const files =
        flavor === "play"
            ? ["styles/player.css"]
            : ["styles/player.css", "images/player-logo.png"];
    for (const file of files) {
        const asset = join(source, file);
        if (!existsSync(asset)) {
            throw new Error("Missing player runtime asset: " + file);
        }
        copyRuntimeAssets(asset, join(destination, file));
    }
    for (const file of readdirSync(join(source, "locales"))) {
        if (/^[a-z]+(?:-[a-z]+)*\.js$/.test(file)) {
            copyRuntimeAssets(
                join(source, "locales", file),
                join(destination, "locales", file)
            );
        }
    }
}

function autoPlaybackScript(srcRoot: string): string {
    // PiP and the classic main bundle execute the same compiled watchdog.
    return readFileSync(
        join(srcRoot, "build/core/auto-playback.js"),
        "utf8"
    ).replace(/^export /gm, "");
}

// Capacitor serves the nested /dist scripts; flat build copies are unused.
function removeDuplicatePlayerAssets(directory: string): void {
    for (const file of [
        "player.js",
        ...Object.keys(CLASSIC_PROVIDER_BUNDLES).map(
            (kind) => "provider-" + kind + ".js"
        ),
    ]) {
        const flat = join(directory, file);
        const nested = join(directory, "dist", file);
        if (!readFileSync(flat).equals(readFileSync(nested)))
            throw new Error("Mismatched native player copies: " + file);
        rmSync(flat);
    }
}

// Stage a Mode A-like web root for Tauri Mode B (frontendDist).
// Boot resolves host + "/dist/player.js", "/devices/...", "/fonts/...", etc.
// Vite still writes Mode A artifacts to dist/ (player.js + index.html);
// Tauri serves the *contents* of frontendDist as "/", so we nest
// dist/player.js inside the stage dir instead of pointing at ../dist.
// Capacitor's separate dist-mobile stage preserves /dist/player.js too;
// its contents are served from the web root, like the Tauri stage.
function stageTauriFrontend(
    srcRoot: string,
    distDir: string,
    stageDir: string
): void {
    rmSync(stageDir, { force: true, recursive: true });
    mkdirSync(stageDir, { recursive: true });

    // index.html at web root (version already substituted in dist/)
    const indexSrc = join(distDir, "index.html");
    if (existsSync(indexSrc)) {
        cpSync(indexSrc, join(stageDir, "index.html"));
    }

    // PiP is a local app page so media libraries and Tauri IPC share its origin.
    for (const file of ["pip.html", "pip-player.js"]) {
        copyRuntimeAssets(
            join(srcRoot, "src-tauri", "pip", file),
            join(stageDir, file)
        );
    }
    writeFileSync(
        join(stageDir, "auto-playback.js"),
        autoPlaybackScript(srcRoot)
    );

    // Nested dist/player.js so /dist/player.js resolves
    const bundleSrc = join(distDir, "player.js");
    if (existsSync(bundleSrc)) {
        mkdirSync(join(stageDir, "dist"), { recursive: true });
        cpSync(bundleSrc, join(stageDir, "dist", "player.js"));
        for (const kind of Object.keys(CLASSIC_PROVIDER_BUNDLES)) {
            const file = "provider-" + kind + ".js";
            cpSync(join(distDir, file), join(stageDir, "dist", file));
        }
    }

    // Preserve nested vendor paths (lg/webos, samsung/tizen, etc.).
    const stbDir = join(srcRoot, "devices");
    if (existsSync(stbDir)) {
        copyRuntimeAssets(stbDir, join(stageDir, "devices"));
    }

    stagePlayerAssets(srcRoot, stageDir);
    for (const directory of ["hosted", "swop-input"]) {
        copyRuntimeAssets(join(distDir, directory), join(stageDir, directory));
    }

    // js player libs
    const jsSrc = join(srcRoot, "js");
    if (existsSync(jsSrc)) {
        const jsDest = join(stageDir, "js");
        mkdirSync(jsDest, { recursive: true });
        for (const file of [
            "hls.min.js",
            "jquery-1.11.1.min.js",
            "shaka-player.compiled.js",
        ]) {
            const srcFile = join(jsSrc, file);
            if (existsSync(srcFile)) {
                cpSync(srcFile, join(jsDest, file));
            }
        }
    }

    // fonts/ + providers/ (full trees used at runtime)
    for (const dir of ["fonts", "providers"] as const) {
        const src = join(srcRoot, dir);
        if (existsSync(src)) {
            copyRuntimeAssets(src, join(stageDir, dir));
        }
    }

    const faviconSrc = join(srcRoot, "favicon.ico");
    if (existsSync(faviconSrc)) {
        cpSync(faviconSrc, join(stageDir, "favicon.ico"));
    }

    stageNativeRuntime(stageDir, "tauri");
    console.log("Staged Tauri frontend at", stageDir);
}

// Vite wrapper: compile, link the classic global ABI, then minify as ES5.
// Vite's role is orchestration — Rollup's bundler is not used because the
// device/provider scripts still use the published classic globals.
export default defineConfig(({ mode }) => ({
    appType: "custom",
    build: {
        emptyOutDir: false,
        outDir: "dist",
        rollupOptions: {
            // TypeScript and the classic linker own the real graph. Avoid
            // transforming a second bundle that generateBundle never uses.
            input: "virtual:classic-build",
        },
        write: false,
    },
    plugins: [
        {
            configureServer(server) {
                if (mode === "native") {
                    configureNativeDev(server, __dirname);
                    return;
                }
                server.middlewares.use((req, res, next) => {
                    const pathname = req.url?.split("?")[0];
                    if (
                        pathname !== "/pip.html" &&
                        pathname !== "/pip-player.js" &&
                        pathname !== "/auto-playback.js"
                    ) {
                        next();
                        return;
                    }
                    res.setHeader(
                        "Content-Type",
                        pathname.endsWith(".html")
                            ? "text/html; charset=utf-8"
                            : "text/javascript; charset=utf-8"
                    );
                    res.setHeader("Cache-Control", "no-store");
                    res.end(
                        pathname === "/auto-playback.js"
                            ? autoPlaybackScript(__dirname)
                            : readFileSync(
                                  resolve(
                                      __dirname,
                                      "src-tauri/pip",
                                      pathname.slice(1)
                                  )
                              )
                    );
                });
            },
            name: "tauri-pip-dev-assets",
        },
        {
            apply: "build",
            load(id) {
                if (id === "\0virtual:classic-build") return "";
            },
            name: "classic-build-entry",
            resolveId(id) {
                if (id === "virtual:classic-build")
                    return "\0virtual:classic-build";
            },
        },
        {
            apply: "build",
            enforce: "post",
            async generateBundle() {
                const media = await ensureMediaRuntime(__dirname);
                console.log(
                    media.rebuilt
                        ? "Rebuilt media runtime"
                        : "Verified media runtime: reused unchanged assets"
                );
                // Step 1: tsc compile (produces build/*.js)
                console.log("Step 1: tsc compile...");
                if (androidFlavor) {
                    execFileSync(
                        process.execPath,
                        [
                            resolve(
                                __dirname,
                                "node_modules/typescript/bin/tsc"
                            ),
                            "--outDir",
                            join(androidCompileRoot!, "build"),
                            "--removeComments",
                            "false",
                        ],
                        { cwd: __dirname, stdio: "inherit" }
                    );
                    prepareDistributionModules(
                        androidCompileRoot,
                        androidFlavor
                    );
                    // Static cryptographic primitives are not TypeScript output.
                    // Keep the isolated Android link root complete as well.
                    mkdirSync(join(androidCompileRoot!, "js/vendor"), {
                        recursive: true,
                    });
                    cpSync(
                        resolve(__dirname, "js/vendor/sjcl-pin.js"),
                        join(androidCompileRoot!, "js/vendor/sjcl-pin.js")
                    );
                } else {
                    execFileSync(
                        process.execPath,
                        [resolve(__dirname, "node_modules/typescript/bin/tsc")],
                        { cwd: __dirname, stdio: "inherit" }
                    );
                }

                // Step 2: link the ordered modules and their checked classic ABI.
                console.log("Step 2: concatenate...");
                const outDir = androidFlavor
                    ? resolve(androidOutput!)
                    : resolve(__dirname, "dist");
                mkdirSync(outDir, { recursive: true });
                // Retire old public paths even when rebuilding an existing dist.
                for (const retired of [
                    "stbPlayer",
                    "stb",
                    "prov",
                    "stbPlayer.js",
                ])
                    rmSync(join(outDir, retired), {
                        force: true,
                        recursive: true,
                    });

                let bundle = assembleClassic(
                    androidFlavor ? androidCompileRoot : __dirname,
                    CLASSIC_MAIN_MODULES
                );

                const pkg = JSON.parse(readFileSync("package.json", "utf8"));
                const version = pkg.version || "local";
                bundle = embedPlayerBuildIdentity(
                    bundle.replace(/__OTTP_VERSION__/g, version),
                    __dirname,
                    {
                        requireReleaseSource:
                            Boolean(process.env.RELEASE_CHANNEL) ||
                            existsSync(
                                resolve(__dirname, ".release-plan.json")
                            ),
                    }
                );

                const outPath = join(outDir, "player.js");
                // Optimize local implementation details while preserving the classic ABI.
                console.log("Step 3: optimize ES5 classic bundle...");
                const result = await optimizeClassic(
                    bundle,
                    CLASSIC_PLAYER_NAME_POLICY
                );
                const size = measureBundle(result.code, "dist/player.js");
                writeFileSync(outPath, result.code);
                // Emit each implementation once; the selected provider loader
                // fetches its family without downloading every other factory.
                for (const name of readdirSync(outDir)) {
                    if (/^provider-.*\.js$/.test(name))
                        rmSync(join(outDir, name));
                }
                const providerKinds = Object.keys(
                    CLASSIC_PROVIDER_BUNDLES
                ).filter(
                    (kind) =>
                        androidFlavor !== "play" ||
                        kind === "plex" ||
                        kind === "stalker" ||
                        kind === "m3u"
                );
                for (const kind of providerKinds) {
                    const providerSource = assembleClassic(
                        androidFlavor ? androidCompileRoot : __dirname,
                        CLASSIC_PROVIDER_BUNDLES[kind]
                    ).replace(/__OTTP_VERSION__/g, version);
                    const providerResult = await optimizeClassic(
                        providerSource,
                        CLASSIC_PLAYER_NAME_POLICY
                    );
                    writeFileSync(
                        join(outDir, "provider-" + kind + ".js"),
                        providerResult.code
                    );
                }
                console.log(
                    "Classic bundle: " +
                        result.report.inputBytes +
                        " -> " +
                        size.bytes +
                        " bytes (gzip " +
                        size.gzipBytes +
                        ")"
                );

                // Copy index.html with version substituted
                const indexSrc = resolve(__dirname, "index.html");
                if (existsSync(indexSrc)) {
                    // Same-version beta deployments must not reuse a cached player URL.
                    const assetVersion =
                        version +
                        "-" +
                        createHash("sha256")
                            .update(result.code)
                            .digest("hex")
                            .slice(0, 16);
                    let html = readFileSync(indexSrc, "utf8")
                        .replace(/__OTTP_ASSET_VERSION__/g, assetVersion)
                        .replace(/__OTTP_VERSION__/g, version);
                    if (androidFlavor === "play") {
                        // The favicon is another copy of the excluded startup logo.
                        html = html.replace(
                            /\s*<link\b[^>]*href=["']favicon\.ico["'][^>]*>/gi,
                            ""
                        );
                        if (html.includes("favicon.ico")) {
                            throw new Error(
                                "Play must not reference the legacy favicon"
                            );
                        }
                    }
                    writeFileSync(join(outDir, "index.html"), html);
                    console.log(
                        "Wrote dist/index.html with version=" + version
                    );
                }

                const favicon = join(outDir, "favicon.ico");
                if (androidFlavor === "play") {
                    rmSync(favicon, { force: true });
                } else {
                    cpSync(join(__dirname, "favicon.ico"), favicon);
                }

                // Native roots retain the /dist/player.js bootstrap URL.
                // Prepare the nested copy before staging Capacitor separately
                // into dist-mobile and applying its native transformations.
                rmSync(join(outDir, "dist"), { force: true, recursive: true });
                mkdirSync(join(outDir, "dist"), { recursive: true });
                cpSync(outPath, join(outDir, "dist", "player.js"));
                for (const kind of providerKinds) {
                    const file = "provider-" + kind + ".js";
                    cpSync(join(outDir, file), join(outDir, "dist", file));
                }
                console.log("Nested Cap contract: dist/dist/player.js");
                // Retire media left by older builds; demo streams now live on here.now.
                rmSync(join(outDir, "demo"), { force: true, recursive: true });
                rmSync(join(outDir, "diagnostics"), {
                    force: true,
                    recursive: true,
                });
                // Older Mode A packaging wrote release archives into Capacitor's
                // web root, embedding an entire stale player in iOS applications.
                for (const file of [
                    "ottplay-foss-modea.tar.gz",
                    "ottplay-foss-modea.sha256",
                ]) {
                    rmSync(join(outDir, file), { force: true });
                }

                // Ship the same local device and library fallbacks in Capacitor as on the web.
                for (const dir of [
                    "fonts",
                    "providers",
                    "devices",
                    "js",
                ] as const) {
                    if (dir === "devices" && androidFlavor === "play") {
                        // Android uses its device shim and the HTML5 PC fallback.
                        // Do not ship legacy branded/device-specific shells.
                        for (const device of ["android", "pc"]) {
                            copyRuntimeAssets(
                                join(__dirname, dir, device),
                                join(outDir, dir, device)
                            );
                        }
                        continue;
                    }
                    if (dir === "providers" && androidFlavor === "play") {
                        stagePlayProviders(__dirname, join(outDir, dir));
                        continue;
                    }
                    const src = join(__dirname, dir);
                    if (existsSync(src)) {
                        copyRuntimeAssets(
                            src,
                            join(outDir, dir),
                            dir !== "js" || !androidFlavor
                        );
                    }
                }

                // All targets receive the same styles, logo and language packs.
                stagePlayerAssets(__dirname, outDir, androidFlavor || "full");
                stageHostedEpg(outDir);
                await stageHostedSwop(
                    outDir,
                    resolve(androidCompileRoot || __dirname, "build")
                );
                if (androidFlavor === "play") {
                    // This translation belongs to the excluded legacy adapter.
                    const locale = join(outDir, "locales/english.js");
                    writeFileSync(
                        locale,
                        readFileSync(locale, "utf8").replace(
                            /^\s*"Loading from Edem API\.\.\.":.*\r?\n/m,
                            ""
                        )
                    );
                }

                // Stage Mode A-like tree for Tauri Mode B (src-tauri/frontend).
                // Mode A companion still serves dist/player.js + repo-root
                // devices/fonts/providers/js — URL shapes unchanged.
                if (androidFlavor) {
                    stageNativeRuntime(outDir, "capacitor");
                    // The retained legacy Android export also applies native
                    // transformations before its final size gate.
                    measureBundle(readFileSync(outPath), "android/player.js");
                    measureBundle(
                        readFileSync(join(outDir, "dist/player.js")),
                        "android/dist/player.js"
                    );
                    inspectBundleSets(
                        outDir,
                        ["player.js", "dist/player.js"],
                        providerKinds
                    );
                    return;
                }
                stageOfflineShell(outDir);
                if (mode === "server") {
                    writeBundleReport(
                        __dirname,
                        result.report,
                        CLASSIC_MAIN_MODULES,
                        ["dist/player.js"]
                    );
                    execFileSync(
                        process.execPath,
                        ["scripts/check-es5.cjs", "--server-only"],
                        { cwd: __dirname, stdio: "inherit" }
                    );
                    return;
                }
                stageTauriFrontend(
                    __dirname,
                    outDir,
                    resolve(__dirname, "src-tauri/frontend")
                );
                // Capacitor must never consume the legacy server's dist tree.
                // Its own clean stage shares modern dependencies with Tauri.
                const mobileDir = resolve(__dirname, "dist-mobile");
                copyRuntimeAssets(outDir, mobileDir);
                removeDuplicatePlayerAssets(mobileDir);
                stageNativeRuntime(mobileDir, "capacitor");
                writeBundleReport(
                    __dirname,
                    result.report,
                    CLASSIC_MAIN_MODULES
                );
                // Only the server/legacy assets are constrained to ES5. Native
                // vendor files are checked against their pinned npm bytes.
                execSync("node scripts/check-es5.cjs", {
                    cwd: __dirname,
                    stdio: "inherit",
                });
            },
            name: "vite-concat-pipeline",
        },
    ],
    root: ".",
}));
