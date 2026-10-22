const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const ts = require("typescript");
const { chromium } = require("@playwright/test");
const { stageOfflineShell } = require("../scripts/offline-shell.cjs");
const source = ts.transpileModule(
    fs
        .readFileSync(
            path.join(__dirname, "../src/offline/browser-local-media.ts"),
            "utf8"
        )
        .replace(/^export /gm, ""),
    {
        compilerOptions: {
            module: ts.ModuleKind.None,
            target: ts.ScriptTarget.ES5,
        },
    }
).outputText;
require("acorn").parse(source, { ecmaVersion: 5 });
async function main() {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "ott-offline-"));
    let browser, server;
    try {
        fs.mkdirSync(path.join(folder, "dist"));
        fs.mkdirSync(path.join(folder, "logs"));
        fs.mkdirSync(path.join(folder, "js"));
        fs.writeFileSync(path.join(folder, "js/version.js"), "old-version");
        fs.writeFileSync(path.join(folder, "dist/player.js"), source);
        fs.writeFileSync(
            path.join(folder, "index.html"),
            '<!doctype html><script src="/dist/player.js?1.1.55"></script><script>installBrowserLocalMedia(window);installOfflineShell(window);</script>'
        );
        fs.writeFileSync(path.join(folder, "logs/private.js"), "secret");
        fs.writeFileSync(path.join(folder, "private.json"), '{"secret":true}');
        const manifest = stageOfflineShell(folder);
        assert.deepEqual(manifest.assets, [
            "dist/player.js",
            "index.html",
            "js/version.js",
        ]);
        const old = manifest.version;
        fs.appendFileSync(path.join(folder, "dist/player.js"), "\n// update");
        assert.notEqual(stageOfflineShell(folder).version, old);
        const requests = [];
        server = http.createServer((req, res) => {
            const url = new URL(req.url, "http://localhost");
            requests.push(url.pathname + url.search);
            if (url.pathname.startsWith("/api/")) {
                res.end("private");
                return;
            }
            const file = path.join(
                folder,
                url.pathname === "/" ? "index.html" : url.pathname
            );
            if (!fs.existsSync(file)) {
                res.statusCode = 404;
                res.end();
                return;
            }
            if (url.pathname === "/js/version.js")
                res.setHeader("Cache-Control", "public, max-age=3600");
            res.setHeader(
                "Content-Type",
                file.endsWith(".js") ? "text/javascript" : "text/html"
            );
            res.end(fs.readFileSync(file));
        });
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const origin = "http://127.0.0.1:" + server.address().port;
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ serviceWorkers: "allow" });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        await page.goto(origin);
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.waitForFunction(() => navigator.serviceWorker.controller);
        assert.equal(
            await page.evaluate(
                async () =>
                    (await window.__ottBrowserLocalMedia.list()).offlineReady
            ),
            true
        );
        const result = await page.evaluate(async () => {
            const api = window.__ottBrowserLocalMedia;
            // Backward compatibility: old copied libraries remain readable,
            // but new selection must never create another media copy.
            await new Promise((resolve, reject) => {
                const request = indexedDB.open("ott-local-media", 1);
                request.onsuccess = () => {
                    const tx = request.result.transaction("files", "readwrite");
                    tx.objectStore("files").put({
                        blob: new File(["fixture-video"], "clip.mp4", {
                            type: "video/mp4",
                        }),
                        created: 1,
                        id: "legacy-fixture",
                        name: "clip.mp4",
                    });
                    tx.oncomplete = resolve;
                    tx.onerror = () => reject(tx.error);
                };
                request.onerror = () => reject(request.error);
            });
            const first = await api.list();
            const repeated = await api.list();
            return {
                data: await (await fetch(first.items[0].url)).text(),
                item: first.items[0],
                repeated: repeated.items[0],
            };
        });
        assert.equal(result.item.name, "clip.mp4");
        assert.equal(
            result.item.url,
            result.repeated.url,
            "listing must preserve a playing object URL"
        );
        assert.equal(result.data, "fixture-video");
        assert.equal(
            await page.evaluate(() =>
                window.__ottBrowserLocalMedia
                    .importFiles([
                        new File(["bad"], "secret.txt", { type: "text/plain" }),
                    ])
                    .then(
                        () => "accepted",
                        (e) => e.message
                    )
            ),
            "Direct sources require the file picker; media copying is disabled"
        );
        assert.equal(
            await page.evaluate(
                async () =>
                    (await window.__ottBrowserLocalMedia.list()).items.length
            ),
            1
        );
        await page.evaluate(() => fetch("/api/private?token=fixture"));
        const cacheKeys = await page.evaluate(async () => {
            const stores = await caches.keys();
            const keys = await Promise.all(
                stores.map(async (s) =>
                    (await (await caches.open(s)).keys()).map((r) => r.url)
                )
            );
            return keys.flat();
        });
        assert.ok(
            cacheKeys.every(
                (url) =>
                    !url.includes("token") &&
                    !url.includes("/api/") &&
                    !url.includes("private")
            )
        );
        assert.equal(
            await page.evaluate(() =>
                fetch("/js/version.js").then((r) => r.text())
            ),
            "old-version",
            "prime the browser HTTP cache with a long-lived static asset"
        );
        fs.writeFileSync(path.join(folder, "js/version.js"), "new-version");
        assert.equal(
            await page.evaluate(() =>
                fetch("/js/version.js").then((r) => r.text())
            ),
            "new-version",
            "online app must never be stuck on old assets"
        );
        await context.setOffline(true);
        assert.equal(
            await page.evaluate(() =>
                fetch("/js/version.js?version=old").then((r) => r.text())
            ),
            "old-version",
            "offline fallback preserves the installed version"
        );
        await page.reload();
        const restored = await page.evaluate(async () => {
            const catalog = await window.__ottBrowserLocalMedia.list();
            return {
                data: await (await fetch(catalog.items[0].url)).text(),
                item: catalog.items[0],
            };
        });
        assert.equal(restored.item.id, result.item.id);
        assert.notEqual(
            restored.item.url,
            result.item.url,
            "reload must regenerate nonpersistent blob URL"
        );
        assert.equal(restored.data, "fixture-video");
        assert.equal(
            await page.evaluate(
                async (id) =>
                    (await window.__ottBrowserLocalMedia.remove(id)).items
                        .length,
                result.item.id
            ),
            0
        );
        const missing = await page.evaluate(() =>
            installBrowserLocalMedia({
                addEventListener() {},
                navigator: {},
                URL: {},
            }).list()
        );
        assert.equal(missing.available, false);
        console.log(
            "PASS browser local media: legacy IndexedDB reads, stable playback URL, validation, persistence, offline cold reload, no private cache, delete, unsupported browser"
        );
    } finally {
        if (browser) await browser.close();
        if (server) await new Promise((r) => server.close(r));
        fs.rmSync(folder, { force: true, recursive: true });
    }
}
main()
    .then(async () => {
        if (process.argv.includes("--built-ui")) {
            await builtUi("/f/pc/");
            await builtUi("/f/");
        }
    })
    .catch((e) => {
        console.error(e);
        process.exitCode = 1;
    });

async function builtUi(devicePath) {
    const stalledFixture = process.argv.includes("--stalled-file");
    const root = path.resolve(__dirname, "..");
    const dist = path.join(root, "dist");
    if (!fs.existsSync(path.join(dist, "offline-worker.js")))
        throw new Error("Build the player before --built-ui");
    const assetHash = require("node:crypto")
        .createHash("sha256")
        .update(fs.readFileSync(path.join(dist, "player.js")))
        .digest("hex")
        .slice(0, 16);
    assert.ok(
        fs
            .readFileSync(path.join(dist, "index.html"), "utf8")
            .includes("-" + assetHash + '"'),
        "bootstrap asset URL changes with same-version player bytes"
    );
    const muxjs = require("mux.js");
    // Repeat the two-second fixture with real increasing decode timestamps so
    // transport shortcuts exercise a seekable 40-second file, not a mocked
    // currentTime setter or an immediate end-of-file clamp.
    const segment = new Uint8Array(
        fs.readFileSync(
            path.join(root, "tests/fixtures/media-runtime/segment00.ts")
        )
    );
    const fragments = [];
    for (let index = 0; index < 20; index++) {
        const transmuxer = new muxjs.mp4.Transmuxer({
            baseMediaDecodeTime: index * 2 * 90000,
            remux: true,
        });
        transmuxer.on("data", (data) => {
            if (index === 0) fragments.push(Buffer.from(data.initSegment));
            fragments.push(Buffer.from(data.data));
        });
        transmuxer.push(segment);
        transmuxer.flush();
    }
    const movie = Buffer.concat(fragments);
    assert.ok(movie && movie.length > 1000);
    const mediaFolder = fs.mkdtempSync(
        path.join(os.tmpdir(), "ott-local-folder-")
    );
    fs.mkdirSync(path.join(mediaFolder, "nested"));
    fs.writeFileSync(path.join(mediaFolder, "nested/folder-video.mp4"), movie);
    fs.writeFileSync(path.join(mediaFolder, "notes.txt"), "not a video");
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://localhost");
        if (url.pathname === "/test-local-library") {
            res.setHeader("Content-Type", "application/json");
            res.end(
                JSON.stringify({
                    available: true,
                    items: [],
                    sources: [],
                    storage: "server",
                })
            );
            return;
        }
        const relative =
            url.pathname === "/" || url.pathname.startsWith("/f/")
                ? "index.html"
                : url.pathname.slice(1);
        const file = path.resolve(dist, relative);
        if (
            !file.startsWith(dist + path.sep) ||
            !fs.existsSync(file) ||
            !fs.statSync(file).isFile()
        ) {
            res.writeHead(404).end();
            return;
        }
        const type = {
            ".css": "text/css",
            ".html": "text/html",
            ".js": "text/javascript",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".ttf": "font/ttf",
            ".woff": "font/woff",
            ".woff2": "font/woff2",
        }[path.extname(file)];
        if (type) res.setHeader("Content-Type", type);
        res.end(fs.readFileSync(file));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const browser = await chromium.launch({ headless: true });
    try {
        const context = await browser.newContext({ serviceWorkers: "allow" });
        // Real handles/IndexedDB survive actual page closure below. Only the
        // browser permission policy is controlled: OPFS does not normally
        // require the external-folder grants exercised by this regression.
        await context.addInitScript(() => {
            if (window.FileSystemHandle) {
                FileSystemHandle.prototype.queryPermission = function () {
                    return Promise.resolve(
                        localStorage.getItem("fixture-source-permission") ||
                            "granted"
                    );
                };
                FileSystemHandle.prototype.requestPermission = function () {
                    localStorage.setItem(
                        "fixture-request-activation",
                        String(navigator.userActivation.isActive)
                    );
                    localStorage.setItem(
                        "fixture-source-permission",
                        "granted"
                    );
                    return Promise.resolve("granted");
                };
            }
        });
        let page = await context.newPage();
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.addInitScript(() => {
            if (!localStorage.getItem("ottplayprov")) {
                localStorage.setItem("ottplaylang", "_eng");
                localStorage.setItem("ottplayprov", "demo");
            }
        });
        const origin = "http://127.0.0.1:" + server.address().port;
        await page.goto(origin + devicePath);
        await page.waitForFunction(
            () =>
                window.__ottLocalMedia &&
                !document.body.classList.contains("booting")
        );
        const action = (name) =>
            page.locator('[data-local-media-action="' + name + '"]');
        async function selectAction(name) {
            await page.locator("#dialogbox").waitFor({ state: "hidden" });
            const index = await page.evaluate(
                (id) => window.listArray.findIndex((row) => row.id === id),
                name
            );
            assert.ok(index >= 0, "Missing local media action: " + name);
            for (let step = 0; step < 30; step++) {
                const current = await page.evaluate(() => window.selIndex);
                if (current === index) break;
                await page.keyboard.press(
                    current < index ? "ArrowDown" : "ArrowUp"
                );
            }
            await page.keyboard.press("Enter");
        }
        async function chooseLocalProvider() {
            await page.evaluate(() => {
                window.stbStop();
                window.showProviderSelection();
            });
            await page.keyboard.press("Home");
            for (let step = 0; step < 12; step++) {
                const selected = await page.evaluate(() => {
                    const row = document.getElementById("it" + window.selIndex);
                    return row && row.textContent.includes("Local videos");
                });
                if (selected) break;
                await page.keyboard.press("ArrowDown");
            }
            await page.keyboard.press("Enter");
            await action("add-folder").waitFor();
        }
        await chooseLocalProvider();
        await selectAction("play");
        await page
            .getByText(
                "No playable local videos. Add a folder or grant access to a connected source.",
                { exact: true }
            )
            .waitFor();
        assert.notEqual(
            await page.evaluate(() => window.stbGetItem("ottplayprov")),
            "offline",
            "empty Play must not activate an empty provider"
        );
        await selectAction("close");
        await chooseLocalProvider();
        await page.screenshot({ path: "/tmp/ott-local-standard-ui.png" });
        // The library editor must remain escapable without changing its URL.
        // Exercise both physical Escape and the player's own cancel/back hints.
        for (const exitMethod of ["escape", "cancel-hint", "remote-back"]) {
            await selectAction("server-library");
            await page.locator("#listEdit").waitFor({ state: "visible" });
            if (await page.locator("#editvar").count())
                await page
                    .locator("#editvar")
                    .fill("https://discard.example/" + exitMethod);
            if (exitMethod === "escape") await page.keyboard.press("Escape");
            else if (exitMethod === "cancel-hint") {
                const key = await page.evaluate(() => window.keys.EXIT);
                await page
                    .locator('#listEdit [data-ott-key="' + key + '"]')
                    .click();
            } else {
                await page.evaluate(() => window.editKey(window.keys.RETURN));
            }
            await page.locator("#listEdit").waitFor({ state: "hidden" });
            await action("server-library").waitFor({ state: "visible" });
            assert.equal(
                await page.evaluate(
                    () => window.stbGetItem("localMediaEndpoint") || ""
                ),
                ""
            );
        }
        // Recovery after a startup timeout must be actionable without starting
        // another automatic scan of the same stalled filesystem.
        await page.evaluate(() => {
            const api = window.__ottBrowserLocalMedia;
            window.__originalLocalList = api.list;
            window.__recoveryScans = 0;
            api.list = () => {
                window.__recoveryScans++;
                return new Promise(() => {});
            };
            window.__ottLocalMedia.resume(true);
        });
        await action("resume").waitFor({ state: "visible" });
        assert.equal(await page.evaluate(() => window.__recoveryScans), 0);
        assert.equal(
            await page.locator("#dialogbox .ott-spinner").isVisible(),
            false
        );
        await page.evaluate(() => {
            window.__ottBrowserLocalMedia.list = window.__originalLocalList;
            delete window.__originalLocalList;
            window.__ottLocalMedia.open();
        });
        await page.locator("#dialogbox").waitFor({ state: "hidden" });
        // Completing an older refresh while the editor is open cannot steal
        // its owner or leave a visible editor that no longer receives keys.
        await page.evaluate(() => {
            const api = window.__ottBrowserLocalMedia;
            const original = api.list;
            api.list = () => {
                api.list = original;
                return new Promise((resolve) => {
                    window.__resolveRefresh = resolve;
                });
            };
        });
        await selectAction("refresh");
        await page.waitForFunction(
            () => typeof window.__resolveRefresh === "function"
        );
        await page.locator("#dialogbox .ott-spinner").waitFor();
        // A remote/action transition can replace the loading dialog with the
        // editor even though local keyboard input is captured by the dialog.
        await page.evaluate(() =>
            window.listArray.find((row) => row.id === "server-library").action()
        );
        await page.locator("#dialogbox").waitFor({ state: "hidden" });
        await page.evaluate(async () => {
            window.__resolveRefresh({
                available: true,
                items: [],
                sources: [],
            });
            await Promise.resolve();
            await Promise.resolve();
        });
        await page.locator("#editvar").fill("https://discard.example/pending");
        await page.keyboard.press("Escape");
        await page.locator("#listEdit").waitFor({ state: "hidden" });
        await action("server-library").waitFor({ state: "visible" });
        await selectAction("server-library");
        await page.locator("#editvar").fill("not-a-server-url");
        await page.keyboard.press("Enter");
        await page.locator("#listEdit").waitFor({ state: "hidden" });
        await page
            .getByText("Use a complete HTTP or HTTPS URL.", { exact: true })
            .waitFor();
        assert.equal(
            await page.evaluate(
                () => window.stbGetItem("localMediaEndpoint") || ""
            ),
            ""
        );
        await selectAction("server-library");
        await page.locator("#editvar").fill(origin + "/test-local-library");
        await page.keyboard.press("Enter");
        await page.waitForFunction(() =>
            window
                .stbGetItem("localMediaEndpoint")
                .endsWith("/test-local-library")
        );
        await page.locator("#listEdit").waitFor({ state: "hidden" });
        await page
            .getByText(
                "A server library is selected. Clear its URL to use files on this device.",
                { exact: true }
            )
            .waitFor();
        await selectAction("server-library");
        await page.locator("#editvar").fill("");
        await page.keyboard.press("Enter");
        await page.waitForFunction(
            () => !window.stbGetItem("localMediaEndpoint")
        );
        await page.locator("#listEdit").waitFor({ state: "hidden" });
        await action("add-folder").waitFor();
        // Start at the first row to verify normal remote navigation.
        while (await page.evaluate(() => window.selIndex > 0))
            await page.keyboard.press("ArrowUp");
        await page.keyboard.press("ArrowDown");
        assert.equal(
            await page.evaluate(() => window.listArray[window.selIndex].id),
            "add-files",
            "standard remote list navigation handles local manager rows"
        );
        for (const name of ["add-files", "add-folder"]) {
            await page.evaluate((id) => {
                window[
                    id === "add-files"
                        ? "showOpenFilePicker"
                        : "showDirectoryPicker"
                ] = () =>
                    Promise.reject(
                        new DOMException("Selection cancelled", "AbortError")
                    );
            }, name);
            await selectAction(name);
            await page.locator("#dialogbox").waitFor({ state: "hidden" });
            assert.equal(
                await page.evaluate(
                    async () =>
                        (await window.__ottLocalMedia.list()).items.length
                ),
                0
            );
            await selectAction("close");
            await chooseLocalProvider();
        }
        await page.evaluate(() => {
            window.showDirectoryPicker = () =>
                Promise.reject(new Error("Fixture permission denied"));
        });
        await selectAction("add-folder");
        await page
            .getByText("Fixture permission denied", { exact: true })
            .waitFor();
        await selectAction("close");
        await chooseLocalProvider();
        // A response from a dismissed manager must not replace a newly opened one.
        await page.evaluate(() => {
            const api = window.__ottBrowserLocalMedia;
            const original = api.list;
            api.list = () => {
                api.list = original;
                return new Promise((resolve) => {
                    window.__resolveOldLocalList = resolve;
                });
            };
            window.__ottLocalMedia.open();
        });
        await page.waitForFunction(
            () => typeof window.__resolveOldLocalList === "function"
        );
        await page.locator("#dialogbox .ott-spinner").waitFor();
        assert.equal(
            await page
                .locator("#listDetail")
                .textContent()
                .then((text) => text.includes("Working")),
            false,
            "catalog loading uses the standard spinner, not a detail placeholder"
        );
        await page.keyboard.press("Escape");
        await page.locator("#dialogbox").waitFor({ state: "hidden" });
        await chooseLocalProvider();
        await page.evaluate(() =>
            window.__resolveOldLocalList({
                available: true,
                items: [],
                sources: [
                    {
                        available: true,
                        id: "obsolete",
                        name: "Obsolete response",
                    },
                ],
            })
        );
        await selectAction("refresh");
        await page.locator("#dialogbox").waitFor({ state: "hidden" });
        assert.equal(
            await page
                .getByText("Disconnect: Obsolete response", { exact: true })
                .count(),
            0
        );
        // Escape is also a back action for the manager itself, including when
        // a refresh has not returned yet.
        await page.evaluate(() => {
            const api = window.__ottBrowserLocalMedia;
            const original = api.list;
            api.list = () => {
                api.list = original;
                return new Promise((resolve) => {
                    window.__resolveClosedLocalList = resolve;
                });
            };
        });
        await selectAction("refresh");
        await page.waitForFunction(
            () => typeof window.__resolveClosedLocalList === "function"
        );
        await page.locator("#dialogbox .ott-spinner").waitFor();
        await page.keyboard.press("Escape");
        await page.locator("#dialogbox").waitFor({ state: "hidden" });
        await action("add-folder").waitFor({ state: "hidden" });
        await page.evaluate(async () => {
            window.__resolveClosedLocalList({
                available: true,
                items: [],
                sources: [],
            });
            await Promise.resolve();
            await Promise.resolve();
        });
        await action("add-folder").waitFor({ state: "hidden" });
        await chooseLocalProvider();
        // Real filesystem handles, not uploaded File/Blob copies. The native
        // picker is replaced only to make the user-selection step deterministic.
        await page.evaluate(
            async ({ bytes, stalled }) => {
                const root = await navigator.storage.getDirectory();
                const folder = await root.getDirectoryHandle(
                    "selected-folder",
                    {
                        create: true,
                    }
                );
                const nested = await folder.getDirectoryHandle("nested", {
                    create: true,
                });
                async function write(parent, name, data) {
                    const handle = await parent.getFileHandle(name, {
                        create: true,
                    });
                    const output = await handle.createWritable();
                    await output.write(data);
                    await output.close();
                    return handle;
                }
                const file = await write(
                    root,
                    "offline-fixture.mp4",
                    new Uint8Array(bytes)
                );
                await write(nested, "folder-video.mp4", new Uint8Array(bytes));
                await write(folder, "notes.txt", "not a video");
                window.showOpenFilePicker = () => Promise.resolve([file]);
                window.showDirectoryPicker = () => Promise.resolve(folder);
                if (stalled) {
                    const bad = await folder.getFileHandle(
                        "stalled-first.mp4",
                        { create: true }
                    );
                    const filePrototype = FileSystemFileHandle.prototype;
                    const originalGetFile = filePrototype.getFile;
                    const directoryPrototype =
                        FileSystemDirectoryHandle.prototype;
                    const originalValues = directoryPrototype.values;
                    const pending = [];
                    window.__stalledFileFixture = {
                        bad,
                        calls: 0,
                        originalGetFile,
                        pending,
                    };
                    filePrototype.getFile = function () {
                        if (this.name !== "stalled-first.mp4")
                            return originalGetFile.call(this);
                        window.__stalledFileFixture.calls++;
                        return new Promise((resolve) => pending.push(resolve));
                    };
                    directoryPrototype.values = function () {
                        const iterator = originalValues.call(this);
                        if (this.name !== "selected-folder") return iterator;
                        let first = true;
                        return {
                            next: async () => {
                                if (first) {
                                    first = false;
                                    return { done: false, value: bad };
                                }
                                let step;
                                do {
                                    step = await iterator.next();
                                } while (
                                    !step.done &&
                                    step.value.name === "stalled-first.mp4"
                                );
                                return step;
                            },
                        };
                    };
                }
            },
            { bytes: Array.from(movie), stalled: stalledFixture }
        );
        async function blockOlderSource() {
            await page.evaluate(async () => {
                const root = await navigator.storage.getDirectory();
                const folder = await root.getDirectoryHandle(
                    "unresponsive-old-source",
                    { create: true }
                );
                const picker = window.showDirectoryPicker;
                window.showDirectoryPicker = () => Promise.resolve(folder);
                const saved = await window.__ottBrowserLocalMedia.importFolder({
                    deferScan: true,
                });
                window.showDirectoryPicker = picker;
                const prototype = FileSystemDirectoryHandle.prototype;
                const values = prototype.values;
                const pending = [];
                window.__blockedImportSource = {
                    id: saved.sourceIds[0],
                    pending,
                    prototype,
                    values,
                };
                prototype.values = function () {
                    if (this.name !== "unresponsive-old-source")
                        return values.call(this);
                    return {
                        next: () =>
                            new Promise((resolve) => pending.push(resolve)),
                    };
                };
            });
        }
        async function releaseOlderSource() {
            await page.evaluate(async () => {
                const blocked = window.__blockedImportSource;
                blocked.prototype.values = blocked.values;
                for (const resolve of blocked.pending) resolve({ done: true });
                await window.__ottBrowserLocalMedia.removeSource(blocked.id);
                delete window.__blockedImportSource;
            });
        }
        async function expectImportedPlayback(actionName) {
            const expected =
                actionName === "add-files"
                    ? "offline-fixture.mp4"
                    : "folder-video.mp4";
            await page.waitForFunction(
                (name) => {
                    const id = window.curList[window.primaryIndex];
                    return window.channels[id]?.channel_name === name;
                },
                expected,
                { timeout: stalledFixture ? 20000 : 10000 }
            );
            await page.waitForFunction(() =>
                Array.from(document.querySelectorAll("video")).some(
                    (video) =>
                        video.currentTime > 0.1 && !video.error && !video.paused
                )
            );
            await action("add-folder").waitFor({ state: "hidden" });
            const playback = await page.evaluate(() => {
                const video = Array.from(
                    document.querySelectorAll("video")
                ).find(
                    (item) =>
                        item.currentTime > 0.1 && !item.error && !item.paused
                );
                return {
                    frames: video.getVideoPlaybackQuality().totalVideoFrames,
                    position: video.currentTime,
                };
            });
            assert.ok(
                playback.frames > 0,
                "imported video decodes actual frames"
            );
            console.log(
                "PASS imported playback " +
                    devicePath +
                    " " +
                    actionName +
                    ": " +
                    JSON.stringify(playback)
            );
        }
        await blockOlderSource();
        await selectAction("add-files");
        await expectImportedPlayback("add-files");
        await releaseOlderSource();
        await chooseLocalProvider();
        await page.waitForFunction(
            () =>
                document.querySelectorAll(
                    '[data-local-media-action="disconnect-source"]'
                ).length === 1
        );
        await blockOlderSource();
        await selectAction("add-folder");
        await expectImportedPlayback("add-folder");
        await releaseOlderSource();
        if (stalledFixture) {
            const before = await page.evaluate(
                () => window.curList[window.primaryIndex]
            );
            const calls = await page.evaluate(async () => {
                const fixture = window.__stalledFileFixture;
                const file = await fixture.originalGetFile.call(fixture.bad);
                for (const resolve of fixture.pending) resolve(file);
                return fixture.calls;
            });
            await page.waitForTimeout(100);
            assert.equal(
                calls,
                1,
                "provider handoff does not duplicate the abandoned file read"
            );
            assert.equal(
                await page.evaluate(() => window.curList[window.primaryIndex]),
                before,
                "late first-file completion cannot replace the healthy playing file"
            );
            console.log(
                "PASS stalled first metadata " +
                    devicePath +
                    ": healthy next video decoded and late file ignored"
            );
            return;
        }
        await chooseLocalProvider();
        await page.waitForFunction(
            () =>
                document.querySelectorAll(
                    '[data-local-media-action="disconnect-source"]'
                ).length === 2
        );
        assert.equal(
            await page.evaluate(
                async () => (await window.__ottLocalMedia.list()).items.length
            ),
            2,
            "linked folder lists nested media and skips text files"
        );
        await selectAction("close");
        await chooseLocalProvider();
        await selectAction("play");
        await page.waitForFunction(() =>
            Array.from(document.querySelectorAll("video")).some(
                (v) => v.currentTime > 0.1 && !v.error
            )
        );
        for (const input of ["keyboard", "pointer", "touch"]) {
            const before = await page.evaluate(() => ({
                selected: window.curList[window.primaryIndex],
                volume: document.querySelector("video").volume,
            }));
            await page.evaluate(() => window.stbSetStandby(true));
            await page.waitForFunction(() => window.__ottStandby.isStandby());
            if (input === "keyboard") await page.keyboard.press("ArrowDown");
            else if (input === "pointer") await page.mouse.click(300, 200);
            else {
                const touch = await context.newCDPSession(page);
                await touch.send("Emulation.setTouchEmulationEnabled", {
                    enabled: true,
                    maxTouchPoints: 1,
                });
                await touch.send("Input.dispatchTouchEvent", {
                    touchPoints: [{ x: 300, y: 200 }],
                    type: "touchStart",
                });
                await touch.send("Input.dispatchTouchEvent", {
                    touchPoints: [],
                    type: "touchEnd",
                });
                await touch.send("Emulation.setTouchEmulationEnabled", {
                    enabled: false,
                });
                await touch.detach();
            }
            await page.waitForFunction(() => {
                const video = document.querySelector("video");
                return (
                    !window.__ottStandby.blocked() &&
                    video.currentTime > 0.1 &&
                    !video.paused &&
                    !video.error &&
                    video.getVideoPlaybackQuality().totalVideoFrames > 0
                );
            });
            const after = await page.evaluate(() => ({
                frames: document
                    .querySelector("video")
                    .getVideoPlaybackQuality().totalVideoFrames,
                selected: window.curList[window.primaryIndex],
                volume: document.querySelector("video").volume,
            }));
            assert.equal(
                after.selected,
                before.selected,
                "wake gesture cannot change the selected video"
            );
            assert.equal(
                after.volume,
                before.volume,
                "wake gesture cannot change the volume"
            );
            assert.ok(after.frames > 0, "local wake resumes decoded video");
            console.log("PASS local standby wake " + devicePath + " " + input);
        }
        await page.waitForFunction(() => !!window.__ottTryKeyboardSeek);
        await page.waitForFunction(() => window.playType === -99999999999);
        const playbackUrl = page.url();
        await page.evaluate(async () => {
            const video = document.querySelector("video");
            if (document.fullscreenEnabled) await video.requestFullscreen();
            video.controls = true;
            video.tabIndex = 0;
            video.focus();
            video.pause();
            video.currentTime = 15;
        });
        assert.equal(
            await page.evaluate(() => document.activeElement.tagName),
            "VIDEO",
            "native video controls own keyboard focus during seek regression"
        );
        assert.equal(
            await page.evaluate(() => document.fullscreenElement?.tagName),
            "VIDEO",
            "seek regression exercises the actual browser fullscreen element"
        );
        await page.waitForFunction(() => {
            const video = document.querySelector("video");
            return !video.seeking && Math.abs(video.currentTime - 15) < 0.5;
        });
        assert.ok(
            await page.evaluate(
                () => document.querySelector("video").duration > 35
            ),
            "the browser seek fixture must be long enough for real seeks"
        );
        for (const [key, expected] of [
            ["Control+ArrowRight", 25],
            ["Control+ArrowLeft", 15],
            ["Alt+ArrowRight", 25],
            ["Alt+ArrowLeft", 15],
            ["Meta+ArrowRight", 25],
            ["Meta+ArrowLeft", 15],
        ]) {
            await page.keyboard.press(key);
            await page.waitForFunction((position) => {
                const video = document.querySelector("video");
                return (
                    !video.seeking &&
                    Math.abs(video.currentTime - position) < 0.75
                );
            }, expected);
            assert.equal(
                page.url(),
                playbackUrl,
                key + " must not navigate the browser"
            );
            assert.equal(
                await page.evaluate(
                    () => document.querySelector("video").paused
                ),
                true,
                key + " preserves paused playback"
            );
        }
        if (await page.evaluate(() => /^pc(?:2)?$/.test(window.ott_device))) {
            const before = await page.evaluate(() => {
                window.changeVolume(-100);
                window.changeVolume(50);
                return {
                    position: document.querySelector("video").currentTime,
                    volume: window.stbGetVolume(),
                };
            });
            await page.keyboard.press("ArrowRight");
            assert.equal(
                await page.evaluate(
                    () => document.querySelector("video").currentTime
                ),
                before.position,
                "plain right in fullscreen does not seek"
            );
            assert.ok(
                (await page.evaluate(() => window.stbGetVolume())) >
                    before.volume,
                "plain right increases volume"
            );
            await page.keyboard.press("ArrowLeft");
            assert.ok(
                Math.abs(
                    (await page.evaluate(() => window.stbGetVolume())) -
                        before.volume
                ) < 0.01,
                "plain left restores volume"
            );
            assert.equal(
                await page.evaluate(
                    () => document.querySelector("video").currentTime
                ),
                before.position,
                "plain left in fullscreen does not seek"
            );
        }
        await page.evaluate(async () => {
            if (document.fullscreenElement) await document.exitFullscreen();
            const video = document.querySelector("video");
            video.controls = false;
            video.blur();
            await video.play();
        });
        await chooseLocalProvider();
        await action("play").waitFor();
        const menuPosition = await page.evaluate(
            () => document.querySelector("video").currentTime
        );
        await page.keyboard.press("Alt+ArrowRight");
        await page.keyboard.press("Meta+ArrowLeft");
        assert.equal(
            await page.evaluate(
                () => document.querySelector("video").currentTime
            ),
            menuPosition,
            "transport shortcuts do not seek while a player menu owns input"
        );
        await selectAction("server-library");
        await page.locator("#editvar").waitFor({ state: "visible" });
        await page.locator("#editvar").fill("https://editor.example/library");
        await page.keyboard.press("Alt+ArrowRight");
        await page.keyboard.press("Meta+ArrowLeft");
        assert.equal(
            await page.evaluate(
                () => document.querySelector("video").currentTime
            ),
            menuPosition,
            "transport shortcuts leave playback unchanged while editing text"
        );
        assert.equal(
            await page.locator("#editvar").inputValue(),
            "https://editor.example/library"
        );
        await page.keyboard.press("Escape");
        await action("play").waitFor();
        await selectAction("play");
        await page.waitForFunction(() =>
            Array.from(document.querySelectorAll("video")).some(
                (v) => v.currentTime > 0.1 && !v.error
            )
        );
        // Playback may start from the first batch while the second file is
        // still being read. Wait for the row this test intends to select.
        await page.waitForFunction(() => window.curList.length === 2);
        const selectedChannel = await page.evaluate(() => {
            const id = window.curList[1];
            window.playChannel(window.catIndex, 1, true);
            return id;
        });
        await page.waitForFunction(
            (id) => window.curList[window.primaryIndex] === id,
            selectedChannel
        );
        const before = await page.evaluate(() => ({
            catalog: window.cList,
            provider: window.stbGetItem("ottplayprov"),
            urls: Object.values(window.chanels || {}).map((c) => c.url),
        }));
        assert.equal(before.provider, "offline");
        await page.evaluate(() => navigator.serviceWorker.ready);
        await page.waitForFunction(() => navigator.serviceWorker.controller);
        await context.setOffline(true);
        await page.reload();
        await page.waitForFunction(
            () =>
                window.__ottLocalMedia &&
                !document.body.classList.contains("booting")
        );
        const autoplay = await page.evaluate(() =>
            document
                .querySelector("video")
                .play()
                .then(
                    () => "played",
                    (error) => error.name
                )
        );
        if (autoplay === "NotAllowedError") {
            await page.keyboard.press("Space");
        }
        await page
            .waitForFunction(
                () =>
                    Array.from(document.querySelectorAll("video")).some(
                        (v) => v.currentTime > 0.1 && !v.error
                    ),
                null,
                { timeout: 5000 }
            )
            .catch(async (error) => {
                console.error(
                    "Offline playback state",
                    await page.evaluate(() => ({
                        catalog: window.cList,
                        channels: window.chanels,
                        provider: window.stbGetItem("ottplayprov"),
                        text: document.body.innerText.slice(0, 1500),
                        videos: Array.from(
                            document.querySelectorAll("video")
                        ).map((v) => ({
                            error: v.error && v.error.code,
                            paused: v.paused,
                            src: v.currentSrc,
                            time: v.currentTime,
                        })),
                    })),
                    errors
                );
                throw error;
            });
        // Cold reload can resume the saved file before other rows arrive.
        // Compare membership only after that background catalogue is complete.
        await page.waitForFunction(
            (expected) =>
                window.cList.length === expected.length &&
                expected.every((id) => window.cList.includes(id)),
            before.catalog
        );
        const after = await page.evaluate(() => ({
            catalog: window.cList,
            provider: window.stbGetItem("ottplayprov"),
            urls: Object.values(window.chanels || {}).map((c) => c.url),
        }));
        assert.equal(after.provider, "offline");
        assert.deepEqual(
            after.catalog.slice().sort(),
            before.catalog.slice().sort(),
            "progressive resume preserves catalog membership"
        );
        assert.notDeepEqual(
            after.urls,
            before.urls,
            "offline driver regenerates blob URLs after cold reload"
        );
        assert.equal(
            await page.evaluate(() => window.curList[window.primaryIndex]),
            selectedChannel,
            "offline reload must preserve the selected second local video"
        );
        await context.setOffline(false);
        async function reopenPlayer() {
            await page.close();
            page = await context.newPage();
            page.setDefaultTimeout(10000);
            page.on("pageerror", (e) => errors.push(e.message));
            await page.goto(origin + devicePath);
            await page.waitForFunction(
                () =>
                    window.__ottLocalMedia &&
                    !document.body.classList.contains("booting")
            );
        }
        // A retained grant must restore the saved channel after the page has
        // actually closed, without sending the user back into setup.
        await page.evaluate(() => {
            const video = document.querySelector("video");
            video.pause();
            video.currentTime = 17;
            video.tabIndex = 0;
            video.focus();
            window.close = () => {
                window.__localExitRequested = true;
            };
        });
        await page.keyboard.press("q");
        assert.equal(
            await page.evaluate(() => window.__localExitRequested),
            true,
            "Q reaches the actual exit path"
        );
        assert.equal(
            await page.evaluate(() => {
                window.body_onUnload();
                window.body_onUnload();
                return window.__ottClassicPlayback.bookmark().playTime;
            }),
            17,
            "Q and repeated unload after teardown preserve the last media clock"
        );
        await reopenPlayer();
        await page.waitForFunction(
            (id) => window.curList[window.primaryIndex] === id,
            selectedChannel
        );
        assert.equal(await action("resume").count(), 0);
        await page.waitForFunction(() =>
            Array.from(document.querySelectorAll("video")).some(
                (v) =>
                    v.currentSrc &&
                    !v.error &&
                    v.currentTime >= 16.5 &&
                    v.currentTime < 21
            )
        );
        // External folder grants may become prompt after browser restart.
        // The player must focus one explicit recovery action and continue the
        // previously selected video once that click restores access.
        const savedPrimaryIndex = await page.evaluate(() =>
            Number(window.providerGetItem("primaryIndex"))
        );
        await page.evaluate(() =>
            localStorage.setItem("fixture-source-permission", "prompt")
        );
        await reopenPlayer();
        await action("resume").waitFor({ state: "visible" });
        assert.equal(
            await page.evaluate(() => window.listArray[window.selIndex].id),
            "resume",
            "permission recovery must be the initially focused action"
        );
        assert.equal(await action("resume").textContent(), "Continue playback");
        assert.equal(
            Number(
                await page.evaluate(() =>
                    window.providerGetItem("primaryIndex")
                )
            ),
            savedPrimaryIndex,
            "permission-blocked startup must not overwrite the channel bookmark"
        );
        await selectAction("resume");
        await page.waitForFunction(
            (id) => window.curList[window.primaryIndex] === id,
            selectedChannel
        );
        await action("resume").waitFor({ state: "hidden" });
        await page.waitForFunction(() =>
            Array.from(document.querySelectorAll("video")).some(
                (v) => v.currentTime > 0.1 && !v.error
            )
        );
        assert.equal(
            await page.evaluate(() =>
                localStorage.getItem("fixture-request-activation")
            ),
            "true",
            "permission recovery must start during the user's Enter action"
        );
        assert.equal(
            await page.evaluate(
                async () => (await window.__ottLocalMedia.list()).items.length
            ),
            2,
            "permission recovery retains both linked sources"
        );
        const portableProfile = await page.evaluate(async () => {
            if (typeof window.loadChannels !== "function")
                throw new Error("Generic catalogue loader is missing");
            const profiles = window.__ottOfflineProfiles;
            const saved = await profiles.request({
                action: "profile_save",
                params: { name: "Browser fixture", number: 1 },
            });
            if (saved.status !== "ok") throw new Error(JSON.stringify(saved));
            return (
                await profiles.request({
                    action: "profile_export",
                    params: { number: 1 },
                })
            ).data.profile;
        });
        await page.evaluate(() => window.playChannel(window.catIndex, 0, true));
        await page.waitForFunction(() => window.primaryIndex === 0);
        const loadedProfile = await page.evaluate(async (profile) => {
            const profiles = window.__ottOfflineProfiles;
            const imported = await profiles.request({
                action: "profile_import",
                params: { number: 2, profile },
            });
            if (imported.status !== "ok")
                throw new Error(JSON.stringify(imported));
            return profiles.request({
                action: "profile",
                params: { number: 2 },
            });
        }, portableProfile);
        assert.equal(loadedProfile.status, "ok");
        assert.equal(loadedProfile.data.binding_required, false);
        await page.waitForFunction(
            (id) =>
                window.commandChannelsReady &&
                window.curList[window.primaryIndex] === id,
            selectedChannel
        );
        await page.waitForFunction(() =>
            Array.from(document.querySelectorAll("video")).some(
                (v) => v.currentTime > 0.1 && !v.error
            )
        );
        await reopenPlayer();
        await page.waitForFunction(
            (id) =>
                window.commandChannelsReady &&
                window.curList[window.primaryIndex] === id,
            selectedChannel
        );
        await page.waitForFunction(() =>
            Array.from(document.querySelectorAll("video")).some(
                (v) => v.currentSrc && !v.error
            )
        );
        // A saved profile owns an independent resume journal. Exercise Q after
        // metadata is ready; the page may need a Play gesture after reopening.
        await page.waitForFunction(
            () => document.querySelector("video").readyState >= 2
        );
        await page.evaluate(() => {
            document.querySelector("video").focus();
        });
        if (await page.evaluate(() => document.querySelector("video").paused))
            await page.keyboard.press("p");
        const beforeProfilePlayback = await page.evaluate(
            () => document.querySelector("video").currentTime
        );
        await page.waitForFunction((before) => {
            const video = document.querySelector("video");
            return (
                !video.paused &&
                video.readyState >= 2 &&
                window.__ottClassicPlayback.snapshot().phase === "playing" &&
                video.currentTime > before + 0.1
            );
        }, beforeProfilePlayback);
        const profileExit = await page.evaluate(() => {
            const video = document.querySelector("video");
            video.pause();
            video.currentTime = 17;
            video.tabIndex = 0;
            video.focus();
            window.close = () => {
                window.__profileExitRequested = true;
            };
            return {
                channel: window.curList[window.primaryIndex],
                source: window.__ottClassicPlayback.sourceId(),
            };
        });
        await page.waitForFunction(() => {
            const video = document.querySelector("video");
            return (
                !video.seeking &&
                video.readyState >= 2 &&
                Math.abs(video.currentTime - 17) < 0.1
            );
        });
        await page.keyboard.press("q");
        assert.equal(
            await page.evaluate(() => window.__profileExitRequested),
            true
        );
        assert.equal(
            await page.evaluate(() => {
                window.body_onUnload();
                return window.__ottClassicPlayback.bookmark().playTime;
            }),
            17
        );
        await reopenPlayer();
        await page.waitForFunction(() => {
            const video = document.querySelector("video");
            return (
                video.currentTime >= 16.5 &&
                video.currentTime < 21 &&
                !video.error
            );
        });
        const profileReopened = await page.evaluate(() => ({
            active: window.__ottOfflineProfiles.read().active,
            channel: window.curList[window.primaryIndex],
            source: window.__ottClassicPlayback.sourceId(),
        }));
        assert.equal(profileReopened.source, profileExit.source);
        assert.equal(profileReopened.channel, profileExit.channel);
        assert.equal(profileReopened.active, 1);

        // Exercise the real driver/mount path: play an initial batch while the
        // browser catalog's final result remains pending, then append the rest
        // without restarting or unpausing the same video element.
        await page.evaluate(async () => {
            if (window.__ottOfflineProfiles.read().active !== 1)
                throw new Error(
                    "The partial scan must exercise the loaded profile"
                );
            // A disk-backed source can report duration only after the legacy
            // two-second probe. Exercise normal channel playback in that state,
            // rather than the Local videos manager's separate Play action.
            Object.defineProperty(document.querySelector("video"), "duration", {
                configurable: true,
                get: () => NaN,
            });
            const api = window.__ottBrowserLocalMedia;
            const original = api.list;
            const catalog = await original.call(api);
            const selected = String(window.curList[window.primaryIndex]);
            const first = catalog.items.find(
                (item) => "local-" + item.id === selected
            );
            if (!first || catalog.items.length < 2)
                throw new Error("Need selected and later batch fixtures");
            window.__progressiveCatalogFixture = {
                api,
                catalog,
                first,
                original,
            };
            window.__progressiveListCalls = 0;
            api.list = function (onProgress, preferredId) {
                window.__progressiveListCalls++;
                if (typeof onProgress !== "function")
                    return original.call(api, onProgress, preferredId);
                return new Promise((resolve) => {
                    window.__finishProgressiveCatalog = () =>
                        resolve({ ...catalog, scanning: false });
                    Promise.resolve().then(() =>
                        onProgress({
                            ...catalog,
                            items: [first],
                            scanned: 1,
                            scanning: true,
                        })
                    );
                });
            };
            window.loadProv();
        });
        try {
            await page.waitForFunction(
                () =>
                    window.cList.length === 1 &&
                    window.commandChannelsReady &&
                    document.querySelector("video").currentTime > 0.1 &&
                    !document.querySelector("video").paused
            );
            await page.waitForTimeout(2200);
            assert.equal(
                await page.evaluate(
                    () => window.__ottClassicPlayback.snapshot().target.kind
                ),
                "vod",
                "normal offline channels are seekable even when metadata misses the probe"
            );
            await page.evaluate(() => {
                delete document.querySelector("video").duration;
            });
            const firstBatch = await page.evaluate(() => {
                const video = document.querySelector("video");
                video.pause();
                video.currentTime = 8;
                window.__progressiveVideo = video;
                window.__progressiveMediaEvents = [];
                for (const name of ["play", "loadstart", "emptied"])
                    video.addEventListener(name, () =>
                        window.__progressiveMediaEvents.push(name)
                    );
                return {
                    channel: window.curList[window.primaryIndex],
                    count: window.cList.length,
                    src: video.currentSrc,
                };
            });
            assert.equal(
                firstBatch.count,
                1,
                "first batch starts before final catalog resolves"
            );
            await page.waitForFunction(() => {
                const video = document.querySelector("video");
                return (
                    video.paused &&
                    !video.seeking &&
                    Math.abs(video.currentTime - 8) < 0.1
                );
            });
            const inactiveImport = await page.evaluate(async () => {
                const profiles = window.__ottOfflineProfiles;
                const exported = await profiles.request({
                    action: "profile_export",
                    params: { number: 2 },
                });
                return profiles.request({
                    action: "profile_import",
                    params: { number: 4, profile: exported.data.profile },
                });
            });
            assert.equal(
                inactiveImport.status,
                "ok",
                "inactive profile import stays available during the active scan"
            );
            const rejectedSave = await page.evaluate(() =>
                window.__ottOfflineProfiles.request({
                    action: "profile_save",
                    params: { name: "Incomplete scan", number: 3 },
                })
            );
            assert.equal(rejectedSave.status, "rejected");
            assert.match(rejectedSave.data.error, /scan to finish/);
            assert.equal(
                await page.evaluate(() => window.__progressiveListCalls),
                1,
                "partial profile save does not restart or duplicate enumeration"
            );
            await page.evaluate(() => {
                const video = document.querySelector("video");
                video.tabIndex = 0;
                video.focus();
            });
            await page.keyboard.press("Alt+ArrowRight");
            await page.waitForFunction(() => {
                const video = document.querySelector("video");
                return (
                    !video.seeking && Math.abs(video.currentTime - 18) < 0.25
                );
            });
            await page.waitForFunction(() => {
                const video = document.querySelector("video");
                const progress = parseFloat(
                    document.querySelector("#progress").style.width
                );
                return (
                    Math.abs(
                        progress - (video.currentTime / video.duration) * 100
                    ) < 1
                );
            });
            await page.keyboard.press("Alt+ArrowLeft");
            await page.waitForFunction(() => {
                const video = document.querySelector("video");
                return !video.seeking && Math.abs(video.currentTime - 8) < 0.25;
            });
            await page.evaluate(() => window.__finishProgressiveCatalog());
            await page.waitForFunction(
                () =>
                    window.cList.length ===
                    window.__progressiveCatalogFixture.catalog.items.length
            );
            const completeSave = await page.evaluate(async () => {
                const profiles = window.__ottOfflineProfiles;
                const saved = await profiles.request({
                    action: "profile_save",
                    params: { name: "Complete progressive catalog", number: 3 },
                });
                const exported = await profiles.request({
                    action: "profile_export",
                    params: { number: 3 },
                });
                const fixture = window.__progressiveCatalogFixture;
                return {
                    calls: window.__progressiveListCalls,
                    count: fixture.catalog.items.length,
                    profile: exported.data.profile,
                    saved,
                    selected: fixture.first.name,
                    sources: fixture.catalog.sources.map((source) => ({
                        kind: source.kind,
                        name: source.name,
                    })),
                };
            });
            assert.equal(completeSave.saved.status, "ok");
            assert.equal(completeSave.sources.length, 2);
            assert.equal(completeSave.count, 2);
            assert.equal(
                completeSave.saved.data.profile.source_count,
                completeSave.sources.length
            );
            assert.deepEqual(
                completeSave.profile.sources.map(({ kind, name }) => ({
                    kind,
                    name,
                })),
                completeSave.sources
            );
            assert.equal(
                completeSave.profile.selected.name,
                completeSave.selected
            );
            assert.equal(
                completeSave.calls,
                1,
                "saving the complete profile reuses its current catalog"
            );
            const appended = await page.evaluate(() => {
                const video = document.querySelector("video");
                return {
                    channel: window.curList[window.primaryIndex],
                    events: window.__progressiveMediaEvents,
                    paused: video.paused,
                    sameElement: video === window.__progressiveVideo,
                    src: video.currentSrc,
                    time: video.currentTime,
                };
            });
            assert.equal(
                appended.channel,
                firstBatch.channel,
                "later batch preserves selected channel"
            );
            assert.equal(
                appended.src,
                firstBatch.src,
                "later batch does not reload its media URL"
            );
            assert.equal(appended.sameElement, true);
            assert.equal(
                appended.paused,
                true,
                "later batch preserves explicit pause"
            );
            assert.ok(
                Math.abs(appended.time - 8) < 0.1,
                "later batch preserves playback clock"
            );
            assert.deepEqual(
                appended.events,
                [],
                "later batch emits no play or reload events"
            );
        } finally {
            await page.evaluate(() => {
                delete document.querySelector("video").duration;
                const fixture = window.__progressiveCatalogFixture;
                fixture.api.list = fixture.original;
                delete window.__progressiveCatalogFixture;
                delete window.__finishProgressiveCatalog;
                delete window.__progressiveVideo;
                delete window.__progressiveMediaEvents;
                delete window.__progressiveListCalls;
            });
        }
        await page.evaluate(async () => {
            const api = window.__ottBrowserLocalMedia;
            const original = api.list;
            const catalog = await original.call(api);
            const selected = window.__ottOfflineProfiles
                .selection()
                .replace(/^local-/, "");
            window.__missingProfileCatalog = { api, original };
            api.list = async () => ({
                ...catalog,
                items: catalog.items.filter((item) => item.id !== selected),
                scanning: false,
            });
            window.loadProv();
        });
        try {
            await action("resume").waitFor({ state: "visible" });
            assert.equal(await page.locator("#launch").isVisible(), false);
            assert.equal(await page.locator("#buffering").isVisible(), false);
            assert.equal(await page.evaluate(() => window.isListVisible), true);
        } finally {
            await page.evaluate(() => {
                const fixture = window.__missingProfileCatalog;
                fixture.api.list = fixture.original;
                delete window.__missingProfileCatalog;
            });
        }
        assert.deepEqual(errors, []);
        console.log(
            "PASS built UI " +
                devicePath +
                ": editor escape/cancel/back, validation/save, pending request ownership, cancelled/error pickers, file and folder links, fullscreen video-focused Alt/Ctrl/Meta seek and plain PC arrow volume with pause preserved, menu/editor shortcut exclusion, playback, offline reload, page close/reopen, second-channel restoration and permission recovery (controlled permission policy), profile save/export/import/load, progressive first-batch playback and append without restart/pause loss"
        );
    } finally {
        await browser.close();
        await new Promise((r) => server.close(r));
        fs.rmSync(mediaFolder, { force: true, recursive: true });
    }
}
